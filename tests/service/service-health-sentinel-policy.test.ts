import { describe, expect, test } from "bun:test";

import {
  DEFAULT_HEALTH_SENTINEL_TIMING,
  createHealthSentinelPolicy,
  recentRecoveryCount,
  requiredUnhealthySpan,
  type HealthProbeOutcome,
} from "../../src/service/health-sentinel-policy";

const TARGET = 4242;
const T = DEFAULT_HEALTH_SENTINEL_TIMING;
const START = 1_000_000;

/**
 * Drive a policy the way the sentinel does: probe, wait the interval, probe again. `stalled(t)`
 * says whether the target's event loop is blocked at time t; a probe answers at the first
 * unblocked moment inside its deadline, or times out.
 */
function simulate(opts: {
  stalled: (at: number) => boolean;
  until: number;
  history?: number[];
  timing?: Partial<typeof T>;
}) {
  const policy = createHealthSentinelPolicy({ targetPid: TARGET, startedAt: START, recoveryHistory: opts.history ?? [], timing: opts.timing });
  const decisions: { at: number; action: string }[] = [];
  let at = START;
  while (at < opts.until) {
    let answeredAt: number | null = null;
    for (let t = at; t <= at + T.probeTimeoutMs; t += 250) {
      if (!opts.stalled(t)) { answeredAt = t; break; }
    }
    const outcome: HealthProbeOutcome = answeredAt === null
      ? { kind: "timeout", startedAt: at, endedAt: at + T.probeTimeoutMs }
      : { kind: "answered", pid: TARGET, startedAt: at, endedAt: answeredAt };
    const decision = policy.observe(outcome);
    decisions.push({ at: outcome.endedAt, action: decision.action });
    if (decision.action !== "continue") return { decisions, decision, policy };
    at = outcome.endedAt + policy.nextDelayMs();
  }
  return { decisions, decision: null, policy };
}

const timeout = (startedAt: number, ms = T.probeTimeoutMs): HealthProbeOutcome => ({ kind: "timeout", startedAt, endedAt: startedAt + ms });
const answered = (startedAt: number, pid: number | null = TARGET): HealthProbeOutcome => ({ kind: "answered", pid, startedAt, endedAt: startedAt + 5 });

function armedPolicy(history: number[] = []) {
  const policy = createHealthSentinelPolicy({ targetPid: TARGET, startedAt: START, recoveryHistory: history });
  expect(policy.observe(answered(START)).action).toBe("continue");
  return policy;
}

/** Feed timeouts on the default cadence starting after the grace period; return the first non-continue. */
function feedTimeouts(policy: ReturnType<typeof armedPolicy>, from: number, count: number) {
  let at = from;
  for (let i = 0; i < count; i += 1) {
    const decision = policy.observe(timeout(at));
    if (decision.action !== "continue") return { decision, index: i };
    at += T.probeTimeoutMs + T.failureIntervalMs;
  }
  return { decision: null, index: count };
}

