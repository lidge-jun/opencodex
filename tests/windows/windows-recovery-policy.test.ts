import { expect, test } from "bun:test";

const { RecoveryPolicy } = require("../../scripts/ocx-recovery-guardian/policy.cjs") as {
  RecoveryPolicy: new (options?: Record<string, number>) => {
    observe(sample: Record<string, boolean>, now: number): Record<string, unknown>;
    markRecoveryStarted(now: number): Record<string, unknown>;
    markRecoveryFinished(result: { ok: boolean }, now: number): void;
    exportSafeState(): Record<string, unknown>;
    importSafeState(value: unknown, now: number): boolean;
    reset(options?: { resetBudget?: boolean; now?: number }): void;
  };
};

const healthy = { ready: true, health: true, alive: true, owned: true };
const unavailable = { ready: false, health: false, alive: true, owned: true };

test("only the configured consecutive failure threshold enters fallback", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 0 });

  expect(policy.observe(healthy, 0)).toEqual({ state: "healthy", useFallback: false, action: "none", reason: "ready" });
  expect(policy.observe(unavailable, 2_000)).toMatchObject({ state: "suspect", useFallback: false, action: "none" });
  expect(policy.observe(unavailable, 4_000)).toMatchObject({ state: "suspect", useFallback: false, action: "none" });
  expect(policy.observe(unavailable, 6_000)).toMatchObject({ state: "fallback", useFallback: true, action: "none" });
});

test("an owned dead child requests one immediate recovery, while a live freeze waits for the bounded failure duration", () => {
  const dead = { ready: false, health: false, alive: false, owned: true };
  const policy = new RecoveryPolicy({ startupGraceMs: 0, recoverAfterMs: 20_000 });
  expect(policy.observe(healthy, 0)).toMatchObject({ state: "healthy" });
  expect(policy.observe(dead, 2_000)).toMatchObject({ state: "fallback", useFallback: true, action: "recover", reason: "owned-child-dead" });

  const frozen = new RecoveryPolicy({ startupGraceMs: 0, recoverAfterMs: 20_000 });
  frozen.observe(healthy, 0);
  expect(frozen.observe(unavailable, 2_000)).toMatchObject({ action: "none" });
  expect(frozen.observe(unavailable, 20_000)).toMatchObject({ action: "none" });
  expect(frozen.observe(unavailable, 22_000)).toMatchObject({ state: "fallback", action: "recover", reason: "failure-duration" });
});

test("startup grace and short 503 blips do not request recovery", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 45_000 });
  expect(policy.observe(unavailable, 0)).toMatchObject({ state: "suspect", useFallback: false, action: "none", reason: "startup-grace" });
  expect(policy.observe({ ready: true, health: false, alive: true, owned: true }, 2_000)).toMatchObject({ state: "suspect", action: "none" });
  expect(policy.observe(unavailable, 44_000)).toMatchObject({ state: "suspect", useFallback: false, action: "none" });
  expect(policy.observe(healthy, 45_000)).toMatchObject({ state: "fallback", useFallback: true, action: "none" });
});

test("manual stop, dead launcher, foreign identity, and unknown ownership never self-respawn", () => {
  const stopped = new RecoveryPolicy({ startupGraceMs: 0 });
  expect(stopped.observe({ ...unavailable, manualStop: true }, 0)).toMatchObject({ state: "stopped", useFallback: false, action: "none" });
  expect(stopped.observe(unavailable, 60_000)).toMatchObject({ state: "stopped", action: "none" });

  const launcherGone = new RecoveryPolicy({ startupGraceMs: 0 });
  expect(launcherGone.observe({ ...unavailable, launcherAlive: false }, 0)).toMatchObject({ state: "stopped", action: "none" });

  const foreign = new RecoveryPolicy({ startupGraceMs: 0 });
  expect(foreign.observe({ ...unavailable, owned: false }, 0)).toMatchObject({ state: "foreign", useFallback: true, action: "none" });
  expect(foreign.observe({ ...unavailable, owned: false }, 60_000)).toMatchObject({ state: "foreign", action: "none" });

  const unknown = new RecoveryPolicy({ startupGraceMs: 0 });
  expect(unknown.observe({ ready: false, health: false, alive: false, owned: false }, 0)).toMatchObject({ state: "foreign", action: "none" });
});

test("recovery success requires thirty seconds of readiness before fallback returns to healthy", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 0, recoveryStableMs: 30_000 });
  expect(policy.observe({ ready: false, health: false, alive: false, owned: true }, 0)).toMatchObject({ action: "recover" });
  policy.markRecoveryStarted(0);
  policy.markRecoveryFinished({ ok: true }, 1_000);
  expect(policy.observe(healthy, 1_000)).toMatchObject({ state: "recovering", useFallback: true, action: "none" });
  expect(policy.observe(healthy, 30_999)).toMatchObject({ state: "recovering", useFallback: true });
  expect(policy.observe(healthy, 31_000)).toMatchObject({ state: "healthy", useFallback: false, action: "none" });
});

test("a recovered child may use startup grace before its full stable-ready interval under a bounded deadline", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 45_000, recoveryStableMs: 30_000 });
  const dead = { ready: false, health: false, alive: false, owned: true };
  expect(policy.observe(dead, 0)).toMatchObject({ action: "recover" });
  policy.markRecoveryStarted(0);
  policy.markRecoveryFinished({ ok: true }, 1);
  expect(policy.observe(healthy, 45_001)).toMatchObject({ state: "recovering", useFallback: true, action: "none" });
  expect(policy.observe(healthy, 75_001)).toMatchObject({ state: "healthy", useFallback: false, action: "none" });
});

