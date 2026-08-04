# 000 — 260725-plan-cleanup: Plan

## Objective
devlog/_plan 28개 항목을 Luna 4개조 병렬 코드-문서 비교로 전수조사하여
COMPLETED/STALE 22개를 _fin으로 이동, IN_PROGRESS 6개를 유지한다.

## Loop-spec
- Loop archetype: verifier-defined (파일 이동 + ls 확인)
- Write scope: devlog/_plan → devlog/_fin 파일 이동만
- Out-of-scope: 코드 변경 없음

## Work-phase map
| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | 010 | 전수조사 + 이동 + 커밋 + 푸시 | — |

## Accept criteria
- C1: _plan에 IN_PROGRESS 6개만 잔존
- C2: _fin에 22개 이동 완료
- C3: git push origin dev 성공
