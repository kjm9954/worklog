/* =========================================================================
   WorkLog public instance sync

   This replaces the old "make / enter code" flow for public Notion embeds.
   A Cloudflare Worker creates a long random widget instance id during Notion
   OAuth install, then patches the duplicated Notion template embeds to include
   ?w=<instance_id>. The widget can load server state from that id even when
   iOS Notion iframe storage is unavailable.

   Public API kept compatible with shared.js:
     window.initCloudSync(onRemoteApplied)
     window.cloudScheduleSave(stateObj)
     window.cloudSaveNow(stateObj)
     window.cloudIsEnabled()
   ========================================================================= */
'use strict';

const INSTANCE_WORKER_URL = 'https://worklog-public.wldnjsdkk.workers.dev';
const SAVE_DEBOUNCE_MS = 1500;
const INSTANCE_RE = /^[A-Za-z0-9_-]{24,180}$/;

let instanceId = null;
let cloudEnabled = false;
let cloudSaveTimer = null;
let cloudInFlight = false;
let cloudPendingSave = false;
let cloudApplyingRemote = false;
let onRemoteAppliedCb = null;

function readScope() {
  try {
    const sp = new URLSearchParams(window.location.search || '');
    const hp = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    return window.WORKLOG_INSTANCE_SCOPE || sp.get('scope') || hp.get('scope') || 'worklog';
  } catch (e) {
    return window.WORKLOG_INSTANCE_SCOPE || 'worklog';
  }
}

function workerBase() {
  const configured = window.WORKLOG_INSTANCE_WORKER_URL || INSTANCE_WORKER_URL;
  if (!configured || configured.includes('REPLACE-ME')) return '';
  return configured.replace(/\/+$/, '');
}

function readParams() {
  try {
    const sp = new URLSearchParams(window.location.search || '');
    const hp = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
    instanceId = sp.get('w') || sp.get('widget') || sp.get('instance') || hp.get('w') || hp.get('widget') || hp.get('instance') || null;
    cloudEnabled = !!(workerBase() && instanceId && INSTANCE_RE.test(instanceId));
  } catch (e) {
    instanceId = null;
    cloudEnabled = false;
  }
}

function cloudStatus(icon, tone, title) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.textContent = icon;
  el.dataset.tone = tone || '';
  if (title) el.title = title;
}

function stateUrl() {
  return workerBase() + '/api/state?w=' + encodeURIComponent(instanceId) + '&scope=' + encodeURIComponent(readScope());
}

function installUrl() {
  return workerBase() + '/auth/notion/start';
}

function cloudIsEnabled() {
  return cloudEnabled;
}

