# 260706 — GUI Dashboard / Usage 페이지 디자인 폴리시

- **Status:** Plan
  **Implemented:** 2026-07-06
- **Date:** 2026-07-06
- **Work class:** C2 (single-surface CSS/markup polish, `gui/src/` only)
- **Owner:** boss (design direction), agent (implementation)

## Goal

Dashboard와 Usage 페이지의 타이포그래피 밸런스, 반응형 가독성, 차트 데이터 표현을
개선한다. 기능 변경 없이 CSS/markup 폴리시만 수행.

## 이슈 목록 (브라우저 코멘트 기반)

### Issue 1 — Dashboard stat-row 글자 크기 밸런스 깨짐

**위치:** Dashboard 페이지, `.stat-row` (STATUS / VERSION / UPTIME / PROVIDERS / TOKENS)

**현상:**
- `.stat .value`는 `font-size: 24px; font-weight: 700`
- `.stat .value.mono`는 `font-size: 19px` (VERSION, UPTIME 등)
- `.stat .label`은 `font-size: 11px; text-transform: uppercase`
- TOKENS (30D) 카드는 `formatTokens()`로 `8008.95M` 같은 값 표시 + 아래에
  `fontSize: 12` 서브텍스트 (`96% coverage`)

**문제:**
- 24px value vs 11px label의 비율이 과하다. 라벨이 너무 작고 값이 너무 크다.
- 4개 stat이 동일 높이인데 TOKENS 카드만 서브텍스트가 있어 시각적 무게가 다르다.
- `text-transform: uppercase` + `letter-spacing: 0.05em` 조합이
  좁은 카드에서 라벨을 과도하게 축소시킨다.
- Dashboard의 stat-row는 `grid-template-columns: repeat(4, 1fr)`인데,
  실제 카드는 5개 (STATUS, VERSION, UPTIME, PROVIDERS, TOKENS)이므로
  TOKENS 카드가 두 번째 줄로 떨어진다. 그 자체는 의도된 동작이지만
  첫 줄 4개 카드의 value 크기가 제한된 너비에서 과하게 느껴진다.

**소스:**
- `gui/src/pages/Dashboard.tsx:164-181` — stat-row markup
- `gui/src/styles.css:209-215` — `.stat-row`, `.stat`, `.stat .value`
- `gui/src/styles.css:449` — 모바일 breakpoint `repeat(2, ...)`

**방향:**
- value 폰트 크기를 20-22px로 줄이고, label을 12px로 올린다.
- uppercase letter-spacing를 제거하거나 줄인다.
- stat-row를 5칸 그리드로 변경하거나, TOKENS 카드 배치를 재검토한다.

---

### Issue 2 — Usage 페이지 usage-cards 디자인 밸런스

**위치:** Usage 페이지, `.usage-cards` (Requests / Measured / Total tokens / Cached tokens / Coverage / Active days)

**현상:**
- `.usage-cards`는 `grid-template-columns: repeat(5, minmax(0, 1fr))`
- `.stat-value`는 `font-size: 22px; font-weight: 600`
- 라벨은 `.muted` 클래스 (일반 body 크기)
- 6개 카드이므로 첫 줄 5개 + 두 번째 줄 Active days 1개가 왼쪽에 혼자 남는다.

**문제:**
- 첫 줄 5칸에 6개 데이터를 넣다 보니 Active days가 고아 카드가 된다.
- 카드 간 시각적 위계가 없다 — Requests와 Coverage가 동일한 크기/무게.
- Total tokens 값 (`8.01B`)과 Cached tokens (`4.73B`)는 가장 중요한 메트릭인데
  나머지와 동일 취급된다.

**소스:**
- `gui/src/pages/Usage.tsx:183-190` — usage-cards markup
- `gui/src/styles.css:459-460` — `.usage-cards`, `.stat-value`

**방향:**
- 6개 카드를 3x2 또는 2x3 그리드로 재배치하여 고아 카드를 제거한다.
- Total tokens, Coverage 등 핵심 메트릭을 시각적으로 강조한다.

---

### Issue 3 — Daily activity 히트맵 좁은 화면에서 글씨 축소

