/* =========================================================================
   WorkLog board export helper for Google Apps Script
   중요 업무 / 상시 업무 추적 시트를 읽어 board 위젯용 JSON 구조를 만듭니다.
   ========================================================================= */
'use strict';

const BOARD_TRACKING_SOURCES_ = {
  important: {
    label: '중요 업무',
    nameHints: ['중요', 'important', '장기', '핵심']
  },
  routine: {
    label: '상시 업무',
    nameHints: ['상시', 'routine', '반복', '운영']
  }
};

const BOARD_HEADER_ALIASES_ = {
  project: ['프로젝트', '프로', '프로명', '프로젝트명'],
  category: ['구분', '카테고리', '분류'],
  subCategory: ['상세', '세부', '세부구분', '세부 구분', '하위구분', '하위 구분', '서브구분'],
  name: ['업무', '업무명', '할일', '할 일', '태스크', 'task'],
  status: ['상태', '진행상태', '진행 상태'],
  targetDate: ['목표날짜', '목표 날짜', '마감일', '목표일', '날짜'],
  note: ['비고', '메모', '노트', '설명']
};

function exportBoardTrackingToJSON() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const boardData = readBoardTrackingForState_(ss);
  const payload = {
    projectLabels: boardData.projectLabels,
    importantTasks: boardData.importantTasks,
    routines: boardData.routines
  };

  const json = JSON.stringify(payload, null, 2);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const fileName = `worklog-board-${today}.json`;
  const summary = `중요 ${boardData.importantTasks.length}개 · 상시 ${boardData.routines.length}개`;
  showJsonDownloadDialog_(json, fileName, '✅ 보드 JSON 변환 완료', summary);
}

function readBoardTrackingForState_(ss) {
  const spreadsheet = ss || SpreadsheetApp.getActiveSpreadsheet();
  const important = readBoardRows_(spreadsheet, 'important');
  const routine = readBoardRows_(spreadsheet, 'routine');
  const projects = uniqueList_(
    important.items.map(item => item.project)
      .concat(routine.items.map(item => item.project))
      .filter(Boolean)
  );

  return {
    projectLabels: projects,
    importantTasks: important.items,
    routines: routine.items
  };
}

function readBoardRows_(ss, kind) {
  const match = findBestBoardSheet_(ss, kind);
  if (!match) return { sheetName: '', items: [] };

  const values = match.values;
  const map = match.map;
  const items = [];

  for (let r = match.headerRow + 1; r < values.length; r++) {
    const row = values[r];
    if (!rowHasContent_(row)) continue;

    const name = getCellText_(row, map.name);
    if (!name) continue;

    const item = {
      id: uidBoard_(),
      project: getCellText_(row, map.project),
      category: getCellText_(row, map.category),
      name: name,
      status: normalizeBoardStatus_(row[map.status]),
      targetDate: parseBoardDate_(row[map.targetDate]),
      note: getCellText_(row, map.note)
    };

    if (kind === 'routine') {
      item.subCategory = getCellText_(row, map.subCategory);
    }

    items.push(item);
  }

  return {
    sheetName: match.sheet.getName(),
    items: items
  };
}

function findBestBoardSheet_(ss, kind) {
  const sheets = ss.getSheets();
  let best = null;

  sheets.forEach(sheet => {
    const values = sheet.getDataRange().getValues();
    if (!values.length) return;

    const headerInfo = findBoardHeaderInfo_(values);
    if (!headerInfo) return;

    let score = headerInfo.score;
    const sheetName = normalizeToken_(sheet.getName());

    BOARD_TRACKING_SOURCES_[kind].nameHints.forEach(hint => {
      if (sheetName.indexOf(normalizeToken_(hint)) >= 0) score += 4;
    });

    if (kind === 'routine') {
      if (headerInfo.map.subCategory != null) score += 3;
      if (sheetName.indexOf(normalizeToken_('중요')) >= 0) score -= 2;
    } else {
      if (headerInfo.map.subCategory == null) score += 1;
      if (sheetName.indexOf(normalizeToken_('상시')) >= 0) score -= 2;
    }

    if (!best || score > best.score) {
      best = {
        sheet: sheet,
        values: values,
        headerRow: headerInfo.rowIndex,
        map: headerInfo.map,
        score: score
      };
    }
  });

  return best && best.score >= 3 ? best : null;
}

function findBoardHeaderInfo_(values) {
  const maxRows = Math.min(values.length, 12);
  let best = null;

  for (let r = 0; r < maxRows; r++) {
    const row = values[r];
    const map = {};
    let score = 0;

    for (let c = 0; c < row.length; c++) {
      const key = resolveBoardHeaderKey_(row[c]);
      if (!key || map[key] != null) continue;
      map[key] = c;
      score++;
    }

    if (map.name == null) continue;
    if (!best || score > best.score) {
      best = { rowIndex: r, map: map, score: score };
    }
  }

  return best;
}

