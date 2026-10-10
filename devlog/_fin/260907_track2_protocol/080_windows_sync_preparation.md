# Windows competing-OFF preparation allocation

## Failure and bounded plan

Final run 34054412656 passed every individual job except Windows shard 6. The competing-OFF test refused to begin its real second-process flip: 32,262 ms remained of the 85,000 ms child budget after 52,738 ms of preparation. The unchanged flip plus reap requires 45,000 ms. This was a pre-flip budget rejection, not an outer timeout or a product assertion failure. Unlike the composed fixture, this test already inherits the ambient child environment; no cache-causation claim is made.

MODIFY only the test's named preparation allocation: on Windows reserve two existing boot budgets for import, identity and admission preparation, then retain the original single flip and reap budgets. Windows CI child/test limits become 125/130 seconds; other platforms retain 85/90. No product deadline, assertion, coordinator, identity or service evidence changes.

## Remote control

Diagnostic run https://github.com/lidge-jun/opencodex/actions/runs/34056824267 checked out fixed source 0f8936b1f692d72ff1d2c1dd6218183dd0e9b882 and used a 52-second TOTAL preparation floor before the original remaining-budget guard.

- Unchanged control passed and completed its real flip.
- Old allocation rejected the floor before flip, without timeout.
- New allocation completed the real flip and passed the original skip and unchanged-config assertions.
- With the new allocation, a one-site diagnostic mutation stored ON for the OFF request. The real flip process completed successfully, but the original result assertion failed: applied instead of skipped/desired_disabled. No timeout or budget refusal contaminated that failure.

The isolated job restored both files byte-for-byte. Its synthetic floor, traces, workflow and production mutation are excluded from delivery. This proves the preparation allocation and test sensitivity to broken OFF persistence, not every downstream guard. Independent diagnostic security review passed. Full integration CI remains the delivery gate; no local suites, typecheck, install or build were run.
