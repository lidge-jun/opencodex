# wp5 — p4(#2781) 재스택 + D3 Origin verbatim 전달

브랜치 `codex/remote-hub-p4`, head `44f9973a2`, 8커밋 / 48파일, draft.
dev와 겹치는 파일 17개 — 그중 9개가 i18n 로케일이다.

## 겹침

`src/cli/dispatch.ts`, `src/cli/index.ts`,
`src/server/management/logs-usage-routes.ts`, `src/usage/summary.ts`,
`gui/src/i18n/*.ts` 9개, `gui/src/pages/{Integrations,Storage}.tsx`,
`tests/{cli-start-journal-order,usage-summary}.test.ts`.

i18n 충돌은 기계적이다(양쪽이 서로 다른 키를 추가). 9개 로케일 전부에서 dev 키와
스택 키가 모두 살아남아야 한다. 하나라도 누락되면 로케일 패리티 게이트가 잡는다.

## D3 — Origin verbatim 전달 구현

010의 D3이 여기서 코드가 된다. 관련 커밋:

- `b826c200e feat(two-plane): add client machine and hub GUI planes`
- `c8a7b8ce9 feat(two-plane): harden relay and offline target states`

현재 구현은 `POST /opencodex-session`에만 브라우저 Origin을 전달한다.
요구: 허용된 세션 인증 mutation 전체(POST/PUT/PATCH/DELETE)에 대해 Origin을
원문 그대로 전달한다. 합성 Origin fallback을 두지 않는다 — 릴레이가 Origin을
만들어내면 허브의 CSRF 검사는 자기 자신을 검사하는 셈이 된다.

테스트: 허용 메서드마다 릴레이 후 허브가 받은 Origin이 브라우저 원문과
같음을 확인하는 케이스. Origin 부재 시 요청이 거절되는 네거티브.

## D5 — 릴레이 응답의 validator 제거

릴레이를 처음 갖는 단계가 여기이므로 D5도 여기서 구현한다. 릴레이된
세션/부트스트랩/관리 응답은 기본이 `Cache-Control: no-store`이고 ETag /
Last-Modified를 제거한다. p6에서 적대적 커버리지를 덧붙인다.

## /api/machine/* 라우트 선언 — 여기가 소유 단계다

`#2786`(p5)에 보고됐지만 실측하면 `/api/machine/` 추가 라인이 p4에 **49건**,
p5에는 0건이다. 라우트를 도입한 건 p4다(감사 A5).

`tests/cli-headless-parity.test.ts:287`은 "서버가 여는 라우트와 CLI가 선언한
표면이 일치한다"를 주장한다. 7개 라우트를 열거하고 각각 이 단계에 필요한지
판정한 뒤, 필요한 것은 명시 선언하고 불필요한 것은 제거한다. 테스트 예외를
추가해 숨기는 방향은 금지.

## 이 단계가 소유하는 스레드

### T25 (P1) — relay 트랜스포트가 동작하지 않는다

`src/client/machine-listener.ts:79`. 문서화된 `--management-transport relay`를
고르면 `connectClient`가 여전히 throw한다. 문서에 있는 옵션이 죽어 있는 것이므로
연결 경로를 새 리스너까지 잇는다.

### T26 (P1) — supervised 런타임이 disconnect 후 재시작되지 않는다

`src/client/runtime.ts:27`. systemd나 WinSW로 뜬 런타임은 `OCX_SERVICE=1` 때문에
해당 분기를 건너뛰어 재시작되지 않는다.

### T27 / T28 (P2) — GUI

`gui/src/App.tsx:222` disconnect 202 성공 시 `targets.connected` 갱신 누락.
`gui/src/App.tsx:376` pairing 완료 전 공유 페이지가 함께 마운트된다.

### T2 (P2, #2771에서) — 연결된 GUI의 인증된 models 경로

`gui/src/pages/ApiKeys.tsx:154`가 `/v1/models`를 부르는데 허브는 그 경로를
데이터플레인으로 처리한다. 인증된 경로를 제공한다.

## draft 해제

wp3와 동일 근거. 재스택 + CI 그린 후 해제.

## 검증

- `git range-diff` 8커밋 보존.
- `bun test tests/usage-summary.test.ts tests/cli-start-journal-order.test.ts tests/cli-headless-parity.test.ts tests/release-version-line.test.ts`
- i18n 9개 로케일 키 존재 확인.
- **이 단계 head가 초록이어야 p5를 그 위에 쌓는다.**
- exact-head CI.
