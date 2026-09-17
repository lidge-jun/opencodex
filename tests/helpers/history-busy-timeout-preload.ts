/**
 * Test-only seam for a spawned `ocx` child: shorten the `state_5.sqlite` busy timeout.
 *
 * A test that proves cross-process SQLite contention has to hold a real lock against a real CLI
 * child, and the child then pays the production busy timeout twice over — 5 s per attempt plus
 * the retry delay, about 10.5 s of pure waiting. That wait is not the assertion; the JSON
 * envelope is. On a contended windows-latest shard the waiting alone pushed the child past its
 * watchdog, which is how the composed restore-busy case came to be skipped on Windows.
 *
 * In-process tests already shrink this window with `setHistoryDbBusyTimeoutForTests`. A child
 * process cannot be reached that way, so it gets the same knob through `--preload`. Inert unless
 * `OCX_TEST_HISTORY_BUSY_TIMEOUT_MS` is set on that child's environment, and no production
 * module reads that variable or imports this file. The retry count, the lock, the failure
 * classification, and the reported envelope are all untouched: only the length of a sleep changes.
 */
import { setHistoryDbBusyTimeoutForTests } from "../../src/codex/history-provider";

export const HISTORY_BUSY_TIMEOUT_ENV = "OCX_TEST_HISTORY_BUSY_TIMEOUT_MS";

const raw = process.env[HISTORY_BUSY_TIMEOUT_ENV];
if (raw !== undefined) {
  const ms = Number(raw);
  // A malformed value must not silently leave the production 5 s in place while the test
  // believes it was shortened, so it fails the child loudly instead.
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`${HISTORY_BUSY_TIMEOUT_ENV} must be a non-negative number, received: ${raw}`);
  }
  setHistoryDbBusyTimeoutForTests(ms);
}
