# Foundations

## Color

색상 토큰은 역할을 나타낸다. 컴포넌트에서 hex 값을 직접 사용하지 않는다.

| 역할 | 토큰 | 라이트 | 다크 |
|---|---|---:|---:|
| 앱 배경 | `--bg` | `#ffffff` | `#212121` |
| 사이드바 | `--rail` | `#f9f9f9` | `#171717` |
| 기본 표면 | `--surface` | `#ffffff` | `#262626` |
| 올라온 표면 | `--raised` | `#f4f4f4` | `#303030` |
| 기본 텍스트 | `--text` | `#0d0d0d` | `#ececec` |
| 보조 텍스트 | `--muted` | `#6e6e6e` | `#a6a6a6` |
| 약한 텍스트 | `--faint` | `#707070` | `#9a9a9a` |
| 성공/활성 | `--green` | `#0a7d5c` | `#4ecb9d` |
| 경고 | `--amber` | `#9a4a08` | `#fbbf24` |
| 위험 | `--red` | `#b91c1c` | `#f87171` |

`--accent`는 기본 액션과 포커스에 사용한다. 활성 토글은 다크 모드에서 트랙과 핸들이
겹쳐 보이지 않도록 `--toggle-on-bg`와 `--toggle-dot-color`를 사용한다.

### v2 색 역할 (`src/design/theme.css`)

v2는 위 v1 토큰을 `src/design/bridge.css`에서 아래 `--ocx-*` 토큰으로 다시 연결한다.

| 역할 | 토큰 | Tailwind | 라이트 | 다크 |
|---|---|---|---:|---:|
| 메인(기본 버튼, 선택 상태, 켜진 토글) | `--ocx-accent` | `bg-accent` | `#18181b` | `#fafafa` |
| 메인 위 글자 | `--ocx-on-accent` | `text-on-accent` | `#ffffff` | `#09090b` |
| 하이라이트(포커스 링, 링크) | `--ocx-highlight` | `text-highlight` | `#0369a1` | `#38bdf8` |
| 하이라이트 바탕 | `--ocx-highlight-soft` | `bg-highlight-soft` | sky 12% | sky 16% |

메인은 화면의 반전색이다. 다크에서는 흰색, 라이트에서는 흰 배경에 묻히지 않게 거의 검정이다.
파랑을 메인으로 쓰지 않는다. 링크와 키보드 포커스만 스카이블루로 칠한다. 선택된 메뉴, 호버는
흰색 계열로 처리하고, 호버에 색 번짐(glow)을 넣지 않는다.

## Typography

### Font families

- `--font-ui`: 일반 UI, 제목, 본문, 버튼, 입력. 제품 서체를 우선하고, 그 뒤에는 시스템 UI 폰트를 영문도 지원하는 한글 fallback보다 먼저 선언한다. 그래야 한글 fallback이 시스템 UI 폰트의 영문·숫자 글리프까지 대신 표시하지 않는다. 한글은 앞선 서체의 지원 여부에 따라 시스템의 언어별 fallback 또는 뒤에 선언된 한글 글꼴로 표시한다. 중문·일문은 `:root:lang(...)` 규칙으로 해당 언어의 시스템 글꼴을 우선한다.
- `--font-code`: 모델 ID, URL, 버전, 토큰 수, 로그, 코드. 숫자는 tabular 형태로 정렬한다.

외부 CDN 폰트를 사용하지 않는다. 프록시 관리 화면은 오프라인에서도 열려야 하고, 폰트
다운로드 실패가 레이아웃 이동이나 한글 누락으로 이어지면 안 되기 때문이다.

### Type scale

