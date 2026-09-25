import { expect, test } from "bun:test";
import {
  classifySshStderr,
  dueForSpawn,
  FAILED_AFTER_MS,
  IDLE,
  nextDelayMs,
  reduceTunnel,
  type TunnelState,
} from "../../src/link/tunnel-state";

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
