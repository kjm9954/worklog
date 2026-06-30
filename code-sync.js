/* =========================================================================
   WorkLog 공개판 — 동기화 모듈 (노션 밖 KV 저장 / 사용자별 "내 코드")

   cloud-sync.js 를 대체한다. shared.js·HTML 쪽 인터페이스는 그대로 유지:
     window.initCloudSync(onRemoteApplied)
     window.cloudScheduleSave(stateObj)
     window.cloudSaveNow(stateObj)
     window.cloudIsEnabled()

   동작
     - 사용자마다 고유 "내 코드"(예: wk-1a2b-3c4d-5e6f-7a8b)로 데이터를 구분
     - 코드는 이 기기(localStorage)에 기억되고, 다른 기기에선 코드 입력으로 불러옴
     - 실제 데이터는 Cloudflare Worker(public-worker.js) 뒤의 KV에 저장

   설정
     WORKER_URL — 공개 Worker 주소. 'REPLACE-ME'면 클라우드 동기화 비활성(로컬만).
   ========================================================================= */
'use strict';

const WORKER_URL = 'https://worklog-public.wldnjsdkk.workers.dev';
const SAVE_DEBOUNCE_MS = 1500;
const CODE_KEY = 'worklog-public-code-v1';
const INTRO_SEEN_KEY = 'worklog-public-sync-intro-seen-v1';
const CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;

let myCode = null;
let cloudEnabled = false;
let cloudSaveTimer = null;
let cloudInFlight = false;
let cloudPendingSave = false;
let cloudApplyingRemote = false;
let onRemoteAppliedCb = null;

/* ===== 코드 유틸 ========================================================= */
function genCode() {
  const a = new Uint8Array(8);
  (window.crypto || crypto).getRandomValues(a);
  const hex = Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
  return 'wk-' + hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16);
}
function readMyCode() {
  try { return localStorage.getItem(CODE_KEY); } catch (e) { return null; }
}
function writeMyCode(code) {
  try { localStorage.setItem(CODE_KEY, code); } catch (e) { /* iframe storage 차단 시 무시 */ }
  myCode = code;
}
function clearMyCode() {
  try { localStorage.removeItem(CODE_KEY); } catch (e) {}
  myCode = null;
}
function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch (e) {}
  try { return sessionStorage.getItem(key); } catch (e) {}
  return null;
}
function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); return; } catch (e) {}
  try { sessionStorage.setItem(key, value); } catch (e) {}
}
function markIntroSeen() {
  safeStorageSet(INTRO_SEEN_KEY, '1');
}
function shouldSkipIntroPrompt() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('syncPrompt') === '0') {
      markIntroSeen();
      return true;
    }
  } catch (e) {}
  return safeStorageGet(INTRO_SEEN_KEY) === '1';
}
function workerOk() {
  return typeof WORKER_URL === 'string' && WORKER_URL && !WORKER_URL.includes('REPLACE-ME');
}
function recomputeEnabled() {
  // 저장소가 비어 있어도(iOS·아이패드 등 iframe 저장 차단) 메모리에 있는 코드는 유지
  const stored = readMyCode();
  if (stored) myCode = stored;
  cloudEnabled = !!(myCode && CODE_RE.test(myCode) && workerOk());
}

/* URL(?code= 또는 #code=)로 전달된 코드 — 기기 저장이 막히는 환경의 핵심 해결책 */
function readCodeFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    let c = params.get('code') || params.get('mycode');
    if (!c && window.location.hash) {
      c = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code');
    }
    c = (c || '').trim();
    return CODE_RE.test(c) ? c : null;
  } catch (e) { return null; }
}
function shortCode() { return myCode ? myCode.slice(0, 10) + '…' : ''; }

/* ===== 상태 아이콘 ======================================================= */
function cloudStatus(icon, tone, title) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.textContent = icon;
  el.dataset.tone = tone || '';
  if (title) el.title = title;
}

