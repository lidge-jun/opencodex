# Verified stacked integration and closeout

## Changes

No production changes planned. MODIFY phase records with evidence; move this completed public unit from `devlog/_plan/260906_a_runtime_stack/` to `_fin/` only after all units have a terminal outcome. Private security evidence remains ignored.

## Procedure

1. Refresh each original and replacement PR head, base, unresolved reviews, required checks, and live dev. If source author advanced, compare unique new commits before disposition.
2. Require actual current-head full cross-platform tests and typecheck/privacy gates, not intake-only green or old author attestations. Record remote focused triggers as supplementary proof. Repair test failures by cause; never claim retry alone fixed a failure.
3. Verify each child contains its current parent's head and its base points at the parent. Merge the bottom with source author's account-linked Co-authored-by trailer preserved in squash body, or use merge commits to retain ancestry. Push owned branches with --no-verify; any necessary rewrite uses explicit --force-with-lease on owned refs only.
4. Retarget the next child to dev, rebase/merge as needed after a squash, verify its diff and fresh checks. Do not delete a parent branch before child retargeting.
5. Immediately fetch dev and prove `git merge-base --is-ancestor <landed-sha> origin/dev`. Close the superseded source PR with the replacement PR and landing SHA. For original PRs directly merged, record merged state.
6. Read linked issue acceptance scope. Close only fully solved issues; #3661 MESSAGE recovery is partial and must retain the residual issue. Do not use automatic Closes for partial work.
7. Check final dev CI on its exact current SHA. Record all original/replacement PR URLs, contributor trailers, merge SHAs and issue dispositions. Complete goal only when every criterion has captured evidence and all FSM cycles closed.

## Activation and failure cases

Source-author update: compare the new head, carry any still-needed change and reverify. Concurrent dev movement: integrate it without losing another lane's changes. Squash changes parent identity: cascade child before any merge. Failed CI: inspect exact job/step logs, fix the failing scope, re-run on new head. Unresolved issue scope: leave open with specific residual, never close to improve counts.

## Verifiers

Run read-only `gh pr view`, `gh pr checks`, `gh run view` and `git merge-base --is-ancestor` at the real current heads. Local git ancestry and static diff checks are allowed. Runtime/typecheck/build verification occurs on GitHub Actions or isolated the isolated remote verification host checkouts only. Full CI pending means this landing cycle remains active.
