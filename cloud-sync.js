/* =========================================================================
   WorkLog — 클라우드 동기화 모듈 (Notion via Cloudflare Worker)

   URL 파라미터
     ?np=<notion_page_id>    (필수, 32자리 hex — 해당 페이지에 저장/로드)
     ?nk=<widget_secret>     (선택, Worker의 WIDGET_SECRET 일치해야 함)

   설정
     WORKER_URL — 사용자가 Cloudflare Worker 배포 후 아래 상수에 붙여넣기
                  'REPLACE-ME'가 남아 있으면 클라우드 동기화 비활성(로컬만).
   ========================================================================= */
'use strict';

const WORKER_URL = 'https://royal-term-43d8.wldnjsdkk.workers.dev';      /* ex) 'https://worklog-sync.xxxxx.workers.dev' */
const SAVE_DEBOUNCE_MS = 1500;

let cloudPageId = null;
let cloudKey = null;
let cloudEnabled = false;
let cloudSaveTimer = null;
let cloudInFlight = false;
let cloudPendingSave = false;
let cloudApplyingRemote = false;

function cloudReadParams() {
  try {
    const sp = new URLSearchParams(location.search);
    cloudPageId = sp.get('np') || sp.get('page') || null;
    cloudKey = sp.get('nk') || null;
    const workerOk = typeof WORKER_URL === 'string' && WORKER_URL && !WORKER_URL.includes('REPLACE-ME');
    cloudEnabled = !!(cloudPageId && workerOk);
  } catch (e) { cloudEnabled = false; }
}

function cloudHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (cloudKey) h['X-Widget-Key'] = cloudKey;
  return h;
}

function cloudUrl() {
  return WORKER_URL.replace(/\/+$/, '') + '/?p=' + encodeURIComponent(cloudPageId);
}

function cloudStatus(icon, tone, title) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.textContent = icon;
  el.dataset.tone = tone || '';
  if (title) el.title = title;
}

async function cloudLoad() {
  if (!cloudEnabled) return null;
  cloudStatus('⟳', 'pending', '동기화 중…');
  try {
    const res = await fetch(cloudUrl(), { method: 'GET', headers: cloudHeaders() });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cloudStatus('☁', 'ok', '동기화됨');
    return (data && data.state) || null;
  } catch (e) {
    cloudStatus('!', 'err', '동기화 실패: ' + (e && e.message || e));
    console.warn('[cloud] load failed:', e);
    return null;
  }
}

async function cloudSaveNow(stateObj) {
  if (!cloudEnabled) return;
  if (cloudInFlight) { cloudPendingSave = true; return; }
  cloudInFlight = true;
  cloudStatus('⟳', 'pending', '저장 중…');
  try {
    const res = await fetch(cloudUrl(), {
      method: 'PUT', headers: cloudHeaders(), body: JSON.stringify(stateObj),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cloudStatus('☁', 'ok', '동기화됨 · ' + new Date().toLocaleTimeString('ko-KR'));
  } catch (e) {
    cloudStatus('!', 'err', '저장 실패: ' + (e && e.message || e));
    console.warn('[cloud] save failed:', e);
  } finally {
    cloudInFlight = false;
    if (cloudPendingSave) {
      cloudPendingSave = false;
      /* 마지막 state로 한 번 더 저장 — 호출 측에서 state 전역을 읽어 재호출 */
      if (typeof state !== 'undefined' && state) cloudScheduleSave(state);
    }
  }
}

function cloudScheduleSave(stateObj) {
  if (!cloudEnabled) return;
  if (cloudApplyingRemote) return;     /* 원격 → 로컬 적용 중에는 에코 방지 */
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => cloudSaveNow(stateObj), SAVE_DEBOUNCE_MS);
}

async function initCloudSync(onRemoteApplied) {
  cloudReadParams();
  if (!cloudEnabled) {
    cloudStatus('⌂', '', '로컬 저장만 (URL에 ?np=... 없음)');
    return false;
  }
  cloudApplyingRemote = true;
  const remote = await cloudLoad();
  cloudApplyingRemote = false;
  if (!remote) return true;             /* 최초 실행: 원격이 비었으면 지금 상태를 업로드 */
  if (typeof onRemoteApplied === 'function') onRemoteApplied(remote);
  return true;
}

function cloudIsEnabled() { return cloudEnabled; }

window.cloudScheduleSave = cloudScheduleSave;
window.cloudSaveNow = cloudSaveNow;
window.initCloudSync = initCloudSync;
window.cloudIsEnabled = cloudIsEnabled;
