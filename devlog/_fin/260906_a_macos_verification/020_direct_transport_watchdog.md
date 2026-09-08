# Focused verification watchdog correction

ClassC1: one test file, no production behavior or public API change. WindowsCIjob101361741694 hit the fixture's flat3000ms childwatchdog before routing assertions. The same child performs imports, an unbounded control fetch, two750ms probes and a2000ms read. The log cannot identify which stage consumed time.

Use the existing CI-watchdog owner for a derived whole-child budget:3000ms startup +2000ms bounded control +750ms identity +750ms readiness +2000ms read +1000ms exit =9500ms. OnCI the existing30s/45s floor applies. Give the test itself the child budget plus1000ms cleanup. Add fixed child phase markers and bounded phase/request-count diagnostics, never capability values. Keep every exact routing/header assertion and existing per-operation budgets. Bound only the previously unbounded control fetch.

Verify remotely on pinnedBun: originalfilechecks, an explicit3500ms pre-import delay underCI that succeeds withthecorrectbudget and fails withtheold3000ms guard, and an intentional memory-read misroute that fails the unchangedproxy/capability assertions despite valid-looking responses. No local execution. This is a causal verifier fix within the ongoing final landing repair loop, not an unconditional rerun or production timeout increase.