async function cloudLoad() {
  if (!cloudEnabled) return null;
  cloudStatus('...', 'pending', '서버 데이터 불러오는 중');
  try {
    const res = await fetch(stateUrl(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cloudStatus('OK', 'ok', '서버 동기화됨');
    return (data && data.state) || null;
  } catch (e) {
    cloudStatus('!', 'err', '서버 동기화 실패: ' + (e && e.message || e));
    console.warn('[instance-sync] load failed:', e);
    return null;
  }
}

async function cloudSaveNow(stateObj) {
  if (!cloudEnabled) return;
  if (cloudInFlight) {
    cloudPendingSave = true;
    return;
  }
  cloudInFlight = true;
  cloudStatus('...', 'pending', '서버 저장 중');
  try {
    const res = await fetch(stateUrl(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stateObj),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cloudStatus('OK', 'ok', '서버 저장됨 - ' + new Date().toLocaleTimeString('ko-KR'));
  } catch (e) {
    cloudStatus('!', 'err', '서버 저장 실패: ' + (e && e.message || e));
    console.warn('[instance-sync] save failed:', e);
  } finally {
    cloudInFlight = false;
    if (cloudPendingSave) {
      cloudPendingSave = false;
      if (typeof state !== 'undefined' && state) cloudScheduleSave(state);
    }
  }
}

function cloudScheduleSave(stateObj) {
  if (!cloudEnabled || cloudApplyingRemote) return;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => cloudSaveNow(stateObj), SAVE_DEBOUNCE_MS);
}

function injectStyles() {
  if (document.getElementById('instanceSyncStyles')) return;
  const style = document.createElement('style');
  style.id = 'instanceSyncStyles';
  style.textContent = `
  #cloudStatus { cursor: pointer; }
  /* 전체 화면을 덮는 모달 대신 상단 배너 카드.
     이유: iOS 노션 iframe에서 fixed+어두운 배경은 카드가 가시 영역 밖으로
     밀리면 검은 화면만 남는다. 배너형은 내용도 계속 보이고 어디서든 안전. */
  .is-overlay { position: absolute; top: 8px; left: 0; right: 0; z-index: 99999;
    display: flex; align-items: flex-start; justify-content: center;
    padding: 0 12px; background: transparent; pointer-events: none; }
  .is-card { pointer-events: auto; width: min(390px, 100%); box-sizing: border-box; padding: 16px 18px; border-radius: 14px;
    background: var(--card, #fff); color: var(--text, #171717); border: 1.5px solid var(--border-strong, #c9c9c6);
    box-shadow: 0 12px 34px rgba(0,0,0,.3); font-size: 14px; line-height: 1.55; }
  .is-card h3 { margin: 0 0 6px; font-size: 16px; }
  .is-card p { margin: 0 0 14px; color: var(--text-muted, #6b7280); font-size: 13px; }
  .is-btn { display: block; width: 100%; box-sizing: border-box; margin: 8px 0; padding: 11px 14px;
    border: 1px solid var(--border, #d8d8d8); border-radius: 10px; text-align: center; cursor: pointer;
    background: var(--card2, #f6f7f9); color: var(--text, #171717); text-decoration: none; font-weight: 700; }
  .is-btn.primary { background: var(--accent, #2f6df6); border-color: var(--accent, #2f6df6); color: #fff; }
  .is-link { display: inline-block; margin-top: 8px; border: 0; background: transparent; color: var(--text-muted, #6b7280);
    text-decoration: underline; cursor: pointer; font-size: 12px; }
  `;
  document.head.appendChild(style);
}

let overlay = null;

function closeInstallModal() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}

function openInstallModal() {
  if (!workerBase()) {
    cloudStatus('-', '', '서버 주소가 설정되지 않아 이 기기에만 임시 저장됩니다');
    return;
  }
  closeInstallModal();
  overlay = document.createElement('div');
  overlay.className = 'is-overlay';
  overlay.innerHTML = `
    <div class="is-card">
      <h3>Notion으로 시작하기</h3>
      <p>처음 한 번만 Notion 권한을 허용하면 템플릿 안의 위젯 주소가 자동으로 세팅되고, 이후에는 서버에 저장된 데이터를 불러옵니다.</p>
      <a class="is-btn primary" href="${installUrl()}" target="_blank" rel="noopener">Notion 연결하기</a>
      <button class="is-link" type="button" id="isClose">이 기기에서만 임시 사용</button>
    </div>
  `;
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeInstallModal();
  });
  document.body.appendChild(overlay);
  const closeBtn = document.getElementById('isClose');
  if (closeBtn) closeBtn.onclick = closeInstallModal;
}

function bindStatusClick() {
  const el = document.getElementById('cloudStatus');
  if (!el || el.dataset.instanceSyncBound) return;
  el.dataset.instanceSyncBound = '1';
  el.addEventListener('click', function() {
    readParams();
    if (cloudEnabled) {
      cloudLoad().then(function(remote) {
        if (remote && typeof onRemoteAppliedCb === 'function') onRemoteAppliedCb(remote);
      });
    } else {
      openInstallModal();
    }
  });
}

async function initCloudSync(onRemoteApplied) {
  onRemoteAppliedCb = onRemoteApplied;
  injectStyles();
  bindStatusClick();
  readParams();

  if (!workerBase()) {
    cloudStatus('-', '', '서버 주소 미설정 - 이 기기에만 저장');
    return false;
  }

  if (!cloudEnabled) {
    cloudStatus('?', '', 'Notion 연결 필요');
    try {
      const params = new URLSearchParams(window.location.search || '');
      if (params.get('syncPrompt') !== '0') openInstallModal();
    } catch (e) {
      openInstallModal();
    }
    return false;
  }

  cloudApplyingRemote = true;
  const remote = await cloudLoad();
  cloudApplyingRemote = false;
  if (remote && typeof onRemoteApplied === 'function') onRemoteApplied(remote);
  return true;
}

window.initCloudSync = initCloudSync;
window.cloudScheduleSave = cloudScheduleSave;
window.cloudSaveNow = cloudSaveNow;
window.cloudIsEnabled = cloudIsEnabled;
