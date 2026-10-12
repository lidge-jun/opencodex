# 002 — Audit synthesis (round 1 -> round 2)

Reviewers: Avicenna (grok-4.6, plan-shape audit) FAIL; Hegel (grok-4.6, deep repo audit) FAIL.

## Accepted (folded into r3 docs)
1. Order rework (Avicenna): CI -> 2295 -> 2294 -> 2296 -> 2289 -> 2270 -> 2281. Adopted in 001 r2 and decade docs 020-065.
2. Fork mechanics (Hegel): #2270 head lives on olddonkey/opencodex, #2281 on Hsia97/opencodex, both maintainerCanModify=true — verified via gh. Stacked commits to those heads push to the FORK remote (https://github.com/<owner>/opencodex.git <local>:<branch>), enabled by maintainerCanModify; --no-verify applies locally. 001 mechanics corrected.
3. Full-suite bar (both): bun run typecheck + bun run test required before approving ANY non-trivial PR (AGENTS.md:178 area); full suite explicitly pre-merge for #2281/#2289/#2295 too, not only 2270/2296. Decade docs updated.
4. #2294 gates (Hegel): add bun run prepush (scripts/AGENTS.md), and record the non-author maintainer review — author is Ingwannu; the merging maintainer account (lidge-jun) supplies the non-author security APPROVE, satisfying MAINTAINERS.md no-self-approval.
5. #2270 stale CHANGES_REQUESTED (Hegel): reviewDecision still CHANGES_REQUESTED although the same reviewer's later comment on exact head 398b7ade4 says no remaining technical blocker. Pre-merge step: dismiss the stale review with rationale (or fresh APPROVE) so the recorded decision matches the converged state.
6. #2294 head drift (Hegel): head moved 86ed0a46a -> 71598fa45; re-fetch and re-review at the new head. 000 corrected.
7. CI cycle-1 (Hegel): rerun attempt 2 green + local 52/52 pass -> exit as flake (010 rewritten); no direct dev push.
8. Docs-sync (Hegel): after both 2295 (en-only doctor docs) and 2289 (8-locale lifecycle) land, verify locales do not contradict the English lifecycle page; added to 070.
9. CODEOWNERS/owner review for core.ts PRs (Hegel): lidge-jun review recorded at 040/065 merge time.

## Rejected (with evidence)
1. "#2270 already collides with intervening dev on src/providers/registry.ts" (Hegel): git merge-tree merge-base(origin/dev, pr/2270) shows 0 conflict markers; same for pr/2281. Rebase risk is semantic, not textual; covered by full suite on rebased head.
2. "#2281 hygiene failure is unsponsored_surface" (Hegel): latest pr-hygiene comment on #2281 says missing_regression_test (fetched via gh api). Treated per 065: re-trigger after stacked commit; drop or record maintainer override.
3. "#2296 cancelled enforce-target ignored" (Avicenna): not ignored — 040 requires it re-run green pre-merge. Kept.

