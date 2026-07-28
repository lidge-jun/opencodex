# 060 — 로그인 URL 블록 스타일의 소속 정리 (wp2)

040의 "남은 항목" 둘째.

## 문제

`LoginUrlBlock`은 세 표면이 공유하는 컴포넌트인데, 그 스타일은 이름도 파일도
한 표면의 소유로 남아 있다.

- 클래스: `.pwi-auth-url-wrap` / `.pwi-auth-url` / `.pwi-auth-url-actions` /
  `.pwi-auth-open-link`. `pwi`는 provider **w**orkspace **i**tem이다.
- 파일: `gui/src/styles/provider-workspace-settings.css:36-39`.
  헤더 주석이 "WP091 — provider workspace settings / auth / JSON editor"이고
  `─ ProviderAuthPanel ─` 섹션 아래 있다.

실제 소비처는 셋이다: 워크스페이스 패널, 프로바이더 추가 모달, Codex 계정 모달.
뒤 둘은 워크스페이스가 아니다. 지금은 `styles.css`가 모든 부분 스타일시트를
전역 import(`styles.css:13`)해서 동작하지만, 이름이 소속을 속이고 있어
다음 사람이 워크스페이스 CSS를 정리할 때 모달을 깨뜨릴 수 있다.

## 컨벤션 근거

이 저장소는 이미 컴포넌트/기능 단위 스타일 파일 + 그 이름을 딴 접두사를 쓴다.
`gui/src/styles/provider-catalog.css`가 `.provider-catalog*`를 소유하는 식이다.
새 규칙을 만드는 게 아니라 기존 관행을 따른다.

## 변경 1 — 신규 `gui/src/styles/login-url-block.css`

`provider-workspace-settings.css`의 네 규칙(`.pwi-auth-open-link`가 `:36`,
나머지 셋이 `:37-39`)을 옮기고 재명명한다.

| 이전 | 이후 |
|------|------|
| `.pwi-auth-url-wrap` | `.login-url-block` |
| `.pwi-auth-url` | `.login-url-block-text` |
| `.pwi-auth-url-actions` | `.login-url-block-actions` |
| `.pwi-auth-open-link` | `.login-url-block-open` |

접두사를 컴포넌트/파일 이름과 정확히 일치시킨다(A 감사 #7). 초안의 `.login-url`은
저장소 관행(`.provider-catalog*`, `.quota-*` 같은 기능 스코프 접두사)에 비해 너무
일반적이라 나중에 충돌 여지를 남긴다. 지금 붙여두면 비용이 0이다.
현재 `gui/src`의 9개 CSS 파일 어디에도 `.login*` 셀렉터가 없음을 감사가 확인했다.

속성값은 한 글자도 바꾸지 않는다. 이번 사이클은 소속 정리이지 시각 변경이
아니다. 렌더 결과가 달라지면 그건 실패다.

`.pwi-auth-open-link`는 `LoginUrlBlock` 밖에 소비처가 없다(rg로 확인).
따라서 함께 옮긴다.

## 변경 2 — `gui/src/styles.css`

`@import "./styles/login-url-block.css";`를 추가한다. 삽입 위치는
`provider-workspace-settings.css` 다음 줄 — 기존 import 블록의 인접성을 유지한다.

**import 순서는 결과에 영향이 없다(A 감사 #8).** 네 규칙은 전부 단일 클래스
선택자(명시도 0-1-0)이고, `provider-workspace-settings.css`에 `@media`도
`!important`도 없으며, 어떤 GUI 스타일시트도 같은 요소를 같은 명시도로 겨루지
않는다. 경쟁 선택자가 없으므로 소스 순서가 캐스케이드를 바꿀 수 없다.
인접 배치는 가독성 때문이지 정확성 때문이 아니다.

## 변경 3 — `gui/src/components/login-url-block.tsx`

네 개의 `className`을 새 이름으로 교체. 구조·속성 변경 없음.

## 변경 4 — 테스트 셀렉터 4파일

| 파일 | 셀렉터 |
|------|--------|
| `gui/tests/login-url-block.test.tsx:76,152` | `.pwi-auth-url-actions button`, `.pwi-auth-url-wrap` |
| `gui/tests/provider-auth-login-copy-link.test.tsx:104` | `.pwi-auth-url-actions button` |
| `gui/tests/add-codex-account-login-url.test.tsx:101` | `.pwi-auth-url-actions button` |
| `gui/tests/add-provider-oauth-url-leak.test.tsx:122,138,167` | `.pwi-auth-url` |

**셀렉터만 바꾸고 단언은 한 글자도 바꾸지 않는다.** 이것이 이 사이클의
안전 조건이다. 단언이 함께 바뀌면 "리네임이 렌더를 보존했다"는 증거가 사라진다.
커밋 diff에서 테스트 변경이 전부 셀렉터 문자열 한 줄짜리인지 눈으로 확인한다.

여기에 단언 하나를 **추가**한다(A 감사 #9). `login-url-block.test.tsx`에
렌더된 래퍼의 클래스가 `login-url-block`임을 단언한다. 리네임 자체에는 동작
변화가 없어 테스트가 없으면 "소속을 정리했다"는 주장이 검증 불가능한 신념으로
남는다. 이 한 줄이 그 주장을 집행 가능하게 만든다.

## 건드리지 않는 것

- `.pwi-device-code*`: `ProviderAuthPanel` 전용이고 다른 표면에 없다.
  이름과 소속이 일치하므로 그대로 둔다.
- `.pwi-auth-wait` / `.pwi-auth-wait-copy` / `.pwi-auth-section` 등 나머지
  `pwi-` 계열 전부. 워크스페이스 패널 전용이다.
- `tests/provider-workspace-auth.test.ts:160`의 `pwi-device-code` 단언.

즉 이 사이클은 `pwi-` 접두사를 일괄 개명하는 작업이 **아니다**. 소속이
어긋난 네 개만 옮긴다.

## 검증

- `bun run typecheck` exit 0 (루트)
- `cd gui && bun x tsc -b` exit 0, `bun run lint:gui` exit 0
- `cd gui && bun test tests` 전건 통과 — 특히 위 4파일이 셀렉터 갱신만으로 통과
- `rg "pwi-auth-url|pwi-auth-open-link" gui/` → 0건
- `rg 'className="login-url' gui/src` → 컴포넌트 4건 (파일명 매치가 섞이는
  `rg "login-url-"`은 게이트로 쓰지 않는다 — 이미 import 3건이 걸린다, A 감사 #10)
- `rg "login-url-block" gui/src/styles/login-url-block.css` → CSS 4건
- `bun run build:gui` 성공(CSS import 경로 확인)
- `bun run test` (루트) 신규 실패 0, `bun run privacy:scan` 통과

## 사이클 배치 (A 감사 #9)

감사는 060을 050의 꼬리 커밋으로 접으라고 권했다 — 동작 변화가 없는 커밋
하나만으로 별도 리뷰 라운드를 도는 건 값이 안 맞는다는 것이다. 절반만 받는다.

**커밋은 분리하되 work-phase는 050과 같은 사이클에 두지 않는다.** 리네임은
7개 파일의 셀렉터를 동시에 건드리므로, 기기 코드 복사 변경과 한 커밋에 섞이면
gui 테스트가 깨졌을 때 원인이 훅 이관인지 셀렉터 교체인지 분리할 수 없다.
별도 work-phase(wp2) + 별도 커밋으로 두되, 리뷰는 wp3의 최종 검증에서
한 번에 받는다. 감사의 "리뷰 라운드 하나" 취지는 지키고 이등분 가능성은 살린다.
