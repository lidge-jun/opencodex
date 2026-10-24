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

/** Header-arrival (connect) deadline applied to public upstreams when the operator sets none. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 200_000;

/**
 * Resolve the per-request header-arrival (connect) deadline in milliseconds.
 *
 * This is the budget `fetchWithHeaderTimeout` applies from dispatch until the upstream returns its
 * first response headers — it covers DNS, TCP, TLS, and the wait for response headers, but NOT the
 * body/stream that follows (that is the stall budget, see {@link resolveStallTimeoutMs}).
 *
 * An explicit value always wins: `0` (or any non-positive) disables the deadline everywhere, and a
 * positive value applies verbatim to local and public upstreams alike. Only when the operator left
 * it unset does the destination matter. A local upstream (loopback / private / `.local` / `.lan`,
 * via {@link StallTimeoutOptions.localUpstream}) resolves to disabled (`0`): LM Studio, Ollama, and
 * similar CPU-bound backends can spend minutes in prompt prefill before the first response header
 * arrives on a large prompt, and a flat ceiling would cut that healthy turn. A public upstream
 * keeps the {@link DEFAULT_CONNECT_TIMEOUT_MS} safety deadline.
 *
 * Disabling is expressed as `0`: `fetchWithHeaderTimeout` arms no header clock for a non-positive
 * budget, so the request is then bounded only by the client's own abort signal.
 */
export function resolveConnectTimeoutMs(configuredMs: number | undefined, options: StallTimeoutOptions = {}): number {
  const { localUpstream = false } = options;
  if (typeof configuredMs === "number" && Number.isFinite(configuredMs)) {
    if (configuredMs <= 0) return 0;
    return Math.max(1, Math.ceil(configuredMs));
  }
  return localUpstream ? 0 : DEFAULT_CONNECT_TIMEOUT_MS;
}

/** Floor applied to a positive non-streaming body-read budget so a public upstream keeps at least
 * a few seconds to deliver a buffered JSON body even when the stall budget resolves lower. */
export const MIN_JSON_BODY_READ_MS = 5_000;

/**
 * Resolve the total/inactivity budget for reading a buffered non-streaming JSON response body.
 *
 * The body stream is governed by the same clock as the streaming stall budget, not by the
 * header-arrival (connect) deadline: once headers arrive the connect phase is over, and a slow
 * local model that streams its JSON body over many seconds must not be cut by a deadline derived
 * from a disabled connect timeout. This therefore follows {@link resolveStallTimeoutMs} — a local
 * upstream with no explicit budget resolves to `0` (disabled; the reader arms no body clock), while
 * a public upstream keeps a positive budget floored at {@link MIN_JSON_BODY_READ_MS}.
 */
export function resolveJsonBodyReadTimeoutMs(configuredSec: number | undefined, options: StallTimeoutOptions = {}): number {
  const stallMs = resolveStallTimeoutMs(configuredSec, options);
  return stallMs <= 0 ? 0 : Math.max(stallMs, MIN_JSON_BODY_READ_MS);
}
