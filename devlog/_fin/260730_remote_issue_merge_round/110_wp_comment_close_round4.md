# 110 — wp: 코멘트/클로즈 라운드 4 + CI 타임아웃 근본원인

PABCD 1사이클, 터미널 결과 DONE. 이 사이클의 주요 산출물은 예정에 없던 CI 근본원인 규명이다.

## 1. 클로즈 대상 대조 결과 — 추가 없음

머지 3건(`fff8c369f` #575 / `48f2e8362` #652 / `d24c5233f` #711)이 실제로 닫는 이슈를
전수 대조했다. 결론: #700 외에 닫을 것이 없다.

| 이슈 | 관련 PR | 판정 |
|------|---------|------|
| #700 | #711 | 이미 닫음 (라운드 3) |
| #553 | #575 | 닫지 않음 — 오너가 PR 본문과 이슈 코멘트 양쪽에 명시 |
| #572 | #652 | 닫지 않음 — 우산 이슈, phase 1만 완료 |

대신 두 건에 진전 코멘트를 달았다: #572 (comment 5124395710), #553 (comment 5124395814).
#553 코멘트에는 자격증명 마스킹 부수효과도 알렸다 — 과거에 base URL 포함 오류를
붙여넣은 적이 있다면 알아야 할 정보다.

이전 4건 종료 상태 재확인: #712 `COMPLETED`, #591 `COMPLETED`, #700 `COMPLETED`,
#401 `NOT_PLANNED`. 성격 구분이 의도대로 유지됐다.

## 2. #710 — 원격 미반영 상태 (사용자 작업)

사용자가 `14d58ec1d`로 커밋하고 이슈에 "Fixed on dev" 코멘트를 달았으나, 실측 결과
커밋이 로컬 전용이다:

```
git rev-list --count origin/dev..HEAD  -> 3
  9eb0837e5 fix(kiro): stop proxy filler from preceding a mid-turn steer
  14d58ec1d fix(kiro): discover the Windows kiro-cli token DB on login import (#710)
  d23cbd727 test(kiro): cover the real upstream shape that omits tokenUsage
```

푸시 전까지 이슈를 닫으면 안 된다. 코멘트가 실제 원격 상태를 앞서간 상황이다. 푸시는
DEV-GIT-PUSH-01에 따라 사용자 결정 사항이므로 보고만 한다.

참고: 이전 세션 문서 커밋 `aa2220726`은 이미 `origin/dev`에 반영됐다
(`git show origin/dev:MAINTAINERS.md | rg -c "primary-source evidence"` → 1).

## 3. CI 타임아웃 — 이 사이클의 실제 발견 (이슈 #717)

#653 재실행이 또 실패로 표시됐는데 `conclusion`을 확인하니 `cancelled`였다.
파고들어 근본원인을 찾았다.

`.github/workflows/ci.yml:53` — `test` 잡의 `timeout-minutes: 12`.

```
job 90733427766 (PR #653, 879efb243)
  conclusion: cancelled
  started 23:11:50Z  completed 23:23:55Z   = 12m05s
  Test: cancelled / 이후 스텝 전부 skipped
```

12분 한도에 5초 초과해서 잘린다. 그리고 이건 #653만의 문제가 아니다:

| run | windows-latest | 시간 |
|-----|----------------|------|
| 30459554635 | success | 11min |
| 30493348190 | cancelled | — |
| 30497549930 | cancelled | — |
| 30498312557 | cancelled | — |
| 30498333662 | cancelled | — |
| 30498427875 | cancelled | — |

마지막 green이 11분 / 한도 12분 — 여유 1분. 그 뒤 `dev` 실행이 전부 취소됐다.
ubuntu는 같은 스위트를 4분에 끝내므로 Windows가 약 2.5배 느리다.

워크플로 주석이 스스로 증언한다: "The Windows full suite now completes near the old
8-minute ceiling" — 8분에서 12분으로 올린 전례가 있고 그 12분도 다시 소진됐다. 천장이
스위트 성장을 뒤따라가는 구조다.

### 왜 이게 리뷰 비용인가

`gh pr checks`는 `cancelled`를 `fail`로 렌더한다. 리뷰어가 매번
`gh api .../check-runs`로 `conclusion`을 확인해야 진짜 실패와 타임아웃을 구분할 수 있다.
오늘 실제로 두 번 겪었다: #711은 취소였고 재실행으로 통과해 머지됐다. #653은 첫 실패는
진짜 failure였지만 재실행은 취소였다. 즉 "Windows 실패는 항상 타임아웃"도 틀렸다 —
매번 확인해야 한다는 점이 문제의 핵심이다.

이슈 #717로 run별 증거와 함께 제출. #653에도 판정 결과와 리베이스 권고를 코멘트했다
(comment 5124414379).

## 성공 기준 판정

| # | 기준 | 결과 | 증거 |
|---|------|------|------|
| 1 | 완료된 것 클로즈 | PASS(공집합) | 대조 결과 #700 외 없음 — 근거와 함께 기록 |
| 2 | 진전 있는 이슈에 코멘트 | PASS | #572, #553 |
| 3 | #653 판정 | PASS | `cancelled` 확인 → 근본원인 규명 → #717 |
| 4 | 사용자 작업분 무손상 | PASS | 미푸시 커밋 3개 및 unstaged 보존 |
| 5 | 푸시 없음 | PASS | 코멘트/이슈 생성만, 로컬 푸시 0회 |

## 다음 사이클 후보

1. #717 수정 — `timeout-minutes` 상향. 다만 Windows가 왜 2.5배 느린지 함께 볼 가치가
   있다. 반복 상향은 천장 추격이다. CI 워크플로 변경이라 MAINTAINERS.md 기준 보안 리뷰 대상
2. #710 푸시 후 클로즈 — 사용자 결정 대기
3. #696 — Run 값 260자. 근거 확보 완료, 수정 방향에 오너 판단 필요
4. #701 / #702 — 정책·설계 판단 포함
