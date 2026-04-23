/* =========================================================================
   WorkLog — shared.js
   3개 위젯(daily / board / history) 공용 로직.
   top-level 선언 — 여러 <script> 태그가 같은 script-scope lexical environment
   공유. 페이지 스크립트에서 state·loadState·saveState·showModal 등을 직접 참조.
   ========================================================================= */
'use strict';

/* ── 상수 ── */
const STORAGE_KEY = 'worklog-widget-state-v1';
const THEME_KEY = 'worklog-theme';
const DEVICE_KEY = 'worklog-device';
const SYNC_CHANNEL_NAME = 'worklog-sync';
const LAST_ROLLOVER_KEY = 'worklog-last-rollover';

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const DEFAULT_PROJECTS = ['메인', '서브', '기타'];
const IMPORTANT_CATEGORIES = [];
const ROUTINE_CATEGORIES = [];
const ROUTINE_SUB = [];
const STATUSES = ['대기', '진행중', '완료'];
const PERIODS = ['오전', '오후'];
const DASH = '-';

const QUADRANT_DEFS = [
  { key: 'q1', label: '# 중요 O\n∩ 긴급 O' },
  { key: 'q2', label: '# 중요 O\n∩ 긴급 X' },
  { key: 'q3', label: '# 중요 X\n∩ 긴급 O' },
  { key: 'q4', label: '# 중요 X\n∩ 긴급 X' }
];

const ICONS = {
  archive:  '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v4H3zM5 11v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9M10 15h4"/></svg>',
  pin:      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5M8 3h8v3l-1 1v5l2 2v2H7v-2l2-2V7L8 6z"/></svg>',
  reset:    '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>',
  save:     '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8"/></svg>',
  upload:   '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>',
  download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  moon:     '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>',
  sun:      '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
};
function icon(name) { return ICONS[name] || ''; }

/* ── 공유 상태 (여러 <script>에서 참조) ── */
let state = null;
let modalCallback = null;
let broadcastChannel = null;
const PAGE_ID = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);

/* ── 순수 유틸 ── */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  if (dateStr === DASH) return DASH;
  const parts = dateStr.split('-');
  if (parts.length < 3) return dateStr;
  return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
}

