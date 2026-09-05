# 000 — Finish Windows stabilization, not monitoring

The earlier monitor-only closeout did not satisfy the user's stabilization goal.
This unit ends only when fixes are reviewed/merged and the repaired Windows suite
is green. Baseline: mergeddevbe81013fa, run33945431119:18330pass84skip2fail.
One cohesive C2 native-Codex test-harness work-phase initially; split only if the
evidence identifies a separate production defect. Exact implementation is010.

## Evidence and competing hypotheses

Path failure: native-codex-toggle.test.ts:107, expected RUNNER~1 versus actual
runneradmin, same unique fixture suffix. H1: ordinary versus native realpath
canonicalization; fixture:80 uses realpathSync, runtime codex/paths.ts:20 uses
native. Falsifier: native resolution identifies different directories. H2: wrong
effective home; source resolves the current CODEX_HOME override and suffix matches.
H3: cached/cross-test home; route resolves dynamically, so a two-home alias test
must continue to reject stale/default paths. Keep the exact original assertion.

Startup failure: native-profile-startup.test.ts:589 waits for a valid child port
with INTERNAL_DEADLINE_MS=15000. Same file documents10-18second Windows boots;
the current deadline was introduced by bf8bc443b. Total failing case23.32seconds;
stopChild did not replace the error with nonzero exit/stop timeout. H1: a healthy
child publishes readiness after the internal deadline. Falsifier: captured child
output shows early failure rather than late readiness. H2: wrong/partial marker;
the helper uses atomic publication and the parent parses a positive integer;
trace exact ready time and keep parsing, not existence-only acceptance. H3:
early process failure or undrained output; drain both pipes, fail fast on exit,
and include bounded diagnostics so it cannot masquerade as a readiness timeout.

Do not call this environmental or accept a rerun as repair. A test-only delayed
port-publication fault must make the old15second wait fail and the corrected
intrinsic spawn budget pass; bypassing admission must still make assertions fail.

## Boundaries

No production changes indicated. No skips, assertion relaxation, full local
suite, SSH, releases, service restarts, or workflow permission changes. Reuse
native realpath, existing spawn/deadline constants and existing test helpers.
User authorizes --no-verify pushes, reviewed admin merges, and gpt-6-astra/high
subagents. Main owns all writes/CI; agents inspect disjoint questions and review.
One Windows dispatch at a time on a fixed ref; macOS is not a completion gate.
Reassess each unchanged failure after two repair attempts; reassess approach at
three hours, never label a red run complete. No token/cost budget was specified.

No-code choices: doing nothing leaves CI red; deleting/skipping loses required
coverage; blindly increasing a timeout gives no cause. Reuse the existing path
canonicalizer and measured-operation budget, with injected boundary/failure proof.

Verifier baseline: focused original status-row test1pass locally; original
12-scenario startup case1pass/72assertions in5.31s locally. Windows failure logs
are the authoritative red baseline, not these local timings. Final gate is a
fresh repaired-head Windows full suite plus causal probes and reviewed delivery.

## Final verification

Windows run33949825505 on6ad49c8b5 is green: six successful shards,
18718pass84skip0fail across1091files. See015_windows_green.md for per-job evidence,
the original-failure closures and delivery requirements. The plan is archived
with the reviewed stack's final evidence; the host goal closes only after the
exact-head/merged-ancestry receipt succeeds.
