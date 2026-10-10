# CI test-boundary evidence

## Launcher observation: not closed

API run 33945229815 attempt 2, job 101253134093, failed the SIGINT-labelled launcher
case before any signal was sent: readiness exceeded 60000ms, launcher alive, no output.
The next SIGTERM/SIGHUP cases passed in 770.07ms/758.94ms. The launcher/startup files
match frozen dev. Two baseline jobs passed, so an identical baseline failure is not proven.
The doc-only successor, API job 101254594969 in run 33946878385, passed all three cases
in 1016.49ms/1017.85ms/1017.39ms. This measures variability, not a causal repair.
No launcher code, startup budget, retry or skip was changed; cause remains unresolved.

## Byte-limit fixture: competing guard

UI run 33946877992, macOS job 101254603450: 8867 passed, 1 skipped, 1 failed.
The output-byte test expected `output_byte_limit` but received `first_byte_timeout`
after 48.74ms. Both dedicated timeout cases passed.

| Hypothesis | Falsifier and observed evidence | Disposition |
|---|---|---|
| Quota changes broke transport error mapping | A changed pinned transport/sender or wrong mapping would support this; both match frozen dev and preserve distinct typed errors | Unsupported by source/diff |
| Byte accounting rejected the wrong size | Reaching the data handler with the wrong count would support this; the observed failure occurred before response headers | Not the observed failing branch |
| Unrelated short fixture deadlines preempted byte enforcement | A byte error with no first-byte timeout would refute this instance; the case inherited 30ms and the log names that timer's error | Confirmed immediate mechanism |

Why response headers took over 30ms is not established; runner contention is not claimed.
The correction isolates the property under test, not a production timeout: the byte-case
budgets alone become 1000ms, while a deliberately delayed 150ms response makes the old
30ms preemption observable on fast machines too. The exact 16-byte boundary must also
succeed. Dedicated first-byte/inactivity cases retain their 30ms guards and typed assertions.
Fresh remote CI must execute these cases; no local suite or checker is allowed.

Independent plan audit: Kant PASS. The response delay is deliberate fault injection, not
sleep-based readiness synchronization. No production guard, assertion, timeout-focused
case, retry policy, skip, dependency or workflow is removed or weakened.
Independent implementation review: Kant PASS after inspecting the concrete three-file delta;
remote execution is still required before declaring the correction verified.
