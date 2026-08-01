# 260720_pr_queue_merge_review — PR 큐 #169-#173 병합 리뷰 (PABCD 멀티사이클)

## Objective

열린 PR 5개(#169, #170, #171, #172, #173)에 대해 메인테이너급 병합 리뷰를
PABCD 사이클로 완료한다. 1차 트리아지(같은 날 앞선 세션 턴)에서 표면 리뷰는
끝냈고, 이 유닛은 (a) CI/테스트 주장의 증거 검증, (b) 미검토 표면 딥리뷰,
(c) #169→#171 리베이스 충돌 해소 가이드 산출을 마무리한다.

## Work map (실행 순서)

| # | Work-phase | Deliverable | decade doc |
|---|------------|-------------|-----------|
| 0 | roadmap-docs | 이 유닛 + 000/001 + decade 문서 전부 | (본 문서) |
| 1 | verify-172-170 | #172/#170 verdict + 증거 | `010_wp1_verify_172_170.md` |
| 2 | review-169 | #169 verdict + GUI hunk 발견사항 | `020_wp2_review_169.md` |
| 3 | review-171 | #171 verdict + 계약 대조표 | `030_wp3_review_171.md` |
| 4 | review-173 | #173 verdict + activation 증거 | `040_wp4_review_173.md` |
| 5 | conflict-guide | #169→#171 충돌 3파일 해소 가이드 | `050_wp5_conflict_guide.md` |

의존 순서 근거(PHASE-SPLIT-01): WP1은 다른 PR의 CI를 살리는 인프라(#172)와
가장 작은 런타임 변경(#170)이라 게이트가 빠르고, WP2/WP3는 서로 충돌하는
한 쌍이라 WP2 확정이 WP5의 입력이 되며, WP4는 독립 외부 PR이라 뒤에 둔다.

## Scope boundary

- IN: 로컬 리포 읽기/테스트, `gh` read-only API, sol 서브에이전트 디스패치,
  이 유닛의 문서, /tmp 스크래치 worktree 머지 시뮬레이션.
- OUT: PR 머지, `git push`, GitHub 코멘트/리뷰 게시 등 외부 상태 변경,
  main 코드 수정, 기존 dirty worktree 접촉.

## Verdict 표기 규칙

- `approve` — 지금 main에 squash-merge 가능.
- `approve-after-rebase` — 코드는 승인, #172 머지 후 리베이스/CI 재실행 필요.
- `approve-after-ci` — 코드는 승인, CI가 한 번도 안 돌았으므로 워크플로 승인 후
  전체 매트릭스 그린 확인(또는 로컬 `bun run prepush` 상당 실행) 필요.
- `needs-work` — file:line 블로거와 함께 기여자에게 요청.
- 모든 verdict는 근거(명령 출력, file:line)를 동반한다. 근거 없는 어프루브 금지.

## 감사/디스패치 이력

(사이클 진행 중 sol 리뷰어 verdict를 여기에 누적한다.)

### WP0 감사 R1 (Feynman + Mendel, sol priority)

- Feynman(팩트체크): PASS — 5개 주장 그룹 전부 확인.
- Mendel(실행성): GO-WITH-FIXES (blockers=10).
  - P1×3: 050 FETCH_HEAD 구문 오류, 030 Codex identity 테스트 미커버, 040 verdict 어휘 미정의.
  - P2×6: 010/030/040 PR head checkout 절차 누락, 020 hash sync activation 미비,
    040 실기 read-only 주장 범위, 050 activation 절차 부재.
  - P3×1: 030 계약표 row 6 문구 불명확.
- 판정: near-pass — 10건 전부 plan amendment로 폴드백.
