# 014 — Restore and same-owner process-bound proof

Parent run33947540953 passed both original native failures: exact config-path
and alias tests, all12 startup recovery scenarios, both manual scenarios, and
Pool behavior. It remained red solely on restore-app-rewrite's15second case.
The goal remained active and this child layer repairs that process-bound class.

| Controlled probe | Actual result |
|---|---|
| Restore16s delay, old15s case | Failed15.005s; statusnull/SIGTERM, runner reaped dangling child |
| Same delay,45s command/90s case | Passed16.677s, original3config assertions |
| Restore46s delay,45s command | Failed45.009s with SIGKILL/ETIMEDOUT, not an outer-case timeout |
| Omitted command limit, same46s delay | Passed46.610s; defeats a timeout-expecting validation driver |
| Voluntary restore-child exit7 | Explicit status7 diagnostic,7.75ms |
| Restore function omitted | Original openai_base_url-removal assertion fails on retained proxy URL |
| Contender16s delay, old10s command | ETIMEDOUT/SIGTERM after seed+contender26.500s |
| Same delay, full contender bound | Busy/retryable and unchanged bytes all pass,32.606s |
| Write-before-lock mutation | Busy result remains but original no-20200 assertion fails |
| Missing holder marker | Labelled failure and clean join,0.498s |
| Holder ignores release | Forced termination/join fails explicitly, exit137,5.591s |
| Stale-ON under-lock predicate | Original desired_disabled oracle fails on statusapplied |
| Expired nested budget | OFF child not launched; labelled failure,0.270s |
| Guard omitted with same expired budget | Normal operation succeeds; defeats refusal-expecting probe |
| Nested exit7 | Labelled flip failure propagates, not swallowed by discovery |
| Nested short deadline +delayed writer | SIGKILL/ETIMEDOUT labelled at flip layer, before write |

All probes were local focused tests. All production/helper/script mutations and
fault values were restored. Normal restore file:5pass/18assertions; full lock
file:17pass/85assertions; full sync file:13pass/56assertions; typecheck and diff
checks pass. Independent implementation review: PASS, no blockers.

No production source change is included. The additional two files were selected
by a read-only same-owner inventory; other unmeasured candidates were not changed.
Windows all-shard green on this full stack is still required before completion.

Before the next dispatch, current dev a53775103 was merged into the parent and
cascaded into this child. The reviewed test changes stayed byte-identical.
Combined isolated focused verification:90pass/0fail/446assertions across5files
in17.70seconds; typecheck passed. No local repository-wide suite was run.
