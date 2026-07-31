# 000 — Star Surge Triage: 2806★ 이후 이슈/PR 대량 유입 처리 계획 (MOC)

- 날짜: 2026-07-22 14:36 KST
- 브랜치 기준: `dev`
- 유닛: `devlog/_plan/260722_star_surge_triage/`
- 성격: **docs-only 조사 유닛** — terra 서브에이전트 2기 병렬 조사(이슈 18건 / 커뮤니티 PR 18건) 결과를 분류·문서화. 코드 패치, GitHub 코멘트/클로즈/머지, push는 이 유닛 범위 밖.

## 배경

스타 2,806개 돌파 이후 하루 유입량이 급증. 2026-07-22 14:36 기준:

- 오픈 이슈 18건 (이 중 7-22 하루에 10건 생성)
- 오픈 PR 19건 (maintainer 자체 PR #259 제외 시 커뮤니티 PR 18건)

기존 처리 자산: `260722_issue_bug_sweep`(버그 RCA + diff-level 패치 계획),
`260722_pr_review_strategy`(직전 PR 라운드 — 대부분 소화 완료, 현재 오픈 목록과 겹치지 않음).

## 조사 방법

- terra(gpt-5.6-terra) 서브에이전트 2기 병렬:
  - Agent A(이슈): 18건 전건 본문+코멘트 열람, PR 매핑, 소스 스팟체크 후 4-버킷 분류
  - Agent B(PR): 18건 diff/CI/충돌 검토, 위험도 버킷 + dev 흡수 순서 제안
- 메인 에이전트: 통합 판단, 분류 문서화, mermaid 다이어그램($cxc-dev-diagram-viewer 라우팅: Codex Desktop → native mermaid)

## 문서 구성

| 문서 | 내용 |
|------|------|
| `000_plan.md` | 이 문서 (MOC) |
| `001_issue_triage.md` | 이슈 18건 전수 분류표 + 근거 |
| `002_pr_triage.md` | PR 18건 전수 분류표 + dev 흡수 순서 + 충돌 결정점 |
| `003_action_split.md` | 최종 액션 분할: 답변만 / 단기 패치 / PR 리뷰 큐 / 장기 프로젝트 |

## 처리 원칙 (기존 트리아지 관행 계승)

- 흡수는 `dev` 스택, **한 번에 하나씩** (one PR per PABCD cycle)
- `merged` vs `closed without merge` 구분 유지, 근거 코멘트 필수
- 충돌 쌍(#256↔#237, #247↔#255/#231)은 방향 결정 전 병합 금지
- 이 유닛은 조사·분류까지. 실행(리뷰/머지/코멘트)은 별도 지시 후 진행.
