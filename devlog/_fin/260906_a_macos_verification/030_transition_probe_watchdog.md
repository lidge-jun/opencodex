# Transition probe readiness budget

The next full Windows verification of the foundation (run33988432596, job101366851939) had one failure: the two-process transition initialization fixture reached its ten-second readiness deadline before both children published their barriers. No transition assertion ran. The same fixture passed in the fully verified stack tip33988434944. The failed log is retained; the exact slow operation on that runner was not captured.

The harness nevertheless has a concrete budget defect: before publishing ready, each Windows child resolves the effective SID and the known folder through two separately bounded thirty-second PowerShell calls. A ten-second enclosing deadline can reject valid operation within those existing product limits. This is a C1 fixture-only follow-up within the final landing cycle.

Derive the child budget from both identity calls plus startup headroom, use the existing CI watchdog on other platforms, and scale each outer test deadline to its sequential phases. Detect an exited child while waiting for a barrier so a crash cannot masquerade as slow startup, and await child exit before deleting its sandbox. Preserve every real process race, lock refusal, winner count, generation and database assertion; no product timing changes.

Verification requires remote pinned-runtime focused tests and typecheck, a delayed-ready control that passes the new budget and fails the old ten-second budget, an early-exit diagnostic control, independent review, and full exact-head cross-platform CI on the final stacked follow-up. No local test, typecheck or build runs.
