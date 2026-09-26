export const DEFAULT_STALL_TIMEOUT_SEC = 300;

/**
 * How the configured stall budget should be resolved for a request.
 *
 * `localUpstream` marks a request whose upstream is operator-trusted local infrastructure
 * (loopback / private / `.local` / `.lan` — see src/lib/local-upstream.ts). Such models are often
 * CPU-bound, and their time-to-first-token or "thinking" phases can go silent for many minutes;
 * a stall budget there would cut a healthy turn mid-thought. Callers compute the flag with
 * `isLocalUpstream(destination)` and pass it in.
 */
export interface StallTimeoutOptions {
  localUpstream?: boolean;
}

/**
 * Resolve the per-request stall budget in seconds.
 *
 * An explicit value always wins: `0` (or any non-positive) disables the budget everywhere, and a
 * positive value applies verbatim to local and public upstreams alike. Only when the operator
 * left the budget unset does the destination matter: a local upstream resolves to disabled
 * (`0`) while a public upstream keeps the {@link DEFAULT_STALL_TIMEOUT_SEC} safety clock.
 *
 * Disabling is expressed as `0`, never as a tiny budget: several consumers translate the
 * seconds into a tick count or a pull deadline, where `0` would otherwise expire on the first
 * beat and kill a healthy stream in ~2s. Consumers that kill on the budget must therefore gate
 * on `resolveStallTimeoutSec(...) > 0` (see src/bridge/sse.ts, src/server/chat-native-sse.ts).
 */
export function resolveStallTimeoutSec(configuredSec: number | undefined, options: StallTimeoutOptions = {}): number {
  const { localUpstream = false } = options;
  if (typeof configuredSec === "number" && Number.isFinite(configuredSec)) {
    if (configuredSec <= 0) return 0;
    return Math.max(1, Math.ceil(configuredSec));
  }
  return localUpstream ? 0 : DEFAULT_STALL_TIMEOUT_SEC;
}

/**
 * The same resolution as {@link resolveStallTimeoutSec}, in milliseconds, for consumers that
 * deadline against `performance.now()`. `0` is a stable "disabled" sentinel the inactivity
 * guards honor (they arm no clock for a non-positive budget).
 */
export function resolveStallTimeoutMs(configuredSec: number | undefined, options: StallTimeoutOptions = {}): number {
  return resolveStallTimeoutSec(configuredSec, options) * 1_000;
}
