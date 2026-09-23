# Components

## App shell and navigation

- 데스크톱은 232px sidebar와 main content의 2열 구조다.
- 760px 이하에서는 sidebar가 off-canvas drawer로 전환된다.
- `.nav-item`은 아이콘 17px, control text, 4px 세로 간격을 사용한다.
- hover와 active는 같은 surface family를 쓰되 active는 semibold로 구분한다.
- 메뉴마다 margin을 직접 추가하지 않고 `.sidebar nav`의 `gap`을 사용한다.

## Buttons

| 변형 | 클래스 | 용도 |
|---|---|---|
| Primary | `.btn.btn-primary` | 저장, 로그인, 확정 |
| Ghost | `.btn.btn-ghost` | 보조 액션, 취소 |
| Danger | `.btn.btn-danger` | 삭제, 중단 |
| Small | `.btn.btn-sm` | 필터, 행 내부 액션 |
| Icon | `.btn-icon` | 닫기, 도움말, 제거 |

버튼은 기본적으로 control text와 medium weight를 사용한다. 액션 중요도는 크기가 아니라
색상 변형으로 표현한다. 아이콘 전용 버튼에는 반드시 접근 가능한 label/title을 제공한다.

## Inputs and selects

- `.input`, `.select-trigger`, `.select-option`, `.field-label`을 재사용한다.
- 라벨은 label text, 입력값은 control text를 사용한다.
- placeholder는 `--faint`, 값은 `--text`, 오류는 `--red`를 사용한다.
- focus는 border와 `--accent-soft` ring을 함께 사용한다.
- 네이티브 select를 새로 만들기보다 `ui.tsx`의 `Select`를 우선한다.

## Cards and panels

- `.card`: 경계와 배경만 제공한다. 내부 padding은 문맥이 소유한다.
- `.panel`: 기본 18px padding이 포함된 독립 구획이다.
- `.panel-accent`: 선택되거나 강조된 구획이다.
- 카드 중첩은 최대 한 단계로 제한한다. 정보를 나누기 위해 무조건 카드부터 추가하지 않는다.

## Tables and rows

- `.tbl`/`.tbl-wrap`은 데이터 표의 기본 조합이다.
- 본문은 control text, 헤더는 label text + medium weight다.
- 숫자 열은 `.num` 또는 `.mono`로 tabular 숫자를 사용한다.
- 작은 화면에서는 열을 억지로 접지 않고 `.tbl-wrap`에서 가로 스크롤한다.

## Badges and status

- `.badge-green`: 성공, 연결됨, 활성
- `.badge-amber`: 경고, 다음 적용, 주의 필요
- `.badge-muted`: 중립 메타데이터
- `.notice-ok/.notice-err/.notice-warn`: 한 줄 이상의 상태 메시지

배지는 핵심 본문을 대신하지 않는다. 매우 작은 `.text-micro`는 짧은 상태 문자열에만 허용한다.

## Toggle and switch

두 마크업 형태가 있지만 동일한 토큰을 사용한다.

- 버튼형: `ui.tsx`의 `Switch`, `.switch`, `.knob`
- label/input형: `.toggle`, `.slider`

켜짐은 `--toggle-on-bg`, 꺼짐은 `--toggle-off-bg`, 핸들은 `--toggle-dot-color`를 사용한다.
다크 모드 활성 상태는 녹색 트랙과 짙은 핸들로 분리한다. 화면별 토글 색상 override는 금지한다.

## Icons

- 기본 아이콘은 `icons.tsx`의 동일한 outline family를 사용한다.
- 기본 크기는 `--icon-md(16px)`, 조밀한 메타 UI는 `--icon-sm(14px)`, 상단 액션은 `--icon-lg(20px)`다.
- 아이콘만으로 의미가 불명확하면 텍스트를 함께 배치한다.
- active 아이콘은 `--text`, inactive 아이콘은 `--faint`를 사용한다.

## Responsive behavior

- 760px 이하: drawer navigation, 세로형 form row, 44px 터치 대상
- 640px 이하: dashboard stat 2열
- 데이터 표와 heatmap은 정보 손실보다 가로 스크롤을 우선한다.
- 모바일에서 제목/본문 크기를 임의 축소하지 않는다. 같은 역할은 같은 type token을 유지한다.

## Provider workspace

- 넓은 화면의 workspace는 일반 페이지의 읽기 폭보다 넓게 쓸 수 있지만, rail은 240–280px 범위로 고정하고 detail은 `minmax(0, 1fr)`로 확장한다. viewport가 아니라 workspace container 폭을 기준으로 overview를 한 열로 바꾸고, rail + detail 최소 폭을 확보할 수 없으면 세로로 쌓는다.
- rail 행 문법은 `원본 브랜드 아이콘 | 두 줄 copy | 상태 trail`이다. 첫 줄에는 표시 이름과 Free/Local 예외 badge만, 둘째 줄에는 모델 수와 충돌 시에만 config id를 둔다. 이름과 메타는 한 줄 ellipsis를 사용하며 전체 값은 title과 접근 가능한 이름으로 보존한다.
- provider SVG는 catalog의 원본 색을 가진 `<img>` 경로를 유지한다. workspace 색으로 mask/recolor하지 않는다. asset이 없는 fallback 아이콘만 현재 text token을 따른다.
- Ready/설정 필요/비활성 텍스트는 그룹 heading과 option의 접근 가능한 이름이 소유한다. 상태 점은 비어 있는 `aria-hidden` 보조 표시이며 내부에 텍스트를 넣지 않는다.
- listbox 자체와 native option button을 동시에 Tab stop으로 만들지 않는다. option button이 focus를 소유하고 ArrowUp/ArrowDown/Home/End 이동은 listbox의 bubbled key event로 처리한다.
- detail tab은 `tablist`/`tab`/`tabpanel`, `aria-controls`/`aria-labelledby`, roving `tabIndex`를 연결하고 ArrowLeft/ArrowRight/Home/End로 선택과 focus를 함께 이동한다. 좁은 폭에서는 tab을 숨기거나 세로 글자로 깨지 말고 가로 스크롤한다.
- 인증 가능한 provider는 Accounts 또는 API keys를 독립 detail tab으로 노출한다. active account는 focus 가능한 상태로 유지하고 text + `aria-current`로 선택을 알린다. loading/error/empty/reauth/switching은 색만으로 표현하지 않는다.
- 계정 행, title, aria-label, 확인창, toast에는 masked email 또는 번역된 순번만 사용한다. 저장소의 opaque account id와 token 원문은 사용자 표면에 노출하지 않는다.

## 분할 필터 (Segmented filters)

- 서로 배타적인 선택지는 네이티브 `button`을 인접한 pill 형태로 묶고, 컨테이너에는 `role="group"`과 번역된 이름을 제공한다.
- 각 버튼은 선택 상태를 `aria-pressed`로 노출하며 모두 일반 Tab 순서에 남긴다. 화살표 키와 roving focus를 구현하지 않는 한 `radio`/`radiogroup` 역할을 사용하지 않는다.
- 버튼의 시각적 라벨과 별개로 번역된 `aria-label`을 명시한다. 좁은 화면에서 브랜드 텍스트를 아이콘으로 접어도 접근 가능한 이름은 유지해야 한다.
- 모바일 버튼은 최소 44px 터치 높이를 보장한다. 공간이 부족하면 선택지를 숨기지 말고 완전한 그룹 단위로 줄바꿈하거나 세로로 쌓는다.
- 여러 segmented filter가 함께 있으면 데이터 차원 순서대로 배치한다. Usage에서는 소스 그룹을 기간 그룹보다 먼저 둔다.
