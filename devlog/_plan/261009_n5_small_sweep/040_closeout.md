# 040 — wp4: merge and closeout

**Reader summary.** Added at wp3 P (LOOP-UNIT-CHAIN-01) after the coordinator granted merge authority. It merges the
lane's two published PRs under the gate in `000_plan.md`, closes the originals they replace or fix with credit, and
produces the final lane report. #6734 already merged in wp1 (`37e9294125`).

## Steps

1. **#6824 (carry of #6813).** Refresh: `gh pr view 6824 --json baseRefName,headRefOid,mergeable,reviewDecision`,
   `gh pr checks 6824` (every triggered job pass or skipped; none failed, cancelled or pending; queued-only
   enforce-target over one hour with all code CI green is reported as non-blocking), review threads and change
   requests (none outstanding), fresh `git fetch origin dev` + `git merge-tree --write-tree origin/dev <head>` clean.
   If dev changed any file the PR touches since `37e9294125`, rerun the wp2 focused tests on a union in a lane-owned
   worktree first. Post the maintainer-integration record and both review verdicts as a PR comment. Merge with
   `gh pr merge 6824 --squash --admin --match-head-commit <head> --body-file <file>` whose body ends with
   `Co-authored-by: hulkbig <happyhls@gmail.com>`. Confirm `state == MERGED` and the trailer in the merge commit, then
   close #6813 with a thank-you comment naming #6824, the merge commit and the credit.
2. **#6757 PR.** Same gate; standard review PASS plus the boundary security pass named in 030. Merge, confirm, then
   comment on #6757 with the PR and merge commit and close it. The comment states the residual: the root cause of the
   preference loss is unproven; the new load warning covers the schema-fallback path.
3. **Flaky handling.** A failure that looks like a timeout gets one rerun of the failed jobs. Conflicts or real failures
   go back to a fix commit on the lane branch, then fresh CI and, if code changed, re-review.
4. **Report.** Record merged PRs, merge commits, closed items, NEEDS_HUMAN items and worktree paths in
   `041_closeout_record.md` on `codex/n5-small`, and deliver one final lane report.

## Verification

Evidence is GitHub state read at the time of each action: `gh pr view --json state,mergeCommit`, `gh issue view
--json state`, and `git log -1 --format=%B <merge sha>` for the trailer. No code changes in this phase; if a fix
becomes necessary, it follows the owning phase's tests.

## Architect Z1–Z4 folds

- Check classes: the dev ruleset (20763889) defines no required status checks, so "skipped" means a job whose path or
  trigger condition did not apply on that head; any other non-success fails the gate. The queued enforce-target
  exemption applies only under its three stated conditions.
- Union reruns use the **owning unit's** commands: 020 C3 for #6824, 030 Verification for the #6757 PR, each bound to
  that PR's current head and fresh dev.
- wp3 ends with its PR published and its final-head evidence recorded (receipt, reviews, PR link) in the D attest;
  wp4 starts from those published heads.
