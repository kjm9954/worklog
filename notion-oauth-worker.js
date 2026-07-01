/* =========================================================================
   WorkLog Notion OAuth + template instance Cloudflare Worker

   Bindings / variables:
     WORKLOG_KV             KV namespace for instance metadata and state
     NOTION_CLIENT_ID       Notion public connection OAuth client id
     NOTION_CLIENT_SECRET   Notion public connection OAuth client secret
     NOTION_REDIRECT_URI    https://<worker-domain>/auth/notion/callback
     APP_BASE_URL           Optional, public widget base URL for install page
     NOTION_AUTH_URL        Optional, defaults to Notion OAuth authorize URL

   Notion setup:
     1. Create a public connection with a template option.
     2. Add NOTION_REDIRECT_URI to OAuth redirect URIs.
     3. Put embeds in the template with a placeholder URL, for example:
        https://your-site.example/public-worklog.html?w=WORKLOG_INSTANCE_ID
     4. During OAuth callback, this Worker receives duplicated_template_id,
        creates a random instance id, and patches those embed URLs.
   ========================================================================= */

const NOTION_VERSION = '2026-03-11';
const MAX_BYTES = 512 * 1024;
const INSTANCE_RE = /^[A-Za-z0-9_-]{24,180}$/;
const SCOPE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PLACEHOLDERS = [
  'WORKLOG_INSTANCE_ID',
  '__WORKLOG_INSTANCE_ID__',
  'WORKLOG_WIDGET_INSTANCE_ID',
  '__WORKLOG_WIDGET_INSTANCE_ID__',
];
const WORKLOG_WIDGET_FILES = new Set([
  'public-worklog.html',
  'public-weekly.html',
  'public-calendar.html',
  'public-routine.html',
  'public-memo.html',
  'public-summary.html',
  'public-review.html',
  'public-history.html',
  'public-distribution.html',
  'public-daily.html',
  'public-board.html',
  'notion-retro-check.html',
  'notion-retro-record.html',
  'notion-retro-history.html',
  'notion-retro-detail-history.html',
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });

    try {
      if (path === '/auth/notion/start' && request.method === 'GET') return startOAuth(request, env);
      if (path === '/auth/notion/callback' && request.method === 'GET') return finishOAuth(request, env);
      if (path === '/api/state') return stateApi(request, env);
      if (path === '/install/success' && request.method === 'GET') return installSuccess(request, env);
      if (path === '/' && request.method === 'GET') return html('WorkLog OAuth Worker is running.');
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

async function startOAuth(request, env) {
  requireEnv(env, ['WORKLOG_KV', 'NOTION_CLIENT_ID', 'NOTION_REDIRECT_URI']);
  const state = randomId(32);
  await env.WORKLOG_KV.put('oauth-state:' + state, JSON.stringify({
    createdAt: Date.now(),
    returnTo: new URL(request.url).searchParams.get('return_to') || '',
  }), { expirationTtl: 600 });

  const authUrl = new URL(env.NOTION_AUTH_URL || 'https://api.notion.com/v1/oauth/authorize');
  authUrl.searchParams.set('owner', 'user');
  authUrl.searchParams.set('client_id', env.NOTION_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', env.NOTION_REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  return Response.redirect(authUrl.toString(), 302);
}

async function finishOAuth(request, env) {
  requireEnv(env, ['WORKLOG_KV', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'NOTION_REDIRECT_URI']);
  const url = new URL(request.url);
  const error = url.searchParams.get('error');
  if (error) return htmlPage('설치가 취소됐어요', '<p>Notion 권한 허용이 완료되지 않았습니다.</p>');

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return htmlPage('설치 실패', '<p>OAuth code/state가 없습니다.</p>', 400);

  const stateRaw = await env.WORKLOG_KV.get('oauth-state:' + state);
  if (!stateRaw) return htmlPage('설치 실패', '<p>OAuth state가 만료됐습니다. 다시 시작해 주세요.</p>', 400);
  await env.WORKLOG_KV.delete('oauth-state:' + state);

  const token = await exchangeCode(env, code);
  const instanceId = 'w_' + randomId(40);
  const now = new Date().toISOString();

  const patchResult = {
    template: { updated: 0, scanned: 0, skipped: !token.duplicated_template_id },
    accessiblePages: { updated: 0, scanned: 0, scannedPages: 0, skipped: false, errors: [] },
  };
  if (token.duplicated_template_id) {
    try {
      patchResult.template = await patchTemplateEmbeds(env, token.access_token, token.duplicated_template_id, instanceId);
    } catch (e) {
      patchResult.template = { updated: 0, scanned: 0, skipped: false, error: String(e && e.message || e) };
    }
  }

  try {
    patchResult.accessiblePages = await patchAccessibleWorklogEmbeds(
      env,
      token.access_token,
      instanceId,
      token.duplicated_template_id || ''
    );
  } catch (e) {
    patchResult.accessiblePages = {
      updated: 0,
      scanned: 0,
      scannedPages: 0,
      skipped: false,
      errors: [String(e && e.message || e)],
    };
  }

  await env.WORKLOG_KV.put('instance:' + instanceId, JSON.stringify({
    id: instanceId,
    createdAt: now,
    workspaceId: token.workspace_id || '',
    workspaceName: token.workspace_name || '',
    duplicatedTemplateId: token.duplicated_template_id || '',
    botId: token.bot_id || '',
    owner: token.owner || null,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    patchResult,
  }));

  return Response.redirect(new URL('/install/success?w=' + encodeURIComponent(instanceId), url.origin).toString(), 302);
}

async function stateApi(request, env) {
  const cors = corsHeaders();
  requireEnv(env, ['WORKLOG_KV']);
  const url = new URL(request.url);
  const instanceId = url.searchParams.get('w') || '';
  if (!INSTANCE_RE.test(instanceId)) return json({ error: 'invalid widget instance' }, 400, cors);
  const scope = url.searchParams.get('scope') || 'worklog';
  if (!SCOPE_RE.test(scope)) return json({ error: 'invalid state scope' }, 400, cors);

  const instance = await env.WORKLOG_KV.get('instance:' + instanceId);
  if (!instance) return json({ error: 'unknown widget instance' }, 404, cors);

  const stateKey = 'state:' + instanceId + ':' + scope;
  if (request.method === 'GET') {
    const raw = await env.WORKLOG_KV.get(stateKey);
    return json({ state: raw ? JSON.parse(raw) : null, ts: Date.now() }, 200, cors);
  }

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'payload too large' }, 413, cors);
    try { JSON.parse(text); } catch (e) { return json({ error: 'invalid json' }, 400, cors); }
    await env.WORKLOG_KV.put(stateKey, text);
    return json({ ok: true, ts: Date.now() }, 200, cors);
  }

  return json({ error: 'method not allowed' }, 405, cors);
}

