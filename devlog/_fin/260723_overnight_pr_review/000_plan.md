# 260723 Overnight PR Review & Triage

## Objective

Review all 10 open PRs as of 2026-07-23 morning KST, classify each as
merge / comment-and-request-changes / close / rebuild-on-dev, then execute.

## PR Inventory & Decision Summary

| PR | Title | Author | Base | CI | Decision | Rationale |
|----|-------|--------|------|----|---------:|-----------|
| #302 | feat(kiro): harden completion and transport | mushikingh | dev | partial | **MERGE** | Large but well-structured: adds incomplete event, provider continuation, phase-aware messages. 8 commits, tests. |
| #301 | ci: PR auto-labeler + auto release notes | Wibias | dev | all pass | **MERGE** | Clean CI workflow. Pinned action refs. Replaces manual git-log release notes with --generate-notes. |
| #299 | ci: issue translator workflow | Wibias | dev | partial | **MERGE** | Uses actions/ai-inference for issue translation. Pinned refs. CodeRabbit fixes applied. |
| #298 | ci: issue deduplicator workflow | Wibias | dev | partial | **MERGE** | Semantic duplicate detection via GitHub Models. Pinned refs. CodeRabbit fixes applied. |
| #296 | Add Cursor Router optimization levels | jontonsoup | dev | pass | **MERGE** | Exposes cursor/auto-cost, cursor/auto-balance, cursor/auto-intelligence. Well-tested, docs updated. |
| #293 | [WRONG BRANCH] ChatGPT non-stream buffer | PyEL666 | main | FAIL | **CLOSE** | Targets main instead of dev. Good ideas but needs retarget. |
| #286 | fix(server): return 400 for non-streaming | lg320531124 | dev | all pass | **MERGE** | One-line fix: 500 to 400. Correct HTTP semantics. |
| #283 | fix(v2): fail fast on encrypted agent tasks | MathiasHeinke | dev (draft) | all pass | **MERGE** | Detects Fernet-encrypted tasks routed to non-ChatGPT providers, returns 400 early. Well-tested. |
| #255 | Fix provider JSON editor save flow | rrmlima | dev (draft) | partial | **MERGE** | Fixes credential round-trip loss in GUI JSON editor. Important UX fix. |
| #249 | feat: Cloudflare Tunnel public API | Aiweline | dev | FAIL (narrow) | **KEEP OPEN + REQUEST CHANGES** | CI failures are narrow (fixture email + i18n keys). Keep open for security/ops review per audit. |

## Merge Order (Phase 1)

1. Batch 1 (low risk, CI green): #286, #301
2. Batch 2 (well-scoped features): #296, #298, #299
3. Batch 3 (undraft + merge): #283, #255
4. Batch 4 (largest, last): #302
5. Close: #293 (wrong branch), #249 (CI broken)
6. Typecheck + test after each batch

## Phase 2: Rebuild-on-dev (if needed)

- #293 SSE buffering / mimo retry ideas: evaluate cherry-pick crediting PyEL666
- #249 Cloudflare tunnel concept: defer to future work

## Security Notes

- #301 modifies release.yml: removes manual notes, adds --generate-notes. Net simplification. OK.
- #299, #298: new workflows, issues:write + models:read only. No extra secrets. OK.
- #283: security improvement (early-exit guard for encrypted tasks).
- #255: improves credential safety (preserves masked fields on save). OK.
