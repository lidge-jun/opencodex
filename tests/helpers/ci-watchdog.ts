/**
 * CI-scaled test watchdogs.
 *
 * Several tests race a real local server round-trip against a short in-test
 * watchdog (`setTimeout(..., reject)`). Locally 1-2 s is generous, but the
 * unsharded GitHub macOS runner runs the whole suite in one pool under heavy
 * CPU contention and these watchdogs were the recurring flake class there
 * (server-auth WS terminal 1 s, provider-option fixture WS 2 s, …). Observed
 * runner stalls exceed 10 s on that lane (a 10 s-floor watchdog fired at
 * 10.16 s), so the CI floor is 30 s: the watchdog exists to bound a genuinely
 * hung test, not to assert latency. Local behaviour is unchanged. Bun's own
 * per-test timeout (`--timeout`, 60 s on CI) would pre-empt a 30 s watchdog,
 * so the lane timeout and this floor move together.
 *
 * Windows needs a higher floor still. Its shards run four Bun pools on one runner, and process
 * spawn there is slower than on the POSIX lanes to begin with — a `ocx restore --json` child
 * that finishes comfortably elsewhere was observed failing the 30 s floor at 30,147 ms (#2152).
 * 45 s keeps the watchdog meaningful while staying under the lane's own 60 s per-test timeout,
 * so a genuinely hung test is still bounded by something rather than running to the ceiling.
 */
export function watchdogMs(base: number): number {
  if (process.env.CI !== "true") return base;
  return Math.max(base, process.platform === "win32" ? 45_000 : 30_000);
}
