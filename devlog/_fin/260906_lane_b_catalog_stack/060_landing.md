# Land the verified catalog stack

## Before and after

Before: five original contribution PRs are open, their carried changes form separate reviewed branches, and dev may have advanced from peer lanes. After: all five behavior contracts are reachable from dev, source authors remain credited, replacements and originals are closed appropriately, and resolved issues #3650/#3651 are closed with landing proof.

## Exact change map

- MODIFY this unit's numbered completion record with replacement PR numbers, source/current SHAs, CI URLs, merge SHAs and issue closure results.
- MODIFY child PR base refs from the open parent branch to dev after parent landing. Keep local and remote parent refs until all children are safely retargeted.
- MODIFY a branch only for demonstrated integration conflicts or failing current-head checks. Preserve unrelated A/C/D work; resolve shared config fields, locale keys and alias helpers by combining contracts, never choosing an entire side blindly.
- CLOSE original #3653/#3654/#3571/#3659/#3649 as superseded only after the respective replacement's merge commit is on dev.
- CLOSE #3650/#3651 only after full visibility/context acceptance criteria are satisfied.
- MOVE the finished public unit from `_plan` to `_fin` only at terminal completion. No credentials or private audit material enters this unit.

## Sequence and activation scenarios

1. Fetch dev; compare each queued replacement to its reviewed head. Trigger: peer dev advanced. Effect: inspect actual overlap, merge/reconcile dev into the affected layer, cascade to children and rerun exact-head checks when the tested tree changed.
2. Confirm each lower layer's CI has actual typecheck, functional tests and GUI gates where applicable; inspect required review findings including security review. No stale approval is reused after code changes.
3. Merge the bottom PR with a merge commit when allowed to preserve ancestry; verify GitHub merge state plus `git merge-base --is-ancestor <merge-sha> origin/dev` after fetching.
4. Immediately close the carried source PR with replacement and landing evidence; close linked issue if its complete report is addressed. Preserve original contribution trailers in merge/squash content.
5. Retarget the child before cleanup; compare `git diff <new-base>...<child>` to its intended layer. If a squash changed ancestry, restack rather than leaving already-squashed content in the child diff.
6. Repeat until all five are landed. Assert final ancestry, original PR/issue states and clean tracked work. Record remaining unrelated items without expanding scope.

## Verification

Before final landing, dispatch `ci.yml` with `lane=all` on the final integrated stack head and verify all six Windows test shards in addition to Linux/macOS. Ordinary PR runs skip Windows test shards; Windows keyring/package smoke alone is not full Windows test evidence.

Read-only `gh pr view`, `gh run view` and `gh issue view` supply fresh state; assertions operate on exact numbers/SHAs, not titles. Git ancestry checks run locally; repository tests do not. A C receipt wraps the read-only verifier and must fail if any required original remains open, intended merge is absent, CI did not execute real tests, or attribution is missing.

Expected outcome is DONE. Pending CI, a conflict or a repairable review finding continues the same goal. An external blocker is recorded with exact evidence rather than closing the remaining work as complete.