/* ===== 네트워크 ========================================================= */
function cloudUrl() {
  return WORKER_URL.replace(/\/+$/, '') + '/?code=' + encodeURIComponent(myCode);
}
async function cloudLoad() {
  if (!cloudEnabled) return null;
  cloudStatus('⟳', 'pending', '동기화 중…');
  try {
    const res = await fetch(cloudUrl(), { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    cloudStatus('☁', 'ok', '동기화됨 · 내 코드 ' + shortCode());
    return (data && data.state) || null;
  } catch (e) {
    cloudStatus('!', 'err', '동기화 실패: ' + (e && e.message || e));
    console.warn('[code-sync] load failed:', e);
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
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stateObj),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    cloudStatus('☁', 'ok', '동기화됨 · ' + new Date().toLocaleTimeString('ko-KR'));
  } catch (e) {
    cloudStatus('!', 'err', '저장 실패: ' + (e && e.message || e));
    console.warn('[code-sync] save failed:', e);
  } finally {
    cloudInFlight = false;
    if (cloudPendingSave) {
      cloudPendingSave = false;
      if (typeof state !== 'undefined' && state) cloudScheduleSave(state);
    }
  }
}
function cloudScheduleSave(stateObj) {
  if (!cloudEnabled) return;
  if (cloudApplyingRemote) return;     /* 원격 → 로컬 적용 중 에코 방지 */
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(() => cloudSaveNow(stateObj), SAVE_DEBOUNCE_MS);
}
function cloudIsEnabled() { return cloudEnabled; }

/* ===== 코드 채택(만들기/입력) =========================================== */
async function adoptCode(code) {
  if (!CODE_RE.test(code)) { alert('코드 형식이 올바르지 않아요.\n예: wk-1a2b-3c4d-5e6f-7a8b'); return false; }
  writeMyCode(code);
  recomputeEnabled();
  if (!cloudEnabled) return false;
  cloudApplyingRemote = true;
  const remote = await cloudLoad();
  cloudApplyingRemote = false;
  if (remote) {
    /* 기존 코드 → 원격 데이터를 화면에 적용 */
    if (typeof onRemoteAppliedCb === 'function') onRemoteAppliedCb(remote);
  } else {
    /* 새 코드(원격 비어 있음) → 현재 로컬 상태를 업로드 */
    if (typeof state !== 'undefined' && state) cloudSaveNow(state);
  }
  return true;
}

/* ===== UI: 스타일 주입 =================================================== */
function injectStyles() {
  if (document.getElementById('codeSyncStyles')) return;
  const css = `
  #cloudStatus { cursor: pointer; }
  .cs-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center; z-index: 99999; padding: 16px; }
  .cs-card { width: 100%; max-width: 380px; background: var(--card, #fff); color: var(--text, #1a1a1a);
    border: 1px solid var(--border, #e2e2e2); border-radius: 14px; padding: 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,.25); font-size: 14px; line-height: 1.55; }
  .cs-card h3 { margin: 0 0 6px; font-size: 16px; }
  .cs-sub { margin: 0 0 16px; color: var(--muted, #6b7280); font-size: 13px; }
  .cs-btn { display: block; width: 100%; box-sizing: border-box; margin: 8px 0; padding: 11px 14px;
    border-radius: 10px; border: 1px solid var(--border, #d8d8d8); background: var(--card2, #f6f7f9);
    color: var(--text, #1a1a1a); font-size: 14px; cursor: pointer; text-align: center; }
  .cs-btn:hover { filter: brightness(.97); }
  .cs-btn.primary { background: var(--accent, #2f6df6); border-color: var(--accent, #2f6df6); color: #fff; }
  .cs-code { display: flex; align-items: center; gap: 8px; margin: 10px 0; padding: 12px;
    border-radius: 10px; background: var(--card2, #f1f3f7); border: 1px dashed var(--border, #cdd3dd); }
  .cs-code code { flex: 1; font-size: 15px; font-weight: 700; letter-spacing: .4px; word-break: break-all; }
  .cs-input { width: 100%; box-sizing: border-box; padding: 11px 12px; margin: 6px 0 4px;
    border-radius: 10px; border: 1px solid var(--border, #cdd3dd); background: var(--card2, #fff);
    color: var(--text, #1a1a1a); font-size: 14px; }
  .cs-warn { margin: 12px 0 4px; padding: 10px 12px; border-radius: 10px;
    background: rgba(245,158,11,.12); color: var(--text, #92400e); font-size: 12.5px; }
  .cs-row { display: flex; gap: 8px; }
  .cs-row .cs-btn { margin: 8px 0; }
  .cs-link { display: inline-block; margin-top: 10px; color: var(--muted, #6b7280);
    font-size: 12.5px; cursor: pointer; text-decoration: underline; background: none; border: none; }
  `;
  const style = document.createElement('style');
  style.id = 'codeSyncStyles';
  style.textContent = css;
  document.head.appendChild(style);
}

/* ===== UI: 모달 ========================================================= */
let csOverlay = null;
function closeModal() { if (csOverlay) { csOverlay.remove(); csOverlay = null; } }
function buildOverlay(innerHtml) {
  closeModal();
  csOverlay = document.createElement('div');
  csOverlay.className = 'cs-overlay';
  csOverlay.innerHTML = '<div class="cs-card">' + innerHtml + '</div>';
  csOverlay.addEventListener('click', (e) => { if (e.target === csOverlay) closeModal(); });
  document.body.appendChild(csOverlay);
  return csOverlay;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); return true;
    } catch (e2) { return false; }
  }
}

/* 첫 진입(코드 없음) */
function openIntroModal() {
  buildOverlay(`
    <h3>☁ 내 업무일지 시작하기</h3>
    <p class="cs-sub">데이터를 안전하게 저장하고 다른 기기에서도 이어 쓰려면 "내 코드"가 필요해요.</p>
    <button class="cs-btn primary" id="csNew">✨ 새로 시작 (내 코드 만들기)</button>
    <button class="cs-btn" id="csEnter">📥 기기 변경 — 기존 코드 입력</button>
    <button class="cs-link" id="csLater">나중에 (이 기기에만 임시 저장)</button>
  `);
  document.getElementById('csNew').onclick = () => openCreatedModal(genCode());
  document.getElementById('csEnter').onclick = openEnterModal;
  document.getElementById('csLater').onclick = () => {
    markIntroSeen();
    closeModal();
    cloudStatus('⌂', '', '내 코드 없음 — 아이콘을 눌러 시작');
  };
}

