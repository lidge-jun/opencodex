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