// "4/13", "04/13", "4-13", "413", "2026-04-13" → YYYY-MM-DD. "-"는 명시적 미설정(DASH)
function parseDateInput(str, fallbackYear) {
  if (!str) return '';
  const s = String(str).trim();
  if (!s) return '';
  if (/^[\-—−–]$/.test(s)) return DASH;
  const y0 = fallbackYear || new Date().getFullYear();
  let m = s.match(/^(\d{4})[\-\/\.](\d{1,2})[\-\/\.](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m = s.match(/^(\d{1,2})[\-\/\.](\d{1,2})$/);
  if (m) return `${y0}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  m = s.match(/^(\d{3,4})$/);
  if (m) {
    const ss = m[1].padStart(4, '0');
    return `${y0}-${ss.slice(0,2)}-${ss.slice(2,4)}`;
  }
  return '';
}

function getThisMonday(base) {
  const d = base ? new Date(base) : new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function createWeekDays(monday) {
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push({
      date: formatDate(d), dayName: DAY_NAMES[d.getDay()],
      schedule: '', memo: '', retro: '',
      quadrants: { q1: [], q2: [], q3: [], q4: [] }
    });
  }
  return days;
}

function parseEstimated(str) {
  if (str == null) return '';
  const s = String(str).trim();
  if (!s) return '';
  if (/^[\-—−–]$/.test(s)) return DASH;
  const n = parseFloat(s);
  if (isNaN(n) || n < 0) return '';
  return String(n);
}

function calcDDay(targetDate) {
  if (!targetDate) return null;
  if (targetDate === DASH) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(targetDate);
  if (isNaN(target.getTime())) return null;
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}

function formatDDay(diff) {
  if (diff == null) return '';
  if (diff === 0) return 'D-DAY';
  if (diff > 0) return `D-${diff}`;
  return `D+${Math.abs(diff)}`;
}

function ddayClass(diff) {
  if (diff == null) return '';
  if (diff < 0) return 'over critical';
  if (diff <= 1) return 'near critical';
  if (diff <= 3) return 'near';
  if (diff <= 7) return 'soon';
  return '';
}

function parseTime(str) {
  if (str == null) return '';
  let s = String(str).trim().toLowerCase();
  if (!s) return '';
  if (/^[\-—−–]$/.test(s)) return DASH;
  let period = null;
  if (/(오후|pm)/i.test(s)) { period = 'pm'; s = s.replace(/(오후|pm)/gi, '').trim(); }
  else if (/(오전|am)/i.test(s)) { period = 'am'; s = s.replace(/(오전|am)/gi, '').trim(); }
  s = s.replace(/[^\d:]/g, '');
  if (!s) return '';
  let hh, mm;
  if (s.includes(':')) {
    const parts = s.split(':');
    hh = parseInt(parts[0], 10);
    mm = parseInt(parts[1] || '0', 10);
  } else if (s.length <= 2) { hh = parseInt(s, 10); mm = 0; }
  else if (s.length === 3) { hh = parseInt(s.slice(0, 1), 10); mm = parseInt(s.slice(1), 10); }
  else { hh = parseInt(s.slice(0, 2), 10); mm = parseInt(s.slice(2, 4), 10); }
  if (isNaN(hh) || isNaN(mm)) return '';
  if (period === 'pm' && hh < 12) hh += 12;
  else if (period === 'am' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23) return '';
  if (mm < 0) mm = 0;
  if (mm > 59) mm = 59;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatTime12(hhmm) {
  if (!hhmm) return { period: '오전', text: '' };
  const parts = String(hhmm).split(':');
  if (parts.length < 2) return { period: '오전', text: '' };
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return { period: '오전', text: '' };
  const period = h >= 12 ? '오후' : '오전';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return { period, text: `${h12}:${String(m).padStart(2, '0')}` };
}

function formatNowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function calcHours(start, end) {
  if (!start || !end) return 0;
  if (start === DASH || end === DASH) return 0;
  const sParts = start.split(':').map(Number);
  const eParts = end.split(':').map(Number);
  if (sParts.length < 2 || eParts.length < 2) return 0;
  const diff = (eParts[0] * 60 + eParts[1]) - (sParts[0] * 60 + sParts[1]);
  return diff > 0 ? diff / 60 : 0;
}

function calcTaskHours(t) {
  if (!t) return 0;
  const base = calcTaskHoursBase(t);
  const adj = Number(t.adjustHours) || 0;
  return Math.max(0, base + adj);
}

// adjustHours 없는 자동 계산값 (팝오버 내부 base 표시용)
function calcTaskHoursBase(t) {
  const base = calcHours(t.startTime, t.endTime);
  const breakMin = parseInt(t.breakMinutes, 10) || 0;
  if (breakMin <= 0 || t.breakMode === 'include') return base;
  return Math.max(0, base - breakMin / 60);
}

function calcDayStats(day) {
  let total = 0, done = 0, actualHours = 0, estimatedHours = 0;
  ['q1','q2','q3','q4'].forEach(key => {
    const tasks = (day.quadrants && day.quadrants[key]) || [];
    tasks.forEach(t => {
      total++;
      if (t.done) done++;
      actualHours += calcTaskHours(t);
      const est = parseFloat(t.estimatedHours);
      if (!isNaN(est)) estimatedHours += est;
    });
  });
  const rate = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, rate, actualHours, estimatedHours };
}

function calcWeekStats(days) {
  let totalHours = 0, estHours = 0, total = 0, done = 0;
  const byQuadrant = { q1: 0, q2: 0, q3: 0, q4: 0 };
  const labels = (state && state.projectLabels) || DEFAULT_PROJECTS;
  const byProject = {};
  labels.forEach(p => { byProject[p] = 0; });
  days.forEach(d => {
    ['q1','q2','q3','q4'].forEach(qk => {
      (d.quadrants[qk] || []).forEach(t => {
        const h = calcTaskHours(t);
        totalHours += h;
        byQuadrant[qk] += h;
        if (byProject.hasOwnProperty(t.project)) byProject[t.project] += h;
        const est = parseFloat(t.estimatedHours);
        if (!isNaN(est)) estHours += est;
        total++;
        if (t.done) done++;
      });
    });
  });
  const rate = total === 0 ? 0 : Math.round(done/total*100);
  return { totalHours, estHours, rate, byQuadrant, byProject, total, done };
}

function rateClass(rate) {
  if (rate == null || isNaN(rate)) return 'rate-none';
  if (rate >= 100) return 'rate-excellent';
  if (rate >= 80) return 'rate-great';
  if (rate >= 50) return 'rate-ok';
  if (rate > 0) return 'rate-low';
  return 'rate-none';
}

// 진행률(%) → 색 클래스. null = 추정치 없음
function progressColorClass(pct) {
  if (pct == null || !isFinite(pct)) return '';
  if (pct < 50) return 'p-low';
  if (pct < 100) return 'p-ok';
  if (pct < 150) return 'p-over';
  return 'p-high';
}

function taskStatus(t) {
  if (t.userStatus === 'wait' || t.userStatus === 'doing' || t.userStatus === 'done') return t.userStatus;
  if (t.done) return 'done';
  if (t.startTime && t.startTime !== DASH) return 'doing';
  return 'wait';
}

// day.quadrants(q1~q4) → 평탄 배열 [{task, qKey, ti}]
function flattenDayTasks(day) {
  const out = [];
  ['q1', 'q2', 'q3', 'q4'].forEach(qKey => {
    const arr = (day.quadrants && day.quadrants[qKey]) || [];
    arr.forEach((t, ti) => out.push({ task: t, qKey: qKey, ti: ti }));
  });
  return out;
}

// 프로젝트 이름 → 슬롯 매핑 (색상 매핑용 — p1~p3 순환)
function projectSlot(projectName) {
  const labels = (state && state.projectLabels) || [];
  const idx = labels.indexOf(projectName);
  if (idx < 0) return '';
  return 'p' + ((idx % 3) + 1);
}

/* ── 상태 라이프사이클 ── */
function createInitialState() {
  const monday = getThisMonday();
  return {
    version: 4.0,
    goals: { week: '', month: '' },
    projectLabels: [],
    weekStart: formatDate(monday),
    days: createWeekDays(monday),
    importantTasks: [], routines: [], history: [],
    lastQuadrant: 'q4',
    lastExportAt: null,
    carryover: []
  };
}

function migrateState(s) {
  if (!s || typeof s !== 'object') return createInitialState();
  if (!s.goals || typeof s.goals !== 'object') {
    s.goals = { week: typeof s.mainGoal === 'string' ? s.mainGoal : '', month: '' };
  }
  s.goals.week = typeof s.goals.week === 'string' ? s.goals.week : '';
  s.goals.month = typeof s.goals.month === 'string' ? s.goals.month : '';
  delete s.mainGoal;
  s.lastQuadrant = ['q1','q2','q3','q4'].includes(s.lastQuadrant) ? s.lastQuadrant : 'q4';
  s.lastExportAt = (typeof s.lastExportAt === 'number' && isFinite(s.lastExportAt)) ? s.lastExportAt : null;
  s.carryover = Array.isArray(s.carryover) ? s.carryover.filter(x => x && typeof x === 'object' && typeof x.qKey === 'string') : [];
  if (!Array.isArray(s.projectLabels)) s.projectLabels = [];
  s.projectLabels = s.projectLabels.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim());
  if (!s.weekStart || !Array.isArray(s.days) || s.days.length === 0) {
    const monday = getThisMonday();
    s.weekStart = formatDate(monday);
    s.days = createWeekDays(monday);
  }
  s.days.forEach(day => {
    day.schedule = day.schedule || '';
    day.memo = day.memo || '';
    day.retro = typeof day.retro === 'string' ? day.retro : '';
    day.quadrants = day.quadrants || { q1: [], q2: [], q3: [], q4: [] };
    ['q1','q2','q3','q4'].forEach(k => {
      if (!Array.isArray(day.quadrants[k])) day.quadrants[k] = [];
      day.quadrants[k].forEach(t => {
        if (!t.id) t.id = uid();
        if (t.project === '공용') t.project = s.projectLabels[2];
        if (!s.projectLabels.includes(t.project)) t.project = s.projectLabels[0];
        t.name = t.name || '';
        t.targetDate = t.targetDate || day.date;
        t.startTime = t.startTime || '';
        t.endTime = t.endTime || '';
        t.breakMinutes = Number(t.breakMinutes) || 0;
        t.breakMode = t.breakMode === 'include' ? 'include' : 'exclude';
        t.estimatedHours = t.estimatedHours == null ? '' : String(t.estimatedHours);
        t.progressHours = t.progressHours == null ? '' : String(t.progressHours);
        t.done = !!t.done;
        t.note = t.note || '';
        t.quadrant = (t.quadrant === 'q1' || t.quadrant === 'q2' || t.quadrant === 'q3' || t.quadrant === 'q4') ? t.quadrant : k;
        t.carriedOver = !!t.carriedOver;
        t.originalDate = typeof t.originalDate === 'string' ? t.originalDate : '';
        t.userStatus = (t.userStatus === 'wait' || t.userStatus === 'doing' || t.userStatus === 'done') ? t.userStatus : '';
        t.adjustHours = Number(t.adjustHours) || 0;
      });
    });
  });
  s.importantTasks = Array.isArray(s.importantTasks) ? s.importantTasks : [];
  s.importantTasks.forEach(it => {
    if (!it.id) it.id = uid();
    if (it.project === '공용') it.project = s.projectLabels[2];
    if (!s.projectLabels.includes(it.project)) it.project = s.projectLabels[0];
    it.category = typeof it.category === 'string' ? it.category : '';
    if (!STATUSES.includes(it.status)) it.status = '대기';
    it.name = it.name || '';
    it.targetDate = it.targetDate || '';
    it.note = it.note || '';
  });
  s.routines = Array.isArray(s.routines) ? s.routines : [];
  s.routines.forEach(r => {
    if (!r.id) r.id = uid();
    if (r.project === '공용') r.project = s.projectLabels[2];
    if (!s.projectLabels.includes(r.project)) r.project = s.projectLabels[0];
    r.category = typeof r.category === 'string' ? r.category : '';
    r.subCategory = typeof r.subCategory === 'string' ? r.subCategory : '';
    if (!STATUSES.includes(r.status)) r.status = '대기';
    r.name = r.name || '';
    r.targetDate = r.targetDate || '';
    r.note = r.note || '';
  });
  s.history = Array.isArray(s.history) ? s.history : [];
  s.history.forEach(h => {
    if (!h.goals || typeof h.goals !== 'object') {
      h.goals = { week: typeof h.mainGoal === 'string' ? h.mainGoal : '', month: '' };
    }
    h.goals.week = typeof h.goals.week === 'string' ? h.goals.week : '';
    h.goals.month = typeof h.goals.month === 'string' ? h.goals.month : '';
    delete h.mainGoal;
  });
  s.version = 4.0;
  return s;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    return migrateState(JSON.parse(raw));
  } catch (err) {
    console.error('상태 로드 실패:', err);
    return createInitialState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    // 같은 origin 내 다른 페이지(iframe)에 변경 알림
    const bc = getBroadcastChannel();
    if (bc) bc.postMessage({ type: 'save', from: PAGE_ID, ts: Date.now() });
    // 클라우드 동기화 (URL에 ?np=... 있고 Worker URL 세팅된 경우만)
    if (typeof window.cloudScheduleSave === 'function') {
      try { window.cloudScheduleSave(state); } catch (e) { console.warn('[cloud] schedule failed:', e); }
    }
  } catch (err) {
    console.error('저장 실패:', err);
    if (typeof showModal === 'function') {
      showModal('저장 실패', '저장 중 문제가 발생했습니다.\n' + (err.message || ''), null);
    }
  }
}

/* 원격(클라우드)에서 받아온 state를 로컬에 적용. cloud-sync가 에코 저장을 막아 호출.
   페이지 render는 호출 측에서 담당한다. */
function applyRemoteState(remote) {
  if (!remote || typeof remote !== 'object') return false;
  try {
    state = migrateState(remote);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const bc = getBroadcastChannel();
    if (bc) bc.postMessage({ type: 'save', from: PAGE_ID, ts: Date.now() });
    return true;
  } catch (err) {
    console.warn('[cloud] apply remote failed:', err);
    return false;
  }
}

function archiveWeek() {
  const archivedAt = new Date().toLocaleString('ko-KR');
  state.history.push({
    archivedAt,
    weekStart: state.weekStart,
    goals: { week: state.goals.week, month: state.goals.month },
    days: JSON.parse(JSON.stringify(state.days))
  });
  const monday = getThisMonday();
  state.weekStart = formatDate(monday);
  state.days = createWeekDays(monday);
  saveState();
}

// 저장된 weekStart가 이번 주 월요일과 다르면 현재 주를 history에 보관하고 새 주로 교체.
// 여러 탭 동시 오픈 시 경쟁 방지를 위해 LAST_ROLLOVER_KEY 가드로 같은 주 1회만 실행.
function autoRolloverWeek() {
  if (!state || !state.weekStart) return;
  const todayMonday = formatDate(getThisMonday());
  if (state.weekStart === todayMonday) return;
  // 가드: 이미 이번 주에 롤오버된 적 있으면 스킵 (state만 갱신)
  try {
    const lastStamp = localStorage.getItem(LAST_ROLLOVER_KEY);
    if (lastStamp === todayMonday) {
      // 혹시 state에 반영이 안 된 경우 다시 로드
      state = loadState();
      return;
    }
  } catch (e) {}

  const hasData = Array.isArray(state.days) && state.days.some(d => {
    if (!d) return false;
    if ((d.retro || '').trim()) return true;
    if ((d.schedule || '').trim()) return true;
    if ((d.memo || '').trim()) return true;
    const q = d.quadrants || {};
    return ['q1','q2','q3','q4'].some(k => Array.isArray(q[k]) && q[k].length > 0);
  });
  if (hasData) {
    if (!Array.isArray(state.history)) state.history = [];
    state.history.push({
      archivedAt: new Date().toLocaleString('ko-KR') + ' (자동)',
      weekStart: state.weekStart,
      goals: { week: state.goals.week, month: state.goals.month },
      days: JSON.parse(JSON.stringify(state.days))
    });
  }
  const monday = getThisMonday();
  state.weekStart = formatDate(monday);
  state.days = createWeekDays(monday);
  if (Array.isArray(state.carryover) && state.carryover.length) {
    const mon = state.days[0];
    state.carryover.forEach(item => {
      const q = ['q1','q2','q3','q4'].includes(item.qKey) ? item.qKey : 'q4';
      if (!mon.quadrants[q]) mon.quadrants[q] = [];
      mon.quadrants[q].push(item.task);
    });
    state.carryover = [];
  }
  try { localStorage.setItem(LAST_ROLLOVER_KEY, todayMonday); } catch (e) {}
  saveState();
}

/* ── 실시간 싱크 (BroadcastChannel + storage 이벤트) ── */
function getBroadcastChannel() {
  if (broadcastChannel) return broadcastChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    broadcastChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
  } catch (e) {
    broadcastChannel = null;
  }
  return broadcastChannel;
}

// 다른 페이지/탭에서 state가 바뀌면 현재 페이지의 state를 자동 리로드하고
// onChange 콜백(보통 render 함수)을 호출한다.
function subscribeStateChanges(onChange) {
  const reload = () => {
    state = loadState();
    if (typeof onChange === 'function') onChange();
  };
  // 1) 같은 origin 내 페이지 간 (iframe·다른 탭 모두 커버)
  const bc = getBroadcastChannel();
  if (bc) {
    bc.addEventListener('message', (ev) => {
      const data = ev && ev.data;
      if (!data || data.type !== 'save') return;
      if (data.from === PAGE_ID) return; // 자기 메시지 무시
      reload();
    });
  }
  // 2) 다른 탭 (BroadcastChannel 미지원 브라우저 폴백)
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY) return;
    reload();
  });
}

/* ── 테마 ── */
function applyTheme(theme) {
  if (!['light', 'dark'].includes(theme)) theme = 'light';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  const btn = document.getElementById('themeToggle');
  if (btn) btn.innerHTML = theme === 'dark' ? icon('sun') : icon('moon');
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// 페이지 로드 시 저장된 테마 또는 시스템 설정 적용
function initTheme() {
  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme) applyTheme(savedTheme);
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
    else applyTheme('light');
  } catch (e) { applyTheme('light'); }
}

/* ── 디바이스 모드 (수동 토글 — PC / Mobile) ── */
function applyDevice(device) {
  if (device !== 'mobile') device = 'pc';
  document.documentElement.dataset.device = device;
  try { localStorage.setItem(DEVICE_KEY, device); } catch (e) {}
  const btn = document.getElementById('deviceToggle');
  if (btn) {
    btn.textContent = device === 'mobile' ? '💻' : '📱';
    btn.title = device === 'mobile' ? 'PC 모드로' : '모바일 모드로';
  }
}

function toggleDevice() {
  const current = document.documentElement.dataset.device || 'pc';
  applyDevice(current === 'mobile' ? 'pc' : 'mobile');
}

function initDevice() {
  try {
    const saved = localStorage.getItem(DEVICE_KEY);
    applyDevice(saved === 'mobile' ? 'mobile' : 'pc');
  } catch (e) { applyDevice('pc'); }
}

/* ── 모달 ── */
function showModal(title, message, onConfirm) {
  const titleEl = document.getElementById('modalTitle');
  const msgEl = document.getElementById('modalMessage');
  const bd = document.getElementById('modalBackdrop');
  const confirmBtn = document.getElementById('modalConfirmBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');
  if (!titleEl || !msgEl || !bd || !confirmBtn || !cancelBtn) return;
  titleEl.textContent = title;
  msgEl.textContent = message;
  modalCallback = onConfirm || null;
  if (onConfirm) { confirmBtn.textContent = '확인'; cancelBtn.style.display = ''; }
  else { confirmBtn.textContent = '닫기'; cancelBtn.style.display = 'none'; }
  bd.classList.remove('hidden');
}

let modalCloseCallback = null;
function hideModal() {
  const bd = document.getElementById('modalBackdrop');
  if (bd) bd.classList.add('hidden');
  modalCallback = null;
  const confirmBtn = document.getElementById('modalConfirmBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');
  if (confirmBtn) confirmBtn.style.display = '';
  if (cancelBtn) { cancelBtn.style.display = ''; cancelBtn.textContent = '취소'; }
  const msgEl = document.getElementById('modalMessage');
  if (msgEl) msgEl.innerHTML = '';
  const cb = modalCloseCallback; modalCloseCallback = null;
  if (typeof cb === 'function') cb();
}

function showChoiceModal(title, message, choices) {
  return new Promise(function(resolve) {
    const titleEl = document.getElementById('modalTitle');
    const msgEl = document.getElementById('modalMessage');
    const bd = document.getElementById('modalBackdrop');
    const confirmBtn = document.getElementById('modalConfirmBtn');
    const cancelBtn = document.getElementById('modalCancelBtn');
    if (!titleEl || !msgEl || !bd || !confirmBtn || !cancelBtn) { resolve(null); return; }
    titleEl.textContent = title;
    msgEl.innerHTML = '';
    if (message) {
      const p = document.createElement('div');
      p.textContent = message;
      p.style.cssText = 'margin-bottom:10px; white-space:pre-line; color:var(--text-muted); font-size:0.85rem;';
      msgEl.appendChild(p);
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    let picked = false;
    choices.forEach(function(c) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = c.label;
      b.style.cssText = 'justify-content:center; padding:10px;';
      b.addEventListener('click', function() {
        picked = true;
        modalCloseCallback = null;
        hideModal();
        resolve(c.value);
      });
      wrap.appendChild(b);
    });
    msgEl.appendChild(wrap);
    modalCallback = null;
    confirmBtn.style.display = 'none';
    cancelBtn.style.display = '';
    cancelBtn.textContent = '취소';
    modalCloseCallback = function() { if (!picked) resolve(null); };
    bd.classList.remove('hidden');
  });
}

function confirmModal() {
  const cb = modalCallback;
  hideModal();
  if (cb) cb();
}

/* ── JSON 백업 / 복원 ── */
function buildBackupPayload(scope) {
  const payload = { version: state.version || 4.0, scope: scope };
  if (scope === 'daily') {
    payload.weekStart = state.weekStart;
    payload.days = state.days;
    payload.history = state.history;
  } else if (scope === 'board') {
    payload.projectLabels = state.projectLabels;
    payload.importantTasks = state.importantTasks;
    payload.routines = state.routines;
  } else {
    payload.scope = 'all';
    return Object.assign({}, state, { scope: 'all' });
  }
  return payload;
}

function downloadJsonFile(data, filenamePrefix) {
  const dataStr = JSON.stringify(data, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = formatDate(new Date());
  a.href = url;
  a.download = `${filenamePrefix}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportJson() {
  showChoiceModal(
    'JSON 백업 범위 선택',
    '다운로드할 범위를 선택해주세요.',
    [
      { label: '📅 업무일지 (주간 날짜별 · 히스토리)', value: 'daily' },
      { label: '📋 중요·상시 업무 (프로젝트 라벨)', value: 'board' },
      { label: '💾 전체 (모든 데이터)', value: 'all' }
    ]
  ).then(function(scope) {
    if (!scope) return;
    try {
      const payload = buildBackupPayload(scope);
      const prefix = scope === 'daily' ? 'worklog-daily' : scope === 'board' ? 'worklog-board' : 'worklog-all';
      downloadJsonFile(payload, prefix);
      state.lastExportAt = Date.now();
      saveState();
      if (typeof window.refreshBackupReminder === 'function') window.refreshBackupReminder();
    } catch (err) {
      showModal('백업 실패', '백업 중 오류가 발생했습니다.\n' + (err.message || ''), null);
    }
  });
}

// 복원 완료 후 재렌더가 필요하므로 page-side renderAll 콜백을 인자로 받음
function importJson(event, renderAll) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const imported = JSON.parse(e.target.result);
      const sections = detectBackupSections(imported);
      if (sections.length === 0) {
        showModal('복원 실패', '이 파일에서 복원 가능한 데이터를 찾지 못했습니다.', null);
        event.target.value = '';
        return;
      }
      const sectionLabels = sections.map(s => '· ' + s.label).join('\n');
      showModal('JSON 부분 복원',
        `"${file.name}" 에서 감지된 데이터:\n\n${sectionLabels}\n\n위 항목만 덮어씁니다. 파일에 없는 항목은 그대로 유지돼요.\n계속할까요?`,
        () => {
          applyImportedSections(imported, sections);
          saveState();
          if (typeof renderAll === 'function') renderAll();
          const summary = sections.map(s => s.label).join(', ');
          showModal('복원 완료', `복원된 항목: ${summary}`, null);
        });
    } catch (err) {
      showModal('복원 실패', '유효한 JSON 파일이 아닙니다.\n' + (err.message || ''), null);
    }
    event.target.value = '';
  };
  reader.readAsText(file, 'utf-8');
}