/* 코드 생성 직후(백업 안내) */
function openCreatedModal(code) {
  buildOverlay(`
    <h3>✅ 내 코드가 만들어졌어요</h3>
    <p class="cs-sub">이 코드가 곧 열쇠예요. 다른 기기에서 이 코드를 입력하면 같은 데이터가 나타나요.</p>
    <div class="cs-code"><code id="csCodeText">${code}</code><button class="cs-btn" style="width:auto;margin:0;padding:8px 12px" id="csCopy">복사</button></div>
    <div class="cs-warn">⚠️ <b>이 코드를 꼭 메모하거나 캡처해두세요.</b> 코드를 잃어버리면 저장된 데이터를 다시 불러올 수 없어요.</div>
    <button class="cs-btn primary" id="csStart">복사하고 시작하기</button>
  `);
  document.getElementById('csCopy').onclick = async () => {
    const ok = await copyText(code);
    document.getElementById('csCopy').textContent = ok ? '복사됨!' : '복사 실패';
  };
  document.getElementById('csStart').onclick = async () => {
    await copyText(code);
    closeModal();
    await adoptCode(code);
  };
}

/* 기존 코드 입력 */
function openEnterModal() {
  buildOverlay(`
    <h3>📥 코드 입력</h3>
    <p class="cs-sub">다른 기기에서 만든 코드를 입력하면 그 데이터를 불러와요.</p>
    <input class="cs-input" id="csInput" placeholder="wk-1a2b-3c4d-5e6f-7a8b" autocomplete="off" spellcheck="false">
    <button class="cs-btn primary" id="csLoad">불러오기</button>
    <button class="cs-link" id="csBack">← 뒤로</button>
  `);
  const input = document.getElementById('csInput');
  input.focus();
  document.getElementById('csLoad').onclick = async () => {
    const code = (input.value || '').trim();
    const ok = await adoptCode(code);
    if (ok) closeModal();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('csLoad').click(); });
  document.getElementById('csBack').onclick = openIntroModal;
}

/* 이미 코드 있음(상태 아이콘 클릭) */
function openManageModal() {
  buildOverlay(`
    <h3>☁ 내 코드</h3>
    <p class="cs-sub">이 코드로 어느 기기에서나 같은 데이터를 볼 수 있어요.</p>
    <div class="cs-code"><code>${myCode}</code><button class="cs-btn" style="width:auto;margin:0;padding:8px 12px" id="csCopy">복사</button></div>
    <div class="cs-warn">⚠️ 코드는 비밀번호처럼 다뤄주세요. 코드를 아는 사람은 이 데이터에 접근할 수 있어요.</div>
    <button class="cs-btn primary" id="csEmbed">📱 모바일·아이패드용 임베드 주소 복사</button>
    <p class="cs-sub" style="margin-top:6px">이 주소를 노션 임베드 주소로 바꾸면, 기기마다 코드를 다시 입력하지 않아도 돼요.</p>
    <button class="cs-btn" id="csSwitch">다른 코드로 전환</button>
    <button class="cs-link" id="csClose">닫기</button>
  `);
  document.getElementById('csCopy').onclick = async () => {
    const ok = await copyText(myCode);
    document.getElementById('csCopy').textContent = ok ? '복사됨!' : '복사 실패';
  };
  document.getElementById('csEmbed').onclick = async () => {
    const url = location.origin + location.pathname + '?code=' + encodeURIComponent(myCode);
    const ok = await copyText(url);
    document.getElementById('csEmbed').textContent = ok ? '주소 복사됨!' : '복사 실패';
  };
  document.getElementById('csSwitch').onclick = openIntroModal;
  document.getElementById('csClose').onclick = closeModal;
}

function bindStatusClick() {
  const el = document.getElementById('cloudStatus');
  if (!el || el.dataset.csBound) return;
  el.dataset.csBound = '1';
  el.addEventListener('click', () => {
    recomputeEnabled();
    if (cloudEnabled) openManageModal();
    else openIntroModal();
  });
}

/* ===== 초기화 =========================================================== */
async function initCloudSync(onRemoteApplied) {
  onRemoteAppliedCb = onRemoteApplied;
  injectStyles();
  bindStatusClick();
  recomputeEnabled();

  if (!workerOk()) {
    cloudStatus('⌂', '', '서버 미설정 — 이 기기에만 저장');
    return false;
  }
  // 저장소에 코드가 없으면 URL의 ?code= 를 채택 (기기 저장이 막히는 모바일/아이패드 대응)
  if (!cloudEnabled) {
    const urlCode = readCodeFromUrl();
    if (urlCode) { writeMyCode(urlCode); recomputeEnabled(); }
  }
  if (!cloudEnabled) {
    cloudStatus('⌂', '', '내 코드 없음 — 눌러서 시작');
    if (shouldSkipIntroPrompt()) return false;
    markIntroSeen();
    openIntroModal();
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