**위치:** Usage 페이지, `.heatmap` section (30d/all 범위)

**현상:**
- 히트맵은 52주 x 7일 그리드를 `overflow-x: auto`로 스크롤 처리
- 월 라벨 `.heatmap-month`는 `font-size: 11px`
- 요일 라벨 `.heatmap-days`는 `font-size: 10px`, `width: 25px`
- 셀은 `aspect-ratio: 1`로 정사각형 유지

**문제:**
- 좁은 뷰포트(~850px 이하)에서 히트맵 셀이 극도로 작아지면서
  월/요일 라벨도 함께 축소되어 읽기 어렵다.
- `min-width`가 셀에 없어서 뷰포트가 좁아지면 셀이 1-2px까지 줄어든다.
- 스크롤 가능하긴 하지만 사용자가 스크롤 가능 여부를 인지하기 어렵다.

**소스:**
- `gui/src/pages/Usage.tsx:198-232` — heatmap markup
- `gui/src/styles.css:468-483` — `.heatmap-*`

**방향:**
- `.heatmap-cell`에 `min-width: 8px` (또는 10px) 추가.
- 히트맵 컨테이너에 `min-width` 하한을 설정하여 일정 크기 이하로는
  스크롤로 전환되도록 강제한다.
- 좁은 화면에서는 최근 26주만 표시하는 반응형 전략도 고려할 수 있다.

---

### Issue 4 — Daily activity 7d 바 차트, 토큰 기준으로 변경

**위치:** Usage 페이지, `.daybars` section (7d 범위)

**현상:**
- 7d 뷰에서 바 차트의 높이가 `d.requests / max` (요청 수) 기준
- 바 아래 표시되는 숫자도 `d.requests` (요청 수)
- 각 바의 세그먼트 분할도 `m.requests` 기준

**요청:**
- 요청 수 대신 **토큰 수** 기준으로 바 높이와 라벨을 변경.

**소스:**
- `gui/src/pages/Usage.tsx:199-229` — 7d daybar 렌더링 로직
  - `max = Math.max(1, ...weekBars.map(x => x.requests))` -> `x.totalTokens`
  - `pct = Math.round((d.requests / max) * 100)` -> `d.totalTokens / max`
  - `<span className="daybar-count">{d.requests}</span>` -> `formatTokens(d.totalTokens)`
  - 세그먼트 `flexGrow: m.requests` -> `m.totalTokens`
  - 툴팁의 `m.requests` -> `formatTokens(m.totalTokens)`

**방향:**
- `weekBars`의 높이/라벨/세그먼트 계산을 `requests` -> `totalTokens`로 전환.
- 기존 `formatTokens()` 또는 `formatTotalTokens()` 활용.
- 모델별 세그먼트에서 `totalTokens`가 0인 경우 대비 처리 필요.

---

## 영향 범위

| 파일 | 변경 유형 |
|------|-----------|
| `gui/src/styles.css` | CSS 토큰 조정 (font-size, grid-template-columns, min-width) |
| `gui/src/pages/Dashboard.tsx` | stat-row 마크업 미세 조정 가능 |
| `gui/src/pages/Usage.tsx` | daybar 데이터 소스 `requests` -> `totalTokens` 전환 |

## 리스크

- C2 수준. CSS/마크업 전용 변경이라 기능 회귀 위험 낮음.
- Issue 4 (토큰 기준 전환)는 `UsageDayModel` 타입에 `totalTokens` 필드가
  이미 존재하는지 확인 필요 — 존재함 (`UsageDayModel.totalTokens`).
- 반응형 breakpoint 변경 시 기존 모바일 레이아웃 영향 가능. 변경 후 850px 이하
  뷰포트에서 교차 확인 필요.

## Next Steps

1. Issue 4 (기능 변경) 먼저 구현 — `Usage.tsx` daybar 로직 수정.
2. Issue 1, 2 (타이포 밸런스) CSS 조정.
3. Issue 3 (히트맵 min-width) CSS 추가.
4. 브라우저에서 Dashboard / Usage 양쪽 스크린샷으로 시각 검증.
