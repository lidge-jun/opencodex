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
 * A deadline *inside* a test, for an await that would otherwise hang forever.
 *
 * Keep these at least a few times under the surrounding budget. An internal deadline
 * shorter than the test budget fails faster than a timeout and reads as a logic error:
 * WS-REBIND-01 died at 748ms against its own hardcoded 1s while the budget was 5s, and
 * that mismatch is exactly why it looked random rather than slow.
 */
export const INTERNAL_DEADLINE_MS = 15_000;
