# 업무일지 위젯 로드맵

> 목표: 노션 임베드 환경에서 스크롤 피로 없이 매일 쓰기 편한 업무일지 + 중요/상시 업무 보드 + 주간/월간 회고 뷰를 완성한다.

---

## 배경 & 결정사항

### 문제
- 기존 단일 `index.html`을 노션에 임베드하면 **가로·세로 스크롤이 중첩**되어 피로도 큼
- 임베드 높이 제약으로 정보 밀도 낮음

### 해결 방향: 3-파일 위젯 구조 + 단일 데이터 (확정)

> **변경**: 기존 해시 라우팅(`#daily`/`#board`/`#history`) 방식에서 **3개 별도 HTML 파일**로 변경.
> 로드 속도·코드 분리·Notion URL 직관성 이점.

```
/WorkLog/
├── daily.html      ← 위젯 1: 오늘 카드 (현재 index.html 리네임)
├── board.html      ← 위젯 2: 중요·상시 보드 (신규)
├── history.html    ← 위젯 3: 주간/월간 히스토리 (신규)
├── shared.js       ← 공용 로직 (state, saveState, 싱크, 스키마)
├── shared.css      ← 공용 스타일 (CSS 변수, 다크모드, 공용 컴포넌트)
└── index.html      ← daily.html로 리다이렉트
```

| # | 위젯 | URL (GitHub Pages) | 역할 | UI |
|---|---|---|---|---|
| 1 | 오늘 카드 | `/daily.html` | 매일 기록·편집 | 카드 1장 + 요일탭 + ◀▶ |
| 2 | 중요·상시 보드 | `/board.html` | 장기 업무 트래킹 | 카드 그리드 |
| 3 | 주간/월간 히스토리 | `/history.html` | 돌아보기·분석 | 테이블 + 시각화 |

### 데이터 동기화
- **GitHub Pages 단일 origin** → 3개 HTML 모두 같은 `localStorage` 자동 공유
- 실시간 싱크 3단 구조:
  1. `localStorage` 저장
  2. `storage` 이벤트 (다른 탭/창 자동 감지)
  3. `BroadcastChannel('worklog-sync')` (같은 페이지 내 iframe 간 즉시)
- 최후 폴백: `setInterval` 기반 lastModified 체크 (Notion sandbox 대응)
- 기기 간 싱크는 Phase 4(Notion API)에서 고려

### 파일별 역할 분담

| 파일 | 읽기 | 쓰기 |
|---|---|---|
| daily.html | `days`, `importantTasks`(참조) | `days`, `goals`, `retro` |
| board.html | `importantTasks`, `routines`, `days`(완료율 참조) | `importantTasks`, `routines` |
| history.html | `history`, `days`(현재주) | 읽기 전용 (주간 요약 생성 버튼만) |

---

## Phase 1: 오늘 카드 실전화 ✅ 거의 완료

- [x] 프로토타입 → `index.html` 통합
- [x] localStorage 스키마 확장 (`retro`, `history`, `adjustHours` 등)
- [x] **빠른 입력 모드** — Enter/Tab/Shift+Tab/Esc
- [x] **자동 시간 채움** — 진행중 전환 시 시작 시각 자동
- [x] **오늘 자동 포커스**
- [x] **진행률 색 규칙** — <50% 회색 / 50~100% 초록 / 100~150% 파랑 / 150%+ 빨강
- [x] **오늘의 한 줄** (retro)
- [ ] **모바일 축약 뷰** — `@media (max-width: 768px)` 업무명+완료 2컬럼 ← **유일 미완**

**추가로 완료된 항목 (비공식)**:
- [x] 주간/히스토리 탭 제거 → 단일 오늘 카드 구조
- [x] `autoRolloverWeek()` — 월요일 바뀌면 이전 주 자동 history 아카이브
- [x] JSON 백업/복원 버튼 헤더 이동
- [x] `importJson` 날짜 범위 라우팅 (현재 주 → days, 외부 → history)
- [x] Google Apps Script 시트→JSON 변환기 (커스텀 메뉴 🚀 마인드셋_효율화)

---

## Phase R: 3-파일 분리 리팩터링 (현재 진행 예정)

