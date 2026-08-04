# 000 — 260725-pr-issue-triage: Plan

## Objective

opencodex 저장소의 open PR 24건, open Issue 22건을 전수 분석하여
사용자 판단 없이 즉시 클로즈/머지 가능한 항목을 식별하고,
전체 우선순위 매트릭스를 devlog + inline visualization으로 산출한다.

## Loop-spec

- Loop archetype: verifier-defined (devlog 파일 존재 + viz 렌더링)
- Write scope: `devlog/260725_pr-issue-triage.md` (NEW), inline-vis fragment (NEW)
- Out-of-scope: 실제 PR/Issue 클로즈/머지 실행, 코드 변경
- Budget: 1 PABCD cycle, 분석 전용

## Work-phase map

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| 1 | 010 | PR/Issue 전수 분석 + devlog + viz | — |

## Accept criteria

- C1: devlog/260725_pr-issue-triage.md에 tier별 분류 + 우선순위 매트릭스 존재
- C2: inline-vis fragment가 `/Users/jun/.codex/visualizations/2026/07/24/019f94cd-ebff-7313-b5d1-d999a6ea60d4/pr-issue-triage.html`에 존재
- C3: 즉시 클로즈 가능 항목(PR 3 + Issue 3)에 구체적 근거 명시
- C4: 최근 머지 이력(7/23~7/24, 20건) 포함
