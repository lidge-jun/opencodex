# Regression candidate verification

The native tray integration has user acceptance and the evidence recorded in
[021](021_integration_verification.md). This candidate also addresses findings from the
since-v2.59.0 source review and preserves the existing dashboard and runtime ownership.
Detailed security working notes remain outside the tracked tree.

## Verification boundary

The user explicitly prohibited all further local tests and requested a no-verify push on
2026-09-22. The active local GUI suite was terminated (exit143); no result from that interrupted
run is counted as passing. Subsequent verification belongs to hosted CI and read-only review.
The candidate is not release-ready until its exact commit has the required hosted results.

Before that instruction, the original21 failures were resolved and a complete root run passed
28,731 tests. Later focused evidence includes Rust101, Swift121, the Bun updater's12 scenarios,
model migration45, cache/routing41 and release-resume20 tests. Those results are historical,
scoped evidence; they are not presented as a complete final-candidate suite. GUI harness findings
were repaired and React Doctor subsequently reported no issues. The latest dependency audit
reported no high-severity failure. Hosted CI must judge the final committed tree.

Native and web screenshots in evidence/ contain synthetic data. The web scroll checks observed
440px content in500x433 and500x633 Chrome viewports (requested outer window sizes were440x520
and440x720), positive inner scrolling, reachable footer and no outer document overflow. They do
not claim Windows desktop compositor coverage. No new local visual checks run after the prohibition.

## Remaining delivery

The exact-head PR checks, remaining read-only review, merged-dev checks, stable/main and preview
publication, registry tags/assets and final installation evidence remain outstanding. No release
or universal no-regression claim is made by this checkpoint. Follow the user-directed hosted-only
verification path and retain every failed, missing, cancelled or timed-out job as unresolved.

## Hosted follow-up at 9233d4f3a3

PR #5490 targets dev. Its Cross-platform CI run 35692642447 completed the macOS
widget/bundle and desktop-shell jobs successfully. Service-lifecycle checks passed on Linux,
macOS and Windows. The full workflow is not green: Linux shard 2 failed two sandbox-fixture
cases because the temporary executable inherited a writable ancestor. Manual all-platform
run 35692726962 also exposed Windows failures, including retention publication while its
source reader remained open. Fixes and unrun regression cases follow in the next commit;
that commit requires fresh hosted evidence. No local tests were run for these repairs.

The Swift optional-filter decoder and malformed-receipt fixtures received a read-only Sol
PASS. The settings-unavailable account section intentionally retains independently fetched
account limits, matching the web/default behavior, while reporting the unavailable settings.
Other baseline and security reviews remain separate from these two findings.

The next hosted candidate also narrows the Windows scheduler fixture's synthetic system path,
awaits server/child cleanup in vision and outbound-proxy cases, and waits for the real native-main
startup gate before asserting discovery rows. Proxy fixture phase diagnostics preserve a bounded
failure if transport rather than teardown remains stuck. The Linux fixture owns a disposable
executable beside the trusted interpreter instead of changing shared-file permissions.

Replacement ordering and CA startup repairs have source-review follow-ups; their new regression
cases are committed for hosted execution only. Final read-only reviews and exact-head hosted
results remain required before integration.

## Final source-review follow-up

The remaining baseline reviewer completed 63/63 assigned files. Its last three findings were
corrected and received a read-only source/security PASS, with regression cases committed but not
run locally. An additional Windows shutdown audit found two test files whose production-server
cleanup was not awaited; both now await release before deleting their directories.

At 4a38eb4bb9, service lifecycle passed on all three platforms, and manual Windows shards 4, 5
and 6 passed. This is intermediate evidence only: the subsequent source-review fixes require
fresh hosted checks. Source review does not establish runtime success or a universal absence
of regressions.

Hosted ec7ad275f2 exposed a test-injection error: the new ZCode failed-stat case overrode
`store.io` while the planner consumes `input.io`. The fixture now injects through the consumed
seam and retains the preview refusal, actual-write refusal and no-write assertions. Sol reviewed
the correction. A later Windows shard exposed the existing 100ms timing margin in the stalled
400-body case. Its helper now waits for the real bounded reader's timeout before releasing the
upstream suffix; retry rules and product timeouts are unchanged. Sol confirmed the call ordering.
The helper is committed with the test. All of these checks remain unrun locally.