describe("service health sentinel policy (#6671)", () => {
  test("a proxy that stays stalled is recovered after three timeouts spanning the minimum", () => {
    const stallFrom = START + 5 * 60_000;
    const result = simulate({ stalled: at => at >= stallFrom, until: START + 30 * 60_000 });
    expect(result.decision?.action).toBe("recover");
    if (result.decision?.action !== "recover") throw new Error("unreachable");
    expect(result.decision.consecutiveTimeouts).toBe(3);
    expect(result.decision.unhealthyMs).toBeGreaterThanOrEqual(T.minUnhealthyMs);
    // Never sooner than the minimum unhealthy span after the stall began, nor much later than a cadence after it.
    const recoveredAt = result.decisions.at(-1)!.at;
    expect(recoveredAt - stallFrom).toBeGreaterThanOrEqual(T.minUnhealthyMs);
    expect(recoveredAt - stallFrom).toBeLessThanOrEqual(T.intervalMs + T.probeTimeoutMs + 3 * (T.probeTimeoutMs + T.failureIntervalMs));
  });

  test("negative controls: stalls the reporter measured never trigger a recovery", () => {
    // A 41 s synchronous model-list stall (the longest isolated control on the issue), repeated hourly.
    const isolated = simulate({ stalled: at => ((at - START) % 3_600_000) > 600_000 && ((at - START) % 3_600_000) < 641_000, until: START + 6 * 3_600_000 });
    expect(isolated.decision).toBeNull();
    // Recurring 1.4 s pressure latencies every few seconds.
    const pressure = simulate({ stalled: at => (at % 5_000) < 1_400, until: START + 3_600_000 });
    expect(pressure.decision).toBeNull();
    // 23 s stalls every 50 s with 27 s of health between them, at every phase relative to the
    // probes (on a fixed 50 s cadence one phase would make every probe time out).
    const alignedStall = (phase: number) => (at: number) => at > START + T.startupGraceMs && ((at - START - phase) % 50_000) < 23_000;
    for (let phase = 0; phase < 50_000; phase += 500) {
      expect(simulate({ stalled: alignedStall(phase), until: START + 3_600_000 }).decision).toBeNull();
    }
    // Not vacuous: probing a failing target on the ordinary 50 s cadence would recover at some phase.
    const fixedCadence = Array.from({ length: 100 }, (_, i) => simulate({
      stalled: alignedStall(i * 500),
      until: START + 3_600_000,
      timing: { failureIntervalMs: T.intervalMs },
    }).decision?.action);
    expect(fixedCadence).toContain("recover");
    // Repeated 45 s stalls with 30 s of health between them.
    const recurring = simulate({ stalled: at => ((at - START) % 75_000) < 45_000 && at > START + 200_000, until: START + 3_600_000 });
    expect(recurring.decision).toBeNull();
  });

  test("nothing counts before the target has answered as itself", () => {
    const policy = createHealthSentinelPolicy({ targetPid: TARGET, startedAt: START, recoveryHistory: [] });
    expect(feedTimeouts(policy, START + T.startupGraceMs, 10).decision).toBeNull();
    expect(policy.state().armed).toBe(false);
    expect(policy.observe(answered(START + 3_600_000, null)).action).toBe("continue");
    expect(policy.state().armed).toBe(false);
  });

  test("timeouts during the startup grace never count", () => {
    const policy = armedPolicy();
    expect(feedTimeouts(policy, START + 1, 2).decision).toBeNull();
    expect(policy.state().consecutiveTimeouts).toBe(0);
  });

  test("any answer, a refusal or an error resets the streak", () => {
    for (const reset of ["answered", "refused", "error"] as const) {
      const policy = armedPolicy();
      const from = START + T.startupGraceMs;
      expect(feedTimeouts(policy, from, 2).decision).toBeNull();
      const at = from + 2 * (T.probeTimeoutMs + T.failureIntervalMs);
      const outcome: HealthProbeOutcome = reset === "answered"
        ? answered(at, null)
        : { kind: reset, startedAt: at, endedAt: at + 1 };
      expect(policy.observe(outcome).action).toBe("continue");
      expect(policy.state().consecutiveTimeouts).toBe(0);
    }
  });

  test("an answer from another pid stands the sentinel down for good", () => {
    const policy = armedPolicy();
    const decision = policy.observe(answered(START + 10_000, TARGET + 1));
    expect(decision.action).toBe("stand_down");
    expect(feedTimeouts(policy, START + T.startupGraceMs, 5).decision?.action).toBe("stand_down");
  });

  test("an overslept cadence discards the streak; fresh observations are needed", () => {
    const policy = armedPolicy();
    const from = START + T.startupGraceMs;
    expect(feedTimeouts(policy, from, 2).decision).toBeNull();
    // The machine slept for an hour after the second timeout.
    const afterSleep = from + 2 * (T.probeTimeoutMs + T.failureIntervalMs) + 3_600_000;
    expect(policy.observe(timeout(afterSleep)).note).toContain("gap");
    expect(policy.state().consecutiveTimeouts).toBe(1);
    expect(feedTimeouts(policy, afterSleep + T.probeTimeoutMs + T.failureIntervalMs, 1).decision).toBeNull();
    expect(feedTimeouts(policy, afterSleep + 2 * (T.probeTimeoutMs + T.failureIntervalMs), 1).decision?.action).toBe("recover");
  });

  test("a probe whose clock spanned a pause, or ran backwards, is not a timeout", () => {
    const policy = armedPolicy();
    const from = START + T.startupGraceMs;
    expect(feedTimeouts(policy, from, 2).decision).toBeNull();
    const at = from + 2 * (T.probeTimeoutMs + T.failureIntervalMs);
    expect(policy.observe(timeout(at, 600_000)).action).toBe("continue");
    expect(policy.state().consecutiveTimeouts).toBe(0);
    expect(policy.observe({ kind: "timeout", startedAt: at + 700_000, endedAt: at + 690_000 }).action).toBe("continue");
    expect(policy.state().consecutiveTimeouts).toBe(0);
  });

  test("a timeout observed while the sentinel itself was late is not evidence", () => {
    // The sentinel is paused for most of each probe (starved, stopped, or the machine slept) and the
    // timeout callback wins on resume: three such timeouts back to back would otherwise recover a
    // healthy target.
    const policy = armedPolicy();
    let at = START + T.startupGraceMs;
    for (let i = 0; i < 10; i += 1) {
      const decision = policy.observe({ kind: "timeout", startedAt: at, endedAt: at + T.probeTimeoutMs, sentinelLagMs: 18_000 });
      expect(decision.action).toBe("continue");
      at += T.probeTimeoutMs + T.failureIntervalMs;
    }
    expect(policy.state().consecutiveTimeouts).toBe(0);
    // Ordinary scheduling jitter still counts.
    const jitter = armedPolicy();
    at = START + T.startupGraceMs;
    let last = null as string | null;
    for (let i = 0; i < 3; i += 1) {
      last = jitter.observe({ kind: "timeout", startedAt: at, endedAt: at + T.probeTimeoutMs, sentinelLagMs: 300 }).action;
      at += T.probeTimeoutMs + T.failureIntervalMs;
    }
    expect(last).toBe("recover");
  });

  test("recoveries dated in the future still count after a clock rollback and across a restart", () => {
    // Merge sign-off condition B: three attempts, then the wall clock is set back two hours. Their
    // entries now lie in the future and must not lift the hourly cap.
    const from = START + T.startupGraceMs;
    const rolledBack = [from + 2 * 3_600_000 - 120_000, from + 2 * 3_600_000 - 60_000, from + 2 * 3_600_000];
    expect(recentRecoveryCount(rolledBack, from, T.recoveryWindowMs)).toBe(3);
    expect(feedTimeouts(armedPolicy(rolledBack), from, 60).decision?.action).toBe("stand_down");
    // A restarted sentinel reads the same history and reaches the same answer.
    const restarted = createHealthSentinelPolicy({ targetPid: TARGET, startedAt: START + 1, recoveryHistory: rolledBack });
    restarted.observe(answered(START + 1));
    expect(feedTimeouts(restarted, from, 60).decision?.action).toBe("stand_down");
    // One future entry still doubles the required span.
    const one = armedPolicy([from + 3_600_000]);
    feedTimeouts(one, from, 1);
    expect(one.requiredUnhealthyMs()).toBe(2 * T.minUnhealthyMs);
    // Once the clock passes an entry by a full window, it stops counting.
    expect(recentRecoveryCount([from], from + T.recoveryWindowMs, T.recoveryWindowMs)).toBe(0);
  });

  test("startup grace is elapsed time: a clock set back neither reopens nor extends it", () => {
    // After the grace: a two-hour rollback must not suspend counting for two hours.
    const after = armedPolicy();
    let at = START + T.startupGraceMs + 10_000;
    expect(after.observe(answered(at)).action).toBe("continue");
    at -= 2 * 3_600_000;
    const decisions: string[] = [];
    for (let i = 0; i < 6 && !decisions.includes("recover"); i += 1) {
      decisions.push(after.observe(timeout(at)).action);
      at += T.probeTimeoutMs + T.failureIntervalMs;
    }
    expect(decisions).toContain("recover");
    // During the grace: time elapsed before the rollback still counts toward it.
    const during = armedPolicy();
    at = START + 100_000;
    expect(during.observe(answered(at)).action).toBe("continue");
    at -= 3_600_000;
    expect(during.observe(timeout(at)).note).toBe("startup grace");
    at += 25_000;
    expect(during.observe(answered(at)).action).toBe("continue");
    at += 1_000;
    expect(during.observe(timeout(at)).note).not.toBe("startup grace");
  });

  test("earlier recoveries double the required unhealthy span and the hourly cap stands down", () => {
    expect(requiredUnhealthySpan(T, 0)).toBe(T.minUnhealthyMs);
    expect(requiredUnhealthySpan(T, 1)).toBe(2 * T.minUnhealthyMs);
    expect(requiredUnhealthySpan(T, 10)).toBe(T.maxBackoffMultiplier * T.minUnhealthyMs);
    const from = START + T.startupGraceMs;
    // One recent recovery: the required span doubles to 120 s, so more back-to-back timeouts are needed.
    const once = armedPolicy([from - 60_000]);
    const onceResult = feedTimeouts(once, from, 40);
    expect(onceResult.decision?.action).toBe("recover");
    expect(once.requiredUnhealthyMs()).toBe(2 * T.minUnhealthyMs);
    // Two recent recoveries need a longer streak than none.
    const twice = armedPolicy([from - 120_000, from - 60_000]);
    const twiceResult = feedTimeouts(twice, from, 40);
    expect(twiceResult.decision?.action).toBe("recover");
    expect(twiceResult.index).toBeGreaterThan(onceResult.index);
    expect(onceResult.index).toBeGreaterThan(feedTimeouts(armedPolicy(), from, 10).index);
    // Three in the window: never again for this process.
    const capped = armedPolicy([from - 180_000, from - 120_000, from - 60_000]);
    expect(feedTimeouts(capped, from, 60).decision?.action).toBe("stand_down");
    // History older than the window does not count.
    expect(recentRecoveryCount([from - 2 * T.recoveryWindowMs], from, T.recoveryWindowMs)).toBe(0);
  });
});
