/**
 * Lifecycle of one link tunnel as a pure reducer. The supervisor that spawns ssh feeds events in
 * and reads decisions out; nothing here touches a process, a timer or the clock.
 *
 * - connected: the forward is up.
 * - reconnecting: a transient failure; requests through the link fail with 503 meanwhile, and a
 *   new attempt is due at `retryAt`.
 * - failed: auth, host key and forward failures, and a link that stayed down for FAILED_AFTER_MS.
 *   Without a retry policy (the Home's `-R` supervisor) it needs the user. With one (the Child's
 *   own `-L` tunnel) a reason that has a delay is tried again at `retryAt`, and the retry attempt
 *   runs with `inFlight` while the state still reads failed; a reason without a delay stays
 *   terminal.
 */

export type TunnelFailure = "auth" | "hostkey" | "forward" | "timeout";
export type StderrClass = "auth" | "hostkey" | "forward" | "network" | "unknown";

export type TunnelState =
  | { kind: "idle" }
  | { kind: "connecting"; since: number }
  | { kind: "connected"; since: number }
  | { kind: "reconnecting"; since: number; attempt: number; retryAt: number; inFlight: boolean }
  | { kind: "failed"; since: number; reason: TunnelFailure; retryAt?: number; inFlight?: boolean };

export type TunnelEvent =
  | { type: "spawn"; now: number }
  | { type: "ready"; now: number }
  | { type: "exit"; now: number; stderrClass: StderrClass }
  | { type: "tick"; now: number }
  | { type: "stop" };

/** Opt-in retry of a failed tunnel: the delay before each failure reason is tried again. */
export interface TunnelRetryPolicy {
  retryFailedAfterMs: Partial<Record<TunnelFailure, number>>;
}

export const FAILED_AFTER_MS = 5 * 60_000;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;

/**
 * The client-owned tunnel's policy. Timeout and forward failures retry about once a minute. Auth
 * retries every five minutes, and because each auth failure schedules the next attempt five
 * minutes out, no more than 12 attempts reach the Home's sshd in an hour. A changed host key is a
 * security signal and is never retried.
 */
export const CLIENT_TUNNEL_RETRY_POLICY: TunnelRetryPolicy = {
  retryFailedAfterMs: { timeout: 60_000, forward: 60_000, auth: 5 * 60_000 },
};

export const IDLE: TunnelState = { kind: "idle" };

/** Capped exponential backoff with ±20% jitter. `random` is injectable for tests. */
export function nextDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(MAX_DELAY_MS, base * jitter));
}

/** A failed state; under a policy that retries `reason` it carries the next attempt's time. */
export function failedTunnel(
  reason: TunnelFailure,
  now: number,
  policy?: TunnelRetryPolicy,
  since: number = now,
): TunnelState {
  const delay = policy?.retryFailedAfterMs[reason];
  return delay === undefined
    ? { kind: "failed", since, reason }
    : { kind: "failed", since, reason, retryAt: now + delay, inFlight: false };
}

function failureOf(cls: StderrClass): TunnelFailure | null {
  return cls === "auth" || cls === "hostkey" || cls === "forward" ? cls : null;
}

export function reduceTunnel(
  state: TunnelState,
  event: TunnelEvent,
  random?: () => number,
  policy?: TunnelRetryPolicy,
): TunnelState {
  if (event.type === "stop") return IDLE;
  switch (event.type) {
    case "spawn":
      if (state.kind === "failed" && state.retryAt !== undefined) return { ...state, inFlight: true };
      if (state.kind === "idle" || state.kind === "failed") return { kind: "connecting", since: event.now };
      if (state.kind === "reconnecting") return { ...state, inFlight: true };
      return state;
    case "ready":
      if (state.kind === "connecting" || state.kind === "reconnecting") return { kind: "connected", since: event.now };
      if (state.kind === "failed" && state.inFlight) return { kind: "connected", since: event.now };
      return state;
    case "exit": {
      if (state.kind === "idle") return state;
      if (state.kind === "failed") {
        if (!state.inFlight) return state;
        // A retry of a failed link failed again. It stays failed from the original moment; a
        // transient exit keeps the slow cadence (timeout) instead of restarting fast backoff.
        return failedTunnel(failureOf(event.stderrClass) ?? "timeout", event.now, policy, state.since);
      }
      const failure = failureOf(event.stderrClass);
      if (failure) return failedTunnel(failure, event.now, policy);
      const since = state.kind === "reconnecting" || state.kind === "connecting" ? state.since : event.now;
      if (event.now - since >= FAILED_AFTER_MS) return failedTunnel("timeout", event.now, policy);
      const attempt = state.kind === "reconnecting" ? state.attempt + 1 : 1;
      return { kind: "reconnecting", since, attempt, retryAt: event.now + nextDelayMs(attempt, random), inFlight: false };
    }
    case "tick":
      // An attempt in flight does not pause the clock: a first attempt or a retry that hangs past
      // the limit still fails the link, and the supervisor kills the child on seeing `failed`.
      if ((state.kind === "reconnecting" || state.kind === "connecting") && event.now - state.since >= FAILED_AFTER_MS) {
        return failedTunnel("timeout", event.now, policy);
      }
      return state;
  }
}

/** Whether the supervisor should start a new ssh attempt now. */
export function dueForSpawn(state: TunnelState, now: number): boolean {
  if (state.kind === "failed") return state.retryAt !== undefined && !state.inFlight && now >= state.retryAt;
  return state.kind === "reconnecting" && !state.inFlight && now >= state.retryAt;
}

/** Classify ssh stderr. Anything unrecognised is treated as transient. */
export function classifySshStderr(stderr: string): StderrClass {
  const text = stderr.toLowerCase();
  if (text.includes("host key verification failed") || text.includes("remote host identification has changed")
    || text.includes("no ecdsa host key is known") || text.includes("no ed25519 host key is known")
    || text.includes("no rsa host key is known") || text.includes("host key is known for")) return "hostkey";
  if (text.includes("permission denied") || text.includes("too many authentication failures")) return "auth";
  if (text.includes("remote port forwarding failed") || text.includes("port forwarding failed")
    || text.includes("address already in use") || text.includes("cannot listen to port")
    || text.includes("could not request local forwarding")) return "forward";
  if (text.includes("connection refused") || text.includes("timed out") || text.includes("could not resolve")
    || text.includes("network is unreachable") || text.includes("connection closed") || text.includes("broken pipe")
    || text.includes("connection reset") || text.includes("no route to host")) return "network";
  return "unknown";
}
