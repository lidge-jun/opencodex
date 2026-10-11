# 010 — wp2: shepherd and land wave-1 lanes, then wave 2

Previous D (wp1): roadmap locked; direction is to shepherd six wave-1 lanes to green PRs, merge in the documented order with security review for flagged items, then dispatch the wave-2 provider-carry lane (#4177, #3282, #4228). This plan keeps that direction.

## Inputs

- Lanes (Opus 5.5, own worktrees, own cxc-loop): claude-cli-api `01a0e6e0-615f…`, provider-small `01a0e6e8-7b5e…`, devin `01a0e6e8-7b64…`, reasoning-zen `01a0e6e8-7c2f…faa1`, platform-service `01a0e6e8-7b5f…`, account-pool `01a0e6e8-7c2f…fa93`.
- Wake: heartbeat `opencodex-rt5-coordinator-heartbeat` every 15 minutes targeting this task.

## Per-PR merge procedure (coordinator only)

1. `gh pr view <n> --json headRefOid,mergeable,isDraft,baseRefName`: base must be `dev`, not draft, mergeable.
2. `gh pr checks <n>` on the current head: the aggregate `ci` job passes, and with it `gates` (typecheck, lint, privacy), `structure gate` when structure paths change, `test 1-4/4`, `hygiene`, `enforce-target`, `storage policy`, `api usage`. This is the PR-triggered CI only; for native-path changes the aggregate also waits on the PR-triggered macOS jobs, which are part of that simplest gate rather than a manual dispatch. Skipped-by-path jobs are fine; pending or failed required jobs are not. The manual `workflow_dispatch lane=all` cross-platform run is not used per PR. CodeRabbit is ignored.
3. Heuristic diff review: scope matches the lane's items; tests added for behavior changes; no file-size cap raised; test-layout entries present; carries carry `Co-authored-by`. Security-boundary items from the roadmap get a line-by-line read of auth/credential/workflow/dependency hunks.
4. `gh pr merge <n> --squash --match-head-commit <sha>`. `--admin` only under the MAINTAINERS.md dev bypass: the merging account (lidge-jun) holds admin, the PR has no outstanding maintainer change request, a PR comment and the ledger record the maintainer-integration decision and the exact-head CI evidence before the merge, and the sole blocker is the missing second-maintainer approval.
5. After each merge: ask any lane whose PR now conflicts to rebase; close superseded contributor PRs with a credit comment and close issues whose fix is on dev.
6. Ledger timing: before merging, add a row to `020_merge_ledger.md` with the PR, exact head SHA, lane, decision, and checks observed; after the merge, fill in the merge SHA on that row.

## Order

Follow the roadmap integration order: #5539 before #5995; #6096 → #6123 carry → #5099; #6121 before #5956. Otherwise first-green-first-merged, provider-compat fixes ahead of platform and pool work.

## Acceptance for wp2

- Every wave-1 and wave-2 item is merged on dev or recorded as dropped with the lane's reason.
- claude-cli API-group PR merged (criterion c-2).
- Ledger lists each merge with SHA and the checks observed.

## User order (17:15): no local tests

No lane, subagent, or coordinator runs local bun tests, typecheck, GUI builds, or verification proxies. The coordinator killed all such processes at 17:15. PR CI on GitHub is the only test evidence; PR Verification sections state that local tests were skipped by maintainer instruction.
