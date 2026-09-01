# wp8 — 스택 체인 정합 + 최종 판정

7단계가 전부 푸시된 뒤 실행하는 마감 사이클.

## 체인 정합

각 PR의 base가 직전 단계 head 브랜치를 정확히 가리켜야 한다.

| PR | base여야 하는 것 |
|----|------------------|
| #2771 | dev |
| #2772 | codex/remote-hub-design |
| #2776 | codex/remote-hub-p1 |
| #2777 | codex/remote-hub-p2 |
| #2781 | codex/remote-hub-p3 |
| #2786 | codex/remote-hub-p4 |
| #2789 | codex/remote-hub-p5 |

재스택 과정에서 GitHub가 base를 자동 변경하는 경우가 있으므로 푸시 후 매번
확인한다. base가 어긋나면 각 PR의 diff가 상류 델타를 삼켜서 리뷰가 불가능해진다.

## 계보 확인

`git merge-base --is-ancestor origin/dev origin/codex/remote-hub-<stage>` 가
7단계 전부에서 참이어야 한다. 하나라도 거짓이면 그 단계는 재스택이 안 된 것이다.

## draft 해제

#2776 / #2781 / #2789. CI 그린 확인 후에만.

## PR 설명 갱신

각 PR에 재스택 사실과 블로커 해소 내역을 적는다. 리뷰어가 exact head에 걸어둔
CHANGES_REQUESTED는 새 head에서 자동 해제되지 않으므로, 무엇이 어떻게
해소됐는지 파일:줄로 지목해야 재리뷰가 가능하다.

## 종료선

DONE = 7단계 재스택 푸시 완료, B1~B7 해소, exact-head CI 그린, base 체인 정합,
draft 해제. **머지는 하지 않는다** — 사용자 요청은 "머지 가능한 정도까지 세팅"이다.

한 단계가 막히면 그 단계만 BLOCKED으로 증거와 함께 보고하고 상류는 계속한다.
단, 스택이므로 하류가 막히면 상류는 그 위에 쌓을 수 없다. 그 경우 막힌 단계를
건너뛴 재스택은 하지 않고 BLOCKED으로 보고한다.
