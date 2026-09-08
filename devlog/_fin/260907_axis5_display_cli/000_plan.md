# Axis 5: display names and provider automation

Date: 2026-09-07. Class C3, scoped satisfy-spec HOTL loop requested by owner.
Goal: deliver feasible unique changes from #3627, #2716, #3780 on dev with original author trailers.
Scope: display-only catalog metadata, discovered-model editor, optional JSONL CLI output, regression coverage and their docs. No auth/default/routing changes, native stacks, releases, or edits to existing dirty work.
Resources: existing repository/GitHub credentials and Astra high leaf agents; no user-set time/token cap. Isolated checkout /tmp/ocx-axis5-01a078d6. Owner authorizes no-verify push and admin merge. All local suites are prohibited; typecheck/build/test evidence will come from final combined GitHub CI. No invented lower-layer CI successes.
Terminal: merged, proven already delivered, or evidence-backed deferred when infeasible; finish after verifying all dispositions. New product decisions are isolated and deferred rather than guessed.
Records: this unit, .tmp/axis5-evidence, and session-bound .codexclaw goalplan.

## Roadmap

WP0: documentation-only source-delta and delivery plan, independent plan audit and document validation.
WP1: implement three scoped source carries with individual credited commits, publish ordinary manual PR chain, audit final tree, validate final combined head, merge verified layers bottom-up, and record dev ancestry.
The three layers are a user-requested review/integration sequence, not a claimed runtime dependency: native catalog -> JSONL CLI -> discovered editor. Source PR branches are never rewritten.
Read 010_delivery.md for diff-level scope and activation scenarios.

## Sources

- https://github.com/lidge-jun/opencodex/pull/3627
- https://github.com/lidge-jun/opencodex/pull/2716
- https://github.com/lidge-jun/opencodex/pull/3780
- Base dev: 137d6a7270e7ecfb1c791993800a17c0e30022d9
- Existing API display-name contract from #3212 is already on dev; only missing UI is carried.

## CI and merge

.github/workflows/ci.yml has pull_request triggers on all bases and workflow_dispatch lane=all for complete coverage. Pushes to feature branches do not independently trigger it. Defer/cancel only this task's lower-layer expensive runs as authorized, recording cancellation as cancellation. Dispatch all on final head; only if final CI fails use lower-layer runs to isolate. Do not edit shared workflow policy or fabricate check statuses.
Use merge commits and retain parent branches so commit identity and author trailers survive bottom-up merges. Retarget a child only after its parent lands. If dev moves concurrently, integrate the new dev into the top and refresh exact combined CI before shipping the resulting changed tree.
Review-ready requirements remain visible; local suite prohibition is explicitly documented instead of ticking a false local attestation. Admin waiver applies to the requested merge, not to truthful evidence.

CI scope refinement: the discovered editor is the final layer so the final commit and PR diff include gui/**, activating GUI lint/build/artifact jobs. ci.yml gates always run GUI tests; docs deployment is NOT dispatched because it publishes. Public docs receive static source consistency inspection here, with docs build explicitly unverified unless an existing build-only remote path is available.

CI scheduling refinement: lower-layer head commits may use GitHub documented [skip ci] to avoid push/pull_request suite launches; this yields missing/pending evidence, NOT green. Final head has no skip marker and receives lane=all workflow_dispatch. Source: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs (opened 2026-09-07). Admin merge records this explicit owner-requested lower-layer waiver. Do not propagate skip markers into integration merge messages.

## Terminal status

DONE: all three feature layers landed; see 020_delivery.md for exact commits, verification boundaries and deferred Mac test-runner investigation.