| 역할 | 클래스 | 토큰 | 크기 | 대표 용도 |
|---|---|---|---:|---|
| Micro | `.text-micro` | `--text-micro` | 10px | 매우 작은 상태 배지 |
| Caption | `.text-caption` | `--text-caption` | 11px | 메타데이터, 보조 수치 |
| Label | `.text-label` | `--text-label` | 12px | 필드 라벨, 표 헤더, 코드 |
| Control | `.text-control` | `--text-control` | 13px | 버튼, 메뉴, 필터, 알림 |
| Body | `.text-body` | `--text-body` | 14px | 본문, 카드 제목 |
| Subtitle | `.text-subtitle` | `--text-subtitle` | 16px | 모달 제목, 브랜드명 |
| Title | `.text-title` | `--text-title` | 20px | 페이지 제목, 주요 수치 |
| Display | `.text-display` | `--text-display` | 24px | 제한적인 대형 수치/빈 상태 |

굵기는 `regular(400)`, `medium(500)`, `semibold(600)`, `bold(700)` 네 단계만 사용한다.
행간은 `tight(1.2)`, `ui(1.35)`, `body(1.5)`, `relaxed(1.6)` 네 단계만 사용한다.

## Spacing

기본 단위는 4px이다.

| 토큰 | 값 | 토큰 | 값 |
|---|---:|---|---:|
| `--space-0-5` | 2px | `--space-1` | 4px |
| `--space-1-5` | 6px | `--space-2` | 8px |
| `--space-3` | 12px | `--space-4` | 16px |
| `--space-5` | 20px | `--space-6` | 24px |
| `--space-8` | 32px | `--space-10` | 40px |
| `--space-12` | 48px | `--space-16` | 64px |

컴팩트 컨트롤 내부는 4–8px, 카드 내부는 12–20px, 페이지 구획은 24–64px 범위를 사용한다.

## Radius and controls

| 토큰 | 값 | 용도 |
|---|---:|---|
| `--radius-2xs` | 4px | 작은 차트 셀, 포커스 보정 |
| `--radius-xs` | 6px | 칩, 작은 아이콘 표면 |
| `--radius-sm` | 8px | 입력, 메뉴 항목, 작은 카드 |
| `--radius` | 12px | 기본 카드/패널 |
| `--radius-lg` | 16px | 모달 |
| `--radius-round` | 50% | 점, 원형 아이콘 |
| `--radius-pill` | 999px | 버튼, 토글, segmented control |

컨트롤 높이는 `28/34/40/44px` 단계다. 44px는 모바일 터치 영역에 사용한다.

### Control sizes (v2)

버튼, 입력창, 선택 상자, 세그먼트 트랙은 아래 두 높이 중 하나만 쓴다. 높이를 패딩으로 만들지
않고 토큰으로 정한 뒤 내용을 가운데 정렬한다.

| 크기 | 토큰 | 높이 | 쓰는 곳 |
|---|---|---:|---|
| md (기본) | `--ocx-control-h` (= v1 `--control-md`) | 34px | 버튼, 입력창, 선택 상자, 세그먼트 트랙, 아이콘 버튼 |
| sm | `--ocx-control-h-sm` (= v1 `--control-sm`) | 28px | 툴바·카드 머리의 작은 버튼, 작은 세그먼트 |

- **짝 맞춤:** 같은 줄에 입력창이나 선택 상자와 함께 놓인 버튼은 md다. 작은 버튼(`.btn-sm`)도
  그 줄에서는 md로 커진다(bridge.css). 한 줄은 하나의 컨트롤처럼 읽혀야 한다.
  v2 `Button`의 `sm`도 같다: 입력·선택이 든 줄의 직계 자식에 `--ocx-row-control-h`가 들어가고
  `sm`은 그 값을 먼저 읽는다(상속되지 않는 속성이라 그 줄 바로 아래 버튼에만 적용).
- **세그먼트:** 트랙 안쪽 여백 2px + 항목 높이(컨트롤 높이 − 4px) = 컨트롤 높이 하나.
- **예외:** 텍스트 줄 안의 "?" 도움말 아이콘처럼 컨트롤이 아닌 보조 아이콘은 이 규칙 밖이다.
- **v2 코드:** `Button`의 `md`/`sm`/`icon`, `SegmentedControl`의 `md`/`sm`이 이 토큰을 쓴다.
  Tailwind로 직접 버튼을 만들 때는 `h-[var(--ocx-control-h)]`처럼 토큰을 쓴다(`h-7`, `h-8`,
  `h-9` 같은 임의 높이 금지).
