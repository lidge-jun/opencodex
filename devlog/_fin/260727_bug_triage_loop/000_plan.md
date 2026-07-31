# 000 — 버그 트리아지 루프 계획

작성: 2026-07-27
세션: 019fa259-f1e1-7791-ab0f-3c8a262c3a7f
goalplan: `opencodex-pr-dev-devlog-511-5ff20dc0-7ba0fec3-53`

## 목표

종결 가능한 이슈/PR을 증거와 함께 닫고, 수정 가능한 버그는 실제로 고쳐 `dev`에 푸시하며,
모든 버그 판정을 이 구현 단위에 문서로 남긴다.

## 진입 시점 기준선

| 항목 | 값 | 확인 방법 |
|------|-----|-----------|
| `dev` HEAD | `f327db1e` | `git log --oneline -1` |
| `origin/main` | `7ba0fec3` (dev에 완전 포함, main-only 0) | `git rev-list --left-right --count origin/main...origin/dev` |
| `preview` | 41커밋 뒤처짐 | `git branch -vv` |
| typecheck | 통과 | `bun run typecheck` |
| 테스트 | 4972 pass / 0 fail (378파일, 153초) | `bun run test` |
| 열린 이슈 | 22건 | `gh issue list --state open` |
| 열린 PR | 17건 | `gh pr list --state open` |

이 기준선은 "회귀 없음"의 정의다. 이후 어떤 사이클도 4972 pass 아래로 내려가면 실패다.

## 제약

- 보안 경계(인증/토큰/OAuth/릴리스 워크플로)는 이번 루프의 범위 밖이다. `MAINTAINERS.md`가
  명시적 보안 리뷰를 요구하므로, 해당 PR은 판정만 하고 머지하지 않는다.
- 타 기여자 PR의 코드를 직접 고치지 않는다. 판정과 코멘트까지가 이번 루프의 권한이다.
- 푸시는 사용자가 명시 승인한 `dev` 범위로 한정한다. `main`/`preview`/태그/force-push는 승인 밖.
- 근거 없는 종결 금지. 모든 close는 코드 인용 또는 커밋 SHA를 동반한다.

## work-phase 맵 (의존성 순서)

PHASE-SPLIT-01에 따라 노력이 아니라 의존 구조로 자른다.

```
WP0 (docs-only)  ── 판정 근거 확정
   │                이후 모든 phase가 이 판정을 소비한다
   ▼
WP1 (구현)       ── #539 경로 해석 수정 + 회귀 테스트 + dev 푸시
   │                WP2의 종결 근거(푸시 SHA)를 생산한다
   ▼
WP2 (종결)       ── 이슈 종결. WP1의 SHA와 WP0의 판정을 모두 필요로 한다
   │
   ▼
WP3 (PR 트리아지) ── PR 처분. WP0 매트릭스를 소비하고 독립 검증한다
```

WP1이 WP2보다 먼저인 이유는 단순하다. #539를 닫으려면 "고쳐졌다"는 근거가 있어야 하고,
그 근거는 WP1이 만드는 커밋 SHA다. 순서를 뒤집으면 근거 없는 종결이 된다.

## 각 phase의 독립 검증 가능성

| phase | 종료 시점의 검증 |
|-------|------------------|
| WP0 | 문서 7종이 존재하고 코드 변경 0건 (`git diff --stat -- src/ tests/`가 비어 있음) |
| WP1 | `bun run typecheck` + `bun run test` 통과, 신규 테스트가 3개 분기를 각각 트리거 |
| WP2 | `gh issue view`로 종결 상태와 근거 코멘트 확인 |
| WP3 | 각 PR의 처분과 그 근거가 `002` 문서에 기록되고 실제 상태와 일치 |

## 문서 구성

| 문서 | 성격 | 내용 |
|------|------|------|
| `000_plan.md` | 연구 | 이 문서 — 목표/제약/phase 맵 |
| `001_issue_triage_matrix.md` | 연구 | 열린 이슈 22건 판정 |
| `002_pr_triage_matrix.md` | 연구 | 열린 PR 17건 판정 |
| `003_claude_desktop_path_rca.md` | 연구 | #539 근본 원인 분석 (번들 근거) |
| `010_phase1_desktop_path_fix.md` | 구현 | WP1 diff-level 설계 |
| `020_phase2_issue_closure.md` | 구현 | WP2 종결 근거와 코멘트 문안 |
| `030_phase3_pr_triage_disposition.md` | 구현 | WP3 처분 계획 |

LEXICO-SPLIT-01에 따라 000번대(연구)와 decade(구현)를 분리한다. 연구 문서에 diff를 넣지
않고, 구현 문서에 조사 산문을 채우지 않는다.