function detectBackupSections(imported) {
  if (!imported || typeof imported !== 'object') return [];
  const out = [];
  if (imported.goals && typeof imported.goals === 'object') out.push({ key: 'goals', label: '목표 (주간·월간)' });
  if (Array.isArray(imported.projectLabels)) out.push({ key: 'projectLabels', label: '프로젝트 라벨' });
  if (Array.isArray(imported.importantTasks)) out.push({ key: 'importantTasks', label: '중요 업무' });
  if (Array.isArray(imported.routines)) out.push({ key: 'routines', label: '상시 업무' });
  if (Array.isArray(imported.days) && imported.days.length > 0) out.push({ key: 'days', label: '업무일지 (주간 날짜별)' });
  if (Array.isArray(imported.history) && imported.history.length > 0) out.push({ key: 'history', label: '히스토리' });
  return out;
}

function applyImportedSections(imported, sections) {
  const picked = Object.create(null);
  sections.forEach(s => { picked[s.key] = true; });
  const scopedRaw = {};
  ['goals','projectLabels','importantTasks','routines','days','history','weekStart','version'].forEach(k => {
    if (imported[k] !== undefined) scopedRaw[k] = JSON.parse(JSON.stringify(imported[k]));
  });
  const normalized = migrateBackupFragment(scopedRaw, picked);

  if (picked.goals) state.goals = normalized.goals;
  if (picked.projectLabels) state.projectLabels = normalized.projectLabels;
  if (picked.importantTasks) state.importantTasks = normalized.importantTasks;
  if (picked.routines) state.routines = normalized.routines;

  if (picked.days) mergeImportedDays(normalized.days);
  if (picked.history) mergeImportedHistory(normalized.history);
}