- `gui/tests/control-size-rule.test.ts`가 토큰과 이 규칙이 bridge와 v2 컴포넌트에 남아 있는지
  확인한다.

## Motion

- `--motion-fast: 120ms`: hover, border, color 변화
- `--motion-normal: 180ms`: drawer, toggle, 위치 변화
- `prefers-reduced-motion: reduce`에서는 transition과 animation을 제거한다.

모션은 상태 이해를 돕는 범위에서만 사용하며 장식 목적의 반복 애니메이션은 추가하지 않는다.

### v2 둥글기 주의

v1 토큰 `--radius-xs`, `--radius-sm`, `--radius-lg`는 Tailwind의 `rounded-xs`, `rounded-sm`,
`rounded-lg`가 읽는 변수와 이름이 같다. v1 값(6px, 8px, 12px)이 이기므로 v2 컴포넌트에서는
이 세 유틸리티를 쓰지 않는다. `rounded-control`, `rounded-card`처럼 v2 이름을 쓰거나
`rounded-[8px]`처럼 값을 명시한다.

## Professional pass (v2)

도구다운 대시보드(Linear, Vercel, Stripe 계열)를 기준으로 한다. 꾸밈이 아니라 정보가 먼저 보여야 한다.
`gui/tests/professional-rules.test.ts`가 아래 규칙을 지킨다.

### 캔버스와 표면

- 페이지 바탕은 단색 `--ocx-bg` 하나다. 배경 그라데이션, 흐린 색 덩어리, 유리(backdrop-filter) 금지.
- 사이드바는 단색 레일(`--rail`)과 오른쪽 1px 경계선.
- 카드와 패널은 1px 경계선(`--ocx-line`)으로 구분한다. 그림자는 떠 있는 것(메뉴, 대화상자)에만.

### Radius

| 토큰 | 값 | 쓰는 곳 |
|---|---:|---|
| `--radius-control` / `rounded-control` | 8px | 버튼, 입력, 선택 |
| `--radius-card` / `rounded-card` | 10px | 카드, 타일 |
| `--radius-panel` / `rounded-panel` | 12px | 패널, 섹션 |
| `--radius-sheet` | 16px | 대화상자 |
| `--radius-full` / `rounded-full` | 9999px | 알약, 원형 버튼·점 |

