# 020 — wp2: carry PR #6813, atomic explicit account selection

**Reader summary.** Selecting a Codex account (or pin) through the management API can report success while a
later whole-config reconcile adopts a newer disk value, so the next request routes and authenticates as a
different account. #6813 (hulkbig, fork PR) commits the selection through the scoped persisted-config
transaction first and only then adopts it and resets routing. Fork CI needs approval the lane does not
have, so the lane carries it onto current dev in a maintainer branch where repository CI runs.

## Facts (origin/dev 730d898457)

- Before: `src/codex/auth-api/routes.ts:269-280` mutates live selection, resets routing, then
  `saveRuntimeConfig` → whole reconcile (`src/codex/auth-api/runtime-config.ts:24-25`);
  `src/config/live-reconcile.ts:325-341` adopts disk when live equals baseline.
- PR head `8441b1bc68`: new `src/codex/auth-api/account-selection.ts` (107 lines) using
  `mutatePersistedConfig` (`src/config/persisted-mutation.ts:37-90`, SQLite `BEGIN IMMEDIATE` lock
  `src/config/mutation-lock.ts:104-152`); `routes.ts` -49/+10; `live-reconcile.ts` +17 (selection-only
  advance); `rebase-provenance.ts` +11; docs in five locales; structure `config.md`,
  `providers/openai-accounts.md`; new test `tests/codex-integration/codex-account-selection-atomicity.test.ts`
  registered in both layout files.
- Merge onto dev is clean (tree `a86859108a`); #6811 (merged `c3bbaaa342`) overlaps only on the layout
  registries and `structure/config.md` and does not change the transaction API; #6792 has no runtime overlap.

## Change map

| Path | Action | Note |
|---|---|---|
| branch `codex/n5-6813-account-selection` from origin/dev | NEW | worktree `opencodex-lanes/261009-N5-small-6813` |
| commits `91e24b0c30`, `8441b1bc68` | CHERRY-PICK | authorship (hulkbig) preserved; no content change expected |
| any conflict in layout registries / `structure/config.md` | MODIFY | keep both sides' entries |
| security-review folds (if any) | MODIFY | separate maintainer commit with `Co-authored-by: hulkbig` |

## Verification

- `bun test tests/codex-integration/codex-account-selection-atomicity.test.ts tests/codex-integration/codex-auth-api.test.ts tests/config/config-user-edits.test.ts tests/codex-integration/codex-pool-rotation.test.ts`
  (targets named directly).
- `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts` (registration).
- `bun run typecheck`; `bun run structure:check` (structure docs changed); `bun run privacy:scan`.
- Activation scenarios to confirm in tests: same-value re-select of main against a newer disk snapshot
  (the original red case); persistence failure leaves routing untouched; post-publication exception
  reconciles to durable state.
- Independent gpt-6.1-sol security review (auth selection, races, credential exposure, error projection),
  then a general correctness review; exact-head hosted CI on the carry PR.

## Terminal

READY = carry PR exact-head CI green, both reviews PASS, MERGEABLE. After merge the coordinator closes #6813
with credit. Residual risks reported: recovery accepts any valid matching snapshot (observed-state, not
writer attribution); non-cooperating external writers after the final freshness check.

## Cycle revision (wp2 P, origin/dev 37e9294125)

dev moved to `37e9294125` (#6820 and the #6734 merge). #6820 also edits both layout registries that #6813 touches; the
union resolves that cleanly and the layout guards stay in C3. `git merge-tree --write-tree
origin/dev refs/remotes/pr/6813` is clean (tree `3d755f0d31`). #6811 is merged (`c3bbaaa342`) and orthogonal.

- **C1 branch.** In the lane worktree: `git switch -c codex/n5-6813-account-selection origin/dev`, then
  `git cherry-pick 91e24b0c30 8441b1bc68`. Both commits keep author Hulk <happyhls@gmail.com>. No content edits unless a
  review finding requires one, in a separate maintainer commit carrying `Co-authored-by: hulkbig <happyhls@gmail.com>`.
- **C2 reviews.** Independent gpt-6.1-sol security reviewer (01a12063-915d) and correctness reviewer (01a12063-926c),
  neither given builder context, review #6813's head against current dev in their own /tmp worktrees.
- **C3 checks (receipt, temporary HOME, carry branch checked out).** `bun test
  tests/codex-integration/codex-account-selection-atomicity.test.ts tests/codex-integration/codex-auth-api.test.ts
  tests/config/config-user-edits.test.ts tests/codex-integration/codex-pool-rotation.test.ts`, `bun test
  tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, `bun run typecheck`, `bun run structure:check`,
  `bun run privacy:scan`.
- **C4 publish and merge.** Push the branch, open a dev PR with the full template (Summary, Verification, Checklist),
  `Carries #6813`, and `Co-authored-by: hulkbig <happyhls@gmail.com>` in the body. After the exact-head CI and both
  reviews pass and the merge gate holds, `gh pr merge --squash --admin --body` with the trailer, then close #6813 with a
  credit comment (merged PR, merge commit, author). D closes on the carry branch before any record commit.

### Architect K1–K4 folds

- **K1/K2 tree binding.** Reviews start on the fork head; they count for the carry only if the carry branch tree equals
  `git merge-tree --write-tree origin/dev refs/remotes/pr/6813` for the dev SHA the branch was cut from (recorded in the
  PR). Any fold commit invalidates that equivalence and requires both reviewers to re-review the fold diff.
- **K3 receipt binding.** Receipts run with the carry branch's final SHA checked out (cxc binds commit + clean state); any
  later edit requires a fresh receipt. Minimal local scope is stated in the PR Verification section; the full suite and
  Windows/macOS shards are left to hosted CI.
- **K4 merge.** `gh pr merge <n> --squash --admin --match-head-commit <sha> --body-file <file>` where the file ends with
  `Co-authored-by: hulkbig <happyhls@gmail.com>`. The PR description carries the maintainer-integration record
  (MAINTAINERS.md `dev` exception) with exact-head verification. The dev ruleset (20763889) defines no required status
  checks; the gate requires every triggered check to pass, and the queued-enforce-target exemption applies only because
  no check is ruleset-required. Close #6813 only after the merge is confirmed.
- **Audit fold.** The merge gate also requires a fresh review-state read: no outstanding maintainer change request
  (resolved or withdrawn), recorded with the exact-head CI evidence. The queued enforce-target exemption keeps all three
  conditions (over one hour, all code CI green, reported). Each reviewer's examined union tree is recorded.
