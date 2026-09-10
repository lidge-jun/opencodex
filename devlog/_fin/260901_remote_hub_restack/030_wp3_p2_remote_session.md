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

## 이 단계가 소유하는 블로커 — 감사로 재배정됨

### gui/tests/api-auth-memory.test.ts:23

`#2777`(p3)에 보고됐지만 실측 결과 이 파일을 처음 건드리는 단계는 **p2**다
(p3은 0건). 여기서 고친다. 재스택 후 실패를 재현해 어느 쪽 계약이 맞는지
판정한다 — dev가 맞으면 스택 코드를 맞추고, 스택이 의도적으로 바꾼 것이면
근거를 PR 설명에 적고 테스트를 함께 갱신한다. 테스트만 지우는 해소는 금지.

### T20 (P1) — pairing 바디 무제한 버퍼링

`src/server/index.ts:1684`. 미인증 호출자가 `Content-Length`를 생략하거나
chunked를 쓰면 `declaredLength`가 0이 되어 바디가 제한 없이 버퍼링된다.
미인증 DoS다. 선언 길이가 없을 때도 하드 캡을 적용하고 초과 시 거절한다.

### T21 (P2) — 설정 문서화

`hub.managementPublicOrigin`, `remoteGui.allowedTailscaleUsers`,
`remoteGui.allowInsecure*`가 사용자 노출 설정인데 문서가 없다.
D1이 `allowInsecure*`의 의미를 바꾸므로 문서도 새 계약으로 쓴다.

## draft 해제

`#2776`은 draft이고 base가 `codex/remote-hub-p1`이다. 이 base는 정당하다 —
`AGENTS.md:278-281`과 `enforce-pr-target.yml:533-557`이 열린 부모 head를
타깃하는 자식의 wrong-base 게이트를 면제한다. 재스택 + CI 그린 후 draft를
해제한다. 다만 draft 해제는 자동화 게이트만 여는 것이고 리뷰어의
CHANGES_REQUESTED는 그대로다(감사 A3).

## 검증

- `git range-diff` 6커밋 보존.
- `bun test tests/server-auth.test.ts tests/config.test.ts tests/cli-registry.test.ts tests/release-version-line.test.ts`
- `cd gui && bun test tests/connect-pairing.test.ts tests/api-auth-memory.test.ts`.
- **이 단계 head가 초록이어야 p3을 그 위에 쌓는다.**
- exact-head CI.
