# wp3 — p2(#2776) 재스택 + D1 HTTPS 업그레이드 정합

브랜치 `codex/remote-hub-p2`, head `7099760a5`, 6커밋 / 32파일, draft.
dev와 겹치는 파일 15개.

## 겹침

`src/cli/dispatch.ts`, `src/cli/help.ts`, `src/cli/registry.ts`,
`src/config.ts`, `src/server/auth-cors.ts`, `src/server/gui-static.ts`,
`src/server/index.ts`, `src/server/proxy-liveness.ts`, `src/types.ts`,
`src/types/config.ts` + 테스트 5.

CLI 레지스트리와 config 타입은 dev가 계속 확장한 곳이라 추가-추가 충돌이
예상된다. 원칙: dev의 항목을 지우지 않고 스택 항목을 병렬로 추가한다.

## D1 — 평문 HTTP credential 금지 구현

010의 D1이 이 단계에서 코드가 된다. 관련 커밋:

- `1e3f7d2b7 feat(remote-gui): add remote session issuance and pairing`
- `6c8dd333e fix(remote-gui): enforce exact bootstrap destination`
- `7099760a5 fix(remote-gui): preserve renewal and mutation origin checks`

요구: 비-loopback 평문 HTTP에서는 pairing grant도 GUI 세션도 발급되지 않는다.
opt-in 플래그로 이 금지를 뚫을 수 없어야 한다. HTTP는 "여기 HTTPS 엔드포인트가
있다"만 알려주는 credential-free 부트스트랩으로 남긴다.

테스트: 평문 HTTP 비-loopback 요청에 대해 grant 발급이 거절되는 네거티브,
그리고 loopback은 기존대로 허용되는 포지티브. `gui/tests/connect-pairing.test.ts`와
서버 쪽 remote-session 테스트에 건다.

## draft 해제

#2776은 draft이고 base가 `codex/remote-hub-p1`이다. `AGENTS.md`의 stacked child
규정상 이 base는 정당하다 — `enforce-target`은 열린 부모 head를 타깃하는 자식의
wrong-base 게이트를 건너뛴다. 재스택 + CI 그린 후 draft를 해제한다.

## 검증

- `git range-diff` 6커밋 보존.
- `bun test tests/server-auth.test.ts tests/config.test.ts tests/cli-registry.test.ts`
  + `cd gui && bun test tests/connect-pairing.test.ts`.
- exact-head CI.
