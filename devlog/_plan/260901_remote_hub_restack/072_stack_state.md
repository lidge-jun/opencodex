# 스택 상태 — 7단계 재스택 완료 시점

| PR | 브랜치 | 이전 head | 새 head | 부모 |
| --- | --- | --- | --- | --- |
| #2771 | codex/remote-hub-design | `bad162407` | `36992baa9` | dev |
| #2772 | codex/remote-hub-p1 | `c10ef21a9` | `07d7f1006` | design |
| #2776 | codex/remote-hub-p2 | `7099760a5` | `b7282858b` | p1 |
| #2777 | codex/remote-hub-p3 | `aa2615953` | `ad1ab25d8` | p2 |
| #2781 | codex/remote-hub-p4 | `44f9973a2` | `95787b9bc` | p3 |
| #2786 | codex/remote-hub-p5 | `a62c8eba2` | `8bcfcaa8e` | p4 |
| #2789 | codex/remote-hub-p6 | `207254fe0` | `ff2913297` | p5 |

각 단계는 직전 단계의 재스택된 head 위에 얹혔다. 원본 커밋은 전부 authorship과
메시지를 보존했고, 계약 변경은 단계마다 조정 커밋 하나로 분리했다.

## 원본 커밋 보존

| 단계 | 원본 커밋 | 조정 커밋 |
| --- | --- | --- |
| design | 9 | 3 |
| p1 | 5 | 1 |
| p2 | 6 | 1 |
| p3 | 11 | 1 |
| p4 | 8 | 1 |
| p5 | 8 | 1 |
| p6 | 17 | 1 |

## 해소된 것

D1~D5 설계 계약 5건, 리뷰 스레드 중 P1 6건(T1, T20, T22, T25, T26, T31)과
T32, 그리고 리뷰 본문이 지목한 테스트 실패 전부.

stale 아티팩트였던 것들 — `release-version-line`, privacy 게이트,
`update-stop-first`, `cli-headless-parity`의 일부 — 은 재스택으로 소멸했고
각 단계 head에서 실제로 확인했다.

## 남은 것

P2/Minor 스레드들(T2/T3/T7/T10/T11/T19/T21/T23/T24/T27/T28/T29/T30/T33)과
`#2771`의 마크다운 린트 6건. wp8에서 처리하거나 근거를 갖춘 반박을 남긴다.
