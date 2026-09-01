# wp4 — p3(#2777) 재스택 + gui api-auth-memory 경계 보존

브랜치 `codex/remote-hub-p3`, head `aa2615953`, 11커밋 / 34파일.
dev와 겹치는 파일 18개 — 이 스택에서 CLI 표면 겹침이 가장 넓다.

## 겹침

`src/cli/{claude,dispatch,help,index,registry,runtime-api,status}.ts`,
`src/config.ts`, `src/lib/service-secrets.ts`, `src/types.ts`,
`src/types/config.ts` + 테스트 7(`cli-headless-parity`,
`cli-start-journal-order`, `cli-status-json` 포함).

`cli-headless-parity`는 wp5에서도 문제를 일으키는 파일이다. 여기서 CLI 표면이
늘어나므로, p3 재스택 시점에 새 명령이 headless 선언에 들어가 있는지 확인해두면
wp5의 부담이 준다.

## gui/tests/api-auth-memory.test.ts — 여기가 아니다

`#2777`에 보고됐지만 실측 결과 이 파일을 처음 건드리는 단계는 p2다(p3은 0건).
**wp3으로 재배정했다**(감사 A5). p3 재스택 시점에는 이미 고쳐져 있어야 한다.
여기서는 회귀하지 않았는지만 확인한다.

## 이 단계가 소유하는 스레드

### T22 (P1) — 기존 Codex journal 재소유

`src/client/connect.ts:229`. `ocx start` 이후의 정상 상태, 즉 Codex가 이미
로컬 OpenCodex 프록시를 통하도록 라우팅된 상태에서 `injectCodexConfig`가
소유권을 잃는다. 연결 전에 기존 journal을 재소유해야 한다.

### T23 (P2) — 응답 읽기 제한

`src/client/hub-client.ts:85`. 신뢰할 수 없는 `Content-Length`(chunked이거나
고의로 잘못 보고된 `/readyz`, `/api/keys`)에 대해 버퍼링 전에 제한한다.
T20과 같은 계열이므로 같은 캡 정책을 쓴다.

### T24 (P2) — connect 워크플로 문서화

`src/cli/help.ts:35`. stdin 전용 자격증명, 클라이언트 선택, HTTP 처리를 포함한
사용자 노출 워크플로가 문서화되지 않았다.

## release-version-line

wp2와 동일. 이 단계 head에서 명시적으로 확인한다.

## 검증

- `git range-diff` 11커밋 보존.
- `cd gui && bun test tests/api-auth-memory.test.ts` (회귀 확인)
- `bun test tests/cli-headless-parity.test.ts tests/cli-registry.test.ts tests/cli-status-json.test.ts tests/release-version-line.test.ts`
- **이 단계 head가 초록이어야 p4를 그 위에 쌓는다.**
- exact-head CI.
