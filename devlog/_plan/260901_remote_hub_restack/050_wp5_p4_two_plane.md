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

## draft 해제

wp3와 동일 근거. 재스택 + CI 그린 후 해제.

## 검증

- `git range-diff` 8커밋 보존.
- `bun test tests/usage-summary.test.ts tests/cli-start-journal-order.test.ts`
- i18n 9개 로케일 키 존재 확인.
- exact-head CI.
