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
 */
export function watchdogMs(base: number): number {
  return process.env.CI === "true" ? Math.max(base, 30_000) : base;
}
