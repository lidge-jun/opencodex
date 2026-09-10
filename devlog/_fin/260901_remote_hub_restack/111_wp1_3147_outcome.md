# 111 — wp1 결과: #3147 시드 복원

## 무엇을 했나

`codex/ws-refresh-quota-seed-flake` 위에 커밋 `0cf5ef7b5`를 올렸다. 선행 테스트
`expired thread affinity returns 409 for an idle-expired thread`에
`updateAccountQuota("pool-a", 10, 5)`를 복원하되, 시계 핀 **이후**
(`Date.now = () => now` 다음, `startServer(0)` 이전)에 놓았다. 그리고 존재하지
않는 호출을 가리키던 주석을 참인 문장으로 바꿨다.

## 무엇을 하지 않았나 — 이게 더 중요하다

이것을 레이스 수정이라고 기록하지 않았다. 감사가 리뷰어의 인과를 반박했고,
반박이 옳았다:

- `primeCodexPoolQuotas`의 stale 판정은
  `!q || Date.now() - q.updatedAt >= POOL_CACHE_TTL`
  (`src/codex/auth-api.ts:1332-1335`)이다. `dev`에서는 시드가 핀 이전에 돌아
  `updatedAt`에 실제 시각이 찍혔고, 테스트는 `Date.now`를
  `1_800_000_000_000`으로 핀한다. 약 136일 대 5분 TTL — **시드가 있어도 이미
  stale이었다.** 삭제는 같은 `||` 가지 안에서 위치만 바꿨다.
- 설령 prime이 fetch를 해도 카운터에 닿지 못한다.
  `redirectCanonicalCodexTo`(`tests/server-auth.test.ts:106-117`)는
  `/backend-api/codex` 접두사만 로컬 `Bun.serve`로 돌리는데, prime의 WHAM 호출은
  `/backend-api/wham/usage`(`auth-api.ts:1157`)다. `upstreamRequests`는 3에서
  움직일 수 없다.

리뷰어가 맞은 고리는 하나다: 자격증명이 시드되어 있으므로 prime은 실제로
`fetchPoolAccountQuota`까지 간다(`:1201-1202`은 null `existing`에 early-return
하지 않는다). 그 고리가 단언까지 이어지지 않을 뿐이다.

그래서 복원의 근거는 두 가지로 남긴다. 주석이 거짓말을 멈춘다는 것, 그리고 핀
이후 시드가 prime을 **처음으로** 실제 억제한다는 것. "가끔 지는 레이스를 닫았다"가
아니다.

## 검증

`bun test tests/server-auth.test.ts` — 91 pass / 0 fail / 618 expect calls,
31.43s. 전체 스위트는 돌리지 않았다(금지).

exact head `0cf5ef7b5`의 원격 매트릭스는 전부 초록이다: macos, test 1~4/4,
gates, storage policy, api usage, keyring ubuntu/windows/macos, hygiene,
react-doctor, enforce-target, ci. FAILURE 0건. 남은 블로커는 리뷰어의
CHANGES_REQUESTED 하나뿐이고, 인과 정정은 PR 코멘트로 회신했다.

## 다음 단계로 넘기는 사실

#2789는 이 수정으로 초록이 되지 않는다. macOS 잡이 17098 pass / **2 fail**이고
두 번째는 `ocx launcher graceful shutdown > SIGINT to the launcher tears down the
Bun proxy`의 20069ms 워치독 타임아웃이다(`tests/shutdown-launcher.test.ts`).

그리고 #2776과 #2789의 `enforce-target` 실패는 base 문제가 아니라 "missing UI
screenshot"이다. 워크플로에 정식 면제 경로가 있다 —
`.github/workflows/enforce-pr-target.yml:259`의 `gui-screenshot-waived` 라벨을
`MAINTAINERS.md`에 등재된 사람이 붙이면 그 실패만 걷힌다. 다만 #2789는
`gui/src/pages/ApiKeys.tsx`, `Usage.tsx` 등 실제 화면을 16개 파일 건드리므로
면제가 아니라 스크린샷이 맞다. #2776이 건드리는 GUI 파일은 `gui/src/api.ts`와
테스트 2개뿐이라 면제가 타당하다.
