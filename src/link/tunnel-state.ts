/**
 * Lifecycle of one link tunnel as a pure reducer. The supervisor that spawns ssh feeds events in
 * and reads decisions out; nothing here touches a process, a timer or the clock.
 *
 * - connected: the forward is up.
 * - reconnecting: a transient failure; requests through the link fail with 503 meanwhile, and a
 *   new attempt is due at `retryAt`.
 * - failed: auth, host key and forward failures, and a link that stayed down for FAILED_AFTER_MS.
 *   Without a retry policy it needs the user. With one (the Home's `-R` supervisor and the Child's
 *   own `-L` tunnel both run with one) a reason that has a delay is tried again at `retryAt`, and
 *   the retry attempt runs with `inFlight` while the state still reads failed; a reason without a
 *   delay stays terminal. Each retry that fails again doubles the next delay, up to the policy's
 *   `maxRetryDelayMs`; `retries` counts those failed retries (absent before the first one). A due
 *   retry whose ssh could not even be started counts too (`failedSpawnTunnel`).
 */

export type TunnelFailure = "auth" | "hostkey" | "forward" | "timeout";
/**
 * `remote_forward` is the Home's `-R` request refused by the peer's sshd: the port is still held,
 * usually by an earlier session the peer has not dropped yet. It fails the link as `forward` and
 * keeps the finer cause in `detail`.
 */
export type StderrClass = "auth" | "hostkey" | "forward" | "remote_forward" | "network" | "unknown";
export type TunnelFailureDetail = "remote_forward_conflict";

export type TunnelState =
  | { kind: "idle" }
  | { kind: "connecting"; since: number }
  | { kind: "connected"; since: number }
  | { kind: "reconnecting"; since: number; attempt: number; retryAt: number; inFlight: boolean }
  | {
    kind: "failed";
    since: number;
    reason: TunnelFailure;
    retryAt?: number;
    inFlight?: boolean;
    /** Failed retries since the link failed; absent until the first retry fails. */
    retries?: number;
    detail?: TunnelFailureDetail;
  };

export type TunnelEvent =
  | { type: "spawn"; now: number }
  | { type: "ready"; now: number }
  | { type: "exit"; now: number; stderrClass: StderrClass }
  | { type: "tick"; now: number }
  | { type: "stop" };

/**
 * Opt-in retry of a failed tunnel: the first delay before each failure reason is tried again, and
 * the cap the doubling delay of later retries stops at.
 */
export interface TunnelRetryPolicy {
  retryFailedAfterMs: Partial<Record<TunnelFailure, number>>;
  maxRetryDelayMs?: number;
}

export const FAILED_AFTER_MS = 5 * 60_000;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;

/**
 * The client-owned tunnel's policy. Timeout and forward failures are first retried after a minute,
 * and each retry that fails again doubles the delay up to five minutes (60, 120, 240, then every
 * 300 seconds). Auth starts at the five-minute cap, so no more than 12 attempts reach the Home's
 * sshd in an hour. A changed host key is a security signal and is never retried.
 */
export const CLIENT_TUNNEL_RETRY_POLICY: TunnelRetryPolicy = {
  retryFailedAfterMs: { timeout: 60_000, forward: 60_000, auth: 5 * 60_000 },
  maxRetryDelayMs: 5 * 60_000,
};

/**
 * The Home's `-R` supervisor dials the Child's sshd on the same cadence and limits. A sleep, an
 * outage longer than FAILED_AFTER_MS, or a forward the Child's sshd still holds for a session that
 * died heals at most five minutes after it clears, instead of waiting for a proxy restart.
 */
export const HOME_TUNNEL_RETRY_POLICY: TunnelRetryPolicy = CLIENT_TUNNEL_RETRY_POLICY;

export const IDLE: TunnelState = { kind: "idle" };

/** Capped exponential backoff with ±20% jitter. `random` is injectable for tests. */
export function nextDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(MAX_DELAY_MS, base * jitter));
}

/** The delay before the next retry of `reason` after `retries` failed retries, or undefined. */
export function failedRetryDelayMs(reason: TunnelFailure, retries: number, policy?: TunnelRetryPolicy): number | undefined {
  const base = policy?.retryFailedAfterMs[reason];
  if (base === undefined) return undefined;
  const cap = Math.max(base, policy?.maxRetryDelayMs ?? base);
  return Math.min(cap, base * 2 ** Math.max(0, Math.min(retries, 16)));
}

/** A failed state; under a policy that retries `reason` it carries the next attempt's time. */
export function failedTunnel(
  reason: TunnelFailure,
  now: number,
  policy?: TunnelRetryPolicy,
  since: number = now,
  options: { retries?: number; detail?: TunnelFailureDetail } = {},
): TunnelState {
  const retries = options.retries ?? 0;
  const delay = failedRetryDelayMs(reason, retries, policy);
  const extra = {
    ...(retries > 0 ? { retries } : {}),
    ...(options.detail ? { detail: options.detail } : {}),
  };
  return delay === undefined
    ? { kind: "failed", since, reason, ...extra }
    : { kind: "failed", since, reason, retryAt: now + delay, inFlight: false, ...extra };
}

/**
 * The state after an attempt whose ssh could not be started (ssh missing, a pidfile that cannot be
 * written, no listener port). On a due retry of a failed link it counts as one more failed retry
 * from the original moment and keeps the reason it was retrying: an attempt that reached no peer
 * says nothing new about the link, so the backoff keeps its step and an auth failure keeps its
 * five-minute cadence. Any other state fails fresh with `reason`.
 */
export function failedSpawnTunnel(
  prior: TunnelState | undefined,
  reason: TunnelFailure,
  now: number,
  policy?: TunnelRetryPolicy,
): TunnelState {
  if (prior?.kind !== "failed") return failedTunnel(reason, now, policy);
  return failedTunnel(prior.reason, now, policy, prior.since, { retries: (prior.retries ?? 0) + 1, detail: prior.detail });
}

function failureOf(cls: StderrClass): TunnelFailure | null {
  if (cls === "remote_forward") return "forward";
  return cls === "auth" || cls === "hostkey" || cls === "forward" ? cls : null;
}

function detailOf(cls: StderrClass): TunnelFailureDetail | undefined {
  return cls === "remote_forward" ? "remote_forward_conflict" : undefined;
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
        // transient exit keeps the slow cadence (timeout) instead of restarting fast backoff, and
        // the next delay doubles up to the policy's cap.
        return failedTunnel(failureOf(event.stderrClass) ?? "timeout", event.now, policy, state.since, {
          retries: (state.retries ?? 0) + 1,
          detail: detailOf(event.stderrClass),
        });
      }
      const failure = failureOf(event.stderrClass);
      if (failure) return failedTunnel(failure, event.now, policy, event.now, { detail: detailOf(event.stderrClass) });
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
  if (text.includes("remote port forwarding failed")) return "remote_forward";
  if (text.includes("port forwarding failed")
    || text.includes("address already in use") || text.includes("cannot listen to port")
    || text.includes("could not request local forwarding")) return "forward";
  if (text.includes("connection refused") || text.includes("timed out") || text.includes("could not resolve")
    || text.includes("network is unreachable") || text.includes("connection closed") || text.includes("broken pipe")
    || text.includes("connection reset") || text.includes("no route to host")) return "network";
  return "unknown";
}
