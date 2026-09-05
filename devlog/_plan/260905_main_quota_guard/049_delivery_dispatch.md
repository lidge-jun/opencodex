# Final delivery dispatch contract

This is wp3, following the completed feature cycles. Bound checkout8841 only. Original authorization includes no-verify pushes and admin merge after green CI/no unresolved defects; it does not include deployment, reset credits, installed-app changes or other checkout cleanup.

## Locked stack inventory

- PR3552, codex/main-account-99-hard-lock → dev, head473934e9a691cd9c987f75a8527fbb788dfe8f8c; CI33939734355.
- PR3560, codex/main-account-99-settings → runtime branch, headb3539dd9c346c0a44b21fc4970228a65aee82555; CI33939735142.
- PR3578, codex/luna-reserve-compatibility → settings branch, head460991765a4bef2f8f3bd98d46135e5955c765e1; CI33940230688.

These are P-time observations, not immutable future merge authority. Refresh head/base/state/labels, all status checks, reviews and review threads immediately before each external action. A changed head invalidates prior green evidence. No empty required-check list counts as success; require the actual aggregate ci and all selected platform jobs. Source review findings must be fixed/rebutted with evidence, never dismissed for convenience. Stale governance review requirements may only be bypassed under the owner's explicit admin authorization after every technical condition is satisfied; record that authorization, do not rewrite another review.

## Bottom-up operations

Use admin squash as040 planned. Before3552 merge, require its complete current-head CI (including all remaining macOS jobs) and no unresolved current technical finding. Merge with --match-head-commit. Fetch origin/dev and prove returned merge SHA is an ancestor of origin/dev.

After squash, retarget3560 to dev and rebase only its UI layer from the freshly recorded old runtime/head range onto the fetched dev tip. The observed d48b32203..2ebe76de7 range contains four UI commits; preserve all of them. Then rebase Reserve's own commits from the recorded old UI head onto the new UI head. Preserve any newer collaborator commit; explicit force-with-lease must name the immediately observed remote tip. Inspect range-diff, ancestry and PR bases before pushing. This plan document can ride the next unavoidable Reserve restack; it must not be presented as part of the earlier remote head before publication.

Require fresh full current-head CI and review re-verification after every cascade. Merge3560 only then, with --match-head-commit naming its rebased head; fetch/prove ancestry again. Retarget3578 to dev and rebase its own layer from the exact rebased UI head that was just merged (not the original P-time inventory head) onto fetched dev. Repeat range-diff/lease/base verification and full exact-head CI. Only then admin squash3578 with --match-head-commit and prove fetched dev ancestry. Never force integration branches or delete/move the managed checkout.

No code repair is presumed. If CI or review exposes a concrete new defect, capture the failing head/log, amend the narrow repair contract, obtain source review, fix only that cause and reverify the affected stack. Do not run local suites, including focused tests; CI is the test authority. Static source checks are distinct from test execution.

## Closeout and evidence

Record source heads, full checks, reviewer closure and merge SHAs. Once all intended implementation is public, write the terminal evidence and move this unit to devlog/_fin. If that requires a separate docs-only closeout PR after code lands, use the same template/CI/admin-merge gates and state its documentation-only scope. Do not falsify evidence or amend a merged layer. Closeout may not trigger a release, service restart or deployment.

Final C receipt must bind a remote verification command to the current source tree; it must not execute a local test suite. Confirm every merged SHA against freshly fetched dev, clean bound worktree and no remaining required work. Then complete delivery tasks/criteria with evidence, obtain the current-tree C receipt, close D to IDLE (which marks wp3 done), validate goalplan E8, and only then complete the host goal. Never hand-mark the unfinished phase done merely to satisfy E8. The final response must disclose that live Reserve-active inference was not exercised and that no local suite/deployment occurred, and include the already captured settings screenshot. Any unresolved prerequisite is reported without claiming completion.

The user subsequently added mixed Team/Plus/Pro pool rotation to the same request. This extends the chain, not the current build slice: after wp3 genuinely closes, enter P and append/audit that unit before implementation. Completion of this original stack must not be reported as completion of the expanded request, and the host goal must not be marked complete while the pool follow-up remains owed.