function migrateBackupFragment(raw, picked) {
  const stub = createInitialState();
  if (picked.goals) stub.goals = raw.goals || stub.goals;
  if (picked.projectLabels) stub.projectLabels = raw.projectLabels || [];
  if (picked.importantTasks) stub.importantTasks = raw.importantTasks || [];
  if (picked.routines) stub.routines = raw.routines || [];
  if (picked.days && raw.weekStart) stub.weekStart = raw.weekStart;
  if (picked.days) stub.days = raw.days || [];
  if (picked.history) stub.history = raw.history || [];
  const migrated = migrateState(stub);
  if (!picked.days) { migrated.days = state.days; migrated.weekStart = state.weekStart; }
  return migrated;
}

function mergeImportedDays(importedDays) {
  if (!Array.isArray(importedDays) || importedDays.length === 0) return;
  const currentDates = state.days.map(d => d.date);
  const outsideDays = [];
  importedDays.forEach(d => {
    if (!d || !d.date) return;
    const hitIdx = currentDates.indexOf(d.date);
    if (hitIdx >= 0) {
      const keepDayName = state.days[hitIdx].dayName;
      state.days[hitIdx] = Object.assign({}, d, { dayName: keepDayName });
    } else {
      outsideDays.push(d);
    }
  });
  if (outsideDays.length === 0) return;
  if (!Array.isArray(state.history)) state.history = [];
  const byWeek = {};
  outsideDays.forEach(d => {
    const dt = new Date(d.date + 'T00:00:00');
    if (isNaN(dt)) return;
    const wkMonday = formatDate(getThisMonday(dt));
    if (!byWeek[wkMonday]) byWeek[wkMonday] = [];
    byWeek[wkMonday].push(d);
  });
  const archivedAt = new Date().toLocaleString('ko-KR') + ' (복원)';
  Object.keys(byWeek).sort().forEach(ws => {
    const existing = state.history.find(h => h && h.weekStart === ws);
    if (existing) {
      if (!Array.isArray(existing.days)) existing.days = [];
      byWeek[ws].forEach(d => {
        const hit = existing.days.findIndex(e => e && e.date === d.date);
        if (hit >= 0) existing.days[hit] = d;
        else existing.days.push(d);
      });
      existing.days.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    } else {
      state.history.push({
        archivedAt: archivedAt,
        weekStart: ws,
        goals: { week: '', month: '' },
        days: byWeek[ws].slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''))
      });
    }
  });
  state.history.sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || ''));
}