### Phase R1 — 공용 파일 분리 + daily.html 셋업
- [ ] `index.html`에서 공용 로직 추출 → `shared.js` 생성
  - `createInitialState`, `loadState`, `saveState`, `formatDate`, `getThisMonday`, `createWeekDays`, `calcHours`, `calcTaskHours`, `autoRolloverWeek`, `importJson`, `exportJson`, `applyTheme`, `toggleTheme`, 스키마 상수, `DEFAULT_PROJECTS` 등
- [ ] 공용 CSS 추출 → `shared.css` 생성 (CSS 변수, 다크모드, 버튼, 칩, 모달)
- [ ] `index.html` → `daily.html` 리네임, shared.js/shared.css 참조
- [ ] `index.html` 신규 생성: `daily.html`로 리다이렉트
- [ ] `saveState()`에 `BroadcastChannel` 방송 추가, `storage` 이벤트 리스너 추가
- [ ] 모바일 축약 뷰(Phase 1 미완) 같이 처리
- [ ] 로컬 동작 확인

**완료 조건**: `daily.html`이 기존 `index.html`과 동일하게 동작 + 싱크 준비 완료.

### Phase R2 — board.html 신규
- [ ] 중요 업무 카드 그리드 UI (`state.importantTasks`, `state.routines`)
- [ ] 카드 CRUD + 우선순위/누적시간 표시
- [ ] **중요 업무 → 오늘 카드 드롭** — BroadcastChannel로 daily.html에 메시지
- [ ] **자동 링크** — 업무명 매칭 시 중요 업무 태그 자동 부착 + 누적 시간 집계
- [ ] **미완 업무 이월** — 우클릭 "다음 영업일로 이월" (금→월 자동)
- [ ] **자동 백업 알림** — 마지막 export 7일 초과 시 상단 뱃지

### Phase R3 — history.html 신규
- [ ] 주간 테이블 (요일별 업무 목록, 완료율)
- [ ] `state.history` 기반 과거 주 탐색
- [ ] **주간 자동 요약** — 금요일 18시 이후 자동 생성 (또는 수동 버튼)
- [ ] **24시간 타임라인 바** — SVG, 업무별 색상 블록
- [ ] **월간 히트맵** — GitHub 잔디 스타일, hover 시 그날 요약
- [ ] **프로젝트 도넛** — SVG circle, 주/월 토글

### Phase R4 — GitHub Pages 배포
- [ ] 기존 리포에 파일 푸시
- [ ] Pages 설정 확인
- [ ] Notion 임베드 URL 3개 테스트 (싱크 동작 실제 검증)

**완료 조건**: 노션에 임베드 3개 꽂으면 완전 동작.

---

## Phase 4: 노션 API 연동 (선택)

- [ ] **노션 페이지 제목 자동 변경** — GitHub Actions cron + Notion API
- [ ] **노션 DB 역방향 싱크** — 중요·상시 업무 읽기 전용 동기화

---

## 사전 준비 ✅

1. ~~**호스팅 결정**~~ → GitHub Pages 확정 (리포 이미 존재)
2. ~~**현재 데이터 백업**~~ → `worklog-backup-2026.json` 보존됨
3. ~~**스키마 동결**~~ → Phase 1 스키마 확정됨

---

## 작업 원칙 (CLAUDE.md 발췌)

- Vanilla HTML/CSS/JS만 (외부 라이브러리 금지)
- CSS 변수 + 다크모드 대비 구조 유지
- `const`/`let`만, `var` 금지
- 변경 후 `saveState()` 호출로 저장 통일 (→ BroadcastChannel 방송 포함)
- 수정 시에도 **전체 파일 기준**으로 응답
- 한 세션에 너무 많이 박지 말고, Phase 완료마다 며칠 실사용 후 피드백 반영

---

## 참고 파일

- `index.html` — 현재 단일 파일 (R1에서 `daily.html`로 리네임 예정)
- `prototype-daily-card.html` — Phase 1 "오늘 카드" UI 확정 프로토타입
- `CLAUDE.md/CLAUDE.md.txt` — 프로젝트 규칙
- `worklog-backup-2026.json` — 현재 데이터 스냅샷
- (신규) `shared.js`, `shared.css`, `board.html`, `history.html` — R1~R3에서 생성
