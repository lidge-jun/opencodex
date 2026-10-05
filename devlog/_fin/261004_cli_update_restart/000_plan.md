# Guarded update restart

A newer CLI should be able to replace an older standalone proxy while preserving target ownership and confirming the exact launched replacement. This unit refines the public proposal in #6548; supervised cases remain explicit limitations until their replacement identity can be established.

- Archetype: satisfy-spec, one cohesive implementation cycle (wp1).
- Trigger: next-release replacement of public PR #6548 at fe3cf0aa823afd4144ab240191939ec6145b1c45.
- Goal: attributed draft PR targeting dev with focused lifecycle tests, independent review and current-head CI evidence.
- Non-goals: merge, source closure, release, installed-runtime operations, account changes, provider calls, version changes or native stacks.
- Verifiers: focused Bun tests, typecheck, structure/privacy/layout/ratchet gates; docs build for changed public prose. Full/changed local suites are impractical alongside concurrent release/lane work; hosted CI supplies wider evidence.
- Stop: publish reviewable focused change, account for source coverage, fix applicable defects or bound missing native/hosted evidence in draft.
- Evidence: ignored scratch holds investigation, review and test receipts. Public prose records only the already-public feature and published outcomes.
- Outcomes: DONE means this delivery scope is met, not merged or all native environments validated. Unresolved ownership or required scope expansion remains explicit.
- Escalation: changes outside CLI orchestration/tests/docs require scope review. No token/cost/time limit was specified; no paid upstream probes are allowed.

Base: dev 0818ea1812a028e1c14cd0b0511b44863407bc52. Source author: agentHits, 140916359+agentHits@users.noreply.github.com. Source consists of one commit and three files, with no native stack membership observed.

Baseline: 44 tests pass across system-restart-client and cli-version-skew after frozen dependency installation. Original public review requests handling failed stop, missing replacement version and behavioral regressions.

Current owner map: CLI index composes system-restart-client and tray-proxy; process-state owns runtime records; ownership-mutation-lease owns cooperative lifecycle serialization; proxy-liveness owns attestation/health; stop-approval owns settlement patterns; structure/runtime.md and public reference/cli/lifecycle.md describe lifecycle behavior.

The no-code alternatives do not deliver the requested newer-install restart. Existing unrestricted stop/start orchestration cannot satisfy the new target contract. Reuse the existing owner primitives and place the narrow orchestration beside the CLI instead of enlarging its index.

Architect consultation: Zeno (01a10493-8767-7422-8098-e28643decd60) proposed D1–D6. Main accepted eligibility, preserved snapshot, confirmed stop and exact replacement requirements; amended stop transport and child admission. Same architect reflected on the concrete scratch plan and returned ALIGNED, with transport/runtime evidence remaining implementation acceptance obligations. Independent audit follows. Family-level model independence is not claimed; the requested leaf model is gpt-6.1-sol.
The independent plan audit identified two lifecycle gaps; main amended the handoff and terminal result requirements. The architect rechecked D5/D6 and returned ALIGNED. Security analysis and detailed review remain in scratch.
