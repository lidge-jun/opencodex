# wp4: current-dev integration and issue/PR closeout

## Change and PR shape

One ordinary `dev` PR will contain the audited wp1 pause carry, the narrower wp3 auth rotation, updated docs/tests, and this lane record. Before push, fetch latest `origin/dev`, replay the branch onto it without overwriting another branch, inspect the union for file-size ratchet and closed unions/locales/counts, and rerun affected tests. The PR is not a native stack. Its Summary/Verification/Checklist sections follow `.github/PULL_REQUEST_TEMPLATE.md`; the GUI screenshot is uploaded to the separate `pr-assets` branch at a commit SHA and linked in the description, not committed on this branch. Include both exact `Co-authored-by` trailers in the branch commit(s) or PR body so squash preserves contributor credit.

## Verification and merge gate

- Run exact focused regression files from [010_pause.md](010_pause.md) and [030_auth_failover.md](030_auth_failover.md), plus `bun run test:changed` from a same-commit `/private/tmp/t4-account-pool-verify` checkout, `bun run typecheck`, `bun run lint:gui`, `bun run build:gui`, `bun run privacy:scan`, `bun run structure:check`, and `bun run skill:surface:check`. Record each command, exit, pass/fail counts and scope. If full local `bun run test` is disproportionate during seven concurrent lanes, say so in Verification and rely on the actual required hosted CI, never an unrun suite. Any full local suite also runs in that `/private/tmp` checkout; do not bypass the test cleanup guard under `~/.codex`.
- Confirm `origin/dev` is an ancestor of the PR head at merge time; otherwise rebase and revalidate. Inspect `git diff origin/dev...HEAD` for mixed PR union, ratchet overages and exhaustive union/locale/count consumers.
- Obtain an explicit independent auth/security review and resolve correct Codex/CodeRabbit findings. A review finding still open is not treated as approved by self-integration.
- Inspect required checks by head SHA, event, run id/attempt and individual job conclusions. Missing, skipped, cancelled, approval-blocked, pending and old-head results are not success. Record the maintainer-integration decision and exact-head evidence if using the authorized `dev` exception; never direct-push to `dev`.
- Merge the PR only when every required check is successful at that exact head. Read back merge SHA and `origin/dev`; inspect post-merge `dev` CI and repair a regression from this lane before closing.

## GitHub disposition writes

After the change is on `dev`, thank and close #6087 as fully carried, linking our PR and `dev` SHA. Thank #5099's author and comment that only its bounded Antigravity status-rotation slice landed; keep #5099 open because its proposed persistent health/recovery remains independent and unmerged. Explain why the dynamic 15-rotation change was rejected for this train. Leave #5956, #5879 and #3738 open after posting specific English hold comments; avoid posting duplicate comments if another lane already changed their premise. Comment on all nine lane issues with a link to the relevant fix or the concrete reason and next evidence needed. #4878 has its P1 comment in wp2; do not close it without a controlled both-exhausted fix. #3375 and #3376 are umbrella issues and remain open unless every recorded requirement is demonstrably on `dev`.

Read back every posted comment/state and record links. Do not close a source PR merely because a related subfeature landed if its remaining contract is still intended for review; if a source author materially updates a held head during this lane, re-evaluate before posting a stale verdict.

## Final report

Give merged PR number and `dev` merge SHA; for each candidate state as-is/cherry-pick/squash/batch/reimplementation/hold; link closed source PRs/issues and hold comments; list local commands/results and exact-head/merge CI run URLs; name residual client, security or provider behavior that was not proven and files likely to collide with other lanes.
