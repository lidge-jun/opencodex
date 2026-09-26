import { expect, test } from "bun:test";
import {
  classifySshStderr,
  CLIENT_TUNNEL_RETRY_POLICY,
  dueForSpawn,
  FAILED_AFTER_MS,
  IDLE,
  nextDelayMs,
  reduceTunnel,
  type TunnelState,
} from "../../src/link/tunnel-state";

const POLICY = CLIENT_TUNNEL_RETRY_POLICY;
const HOUR_MS = 60 * 60_000;

test("tunnel lifecycle reaches connected from idle", () => {
  let state = IDLE;
  state = reduceTunnel(state, { type: "spawn", now: 100 });
  expect(state).toEqual({ kind: "connecting", since: 100 });
  state = reduceTunnel(state, { type: "ready", now: 125 });
  expect(state).toEqual({ kind: "connected", since: 125 });
});

test("network exits schedule retries with attempt tracking and due times", () => {
  let state = reduceTunnel({ kind: "connected", since: 100 }, { type: "exit", now: 200, stderrClass: "network" }, () => 0.5);
  expect(state).toEqual({ kind: "reconnecting", since: 200, attempt: 1, retryAt: 1200, inFlight: false });
  if (state.kind !== "reconnecting") throw new Error("expected reconnecting state");
  expect(dueForSpawn(state, 1199)).toBe(false);
  expect(dueForSpawn(state, 1200)).toBe(true);
  state = reduceTunnel(state, { type: "spawn", now: 1200 });
  expect(state).toMatchObject({ kind: "reconnecting", attempt: 1, inFlight: true });
  state = reduceTunnel(state, { type: "exit", now: 1300, stderrClass: "network" }, () => 0.5);
  expect(state).toEqual({ kind: "reconnecting", since: 200, attempt: 2, retryAt: 3300, inFlight: false });
});

test("auth, host-key, and forwarding failures become terminal until spawned again", () => {
  for (const stderrClass of ["auth", "hostkey", "forward"] as const) {
    let state = reduceTunnel({ kind: "connected", since: 1 }, { type: "exit", now: 2, stderrClass });
    expect(state).toEqual({ kind: "failed", since: 2, reason: stderrClass });
    state = reduceTunnel(state, { type: "spawn", now: 3 });
    expect(state).toEqual({ kind: "connecting", since: 3 });
  }
});

test("connecting and reconnecting links fail after five minutes even with an attempt in flight", () => {
  let state = reduceTunnel({ kind: "connected", since: 0 }, { type: "exit", now: 100, stderrClass: "network" }, () => 0.5);
  expect(state.kind).toBe("reconnecting");
  state = reduceTunnel(state, { type: "spawn", now: 100 });
  expect(state).toMatchObject({ kind: "reconnecting", inFlight: true });
  state = reduceTunnel(state, { type: "tick", now: 100 + FAILED_AFTER_MS });
  expect(state).toEqual({ kind: "failed", since: 100 + FAILED_AFTER_MS, reason: "timeout" });

  state = reduceTunnel(IDLE, { type: "spawn", now: 500 });
  state = reduceTunnel(state, { type: "tick", now: 500 + FAILED_AFTER_MS });
  expect(state).toEqual({ kind: "failed", since: 500 + FAILED_AFTER_MS, reason: "timeout" });

  state = reduceTunnel({ kind: "reconnecting", since: 10, attempt: 1, retryAt: 11, inFlight: false }, { type: "exit", now: 10 + FAILED_AFTER_MS, stderrClass: "network" });
  expect(state).toEqual({ kind: "failed", since: 10 + FAILED_AFTER_MS, reason: "timeout" });
});

test("stale lifecycle events are ignored and stop always returns idle", () => {
  const failed: TunnelState = { kind: "failed", since: 1, reason: "auth" };
  expect(reduceTunnel(failed, { type: "ready", now: 2 })).toBe(failed);
  expect(reduceTunnel(failed, { type: "exit", now: 2, stderrClass: "network" })).toBe(failed);
  expect(reduceTunnel(IDLE, { type: "exit", now: 2, stderrClass: "network" })).toBe(IDLE);
  expect(reduceTunnel(IDLE, { type: "ready", now: 2 })).toBe(IDLE);
  const connected: TunnelState = { kind: "connected", since: 1 };
  expect(reduceTunnel(connected, { type: "spawn", now: 2 })).toBe(connected);
  for (const state of [IDLE, { kind: "connecting", since: 1 }, connected, {
    kind: "reconnecting", since: 1, attempt: 1, retryAt: 2, inFlight: false,
  }, failed] as TunnelState[]) {
    expect(reduceTunnel(state, { type: "stop" })).toBe(IDLE);
  }
});

test("backoff uses capped exponential delay with twenty percent jitter", () => {
  expect(nextDelayMs(1, () => 0)).toBe(800);
  expect(nextDelayMs(1, () => 1)).toBe(1200);
  expect(nextDelayMs(2, () => 0.5)).toBe(2000);
  expect(nextDelayMs(6, () => 0.5)).toBe(30000);
  expect(nextDelayMs(6, () => 0)).toBe(24000);
  expect(nextDelayMs(6, () => 1)).toBe(30000);
});

test("ssh stderr is classified by its retry policy", () => {
  const cases = [
    ["Permission denied (publickey).", "auth"],
    ["Host key verification failed.", "hostkey"],
    ["Error: remote port forwarding failed for listen port 20100", "forward"],
    ["ssh: connect to host x port 22: Connection refused", "network"],
    ["unexpected diagnostic", "unknown"],
  ] as const;
  for (const [stderr, expected] of cases) expect(classifySshStderr(stderr)).toBe(expected);
});

