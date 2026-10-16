# L2 — Anthropic account pool

Worktree `/tmp/ocx-rt6-l2`. Items: #6204, #6207, #6203 (fix-up), #6234 (carry); #6244 investigation only. Security-sensitive:
OAuth account admission, persistence and selection.

## #6204 / #6207

No code change expected. Dry run on a disposable branch `rt6-dry-l2-6204-6207` (never pushed):
merge #6204's head into origin/dev, then #6207's head; report conflicts; then switch away and delete
the dry-run branch before any other L2 work. Every L2 work branch starts from `origin/dev` or from the
named PR head, and the worker checks `git log origin/dev..HEAD` before each push.
Independent security reviewer (separate agent) reviews #6204 and #6207 exact heads.
Coordinator merges #6204 with a merge commit, retargets #6207 to dev, re-reads CI, merges.

## #6203 fix-up (in place, branch `fix/6197-anthropic-cooldown`, head 89ee638c3b at survey time)

Address @luvs01's three P2s (threads at `src/providers/quota/vendor-probes-oauth.ts:340` and
`src/providers/quota/anthropic-cooldown-recovery.ts:88` on the PR head):
1. a probe started after recovery must not join an older in-flight request;
2. a superseded null/rejected result must not overwrite a newer negative-cache entry;
3. a successful cache entry keeps the live `isCurrent` predicate.
Add a three-flight regression in `tests/adapters/anthropic/anthropic-cooldown-recovery.test.ts`.
`src/providers/quota.ts` is at its 558-line cap: net growth there must be zero.
Commit on top of the observed head; re-check `gh pr view 6203 --json headRefOid` before push; no force.

## #6234 carry (branch `codex/rt6-l2-combo-account-cooldown`)

Cherry-pick the PR commits onto origin/dev (if they conflict with #6204, report rather than basing
on unmerged work). Semantics:
skip the combo target cooldown in `src/combos/resolve.ts:385-400` (called from
`src/server/responses/core-combo.ts:970-979`) only when the 429 is attributed to a pooled account
that was itself cooled (`src/oauth/anthropic-routing.ts:725-765`); unknown-account 429s and other target
failures still cool the target; API-key and generic OAuth pools unchanged.
Tests: `tests/server/server-combo-cooldown-recording.test.ts`,
`tests/adapters/anthropic/anthropic-combo-account-cooldown.test.ts` (PR-new), plus negative cases.
`Co-authored-by` vadymhimself, per the credit rule in 000_plan.md.

## #6244 main hard lock stuck on a stale short window — investigation only in RT6

Defect (issue #6244; anchors verified on dev by the A reviewer): `assignCarriedShort()` in
`src/codex/quota.ts` (around 257-269) keeps a blocking (>= 98) policy short tuple indefinitely,
`getMainAccountHardLockStatus()` (`src/codex/main-account-hard-lock.ts:42,67-74`) blocks on it, and
`runMainAccountHardLockRecovery()` (`src/codex/auth-api/pool-mode-gate.ts:79-150`) only ever sees
weekly-only snapshots. The maintainer change request on #6188 says omission of a short window does not
establish that it fell below 98%, and the stored policy quota keeps only the latest `updatedAt`, not an
observation series. Any automatic admission rule therefore needs either a provider contract or an explicit
owner policy decision, and removing the tuple at 0% weekly usage yields `ready`, not `unknown`.

RT6 action: no behavior change. The coordinator asks the owner for the policy (automatic release after a
bound vs. operator-actionable clear vs. keep blocked). Without an answer during the train, #6244 is
recorded DEFERRED with this analysis and the workaround from the issue body; it is not in the merge train.

GUI evidence (#6207 changes GUI components, ten locale catalogs and three GUI tests; the root
`tsconfig.json` covers only `src`): run `cd gui && bun install --frozen-lockfile && bun test
tests/provider-account-pause-refresh.test.tsx tests/anthropic-pool-quota-window.test.tsx
tests/provider-quota-refresh-controls.test.tsx` and `bun run build:gui` on the dry-run tree, or cite the
exact-head CI jobs that ran them, before reporting #6204/#6207 READY.

Verification for the lane: per landed item: `bun test tests/adapters/anthropic tests/oauth/oauth-accounts-api.test.ts tests/cli/cli-account-pool-verbs.test.ts tests/server/server-combo-cooldown-recording.test.ts`,
`bun run typecheck`, `bun run skill:surface:check`, `bun run structure:check`.