function mergeImportedHistory(importedHistory) {
  if (!Array.isArray(importedHistory) || importedHistory.length === 0) return;
  if (!Array.isArray(state.history)) state.history = [];
  importedHistory.forEach(h => {
    if (!h || !h.weekStart) return;
    const hit = state.history.findIndex(e => e && e.weekStart === h.weekStart);
    if (hit >= 0) state.history[hit] = h;
    else state.history.push(h);
  });
  state.history.sort((a, b) => (a.weekStart || '').localeCompare(b.weekStart || ''));
}

/* ── 헤더 접기/펼치기 (위젯별 개별 기억) ── */
function headerOpenKey() {
  // 파일명 기반 개별 키. daily.html, board.html, history.html 각자 기억.
  const p = (location.pathname || '').split('/').pop() || 'index';
  const name = p.replace(/\.html?$/i, '') || 'index';
  return 'worklog.headerOpen.' + name;
}
function applyHeaderState(open) {
  const header = document.querySelector('.app-header');
  const btn = document.getElementById('headerToggleBtn');
  if (!header) return;
  if (open) {
    header.classList.remove('collapsed');
    if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('title', '헤더 접기'); }
  } else {
    header.classList.add('collapsed');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('title', '헤더 펼치기'); }
  }
}
function toggleHeader() {
  const key = headerOpenKey();
  const cur = localStorage.getItem(key) === '1';
  const next = !cur;
  try { localStorage.setItem(key, next ? '1' : '0'); } catch (e) {}
  applyHeaderState(next);
}
function initHeaderCollapse() {
  // 기본은 접힘. 이전에 펼쳐뒀으면 펼친 상태 유지.
  const saved = localStorage.getItem(headerOpenKey());
  const open = saved === '1';
  applyHeaderState(open);
}