test("the client policy retries timeout and forward after a minute and auth after five minutes, never a host key", () => {
  const forward = reduceTunnel({ kind: "connected", since: 0 }, { type: "exit", now: 1_000, stderrClass: "forward" }, () => 0.5, POLICY);
  expect(forward).toEqual({ kind: "failed", since: 1_000, reason: "forward", retryAt: 61_000, inFlight: false });
  expect(dueForSpawn(forward, 60_999)).toBe(false);
  expect(dueForSpawn(forward, 61_000)).toBe(true);

  const reconnecting = reduceTunnel({ kind: "connected", since: 0 }, { type: "exit", now: 0, stderrClass: "network" }, () => 0.5, POLICY);
  const timeout = reduceTunnel(reconnecting, { type: "tick", now: FAILED_AFTER_MS }, () => 0.5, POLICY);
  expect(timeout).toEqual({ kind: "failed", since: FAILED_AFTER_MS, reason: "timeout", retryAt: FAILED_AFTER_MS + 60_000, inFlight: false });
  expect(dueForSpawn(timeout, FAILED_AFTER_MS + 60_000)).toBe(true);

  const auth = reduceTunnel({ kind: "connecting", since: 0 }, { type: "exit", now: 2_000, stderrClass: "auth" }, () => 0.5, POLICY);
  expect(auth).toMatchObject({ kind: "failed", reason: "auth", retryAt: 302_000 });
  expect(dueForSpawn(auth, 301_999)).toBe(false);
  expect(dueForSpawn(auth, 302_000)).toBe(true);

  const hostkey = reduceTunnel({ kind: "connected", since: 0 }, { type: "exit", now: 3_000, stderrClass: "hostkey" }, () => 0.5, POLICY);
  expect(hostkey).toEqual({ kind: "failed", since: 3_000, reason: "hostkey" });
  expect(dueForSpawn(hostkey, 3_000 + 24 * HOUR_MS)).toBe(false);
});

test("a retry runs while the link still reads failed, connects on ready and falls back to the slow cadence", () => {
  const failed: TunnelState = { kind: "failed", since: 100, reason: "timeout", retryAt: 60_100, inFlight: false };
  let state = reduceTunnel(failed, { type: "spawn", now: 60_100 }, () => 0.5, POLICY);
  expect(state).toEqual({ ...failed, inFlight: true });
  expect(dueForSpawn(state, 10 * HOUR_MS)).toBe(false);
  // A transient exit of the retry keeps the original failure time and waits another minute.
  state = reduceTunnel(state, { type: "exit", now: 61_000, stderrClass: "network" }, () => 0.5, POLICY);
  expect(state).toEqual({ kind: "failed", since: 100, reason: "timeout", retryAt: 121_000, inFlight: false });
  // A hung retry is not timed out by the reducer; ssh's own keepalive bounds it.
  state = reduceTunnel(state, { type: "spawn", now: 121_000 }, () => 0.5, POLICY);
  expect(reduceTunnel(state, { type: "tick", now: 121_000 + 10 * FAILED_AFTER_MS }, () => 0.5, POLICY)).toBe(state);
  expect(reduceTunnel(state, { type: "ready", now: 122_000 }, () => 0.5, POLICY)).toEqual({ kind: "connected", since: 122_000 });
  // A retry that meets a changed host key stops retrying.
  expect(reduceTunnel(state, { type: "exit", now: 122_000, stderrClass: "hostkey" }, () => 0.5, POLICY))
    .toEqual({ kind: "failed", since: 100, reason: "hostkey" });
});

test("auth retries reach the Home's sshd at most 12 times in any hour", () => {
  let state: TunnelState = reduceTunnel({ kind: "connecting", since: 0 }, { type: "exit", now: 0, stderrClass: "auth" }, () => 0.5, POLICY);
  const attempts: number[] = [];
  for (let now = 0; now <= 3 * HOUR_MS; now += 1_000) {
    if (!dueForSpawn(state, now)) continue;
    state = reduceTunnel(state, { type: "spawn", now }, () => 0.5, POLICY);
    attempts.push(now);
    state = reduceTunnel(state, { type: "exit", now: now + 50, stderrClass: "auth" }, () => 0.5, POLICY);
  }
  expect(attempts.length).toBeGreaterThan(30);
  for (const start of attempts) {
    expect(attempts.filter(at => at >= start && at < start + HOUR_MS).length).toBeLessThanOrEqual(12);
  }
});

test("without a retry policy (the Home's -R supervisor) a failed tunnel is never due", () => {
  for (const stderrClass of ["auth", "forward"] as const) {
    const state = reduceTunnel({ kind: "connected", since: 0 }, { type: "exit", now: 5, stderrClass });
    expect(state).toEqual({ kind: "failed", since: 5, reason: stderrClass });
    expect(dueForSpawn(state, 24 * HOUR_MS)).toBe(false);
  }
  const timeout = reduceTunnel({ kind: "connecting", since: 0 }, { type: "tick", now: FAILED_AFTER_MS });
  expect(timeout).toEqual({ kind: "failed", since: FAILED_AFTER_MS, reason: "timeout" });
  expect(dueForSpawn(timeout, 24 * HOUR_MS)).toBe(false);
});