function resolveBoardHeaderKey_(value) {
  const token = normalizeToken_(value);
  if (!token) return '';

  const keys = Object.keys(BOARD_HEADER_ALIASES_);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const aliases = BOARD_HEADER_ALIASES_[key];
    for (let j = 0; j < aliases.length; j++) {
      if (token === normalizeToken_(aliases[j])) return key;
    }
  }

  return '';
}

function normalizeToken_(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()_\-\/]/g, '');
}

function getCellText_(row, index) {
  if (index == null || index < 0 || index >= row.length) return '';
  const value = row[index];
  if (value == null) return '';
  if (value instanceof Date) {
    if (value.getFullYear() >= 2020) return fmtDate_(value);
    return '';
  }
  return String(value).trim();
}

function rowHasContent_(row) {
  for (let i = 0; i < row.length; i++) {
    const value = row[i];
    if (value == null || value === '') continue;
    if (value instanceof Date) return true;
    if (String(value).trim()) return true;
  }
  return false;
}

function normalizeBoardStatus_(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '대기';

  if (['완료', 'done', 'completed', 'finish', 'finished', 'true', 'y', 'yes', '1', '☑', '✓'].indexOf(raw) >= 0) {
    return '완료';
  }
  if (['진행중', '진행 중', 'doing', 'inprogress', 'in progress', 'wip', '작업중', '작업 중'].indexOf(raw) >= 0) {
    return '진행중';
  }
  return '대기';
}

function parseBoardDate_(value) {
  if (value == null || value === '') return '';

  if (value instanceof Date) {
    if (value.getFullYear() >= 2020) return fmtDate_(value);
    return '';
  }

  const text = String(value).trim();
  if (!text) return '';
  if (/^[\-—−–]$/.test(text)) return '';

  let match = text.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (match) return `${match[1]}-${pad2_(match[2])}-${pad2_(match[3])}`;

  match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (match) {
    const year = new Date().getFullYear();
    return `${year}-${pad2_(match[1])}-${pad2_(match[2])}`;
  }

  return '';
}

function uniqueList_(items) {
  const seen = {};
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const value = String(items[i] || '').trim();
    if (!value || seen[value]) continue;
    seen[value] = true;
    out.push(value);
  }
  return out;
}

function uidBoard_() {
  return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function pad2_(value) {
  return String(value).padStart(2, '0');
}

function fmtDate_(date) {
  return `${date.getFullYear()}-${pad2_(date.getMonth() + 1)}-${pad2_(date.getDate())}`;
}

function showJsonDownloadDialog_(json, fileName, title, summary) {
  const jsonLit = JSON.stringify(json);
  const nameLit = JSON.stringify(fileName);
  const titleLit = JSON.stringify(title);
  const summaryLit = JSON.stringify(summary);

  const html = HtmlService.createHtmlOutput(`
    <div style="font-family:system-ui,sans-serif;padding:14px;line-height:1.6;font-size:13px">
      <h3 id="title" style="margin:0 0 8px"></h3>
      <div id="summary"></div>
      <hr style="margin:10px 0">
      <div id="msg" style="color:#2383e2;font-weight:600">⬇ 다운로드 시작됨…</div>
      <button id="retry" style="margin-top:8px;padding:6px 12px;cursor:pointer;display:none">다시 다운로드</button>
    </div>
    <script>
      const DATA = ${jsonLit};
      const NAME = ${nameLit};
      document.getElementById('title').textContent = ${titleLit};
      document.getElementById('summary').textContent = ${summaryLit};

      function download() {
        const blob = new Blob([DATA], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = NAME;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 500);
        document.getElementById('msg').textContent = '✅ "' + NAME + '" 다운로드 완료';
        document.getElementById('retry').style.display = 'inline-block';
      }

      document.getElementById('retry').onclick = download;
      window.addEventListener('load', () => setTimeout(download, 150));
    </script>
  `).setWidth(420).setHeight(260);

  SpreadsheetApp.getUi().showModalDialog(html, 'WorkLog Board JSON 추출');
}

/*
기존 exportWorkLogToJSON() 안에 합치려면:

const boardData = readBoardTrackingForState_();

const state = {
  version: 4.0,
  goals: { week: '', month: '' },
  projectLabels: uniqueList_(Array.from(projectSet).concat(boardData.projectLabels)),
  weekStart: weekStart,
  days: days,
  importantTasks: boardData.importantTasks,
  routines: boardData.routines,
  history: []
};
*/
