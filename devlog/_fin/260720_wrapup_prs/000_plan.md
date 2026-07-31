# 260720_wrapup_prs — devlog 2레인 마무리 + PR/이슈 정리 + main/preview 머지 준비

## Objective

어제(260719-20) 진행한 devlog 두 유닛(windows_service, claude_authmode_persist)의
완료를 검증하고, sol 감사로 남은 결함을 닫은 뒤 push. 신규 PR #167 머지 검토,
관련 이슈 정리, main/preview 머지 준비 상태 확보.

## Work map (실행 순서)

| # | Deliverable | 결과 |
|---|-------------|------|
| 1 | 두 devlog 유닛 완료 검증 (커밋/done-doc/테스트) | DONE — authmode는 090/091 done doc 존재, windows는 080 작성 |
| 2 | sol 적대 감사 (McClintock) | GO-WITH-FIXES → blocker 1 (WinSW fail-open status) |
| 3 | blocker 수정: `unknown` 상태 + SCM probe + fail-closed | 99b2f3ad |
| 4 | #168 `ocx update --help` 부작용 수정 (양 진입로) | a4f06beb |
| 5 | PR #167 sol 리뷰 (Peirce) → stdio 포트 + close | a4f06beb + PR close |
| 6 | Models.tsx 활성 모델 상단 정렬 커밋 | e3e34a9b |
| 7 | devlog _fin 아카이브 | 0a8e1c66 |
| 8 | CI 회귀 수정 (sc.exe stdout 1060 / stale 등록 sc delete / probe error abort) | 1e6bd6d4, 122f8dba, 0fecab87 |
| 9 | dev CI all-green 확인 | Cross-platform + service-lifecycle 둘 다 0fecab87 그린 |
| 10 | main/preview 머지 준비 (머지 자체는 사용자 결정) | 준비 완료 보고 |

## Scope boundary

- IN: 위 1-10. 이슈 #165/#166/#168 close (수정 참조 포함), PR #167 close.
- OUT: PR #144 (사용자 지시로 보류), PR #150 (draft safety net, 유지),
  preview/main으로의 실제 머지, 릴리스 컷.

## 감사 이력

- McClintock (sol, code-reviewer): R1 GO-WITH-FIXES(blocker 1: winsw status
  fail-open) → R2 OPEN(exe missing ≠ SCM absent) → R3 OPEN(1060이 stderr 외
  채널 가능) → CLOSED → CI 회귀 후 재검토 OPEN(probe error 시 uninstall 침묵)
  → 최종 PASS.
- Peirce (sol, PR reviewer): #167 = PORT(stdio) + CLOSE(superseded).

## 증거

- focused bun test: 69 / 58 / 48 / 20 pass, 0 fail (수정 라운드별).
- tsc root+gui 매 라운드 clean.
- 실기: `ocx update --help` 두 진입로 usage + exit 0 + 부작용 없음.
- CI: Cross-platform 29712048661 ✓, service-lifecycle 29712075697 ✓ (0fecab87).
- 로컬 전체 스위트의 54건 실패는 라이브 프록시(127.0.0.1:10100) 포트 충돌 +
  병렬 부하 플레이크: 실패 파일 전부 격리/소배치 실행 시 pass, CI 그린.
