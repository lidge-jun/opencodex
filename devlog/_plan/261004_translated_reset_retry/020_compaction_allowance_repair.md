# Repair emergency compaction target allowance

The first publication's local checks missed a compaction integration regression. Hosted test4/4 on #6555 head `9e8d7817fe458041a9410bf12b7758b1c40cc43c` proved that a configured three-send emergency provider made only two sends despite shared capacity for source plus three. This cycle restores that existing behavior without changing its assertion.

Loop: satisfy-spec follow-up to the prior D publication, with hosted failure as new evidence. Goal: repair and push the same PR with focused/local and current-head CI proof. Non-goals: merge/source closure/release/runtime/account changes, new retry owners, full/changed local suites, paid/live requests. Artifacts: this document plus ignored repair evidence. Stop: regression green unchanged, protections retained, independent review PASS, repaired head published and actual CI inspected. No user token/time budget was set; use bounded managed commands. Escalate scope/authority changes only.

## Evidence and root cause

The unchanged test is `tests/responses/responses-compaction-recovery.test.ts:340`; local RED reproduced Expected3/Received2. `compaction-recovery.ts:203` reserves the emergency child's first send against the shared budget and `:262` passes that permit. At dispatch entry, shared used=2 includes source1 and prepaid emergency1. `adapter-dispatch.ts:364` subtracts used-minus-prepaid from the emergency provider's configured attempts3, yielding2. That wrongly deducts the source provider's send from the emergency target's own initial ladder; the shared-budget intersection already accounts for it.

## Diff plan

- MODIFY `src/server/responses/adapter-dispatch.ts` initialSendCap only: treat a valid `compactPrepaid` handoff like combo admission for the target-local configured initial ceiling. Before: `options.comboAttempt ? 0 : sendsUsed - prepaid`. After: `(options.comboAttempt || compactPrepaid) ? 0 : sendsUsed`. Keep `Math.min(initialSendCap, remainingTransientSendBudget(initialSendCap) + prepaid)` unchanged, plus one-use permit and helper send reports. No change to direct/rebuilt deductions, absent-policy one-send behavior, grants or adapter-owned/post-header paths.
- MODIFY `tests/responses/responses-compaction-recovery.test.ts`: retain the original failing case and assertions byte-for-byte; add a small parameter matrix proving configured emergency attempts1/2/3 and shared cap2/3/4 intersect correctly, with reset opt-in present/absent. Synthetic upstream500, one source failure, assert emergency count and shared used. Reuse the existing fixture and no new registry file.
- MODIFY `structure/transports/responses-failover.md`: clarify emergency initial provider allowance is intersected with remaining shared capacity plus already-prepaid send; source provider usage is not deducted twice.
- Update this unit's verification record and PR Verification after actual results. Existing source coverage/attribution unchanged.

Main owns runtime/SoT/evidence; a bounded leaf may implement only the test matrix. No new abstraction, configuration, dependency or public type. Reuse existing cap and budget owners; configuring or deleting the refusal cannot repair arithmetic.

## Verification and acceptance

Executed baseline command: `bun test tests/responses/responses-compaction-recovery.test.ts -t 'emergency transient 5xx retry cannot exceed the shared cap'` failed0pass1fail for the hosted signature. After repair run the full compaction file plus translated-reset, send-count, reset-replay, Fast-downgrade, and core-lab tests. Run typecheck, structure/privacy/layout/ratchet gates. Do not repeat passing checks on unchanged code. The original case must show three emergency sends and totalused4; cap2 allows one emergency, cap3 allows at mosttwo, configured1 remains one. Existing35 translated cases retain exact direct/rebuild totals, prepaid last-slot, default-off, cancellation, no post-output replay and loopback behavior.

Independent architect and audit will assess the proposed target handoff boundary. Fresh final review inspects arithmetic/negative tests and no weakened assertions. Hosted ordinary PR checks run after push; no release dispatch or merge. The prior source was closed by the coordinator, not this lane.

Architect proposal/reflection CR-D01–D05 ALIGNED: target-local admitted handoff; unchanged shared clamp; direct and absent-policy behavior intact; permit/reporting intact; grants intact. Main accepts all. Matrix expected emergency sends by attempts1/2/3 and cap2/3/4: `[1,1,1]`, `[1,2,2]`, `[1,2,3]`, each with reset present/absent. HTTP500 matrix proves policy neutrality, not reset-grant exhaustion; retained reset tests own the latter.
