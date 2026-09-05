# 013 — Same-owner deadline gaps, bounded follow-through

Read-only inventory found two high-confidence siblings importing the same real
inject/config owner, not plain eval or mocked logic. Other catalog/leaf-owner
candidates remain inventory, not targets for blanket timeout increases.

## MODIFY codex-inject-write-lock.test.ts: contention case only

The contender cold-loads real inject/config but has a10second process deadline
because lockTimeoutMs=0. Fail-fast lock acquisition does not make module loading
fail-fast. Three process starts currently share45seconds, and the35second holder
ceiling would expire before a40second contender could finish.

Keep the existing SPAWN_TIMEOUT_MS=SPAWN_BUDGET_MS-5000. Set readiness to that40s
bound, contender to the same40s default, reap windows5s each, holder ceiling to
ready40+contender40+reap5=85s, and this case to3*40+3*5=135s. Other tests retain
their existing defaults. Poll the marker with await Bun.sleep(20), not new
processes; fail promptly when the holder exits. Drain both output streams from
spawn. Release normally, bounded-wait, SIGKILL and bounded-join on timeout; never
report forced cleanup as success. Preserve primary and cleanup errors together.
If even forced join fails, retain the fixture instead of deleting a live owner.
Keep all four busy/retryable/no-write assertions unchanged.

Proof: add a temporary16second delay in codex-inject-race-child after imports.
Old10s contender must fail; corrected contender must still report busy and leave
the first winner's bytes intact. Restore helper. Authoritative mutation in
inject.ts before the lock: `if (port === 20200) applyNativeArtifacts();` must leave
busy reporting intact but fail the no-20200/exact-byte assertion. Restore source.
Exercise the holder cleanup failure with the existing hold/release protocol;
no new production behavior or shared test-budget change.

The holder's result and both streams are joined with timer-clearing5second waits;
if the forced join also fails, remove this fixture from cleanup and retain it
with an explicit diagnostic. Pin the case's root locally for that decision.

## MODIFY codex-sync-api.test.ts: competing OFF case only

One cold process imports real config/sync/inject and launches another process to
persist OFF, but the case currently has15seconds and neither command is bounded.
Use boot40s, outer command2*40+5=85s, case90s, and SIGKILL/windowsHide for both
spawnSync calls. Include status/signal/error/stdout/stderr in labelled failures.
Inside the generated script retain flipFailure separately: syncModelsToCodex
catches discovery errors, so rethrow flipFailure after awaiting sync and before
printing success; end the IIFE with a catch setting exitCode=1.

Audit P2 folded: the outer parent passes its absolute85second deadline. Before
launching OFF, require at least40seconds plus5seconds cleanup reserve remaining;
otherwise set/throw a labelled flipFailure without spawning. The generated
inject wrapper delegates to the real injector on normal runs but rethrows an
already-recorded flipFailure so sync's discovery catch cannot trigger unrelated
fixture writes. Check flipFailure again before the result is printed.

Fault proofs: temporarily pass an expired outer deadline and require the
not-started failure (no nested writer); removing that guard must defeat the
fault expectation. Temporarily give the nested call a short command timeout
and a delayed writer; require its timeout/signal diagnostics and no late write.
Restore the real deadlines and script after the probes. These test-controlled
remaining-budget snapshots exercise late-launch admission without a long sleep.

Keep the real injector, OCX_TEST_SERVICE_HOME_PROBE removal, discriminated
desired_disabled skip and exact config-byte oracle. A temporary mutation of the
under-lock predicate from shouldSyncCodexOnStart(loadConfig()) to the stale
shouldSyncCodexOnStart(config??{}) must fail those original oracles. Restore it.
Inject a nested exit7 once and require its labelled error rather than swallowed
success. Run the two full focused files after restoring all probes.

This adds two files to the same child-layer process-bound correction; it does
not claim measured failures in untouched candidates. Independent review checks
the interval relationships and ownership before these changes are applied.
