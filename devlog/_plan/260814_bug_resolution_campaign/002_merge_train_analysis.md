# 002 — Merge Train Analysis

## 의존 그래프

PR 간 의존은 코드 충돌과 논리적 선행 관계 두 가지다.
같은 파일/영역을 건드리는 PR은 순서가 중요하고,
독립적인 PR은 병렬로 머지할 수 있다.

## Chain A: Windows PowerShell (직렬)

#1674 (argv -WindowStyle Hidden 제거)
  -> #1678 (localized profile paths, #1674 위에 rebase)
    -> #1647 (service wrapper exit 0, behavior test 추가)
    -> #1626 (scheduler native service removal)

왜 이 순서인가:
- #1678이 #1674를 먼저 머지하지 않으면 -WindowStyle Hidden argv를 다시 도입한다.
- #1647과 #1626은 같은 PowerShell/서비스 영역이라 #1674/#1678 안정화 뒤에 리베이스해야 한다.

## Chain B: Cursor (반직렬)

#1680 (malformed args fail-closed, 독립)
#1673 (unified exec tool filtering, rebase 후)
  -> #1634 splits (structured-edit, 3분할 후)
    -> #1623 (adapter registry, behavior fix 뒤 architecture)

왜 이 순서인가:
- #1680은 Cursor 보안 불변식이라 독립 즉시 머지.
- #1673은 #1661을 해결하는 focused fix라 대형 PR보다 먼저.
- #1634는 분할 없이 머지하면 #1388을 닫을 수 없다 (host exact-match 미해결).
- #1623은 architecture 변경이라 behavior fix 안정화 후.

## Chain C: OAuth (직렬)

#1656 (exact accountId)
  -> #1663 (forced add-account preservation)

왜 이 순서인가:
- #1663이 #1656의 identity resolution에 의존한다.

## 독립 PR (병렬 머지 가능)

| PR | 내용 | 차단점 |
|----|------|--------|
| #1677 | encrypted payload iterative traversal | Actions 승인 |
| #1636 | maxRequestBodySize 256MiB | 테스트 보강 |
| #1675 | body-read timeout | rebase |
| #1638 | usage calendar alignment | DST 테스트 추가 |
| #1617 | packaging symlink skip | rebase |

## 특수 케이스: 분할 필요 PR

| PR | 분할 계획 | 상세 |
|----|----------|------|
| #1412 | 3-way split | 003_pr_split_decisions.md 참고 |
| #1623 | 3-way split | 003_pr_split_decisions.md 참고 |
| #1634 | 3-way split | 003_pr_split_decisions.md 참고 |
| #1609 | cherry-pick | 003_pr_split_decisions.md 참고 |

## Hold

| PR | 이유 |
|----|------|
| #1625 | 제품 결정과 플랫폼 matrix 필요 |
| #1608 | Bun 1.4 준비, 현재 release blocker 아님 |

## 최적 머지 순서 요약

1. #1674 -> #1677 -> #1680 (즉시, 독립)
2. #1636 fixup -> #1582 new PR (P0 quick wins)
3. #1678 rebase -> #1673 rebase (체인 진행)
4. #1675, #1638, #1617 (독립 소형)
5. #1656 -> #1663 (OAuth 체인)
6. #1647 -> #1626 (Windows 서비스)
7. #1412 split -> #1634 split -> #1623 split (대형 분할)
8. Wave 5-6 (Provider, CI)