test("an accepted recovery receipt that never becomes ready diagnoses immediately without consuming another recovery attempt", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 45_000, recoveryStableMs: 30_000, maxAttempts: 2 });
  expect(policy.markRecoveryStarted(0)).toMatchObject({ state: "recovering", reason: "recovery-started" });
  expect(policy.markRecoveryFinished({ ok: true }, 0)).toMatchObject({ state: "recovering", reason: "awaiting-stable-ready" });

  expect(policy.observe(unavailable, 74_999)).toMatchObject({ state: "recovering", action: "none" });
  expect(policy.observe(unavailable, 75_000)).toEqual({
    state: "failed", useFallback: true, action: "diagnose", reason: "recovery-not-stable",
  });
  expect(policy.exportSafeState()).toMatchObject({
    attempts: [0], awaitingReady: false, recoveryStartedAt: null, recoveryDeadline: null, lastFailedAttemptAt: 75_000,
  });
  expect(policy.observe(unavailable, 75_001)).toEqual({
    state: "suspect", useFallback: false, action: "none", reason: "transient-failure",
  });
});

test("manual stop or unknown ownership wins over an awaiting-ready expiry", () => {
  for (const sample of [
    { ...unavailable, manualStop: true },
    { ...unavailable, owned: false },
  ]) {
    const policy = new RecoveryPolicy({ startupGraceMs: 45_000, recoveryStableMs: 30_000 });
    policy.markRecoveryStarted(0);
    policy.markRecoveryFinished({ ok: true }, 0);
    expect(policy.observe(sample, 75_000)).toMatchObject({
      state: sample.manualStop ? "stopped" : "foreign", action: "none",
    });
  }
});

test("a timed-out recovery clears its in-progress latch so the bounded retry can be decided", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 0, recoverAfterMs: 1_000 });
  const dead = { ready: false, health: false, alive: false, owned: true };
  expect(policy.observe(dead, 0)).toMatchObject({ action: "recover" });
  policy.markRecoveryStarted(0);
  expect(policy.observe(dead, 1_000)).toMatchObject({ state: "failed", action: "none", reason: "recovery-timeout" });
  expect(policy.observe(dead, 6_000)).toMatchObject({ state: "fallback", action: "recover", reason: "owned-child-dead" });
});

test("failed recoveries use bounded backoff, retain the rolling budget, and diagnose once when exhausted", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 0, maxAttempts: 2, recoverAfterMs: 20_000 });
  const dead = { ready: false, health: false, alive: false, owned: true };
  expect(policy.observe(dead, 0)).toMatchObject({ action: "recover" });
  policy.markRecoveryStarted(0);
  policy.markRecoveryFinished({ ok: false }, 1);
  expect(policy.observe(dead, 2_000)).toMatchObject({ action: "none", reason: "recovery-backoff" });
  expect(policy.observe(dead, 5_001)).toMatchObject({ action: "recover" });
  policy.markRecoveryStarted(5_001);
  expect(policy.markRecoveryFinished({ ok: false }, 5_002)).toMatchObject({ state: "failed", action: "diagnose", reason: "attempt-budget-exhausted" });
  expect(policy.observe(dead, 20_002)).toMatchObject({ state: "failed", action: "none", reason: "attempt-budget-exhausted" });
  expect(policy.observe(dead, 22_002)).toMatchObject({ state: "failed", action: "none", reason: "attempt-budget-exhausted" });
  policy.reset({ now: 30_000 });
  expect(policy.observe(dead, 30_000)).toMatchObject({ state: "failed", action: "none" });
  policy.reset({ resetBudget: true, now: 30_000 });
  expect(policy.observe(dead, 30_000)).toMatchObject({ action: "recover" });
});

test("safe restart state retains a bounded attempt budget and invalid state fails closed", () => {
  const original = new RecoveryPolicy({ startupGraceMs: 0 });
  const dead = { ready: false, health: false, alive: false, owned: true };
  original.observe(dead, 0);
  original.markRecoveryStarted(0);
  original.markRecoveryFinished({ ok: false }, 1);
  const restored = new RecoveryPolicy({ startupGraceMs: 0 });
  expect(restored.importSafeState(original.exportSafeState(), 2_000)).toBe(true);
  expect(restored.observe(dead, 2_000)).toMatchObject({ action: "none", reason: "recovery-backoff" });
  const invalid = new RecoveryPolicy({ startupGraceMs: 0 });
  expect(invalid.importSafeState({ attempts: ["bad"] }, 0)).toBe(false);
  expect(invalid.observe(dead, 60_000)).toMatchObject({ state: "foreign", action: "none" });
});

test("attempt budget is released only when its rolling window expires", () => {
  const policy = new RecoveryPolicy({ startupGraceMs: 0, maxAttempts: 1, attemptWindowMs: 10_000 });
  const dead = { ready: false, health: false, alive: false, owned: true };
  expect(policy.observe(dead, 0)).toMatchObject({ action: "recover" });
  policy.markRecoveryStarted(0);
  expect(policy.markRecoveryFinished({ ok: false }, 1)).toMatchObject({ action: "diagnose" });
  expect(policy.observe(dead, 10_000)).toMatchObject({ action: "none", reason: "attempt-budget-exhausted" });
  expect(policy.observe(dead, 10_001)).toMatchObject({ action: "recover" });
});
