/**
 * Lifecycle of one link tunnel as a pure reducer. The supervisor that spawns ssh feeds events in
 * and reads decisions out; nothing here touches a process, a timer or the clock.
 *
 * - connected: the forward is up.
 * - reconnecting: a transient failure; requests through the link fail with 503 meanwhile, and a
 *   new attempt is due at `retryAt`.
 * - failed: needs the user. Auth, host key and forward failures are not retried, and neither is a
 *   link that stayed down for FAILED_AFTER_MS.
 */

export type TunnelFailure = "auth" | "hostkey" | "forward" | "timeout";
export type StderrClass = "auth" | "hostkey" | "forward" | "network" | "unknown";

export type TunnelState =
  | { kind: "idle" }
  | { kind: "connecting"; since: number }
  | { kind: "connected"; since: number }
  | { kind: "reconnecting"; since: number; attempt: number; retryAt: number; inFlight: boolean }
  | { kind: "failed"; since: number; reason: TunnelFailure };

export type TunnelEvent =
  | { type: "spawn"; now: number }
  | { type: "ready"; now: number }
  | { type: "exit"; now: number; stderrClass: StderrClass }
  | { type: "tick"; now: number }
  | { type: "stop" };

export const FAILED_AFTER_MS = 5 * 60_000;
export const BASE_DELAY_MS = 1_000;
export const MAX_DELAY_MS = 30_000;

export const IDLE: TunnelState = { kind: "idle" };

/** Capped exponential backoff with ±20% jitter. `random` is injectable for tests. */
export function nextDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 16));
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** exponent);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(MAX_DELAY_MS, base * jitter));
}

export function reduceTunnel(state: TunnelState, event: TunnelEvent, random?: () => number): TunnelState {
  if (event.type === "stop") return IDLE;
  switch (event.type) {
    case "spawn":
      if (state.kind === "idle" || state.kind === "failed") return { kind: "connecting", since: event.now };
      if (state.kind === "reconnecting") return { ...state, inFlight: true };
      return state;
    case "ready":
      if (state.kind === "connecting" || state.kind === "reconnecting") return { kind: "connected", since: event.now };
      return state;
    case "exit": {
      if (state.kind === "idle" || state.kind === "failed") return state;
      const cls = event.stderrClass;
      if (cls === "auth" || cls === "hostkey" || cls === "forward") return { kind: "failed", since: event.now, reason: cls };
      const since = state.kind === "reconnecting" || state.kind === "connecting" ? state.since : event.now;
      if (event.now - since >= FAILED_AFTER_MS) return { kind: "failed", since: event.now, reason: "timeout" };
      const attempt = state.kind === "reconnecting" ? state.attempt + 1 : 1;
      return { kind: "reconnecting", since, attempt, retryAt: event.now + nextDelayMs(attempt, random), inFlight: false };
    }
    case "tick":
      // An attempt in flight does not pause the clock: a first attempt or a retry that hangs past
      // the limit still fails the link, and the supervisor kills the child on seeing `failed`.
      if ((state.kind === "reconnecting" || state.kind === "connecting") && event.now - state.since >= FAILED_AFTER_MS) {
        return { kind: "failed", since: event.now, reason: "timeout" };
      }
      return state;
  }
}

/** Whether the supervisor should start a new ssh attempt now. */
export function dueForSpawn(state: TunnelState, now: number): boolean {
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