async function installSuccess(request, env) {
  const url = new URL(request.url);
  const instanceId = url.searchParams.get('w') || '';
  if (!INSTANCE_RE.test(instanceId)) return htmlPage('설치 확인 실패', '<p>위젯 인스턴스 ID가 올바르지 않습니다.</p>', 400);

  const base = (env.APP_BASE_URL || url.origin).replace(/\/+$/, '');
  const links = [
    ['업무일지', base + '/public-worklog.html?w=' + encodeURIComponent(instanceId)],
    ['주간 업무', base + '/public-weekly.html?w=' + encodeURIComponent(instanceId)],
    ['중요 업무 캘린더', base + '/public-calendar.html?w=' + encodeURIComponent(instanceId)],
    ['상시 업무', base + '/public-routine.html?w=' + encodeURIComponent(instanceId)],
    ['메모', base + '/public-memo.html?w=' + encodeURIComponent(instanceId)],
    ['업무 복기', base + '/public-review.html?w=' + encodeURIComponent(instanceId)],
    ['업무 히스토리', base + '/public-history.html?w=' + encodeURIComponent(instanceId)],
    ['시간 분포', base + '/public-distribution.html?w=' + encodeURIComponent(instanceId)],
    ['실수 체크', base + '/notion-retro-check.html?w=' + encodeURIComponent(instanceId)],
    ['실수 기록', base + '/notion-retro-record.html?w=' + encodeURIComponent(instanceId)],
    ['실수 히스토리', base + '/notion-retro-history.html?w=' + encodeURIComponent(instanceId)],
    ['지난 실수 상세 히스토리', base + '/notion-retro-detail-history.html?w=' + encodeURIComponent(instanceId)],
  ];
  const body = [
    '<p>Notion 연결이 완료됐습니다. 템플릿 안의 placeholder embed가 자동으로 바뀌었다면 이 창은 닫아도 됩니다.</p>',
    '<p>아래 주소는 자동 세팅이 실패했을 때 확인용으로만 사용하세요.</p>',
    '<ul>',
    ...links.map(([label, href]) => '<li><a href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</a></li>'),
    '</ul>',
  ].join('');
  return htmlPage('WorkLog 설치 완료', body);
}

async function exchangeCode(env, code) {
  const auth = btoa(env.NOTION_CLIENT_ID + ':' + env.NOTION_CLIENT_SECRET);
  const res = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + auth,
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.NOTION_REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error('Notion token exchange failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function notionFetch(accessToken, path, init) {
  const res = await fetch('https://api.notion.com/v1' + path, {
    ...init,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init && init.headers || {}),
    },
  });
  if (!res.ok) throw new Error('Notion API failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function patchTemplateEmbeds(env, accessToken, pageId, instanceId) {
  return patchPageEmbeds(env, accessToken, pageId, instanceId, { maxBlocks: 500 });
}

