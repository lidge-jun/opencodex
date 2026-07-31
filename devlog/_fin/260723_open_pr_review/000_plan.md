# 260723 Open PR Review (post-overnight-merges)

## Objective

Review all PRs still open after the overnight batch merges into `dev`
(through d56d2948, PR #313). Classify each as merge / request-changes /
close / rebuild-on-dev, with evidence per PR.

## Worktree

- Path: `/Users/jun/.codex/worktrees/3118/opencodex-pr-review`
- Branch: `codex/pr-review-260723` (tracking `origin/dev` @ d56d2948)

## PR Inventory (as of 2026-07-23 ~16:30 KST)

| PR  | Title | Author | Overlap w/ overnight review |
|-----|-------|--------|------------------------------|
| #316 | fix(anthropic): preserve terminal SSE frames | Ingwannu | new |
| #309 | fix(google): eliminate Antigravity request-shape 400s | HaydernCenterpoint | new |
| #307 | Preserve custom model display names across catalog syncs | diegocantarero | new |
| #306 | feat(windows): tray controls + restart-safety diagnostics | himomohi | new |
| #304 | fix(kiro): restore hardening and complete text turns | mushikingh | follow-up to merged #302 |
| #303 | Document Cursor exec policy and catalog troubleshooting | diegocantarero | new |
| #279 | feat: GitHub Copilot App via OpenAI-compatible chat completions | HaydernCenterpoint | new |
| #249 | feat: Named Cloudflare Tunnel default public API | Aiweline | overnight decision: CLOSE — still open, re-verify |

## Decision Summary

| PR | CI | GUI-touching | Decision | Unit |
|----|----|--------------|----------|------|
| #316 | green | no | ALREADY MERGED (af973e54) during this pass | 010 |
| #309 | green + CodeRabbit | no | MERGE-READY | 020 |
| #307 | green + CodeRabbit | no | MERGE-READY | 030 |
| #306 | only CodeRabbit ran — cross-platform CI NOT run | **YES** | HOLD: needs CI run + GUI owner approval + service/update security review | 040 |
| #304 | full green incl. lifecycle | no | SECURITY REVIEW (kiro OAuth/credentials) then MERGE; effective diff vs dev is the true delta | 050 |
| #303 | draft; enforce-target pass | no (docs only) | APPROVE once undrafted; locale sync follow-up | 060 |
| #279 | full green | no | MERGE-READY; note /v1/models auth-header change in release notes | 070 |
| #249 | 6/7 FAIL, stale since 07-22 | **YES** | CLOSE with comment (reconfirms overnight decision) | 080 |
| #317 | green (late arrival, fixes #315) | no | MERGE-READY when checks complete | 090 |

## Suggested merge order

1. #307 (small, catalog) → 2. #317 (small, quota) → 3. #309 (google adapter) →
4. #279 (new endpoint) → 5. #304 (after security review) →
then #303 when undrafted; #306 held for CI + GUI approval; #249 closed.

No file overlaps between the merge-ready set (#307 catalog, #317 quota, #309 google/*,
#279 chat/* + server/index) — order-independent, but small-to-large limits bisect surface.
