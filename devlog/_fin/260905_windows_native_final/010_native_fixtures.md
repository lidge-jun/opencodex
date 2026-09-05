# 010 — Native path identity and owned child readiness

## MODIFY tests/codex-integration/native-codex-toggle.test.ts

Replace only fixture-root canonicalization:

```diff
-fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "ocx-codex-toggle-")));
+fixtureRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-codex-toggle-")));
```

Update the comment for macOS symlinks and Windows short names. Keep the exact
configPath assertion unchanged; do not resolve a missing config file or use the
production resolver as the expected-value oracle. Add an adjacent real-directory
alias test: status reports homeA/config.toml, then CODEX_HOME is changed to an
alias of distinct homeB and status must report canonicalB/config.toml. Both files
stay absent. Use a junction on Windows, directory symlink elsewhere. No skip.
Mutant returning the old home or a different filename must fail that check.

## MODIFY tests/codex-integration/native-profile-startup.test.ts

Keep production admission/recovery assertions and all12 recoverable scenarios.
Convert the loop-in-one-test into test.each(recoverable), with phase/observation
in the name. Convert the two manual observations similarly. Each real-process
case gets2*SPAWN_BUDGET_MS, including the existing single Pool case, to contain
one startup, recovery observation and bounded cleanup rather than12 accumulated
starts. Pure in-process tests are unchanged.

`waitForPort(path, child, timeoutMs = SPAWN_BUDGET_MS)` uses the existing45000ms
spawn budget instead of the generic15000ms in-test deadline. It checks child
exit before accepting the marker, validates an integer port1..65535, and reports
elapsed time/exit status on timeout. Recovery markers retain INTERNAL_DEADLINE_MS.
Call sites pass their owned child. Do not fall back to port0 or accept existence.

Keep spawnChild returning the Bun child; add a private WeakMap of child output
promises/startedAt/ready flag. Drain stdout and stderr immediately. On a ready
marker set the flag and emit a compact elapsedMs trace. On early exit surface
captured stdout/stderr (bounded tail); on cleanup before readiness emit the
diagnostics even if exit0, preserving the primary wait failure. stopChild owns
release/stop, bounded exit wait, kill-and-join on timeout; clear its timeout timer.
Never delete the fixture before the child exits. No public helper/production API.

Use a private withStartupChild lifetime wrapper for the three process-scenario
families: collect the primary assertion/readiness error, always stop/join the
child, and rethrow one error or AggregateError for primary+cleanup failure.
Both errors must remain visible. This replaces duplicated try/finally ownership,
not production behavior. Diagnostics cap output tails to8192characters.

## MODIFY tests/helpers/native-profile-startup-child.ts

Add a test-only, normally disabled port-publication delay fault matching the
helper's existing stall-on-stop convention. Read OCX_TEST_NATIVE_STARTUP_DELAY_PORT_MS,
accept only a finite nonnegative delay bounded to60000ms, and apply after server
startup but before atomic port publication. Normal runs add no delay. Emit a
compact publication timestamp relative to the parent launch time; do not log keys,
environment dumps or auth bodies. Parent passes NATIVE_STARTUP_LAUNCHED_AT.

## Proof sequence

1. Instrument/split only; retain old15s port deadline initially. Set the delay
   to16000ms on one named prepared/source-exact scenario. It must fail on readiness
   while cleanup observes healthy exit0/late publication. This is fault injection,
   not sleep-based synchronization in normal tests.
   Run this controlled fault on the local focused single-scenario test so boot
   time plus16seconds fits the old15+10second cleanup horizon; Windows runs use
   no artificial delay. Ordinary Windows stage timings remain separately observed.
2. Use SPAWN_BUDGET_MS for readiness; the SAME delayed scenario must pass all
   admission and convergence assertions. Clear the env fault for normal tests.
3. Temporarily bypass the production native-main traffic gate (uncommitted
   mutant only) for that named scenario; the blocked-before-recovery assertion
   must fail. Restore source exactly before any commit/push. If another guard
   prevents this mutation from exercising the intended path, record it and choose
   the actual authoritative admission seam rather than claim false sensitivity.
4. Simulate an early child failure with a helper-only fault or invalid helper
   input and require prompt exit diagnostics, not the whole readiness deadline.
   The helper may expose OCX_TEST_NATIVE_STARTUP_FAIL_BEFORE_LISTEN=1 for this
   focused proof; normally off. Also run OCX_TEST_STALL_ON_STOP=1 on the same named
   scenario: cleanup must kill/join within its10second bound and finish output
   drains. Combine the old-readiness-delay fault with stall-on-stop once to prove
   the primary readiness error survives the cleanup error. Restore normal env
   and port bound afterwards. No fault settings are used by the normal CI suite.
5. Run the two focused files, typecheck, diff/privacy checks, independent review.
6. Push scoped PR and dispatch existing ci.yml on the repaired fixed head. Require
   all Windows suite shards SUCCESS/0fail and trace late/readiness stages. Any
   residual keeps the goal active and returns to diagnosis; no blind retry.

The initial narrow plan reuses existing CI with no workflow changes. Corpus:
extend existing path-case-sensitive-map and test-budget-sized-from-local-timing
occurrences only after evidence; no duplicate case for an already-known mechanism.
General SoT/runtime docs do not change because no product contract changes.

Audit synthesis: Noether GO-WITH-FIXES (one P2) requested an executable teardown
failure proof; folded above using the existing stall-on-stop hook plus the error
aggregation wrapper. The local platform for the16second fault is explicit.
Path identity, per-scenario splitting and intrinsic spawn budget were approved
subject to these causal and admission-ablation proofs.

Integration residual: run33947540953 revealed the same intrinsic-child budget
class in codex-restore-app-rewrite.test.ts. Research is001; dependent child-layer
repair specification is012. This remains the same native fixture stabilization
work-phase and its Windows-green gate; no successful monitoring substitute.