async function patchAccessibleWorklogEmbeds(env, accessToken, instanceId, alreadyPatchedPageId) {
  const result = { scannedPages: 0, scanned: 0, updated: 0, skipped: false, errors: [] };
  const seenPages = new Set(alreadyPatchedPageId ? [alreadyPatchedPageId] : []);
  const maxPages = 80;
  const maxBlocks = 1600;
  let cursor = '';

  while (result.scannedPages < maxPages && result.scanned < maxBlocks) {
    const body = {
      filter: { property: 'object', value: 'page' },
      page_size: Math.min(100, maxPages - result.scannedPages),
    };
    if (cursor) body.start_cursor = cursor;

    const data = await notionFetch(accessToken, '/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    for (const page of data.results || []) {
      if (!page.id || seenPages.has(page.id)) continue;
      seenPages.add(page.id);
      result.scannedPages++;

      try {
        const pageResult = await patchPageEmbeds(env, accessToken, page.id, instanceId, {
          maxBlocks: Math.min(500, maxBlocks - result.scanned),
        });
        result.scanned += pageResult.scanned;
        result.updated += pageResult.updated;
      } catch (e) {
        if (result.errors.length < 5) result.errors.push(String(e && e.message || e));
      }

      if (result.scannedPages >= maxPages || result.scanned >= maxBlocks) break;
    }

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return result;
}

async function patchPageEmbeds(env, accessToken, pageId, instanceId, options) {
  const result = { scanned: 0, updated: 0, skipped: false };
  const queue = [{ id: pageId, depth: 0 }];
  const maxDepth = options && options.maxDepth || 8;
  const maxBlocks = options && options.maxBlocks || 500;

  while (queue.length && result.scanned < maxBlocks) {
    const current = queue.shift();
    let cursor = '';

    do {
      const path = '/blocks/' + current.id + '/children?page_size=100' +
        (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
      const data = await notionFetch(accessToken, path);

      for (const block of data.results || []) {
        result.scanned++;
        if (block.type === 'embed' && block.embed && block.embed.url) {
          const nextUrl = instanceUrl(block.embed.url, instanceId, env);
          if (nextUrl !== block.embed.url) {
            await notionFetch(accessToken, '/blocks/' + block.id, {
              method: 'PATCH',
              body: JSON.stringify({ embed: { url: nextUrl } }),
            });
            result.updated++;
          }
        }
        if (block.has_children && current.depth < maxDepth) {
          queue.push({ id: block.id, depth: current.depth + 1 });
        }
        if (result.scanned >= maxBlocks) break;
      }

      cursor = data.has_more && data.next_cursor ? data.next_cursor : '';
    } while (cursor && result.scanned < maxBlocks);
  }
  return result;
}

function instanceUrl(rawUrl, instanceId, env) {
  let next = String(rawUrl || '');
  let touched = false;
  for (const marker of PLACEHOLDERS) {
    if (next.includes(marker)) {
      next = next.split(marker).join(instanceId);
      touched = true;
    }
  }

  try {
    const url = new URL(next);
    const w = url.searchParams.get('w') || '';
    if (isTemplateInstanceValue(w)) {
      url.searchParams.set('w', instanceId);
      touched = true;
    } else if (!w && isWorklogWidgetUrl(url, env)) {
      url.searchParams.set('w', instanceId);
      touched = true;
    }
    return touched ? url.toString() : rawUrl;
  } catch (e) {
    return touched ? next : rawUrl;
  }
}

function isTemplateInstanceValue(value) {
  return value === 'template' ||
    value === 'TEMPLATE' ||
    value === 'INSTANCE_ID' ||
    PLACEHOLDERS.includes(value);
}

function isWorklogWidgetUrl(url, env) {
  const fileName = url.pathname.split('/').pop();
  if (!WORKLOG_WIDGET_FILES.has(fileName)) return false;

  const baseRaw = env && env.APP_BASE_URL || 'https://kjm9954.github.io/worklog';
  try {
    const base = new URL(baseRaw);
    const basePath = base.pathname.replace(/\/+$/, '');
    if (url.origin === base.origin && url.pathname.startsWith(basePath + '/')) return true;
  } catch (e) {
    // Fall back to the production GitHub Pages host below.
  }

  return url.hostname === 'kjm9954.github.io' && url.pathname.startsWith('/worklog/');
}

function randomId(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function requireEnv(env, names) {
  for (const name of names) {
    if (!env[name]) throw new Error('missing env binding: ' + name);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });
}

function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function htmlPage(title, body, status) {
  return html('<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escapeHtml(title) + '</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:32px;background:#f6f6f4;color:#171717}main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e3e0d8;border-radius:12px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.06)}h1{font-size:22px;margin:0 0 12px}p{line-height:1.65;color:#555}li{margin:8px 0}a{color:#1f66d1}</style></head><body><main><h1>' +
    escapeHtml(title) + '</h1>' + body + '</main></body></html>', status);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