The older macOS control run 35692726962 timed out after stopping in the first structure-SSOT
test. Its synchronous Git child is the source-based inference; the log does not identify the
child PID. The file now runs through the existing shared singleton roster, retaining every
assertion and existing time limit. Separately, the bridge-stall test's fixed six-second outer
ceiling pre-empted its CI-scaled 30/45-second inner watchdog. Its outer ceiling now retains the
same two-second cleanup margin on each platform; the product's one-second stall setting and
all terminal/cancellation assertions are unchanged. Sol reviewed both adjustments.

Obsolete failed manual runs 35694628931 and 35695558779 were cancelled after their failure logs
were captured, to release runner capacity. Their partial successful jobs remain historical
diagnostics only. Cancelled workflows do not count as passing verification.

Windows shard 8 at d7d2838341 exposed two management-auth teardown failures. The test drained
ACL reaps before draining native-main startup releases, allowing the latter to finish work that
registered a later reap. Teardown now drains native-main releases, all config-directory hardening,
then ACL child reaps before deleting the temporary home. Sol reviewed this ordering; removal
retry budgets and all management-auth assertions remain unchanged.

At b5529c5bb2, Windows shards 1, 3, 4, 5, 6 and 8 passed, and both macOS shards plus the
widget/bundle job passed in the manual run. PR macOS shard 1 independently wedged after the
injection-write-lock zero-byte case and reached its job timeout; source review identifies the
next case's synchronous child spawn/reap boundary as the likely blocked point. That file joins
the existing fresh-process roster without changing assertions or deadlines.

The manual Windows run found two further fixture lifetime failures. Five native-profile crash
phases shared one 90-second test; they now run as five independently bounded cases, preserving
every transaction/recovery assertion, with TERM/SIGKILL/reap bounds on switch-child cleanup.
A passthrough-cancellation fixture left its second pull pending forever despite request abort,
then deleted its accounting home before late cancellation finalized. Its fetch-shaped helper
now settles the pending pull on abort, and the case waits for the 499 cancellation log before
teardown. Sol reviewed both corrections; ownership enforcement is unchanged. No local tests ran.

At 6b919f8dea, a stale-status CLI fixture inferred the human process's health verdict from
separate JSON invocations. The human process could legitimately see an intervening refusal
failure while both other probes reported stale. A preload observer now delegates to the real
probe, records that same process's boolean on stderr, and returns it unchanged. The formatter
assertion runs only when its own observed verdict is true; missing output still fails. Sol
reviewed the observation and import ordering. Product status behavior is unchanged.

## macOS control process boundary amendment
The older b5529c5bb2 control again stalled in a different synchronous subprocess test after the
structure case was isolated. It stopped after assert-mergeable-review/malformed_reviews, reported
a killed dangling process at the per-test ceiling, then emitted no result for twenty minutes.
Keeping one indefinitely growing Bun isolate pool was not yielding reliable completion evidence.

The control now enumerates the entire 1/1 test list through the existing bounded batch runner:
at most twelve files per fresh process, one worker, 300-second process bound, unchanged 60-second
per-test ceiling and 75-minute job cap. Dedicated storage/API families and declared serial files
remain singleton primary processes. Every selected file runs once; primary failures remain red
even if diagnostic attribution is clean. This preserves assertions and file membership but no
longer claims whole-suite shared-process contamination coverage. Behavioral fixtures check exact
membership, argument shape, special-family ownership, invalid input and failure disposition.
Sol architecture, behavioral and explicit workflow/dependency security reviews accepted the change.
The new cases are unrun locally; hosted execution is still required.

The new macOS full-membership control passed at 9df4499dd2 (manual run 35704045906).
The same head's PR Linux run exposed one native Anthropic reject-path fixture race: it freed
an ephemeral upstream port before starting the proxy, allowing reuse/self-targeting instead of
a connection refusal. The fixture now rejects only its exact synthetic upstream origin through
the fetch boundary while retaining real HTTP ingress, an exact-one-upstream-call assertion,
502/api_error/message assertions, and global restoration. Sol accepted the change; it is unrun
locally and requires the next hosted candidate.
