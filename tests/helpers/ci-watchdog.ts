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

/**
 * Scale a *product* timing budget that a test deliberately shortened.
 *
 * `watchdogMs` bounds how long a test may run. This is the other half: a budget the code
 * under test enforces on itself, which a test shrinks to keep the suite fast.
 *
 * The CL-07 fabric tests cut the producer's inactivity budget from 5 s to 750 ms so a
 * hang fails in under a second. That is fine in isolation and wrong under load: the
 * budget starts when the parent spawns a Bun child, and spawning one while the rest of
 * the suite saturates the CPU can take longer than 750 ms by itself. The child is then
 * killed for inactivity before it has run a line, and the test reports whatever the
 * harness makes of a killed producer — `inactivity_timeout` where it expected
 * `sandbox_violation`, or `blocked` where it expected `pass`.
 *
 * That failure mode is deterministic under contention, not random: eight parallel runs of
 * the file reproduced five failures each, while a single run passes 49/49. It surfaced as
 * a "flake" only because it needs a busy machine.
 *
 * A shortened budget must therefore keep enough headroom for process startup. The floor
 * is the same shape as `watchdogMs`: unchanged for a lone local run, generous when the
 * machine is busy. Windows spawns slowest, so it gets the larger floor.
 */
export function isolationBudgetMs(base: number): number {
  const underLoad = process.env.CI === "true" || process.env.OCX_TEST_FULL_SUITE === "1";
  if (!underLoad) return base;
  return Math.max(base, process.platform === "win32" ? 8_000 : 5_000);
}
