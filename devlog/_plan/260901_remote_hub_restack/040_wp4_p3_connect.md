# wp4 — p3(#2777) 재스택 + gui api-auth-memory 경계 보존

브랜치 `codex/remote-hub-p3`, head `aa2615953`, 11커밋 / 34파일.
dev와 겹치는 파일 18개 — 이 스택에서 CLI 표면 겹침이 가장 넓다.

## 겹침

`src/cli/{claude,dispatch,help,index,registry,runtime-api,status}.ts`,
`src/config.ts`, `src/lib/service-secrets.ts`, `src/types.ts`,
`src/types/config.ts` + 테스트 7(`cli-headless-parity`,
`cli-start-journal-order`, `cli-status-json` 포함).

`cli-headless-parity`는 wp6에서도 문제를 일으키는 파일이다. 여기서 CLI 표면이
늘어나므로, p3 재스택 시점에 이미 새 명령이 headless 선언에 들어가 있는지
확인해두면 wp6의 부담이 준다.

## 블로커 — gui/tests/api-auth-memory.test.ts:23

리뷰어 표현은 "현재 대시보드 auth-memory 경계를 보존하라"이다. 즉 스택이
대시보드 인증 상태의 메모리 보관 계약을 바꿨고, dev 쪽 계약과 어긋났다.
재스택 후 실패를 재현해서 **어느 쪽 계약이 맞는지** 먼저 판정한다. dev가
맞으면 스택 코드를 dev 계약에 맞추고, 스택이 의도적으로 바꾼 것이라면
그 근거를 PR 설명에 적고 테스트를 함께 갱신한다. 테스트만 지우는 해소는 금지.

## release-version-line

wp2와 동일 원인. 재스택으로 소멸.

## 검증

- `git range-diff` 11커밋 보존.
- `cd gui && bun test tests/api-auth-memory.test.ts`
- `bun test tests/cli-headless-parity.test.ts tests/cli-registry.test.ts tests/cli-status-json.test.ts`
- exact-head CI.