알약(999px)은 상태 배지와 스위치에만 쓴다. v1 스타일시트의 `--radius-pill`은 999px 그대로다.
`rounded-full`은 Tailwind 기본값 `calc(infinity * 1px)` 대신 유한한 9999px로 고정한다. 기본값은
2147483647px로 빌드되고, macOS WKWebView가 이 값을 각진 모서리로 그릴 수 있다(#8281).

### Type

| 단계 | 크기 | 쓰는 곳 |
|---|---:|---|
| title (`text-title`) | 20px / 600 | 페이지 제목 |
| stat (`text-stat`) | 22px / 600 | 지표 숫자 |
| section | 14px / 600 | 섹션·카드 제목 |
| body | 13px / 400–500 | 본문, 컨트롤, 사이드바 |
| meta | 12px | 보조 설명, 단위 |

숫자는 UI 글꼴의 고정폭 숫자(`tabular-nums`)로 쓴다. 고정폭(mono) 글꼴은 id, 명령, 경로 같은
기계 텍스트에만 쓴다.

### Motion and decoration

- 상태 점은 깜빡이지 않는다(`animate-ping`/`animate-pulse` 금지). 움직임은 상태가 바뀔 때만
  (전환, 진행 중 스피너).
- 버튼은 단색 채움이다. 그라데이션·광택·번짐 없음.
- 기능적인 그라데이션(로딩 스켈레톤, 단색 사각형으로 그린 아이콘)은 예외다.

### 색

색은 상태(정상·경고·오류)에만 쓴다. 진행률, 선택, 강조는 흑백 단계(`--ocx-accent` 반전색)로 한다.
링크와 키보드 포커스만 스카이블루.

### Sidebar

- 메뉴 행 32px, 13px medium, 아이콘 16px. 텍스트는 `--ocx-fg-muted`, 아이콘은 `--ocx-fg-subtle`.
- 호버와 현재 페이지는 은은한 톤 단계 하나. 떠 있는 판, 링, 그림자 없음.
- 분류 제목은 11.5px, 문장형(대문자 변환 없음).
- 아래쪽은 1px 경계선 아래 같은 32px 행: 프록시 상태 행(정지된 점 + 이름 + 켜진 시간 + 레버),
  언어 + 테마, GitHub + 버전.
- 프록시 행의 동작은 3단 슬롯 레버 하나(`proxy-lever.tsx`)다. 가운데 홈까지 당겼다 놓으면 Codex 모델
  목록 새로고침, 끝까지 당기면 프록시 정지(확인 창은 그대로, 취소하면 다시 올라감). 조금만 당기고 놓으면
  제자리로 돌아간다. 클릭·Enter·↓는 안전한 가운데(새로고침), End는 정지. 마우스를 올리면 상태 줄이
  "당겨서 새로고침·정지"가 되고, 당기는 동안에는 "놓으면 모델 새로고침"/"놓으면 프록시 정지"(빨강)로
  놓았을 때 일어날 일을 글자로 말한다. 손잡이도 같은 색이 되고, 새로고침이 끝나면 잠깐 초록. 움직임은
  상태가 바뀔 때만 있다(장식 아님).
- 예외: 새로고침(놓기 직전 문구와 실제 진행 중 상태 글자)은 눈에 띄도록 스카이블루에 빛이 지나가는
  글자(`.ocx-shine`, bridge.css)를 쓴다. 이 한 곳만 하이라이트 색을 상태 표시에 쓰고, 동작 줄이기
  설정에서는 빛 없이 스카이블루 글자만 남는다.
- 레버를 잡고 있는 동안의 움직임: 가운데 칸에서는 하늘색 빛 띠가 계속 줄을 훑고 점도 하늘색이
  된다(`.ocx-sweep-loop`). 정지 칸까지 당기면 프록시 불빛이 전기가 끊기기 직전처럼 빨갛게
  깜빡이고(`.ocx-flicker`), 줄이 살짝 어두워지며(`.ocx-dim`) 줄과 레버가 덜덜 떤다(`.ocx-tremble`).
  놓기 전에 손끝에서 결과를 느끼게 하려는 것이다. 줄 아래 레일 같은 장식 선은 쓰지 않는다.
- 레버 동작이 시작될 때의 움직임(bridge.css, 동작 줄이기 설정에서는 모두 꺼짐):
  - 정지는 기차가 서는 느낌: 손잡이가 무겁게 끝까지 떨어졌다 튕기고(`THROW.stop`), 줄이 앞으로
    쏠렸다 뒤로 흔들리고(`.ocx-halt`), "중지 중…"이 미끄러져 들어와 멈추고(`.ocx-brake`), 불빛이
    몇 번 깜빡이다 꺼져 빈 동그라미가 된다(`.ocx-lightout`).
  - 새로고침은 충전 느낌: 하늘색 빛 띠가 줄을 한 번 훑고(`.ocx-sweep`), 레버 홈이 하늘색으로
    차오르고(`.ocx-charge`), 손잡이가 가운데 홈에 튕기듯 들어가 하늘색 테두리를 두른다.
- 아래쪽 세 줄은 한 격자다: 높이 32px, 왼쪽 16px 아이콘 칸(상태 점도 이 칸 가운데), 글자는 그 뒤 9px,
  오른쪽 동작은 28px 칸으로 오른쪽 10px 안쪽에 끝난다. 줄 사이 여백은 따로 두지 않는다.

### 레이아웃

본문 열은 최대 1120px, 좌우 40px 여백. 페이지 머리는 제목(20px) + 한 줄 설명 + 오른쪽 동작.
