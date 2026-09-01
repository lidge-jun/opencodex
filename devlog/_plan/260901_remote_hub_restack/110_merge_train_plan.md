# 110 — 스택 머지 트레인 계획 (wp1: #3147 플레이크 수정 선행)

## 왜 #3147이 먼저인가

리모트 허브 스택의 CI 실패는 스택 자체 결함이 아니다. #2777 / #2781 / #2789의
`macos` 잡이 실패하고 그 때문에 집계 잡 `ci`가 실패하는데, 실패 테스트는 셋 다
동일한 한 건이다:

    (fail) server local API auth > websocket passthrough refreshes pool auth for each response.create turn

17037 pass / 1 fail. 이 테스트는 `dev`가 이미 가진 플레이크이고, 스택 브랜치가
그것을 상속했을 뿐이다. 스택을 리베이스해도 같은 플레이크를 다시 상속하므로,
수정본인 #3147을 `dev`에 먼저 넣고 그 위로 리베이스하는 순서가 유일하게
수렴하는 순서다.

## #3147에 열려 있는 P1

리뷰어(Ingwannu)가 exact head `ecf51c67`에 CHANGES_REQUESTED를 걸었고, 지적은
타당하다. 문제의 diff는 선행 테스트
`expired thread affinity returns 409 for an idle-expired thread`에서
`updateAccountQuota("pool-a", 10, 5)`를 함께 지웠다. 그 시드는 웹소켓 테스트의
것이 아니라 선행 테스트의 것이다.

지워졌을 때 무슨 일이 벌어지는지가 핵심이다. `startServer`는 동기 반환하지만
비동기 pool-quota prime을 무장하고, 그 prime은
`Date.now() - quota.updatedAt >= POOL_CACHE_TTL`로 staleness를 판단한다
(`src/codex/auth-api.ts`). 캐시된 quota가 아예 없으면 prime은 stale로 보고
리다이렉트된 canonical 업스트림으로 WHAM 요청을 한 건 더 보낸다. 그 요청이
타이밍 창을 이기면 `expect(upstreamRequests).toBe(3)`이 4를 보고 깨진다.
지금 매트릭스가 초록이라는 사실은 레이스가 닫혔다는 증거가 아니다 — 레이스는
정의상 가끔 진다.

덤으로 그 위 주석이 존재하지 않는 코드를 가리킨다. "`updateAccountQuota` above
stamped `updatedAt` with the REAL clock"이라고 쓰여 있는데 above에 그 호출이
없다. 주석이 거짓말하는 상태로 머지할 수는 없다.

## 수정 내용

선행 affinity 테스트에서:

1. `Date.now = () => now` 바로 다음, `startServer(0)` 이전에
   `updateAccountQuota("pool-a", 10, 5)`를 복원한다. 핀 이전이 아니라 이후여야
   하는 이유는 이 PR의 본래 논지와 같다 — 핀 이전에 쓰면 `updatedAt`이 실제
   시각으로 찍혀 2027년 가짜 시계에서 몇 달치 캐시 나이로 보인다.
2. 주석을 실제 코드에 맞춘다. "above"가 아니라 "핀 이후에 시드하므로 prime이
   신선하다고 판단한다"가 참인 문장이다.

웹소켓 테스트 쪽 변경(자격증명 + quota를 핀 이후로 이동)은 그대로 둔다. 그것이
이 PR이 고치려는 플레이크 본체다.

## 검증 경계

로컬 전체 스위트는 금지되어 있다. 검증은 exact-head 원격 CI로 한다. 푸시는
`--no-verify`. `dev`/`main`/`preview` 직접 푸시는 룰셋으로 막혀 있고 시도하지
않는다 — 모든 랜딩은 PR 머지 경로다.

## 이후 순서

wp2 #3143(리뷰어의 중복본) 클로즈 + #3149 머지. wp3 허브 6개 브랜치를 새 `dev`
위로 리베이스. wp4 #2771부터 순차 재타겟 + 머지. wp5 최종 검증.
