/**
 * Test budgets for work that is genuinely slow, not for making red go away.
 *
 * Bun's default is 5s. That is generous for a pure function and thin for anything
 * that spawns a process, binds a server, or writes SQLite on a loaded CI runner —
 * which is why a run of windows-latest failures kept blaming a different test each
 * time. The blame moved; the cause did not.
 *
 * ## When you may raise a budget
 *
 * Both must hold:
 *
 * 1. **The wait is intrinsic to the assertion.** The tray socket-inheritance test
 *    launches PowerShell, which launches Bun, then rebinds the port to prove the
 *    child never inherited the listen socket. Those processes ARE the proof, so it
 *    gets a budget. The sidebar route tests spawned `gh` only incidentally while
 *    claiming route reachability, so they got the spawn DELETED instead. Ask which
 *    kind you have before reaching for a number.
 * 2. **The ablation still fails.** Revert the production behaviour the test covers
 *    and confirm the test goes red. A budget that hides a vacuous test is worse than
 *    the flake, because it converts a reliability signal into silence.
 *
 * If only (1) holds, you have not finished. If neither holds, delete the wait.
 *
 * ## Why these numbers
 *
 * They are headroom against runner contention, not measured durations. Local timings
 * are typically two to four orders of magnitude smaller: the storage cleanup test
 * that blew a 20s CI budget runs in ~7ms here. Sizing to the local number is what
 * produced the original 5s failures.
 */

/** Real child process: PowerShell, a CLI smoke test, an external binary. */
export const SPAWN_BUDGET_MS = 45_000;

/**
 * The cold start of the FIRST child in a process, on Windows only.
 *
 * This exists because raising `SPAWN_BUDGET_MS` itself does not. 31 test files read that
 * constant and nine hand it straight to `setDefaultTimeout`, so moving it from 45s to 90s
 * halved the reporting speed of 339 Windows cases — codex-write-lock contention, the
 * cross-process history-lock exclusions, the shim process cases — in order to fix one. Several
 * of those files never spawn anything. Four more multiply it, and one chain of derivations
 * reached 265s: long enough that a single hang on a Windows shard, which already runs about 25
 * minutes, approaches the 30-minute job timeout and returns an opaque cancellation instead of a
 * readable Bun timeout.
 *
 * ## Why the number
 *
 * Run 35118018849 (job 104895935554) measured the first proxy child in
 * `tests/codex-integration/native-profile-startup.test.ts` publishing its port at
 * elapsedMs=50728, while the next spawn in the same file was ready in 1759ms. Most of that
 * window was the test's own doing: the child published a disposable port number through the
 * production secret writer, which on Windows runs two `hardenSecretPath(..., required: true)`
 * passes, each able to spawn PowerShell for SID resolution and several 30s-budgeted `icacls`
 * calls. That publication is now a plain temp-file rename, so the ceremony is out of the
 * measured window entirely. Across 30 Windows shard logs the surviving readiness waits are
 * 2.0s to 19.7s. 45s covers them; this ceiling covers the possibility that some part of the
 * 50.7s was cold process start rather than ACL work, which the new phase timestamps in
 * `tests/helpers/native-profile-startup-child.ts` will settle on the next slow run.
 *
 * ## Ablation
 *
 * The wait is intrinsic: the case that consumes this budget proves that a FRESH process gates
 * native-main admission, so a real second process reaching a real port is the assertion, not
 * setup for it. And the budget cannot hide a vacuous test, because none of the assertions
 * depend on it. Ablate the behaviour under test — let `waitForNativeMainStartupGate` open
 * admission before journal recovery settles — and the first `mainRequest` returns 200 where the
 * case demands >= 400. That failure lands within milliseconds of readiness at any budget, 45s
 * or 90s. A child that dies instead of listening is reported by `waitForPort` on
 * `child.exitCode` without spending the budget at all.
 *
 * Consume it exactly once, for the readiness wait of a file's first child. A second consumer
 * means the cold start is not what is being waited on.
 */
export const COLD_SPAWN_BUDGET_MS = process.platform === "win32" ? 90_000 : SPAWN_BUDGET_MS;

/** Binds a real server or opens a real socket, including restart-and-reconnect flows. */
export const SERVER_BUDGET_MS = 30_000;

/** Touches SQLite or the filesystem repeatedly. Slow on Windows for reasons outside our code. */
export const STORE_BUDGET_MS = 30_000;

/**
 * Hundreds of individually fsync'd durable writes in one test. The fsyncs ARE the
 * assertion (durable spill is the product contract), so the wait is intrinsic; the
 * orphan-cleanup cap test measured ~34s on windows-latest against Bun's 5s default.
 */
export const BULK_DURABLE_IO_BUDGET_MS = bulkDurableIoBudgetMs();

/**
 * Windows needs a higher ceiling than the ~34s that sized this number, for the same
 * reason `watchdogMs` carries a higher floor there: the leg runs four Bun pools on one
 * runner, and every one of these writes is an individual fsync against a filesystem that
 * is slower under that contention to begin with. The orphan-cleanup cap case ran 100.6s
 * against the 90s budget on shard 4/4 (#2152) while doing exactly the work it claims —
 * 521 durable writes — so the number was measuring runner contention, not a hang.
 *
 * 180s stays a bound rather than an absence of one, and it is gated on Windows so no
 * other lane loses the shorter signal.
 */
function bulkDurableIoBudgetMs(): number {
  return process.platform === "win32" ? 180_000 : 90_000;
}

/**
 * A deadline *inside* a test, for an await that would otherwise hang forever.
 *
 * Keep these at least a few times under the surrounding budget. An internal deadline
 * shorter than the test budget fails faster than a timeout and reads as a logic error:
 * WS-REBIND-01 died at 748ms against its own hardcoded 1s while the budget was 5s, and
 * that mismatch is exactly why it looked random rather than slow.
 */
export const INTERNAL_DEADLINE_MS = 15_000;
