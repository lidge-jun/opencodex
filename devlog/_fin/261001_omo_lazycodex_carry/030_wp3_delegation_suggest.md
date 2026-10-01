# wp3 — carry #6274 (delegation suggest) and close the originals

Source: LilMGenius:feat/subagent-default-sizing head `b180fcec0a4c3ff63b9f230acc79e5f029bb6cea`, layer `6c97ca9a4fdec6c59901fa115be341d9cc590a15..b180fcec0a4c3ff63b9f230acc79e5f029bb6cea` (12 commits, 38 files, +961/-46).

## Steps

1. After wp2 merges: `git fetch origin dev`; assert wp2's squash SHA is an ancestor of `origin/dev` and `git rev-parse refs/omo/6274` = `b180fcec0a4c3ff63b9f230acc79e5f029bb6cea` (gate 1, gate 2). Branch `codex/omo-delegation-suggest` from `origin/dev`; `git cherry-pick 6c97ca9a4fdec6c59901fa115be341d9cc590a15..b180fcec0a4c3ff63b9f230acc79e5f029bb6cea`.
2. Ratchet watch: `src/server/management/agent-settings-routes.ts` must stay under 2,000 lines after the union; if not, apply shared gate 4 (byte-for-byte move of the suggest handler into a sibling module, separate "fix(carry)" commit).
3. PR `feat(subagents): suggest a delegation model by sizing the work (carry #6274)` with shared gates 5–7: template, screenshots from #6274's pr-assets, co-author trailer, security review, maintainer-integration record. Scope note (D8, gate 8): applies to Codex delegation defaults generally, not only LazyCodex.
4. Exact-head CI receipt with coverage assertion (gate 5), then `gh pr merge <n> --squash --match-head-commit <head SHA>`.
5. Close #6262, #6269, #6274 with a comment linking each carry PR and merge SHA, thanking @LilMGenius; resolve remaining threads with pointers.

## Acceptance

**Re-verification at P (2026-10-01, dev `da13a02727` = #6367).** Pinned `refs/omo/6274` is still `b180fcec0a`. The replay `6c97ca9a4f..b180fcec0a` on `codex/omo-delegation-suggest` hit one conflict in `gui/src/pages/integrations/LazyCodexRoleAutoAssign.tsx`. #6274 moves `TIER_LABEL`/`EFFORT_LABEL` into `sizing-labels.ts`, while #6367 hoisted `alreadySet` to module scope at the same spot. Resolved by taking #6274's move and keeping the module-scope `alreadySet` (gate 3). The rest applied cleanly (12 commits).

Gate 4 compatibility repair `881bb588f4` "fix(carry): keep sizing failure text out of delegation suggest responses": #6274's delegated-work suggest path reuses the sizing completion and still echoed raw error text, the same leak class the #6367 security review found. It now goes through `publicSizingError`, with a regression in `tests/codex-integration/injection-model-suggest-routes.test.ts`. `agent-settings-routes.ts` is 1,943 lines, under the 2,000 ceiling. React Doctor shows 0 diagnostics on the changed GUI files, and the privacy scan passes.


- Exact-head required checks pass with the gate 5 coverage assertion; diff equals L3 plus any listed "fix(carry)" compatibility commits.
- The polite live region stays mounted and announces running and completion text (`gui/tests/subagents-delegation-suggest.test.tsx`).
- `--apply` skips an already-matching setting and the suggest route is read-only until `PUT /api/injection-model` (`tests/codex-integration/injection-model-suggest-routes.test.ts`).
- Originals closed with links; goalplan criteria c-1 to c-4 met with evidence.
