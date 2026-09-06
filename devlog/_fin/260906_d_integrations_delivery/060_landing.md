# 060 — D integration and final verification

This operations/verification cycle consumes all five implemented candidates and any explicitly recorded repair work. Main owns it; no new feature scope is implied.

## Loop specification and current handoff

Archetype: integration/evidence closeout. Trigger: all five candidate cycles and their repair cycles have completed. Goal: published D changes and contributor history are on dev, originals are closed with honest remainder tracking, and the completed record is archived. Non-goals: new runtime features, release promotion, dogfooding or unrelated cleanup. Verifier: `.tmp/d-delivery/verify-final.py --ci-head <integrated-source-sha>` and its later `--docs-pr <number>` form, plus remote privacy verification of the docs-only closeout. Stop: merged archive record, successful actual integrated runtime CI and all durable criteria met. Memory: this unit,070 result and ignored JSON/log receipts. A failed or pending gate remains open. Main owns operations; an independent reviewer audits the plan and final evidence. Main reclaims any failed sidecar after two distinct failed packets; new write scopes require a plan amendment.

The preceding D accepted remotealias candidate022887702 with remote full19,751/15/0,292 focused tests, typecheck/docs425, privacy/final-patch Gitleaks and independent reviews. PR3720 still needs integration when this handoff is written. Replay/cache remains separately tracked in3719. Earlier D originals3669/3673/3628/3625 and Cursor follow-up3715 are already on dev; final verification rereads their actual state.

The verifier deliberately refuses an OPEN3720 or a CI head preceding its merge. Its existence and refusal can be audited now; a passing final receipt is only possible after those prerequisites occur. It fetches dev, checks each merge's ancestry in both dev and the tested CI head, checks original/follow-up disposition and preserved authored commits, rejects unresolved carry-review threads, and requires actual Linux four-shard/macOS two-shard/gates/aggregate success. Dispatch-only skips are recorded separately.

## Exact action map

- Read live head/base/reviews/checks for every D carry; compare source-original current heads before closing them. Preserve contributor commits and Co-authored-by trailers.
- Integrate bottom-up with owner-authorized admin merge. Verify fetched origin/dev contains each merge SHA. Retarget every open child immediately; preserve its unique commits and branch identity. A squash requires cascading descendants before further readiness claims.
- Close superseded originals3669/3673/3628/3625 only after actual dev ancestry proof. Resolve3646's alias slice and explicitly preserve its separate thinking/cache request in an exact-scope existing or templated follow-up before closing it; never claim the alias patch fixes cache behavior.
- Reconcile all valid late findings and real CI failures. Any required source repair is planned with exact files/activation before patching; a new independent feature becomes a separate appended cycle, not hidden work here.
- Capture a final integrated dev SHA containing all five fixes and verify actual GitHub CI producers and aggregate on that SHA. Queued/cancelled/skipped application tests are not passes. Record platform dispatch-only limitations honestly. c-2 cannot be met until integrated CI succeeds.
- Recheck shared B locale/model-alias changes and A/C touched seams at final dev. If their source inputs changed the rendered Logs surface, repeat only affected browser scenarios; retain immutable sanitized screenshot URLs.
- Move this completed unit to devlog/_fin only after the published outcome is verified, recording final heads/run URLs/author/source dispositions. Detailed pending security notes remain in ignored scratch; publish only resolved outcomes.

## Evidence and boundaries

Use .tmp/d-delivery JSON/log receipts, current GitHub APIs and git merge-base --is-ancestor checks, never old labels or remembered output. Preserve the managed worktree and unrelated edits. No local suites/typecheck, no release/main/preview or dogfood operations. Every push uses --no-verify. Final goal completion requires all original criteria plus late-review and final-CI criteria; this page does not weaken any earlier bar.


## Archive implementation and checks

After source integration and actual integrated CI succeed, merge the current dev into the closeout branch with hooks disabled. Write `070_result.md` using only verified public outcomes (PR/issue links, merge/run hashes, test scope and attribution), update050's neutral pointer to the published outcome, and move this unit to `devlog/_fin/260906_d_integrations_delivery/`. Keep private050/051 threat/design notes in ignored scratch. Preserve all unrelated A/B/C records and runtime files.

Publish a template-compliant docs-only PR targeting dev. Verify its changed paths are solely this unit's devlog records, and validate the current archive checkout through remote privacy scan and source-tree equality. Admin-merge that record after the docs checks, fetch its ancestry and run the final verifier with its PR number. The P-to-A plan-artifact gate only requires the current plan directory at entry; archiving the verified unit later in B/C is the intended terminal operation, not a new feature. Do not hand-edit FSM/task completion flags.
