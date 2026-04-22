/* =========================================================================
   WorkLog — Cloudflare Worker 프록시 (Notion API 중계)
   Notion API는 브라우저 CORS를 막아 직접 호출 불가 → 이 Worker가 프록시.

   ── 배포 방법 ───────────────────────────────────────────────────────────
   1) https://dash.cloudflare.com → Workers & Pages → Create → Worker
   2) 이 파일 전체를 "Edit code"에 붙여넣고 Save & Deploy
   3) Settings → Variables 에서 아래 환경변수 추가:
        NOTION_TOKEN    = (Notion Integration 토큰, "Encrypt" 체크)
        WIDGET_SECRET   = (임의의 긴 랜덤 문자열, "Encrypt" 체크, 선택)
   4) Worker URL 복사 (예: https://worklog-sync.<your>.workers.dev)
   5) cloud-sync.js 의 WORKER_URL 상수에 붙여넣기
   6) Notion에서 통합(Integration)을 "METABORA" 페이지에 Connect
   ───────────────────────────────────────────────────────────────────────

   엔드포인트
     GET  /?p=<page_id>   → 해당 페이지의 첫 code 블록 JSON 파싱해 반환
     PUT  /?p=<page_id>   (body: state JSON) → code 블록 덮어쓰기 / 없으면 생성
   요청 헤더
     X-Widget-Key: <WIDGET_SECRET>  (WIDGET_SECRET 설정 시 필수)
   ========================================================================= */

const NOTION_VERSION = '2022-06-28';
const CODE_LANGUAGE = 'json';
const RICH_TEXT_MAX = 2000;

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Widget-Key',
      'Access-Control-Max-Age': '86400',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const pageId = url.searchParams.get('p');
    if (!pageId) return json({ error: 'missing query param: p' }, 400, cors);
    if (!env.NOTION_TOKEN) return json({ error: 'server misconfig: NOTION_TOKEN not set' }, 500, cors);

    if (env.WIDGET_SECRET) {
      const key = request.headers.get('X-Widget-Key');
      if (key !== env.WIDGET_SECRET) return json({ error: 'unauthorized' }, 401, cors);
    }

    const notion = (path, opts = {}) => fetch('https://api.notion.com/v1' + path, {
      ...opts,
      headers: {
        'Authorization': 'Bearer ' + env.NOTION_TOKEN,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });

    try {
      if (request.method === 'GET') {
        const state = await loadState(notion, pageId);
        return json({ state, ts: Date.now() }, 200, cors);
      }
      if (request.method === 'PUT') {
        const body = await request.json();
        await saveState(notion, pageId, body);
        return json({ ok: true, ts: Date.now() }, 200, cors);
      }
      return json({ error: 'method not allowed' }, 405, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function listChildren(notion, pageId) {
  const res = await notion(`/blocks/${pageId}/children?page_size=100`);
  if (!res.ok) throw new Error('notion list failed: ' + res.status + ' ' + await res.text());
  return res.json();
}

async function loadState(notion, pageId) {
  const data = await listChildren(notion, pageId);
  const codeBlock = (data.results || []).find(b => b && b.type === 'code');
  if (!codeBlock) return null;
  const text = (codeBlock.code.rich_text || []).map(r => r.plain_text || '').join('');
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function saveState(notion, pageId, state) {
  const text = JSON.stringify(state);
  const chunks = splitChunks(text, RICH_TEXT_MAX);
  const richText = chunks.map(c => ({ type: 'text', text: { content: c } }));

  const data = await listChildren(notion, pageId);
  const codeBlock = (data.results || []).find(b => b && b.type === 'code');

  if (codeBlock) {
    const upd = await notion(`/blocks/${codeBlock.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ code: { rich_text: richText, language: CODE_LANGUAGE } }),
    });
    if (!upd.ok) throw new Error('notion patch failed: ' + upd.status + ' ' + await upd.text());
  } else {
    const add = await notion(`/blocks/${pageId}/children`, {
      method: 'PATCH',
      body: JSON.stringify({
        children: [{
          object: 'block', type: 'code',
          code: { rich_text: richText, language: CODE_LANGUAGE },
        }],
      }),
    });
    if (!add.ok) throw new Error('notion append failed: ' + add.status + ' ' + await add.text());
  }
}

function splitChunks(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [''];
}
