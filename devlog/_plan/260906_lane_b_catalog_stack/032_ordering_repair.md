# Ordering check repair

The first remote check of 1c2616bfd failed 14 new production-writer cases; no failing result was treated as a pass. Investigation separated fixture isolation from a production defect.

The fixture now provides a runnable deterministic Codex command through forced refresh, asserts runtime identity, uses the current featured-roster migration marker, and checks effort arrays without mutating metadata. Full catalog equality and the same five OpenCodex guidance candidates remain required.

Fresh row derivation could copy opencodex_spawn_priority from a previously ordered native template. Assigning a new featured priority did not replace that inherited private rank, so repeated healthy writes could change the guidance window. Fresh clones now clear that previous row's private marker; retained-row markers and reader behavior are unchanged. Direct dirty-template and repeated real-writer regressions cover the cause. Remote causal confirmation and reruns are required before closing this repair.

The native-consumer audit also corrected an overbroad explanation: OpenCodex natural-priority guidance and native Codex's advertised five are separate. Native advertisement may follow display priority on V1 and exposed V2; exact-name override eligibility is not limited to that advertisement. This clarification preserves the existing #1649 design and does not waive the failing natural-guidance assertions. Current code comments, configuration reference and eight ordering guides now make the distinction explicit; the original source-diff appendix remains historical evidence.

No local tests, builds or typechecks were run. Verification must use the repaired committed head and retain red/green, runtime identity and teardown evidence.