/* ── 모달 backdrop/키보드 기본 핸들러 연결 (페이지 공통) ── */
function initModalBase() {
  const modalBd = document.getElementById('modalBackdrop');
  if (modalBd) modalBd.addEventListener('click', function(e) { if (e.target === this) hideModal(); });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      const bd = document.getElementById('modalBackdrop');
      if (bd && !bd.classList.contains('hidden')) { hideModal(); return; }
    }
  });
}

// onclick 속성에서 쓰이므로 window에도 노출
window.toggleTheme = toggleTheme;
window.toggleDevice = toggleDevice;
window.exportJson = exportJson;
window.importJson = importJson;
window.showModal = showModal;

// 백업 신선도 체크 — 마지막 백업이 7일 초과거나 한 번도 없으면 stale
function getBackupStaleness() {
  const ts = state && state.lastExportAt;
  if (!ts) return { stale: true, days: null, never: true };
  const days = Math.floor((Date.now() - ts) / 86400000);
  return { stale: days >= 7, days, never: false };
}

function renderBackupReminder(targetId) {
  const el = document.getElementById(targetId || 'backupReminder');
  if (!el) return;
  const s = getBackupStaleness();
  if (!s.stale) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = s.never ? '⚠ 아직 JSON 백업 기록이 없어요' : `⚠ 마지막 백업 ${s.days}일 전`;
  el.title = '헤더의 "백업" 버튼으로 지금 JSON을 내려받으세요.';
}

window.getBackupStaleness = getBackupStaleness;
window.renderBackupReminder = renderBackupReminder;
window.refreshBackupReminder = function() { renderBackupReminder('backupReminder'); };
window.showChoiceModal = showChoiceModal;
window.hideModal = hideModal;
window.confirmModal = confirmModal;
window.toggleHeader = toggleHeader;
window.initHeaderCollapse = initHeaderCollapse;
window.applyRemoteState = applyRemoteState;
