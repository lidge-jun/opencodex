# 110 — 스택 머지 트레인 계획 (감사 후 정정본)

초판은 A 게이트 감사에서 fail을 받았다. 두 개의 사실 주장이 틀렸고, 아래는 실제
로그와 코드로 확인한 정정본이다. 틀린 서술을 지우지 않고 무엇이 왜 틀렸는지
남긴다 — 다음 사람이 같은 추론을 반복하지 않게.

## 정정 1: 리뷰어 P1의 인과가 뒤집혀 있다

#3147에 걸린 CHANGES_REQUESTED는 선행 테스트
`expired thread affinity returns 409 for an idle-expired thread`에서
`updateAccountQuota("pool-a", 10, 5)`가 삭제되어 startup pool-quota prime이
WHAM 요청을 한 건 더 보내고 `expect(upstreamRequests).toBe(3)`이 깨진다는
주장이다. 초판은 이것을 그대로 받아 적었다. 틀렸다.

`src/codex/auth-api.ts:1332-1335`의 stale 판정은
`!q || Date.now() - q.updatedAt >= POOL_CACHE_TTL` 이다. `dev` 쪽 코드에서 그
시드는 시계 핀 **이전**에 실행되므로 `updatedAt`에 실제 시각이 찍힌다. 테스트는
곧이어 `Date.now`를 `1_800_000_000_000`으로 핀한다. 그 차이는 약 136일이고
`POOL_CACHE_TTL`은 5분이다. 즉 **시드가 있어도 이미 stale이었다.** 삭제는
`!q`를 false-but-stale에서 true-and-stale로 바꿀 뿐, 같은 가지로 떨어진다.
prime의 fetch 여부는 삭제 전후가 동일하다.

두 번째로, 그 fetch는 애초에 카운터에 닿지 못한다. `redirectCanonicalCodexTo`
(`tests/server-auth.test.ts:106-117`)는 `hostname === "chatgpt.com"` 이면서
`pathname`이 `/backend-api/codex`로 시작하는 것만 로컬 `Bun.serve`로 돌린다.
WHAM은 `/backend-api/wham/usage`다(`src/codex/auth-api.ts:1157`). 리다이렉트를
타지 않으므로 `upstreamRequests`를 증가시킬 수 없다. prime이 아무리 이겨도
단언은 4를 볼 수 없다.

리뷰어가 맞은 부분은 한 고리뿐이다: 자격증명이 시드되어 있으므로 prime은 실제로
`fetchPoolAccountQuota`까지 간다(`auth-api.ts:1360-1362`, `:1201-1202`은 null
`existing`에 early-return 하지 않는다). 그 고리가 단언까지 이어지지 않을 뿐이다.

## 정정 2: 주석은 실제로 거짓말한다 — 이게 유일한 유효 지적

head `ecf51c67`의 `tests/server-auth.test.ts:2132` 주석은
"`updateAccountQuota` above stamped `updatedAt` with the REAL clock"이라고
말하는데 above에 그 호출이 없다. 이건 P1이 아니라 문서 위생 문제다. 고쳐야 하지만
"레이스를 닫는다"는 명분으로 고치면 안 된다.

따라서 수정은 하되 근거를 바꾼다: 시계 핀 **이후**에 시드를 복원하면 prime이
처음으로 진짜 fresh를 보고 조용해지고, 주석도 참이 된다. 개선은 맞다. 레이스
수정은 아니다.

## 정정 3: #2789는 #3147로 초록이 되지 않는다

초판은 세 브랜치가 같은 한 건으로 실패한다고 썼다. 실제 macOS 로그:

| PR | 결과 | 실패 테스트 |
|----|------|-------------|
| #2777 | 17037 pass / 1 fail | websocket passthrough refreshes pool auth |
| #2781 | 17049 pass / 1 fail | 위와 동일 |
| #2789 | 17098 pass / **2 fail** | 위 + `ocx launcher graceful shutdown > SIGINT to the launcher tears down the Bun proxy` (20069ms 워치독 타임아웃, `tests/shutdown-launcher.test.ts`) |

#2789는 별개의 타임아웃 플레이크를 하나 더 가지고 있고, `enforce-target`도
따로 실패한다. 실패 사유는 wrong_base가 아니다 — 로그에
"Base codex/remote-hub-p5 matches an open PR head; treating as stacked
(skip wrong_base)"가 찍혀 있고, 실제 사유는 "PR quality gate failed: missing UI
screenshot"다. #2789 본문에 GUI 스크린샷이 없다. #2776도 같은 사유다.

## 정정 4: 순서는 맞지만 "유일"하지 않다

더 싼 대안이 있다: 실패한 macOS 잡 세 개를 재실행하는 것. 플레이크니까 통과할
확률이 높다. 하지만 그건 내구성이 없다 — 다음 푸시에서 다시 진다. #3147을
`dev`에 넣는 쪽을 택하는 이유는 "유일해서"가 아니라 **루트에서 고치는 게
여섯 브랜치를 매번 재실행하는 것보다 내구적이어서**다.

## 확정 실행 순서

1. **wp1** #3147: affinity 테스트에 시드 복원(핀 이후) + 주석 정정. 근거는
   위생, 레이스 아님. `--no-verify` 푸시 → exact-head CI → 리뷰어에게 인과
   정정을 회신하고 P1 해소 → admin 머지.
2. **wp2** #3143(리뷰어 중복본) 클로즈, #3149 머지.
3. **wp3** 허브 6개 브랜치를 새 `dev` 위로 리베이스. 현재 전부 `dev` 팁 위에
   있으므로(behind 0) 실제로는 fast-forward 재적층이다.
4. **wp4** #2771부터 순차 머지. 각 자식은 부모가 랜딩하면 `dev`로 재타겟.
   #2776 / #2789의 `enforce-target`은 UI 스크린샷 누락이므로 본문에 스크린샷을
   넣거나 admin 오버라이드로 넘긴다. #2789의 launcher 타임아웃은 별도 플레이크로
   재실행 대상.
5. **wp5** `dev` 최종 검증.

## 검증 경계

로컬 전체 스위트 금지. 검증은 exact-head 원격 CI. 푸시는 `--no-verify`.
`dev`/`main`/`preview` 직접 푸시 금지 — 모든 랜딩은 PR 머지 경로.
