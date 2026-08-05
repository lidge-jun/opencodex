import { beforeEach, describe, expect, test } from "bun:test";
import {
  UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
  UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,
  acquireUpstreamHostAdmission,
  clearUpstreamHostHealth,
  getUpstreamHostHealth,
  normalizeUpstreamHostCircuitThreshold,
  recordUpstreamHostFailure,
  releaseUpstreamHostAdmission,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  type UpstreamHostAdmissionLease,
} from "../src/codex/upstream-host-health";

beforeEach(() => clearUpstreamHostHealth());

function admit(key: string, threshold: number, now: number): UpstreamHostAdmissionLease {
  const admission = acquireUpstreamHostAdmission(key, threshold, now);
  expect(admission.kind).toBe("admitted");
  if (admission.kind !== "admitted" || !admission.lease) {
    throw new Error("expected a circuit admission lease");
  }
  return admission.lease;
}

function fail(key: string, threshold: number, now: number): void {
  recordUpstreamHostFailure(key, {
    code: "ECONNREFUSED",
    now,
    threshold,
    lease: admit(key, threshold, now),
  });
}

describe("opt-in upstream host circuit", () => {
  test("normalizes the opt-in threshold and leaves zero disabled", () => {
    expect(normalizeUpstreamHostCircuitThreshold(undefined)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(-1)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(1.5)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(3)).toBe(3);
    expect(normalizeUpstreamHostCircuitThreshold(999)).toBe(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD);

    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    expect(acquireUpstreamHostAdmission(key, 0, 1_000)).toEqual({
      kind: "admitted",
      lease: null,
    });
  });

  test("legacy observations cannot open the opt-in circuit without a lease", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    for (let attempt = 0; attempt < 3; attempt++) {
      recordUpstreamHostFailure(key, {
        code: "ECONNREFUSED",
        now: 2_000 + attempt,
        threshold: 1,
      });
    }
    expect(getUpstreamHostHealth(key)).toMatchObject({
      consecutiveFailures: 3,
      lastFailureCode: "ECONNREFUSED",
    });
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBeUndefined();
  });

  test("opens exactly at the configured threshold", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const threshold = 3;
    fail(key, threshold, 3_001);
    fail(key, threshold, 3_002);
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 2 });
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBeUndefined();

    fail(key, threshold, 3_003);
    expect(getUpstreamHostHealth(key)).toMatchObject({
      consecutiveFailures: 3,
      cooldownUntil: 3_003 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
    });
    expect(acquireUpstreamHostAdmission(key, threshold, 3_004)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 30,
    });
  });

  test("admits one half-open request and an HTTP response closes the circuit", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 1, 4_000);
    const probeAt = 4_000 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS;
    const probe = admit(key, 1, probeAt);
    expect(probe.halfOpen).toBe(true);
    expect(acquireUpstreamHostAdmission(key, 1, probeAt)).toEqual({
      kind: "blocked",
      retryAfterSeconds: 1,
    });
    expect(resetUpstreamHostHealth(key, probe, probeAt + 1)).toBe(true);
    expect(getUpstreamHostHealth(key)).toBeNull();
  });

  test("a half-open reachability failure immediately reopens the cooldown", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 1, 5_000);
    const probeAt = 5_000 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS;
    fail(key, 1, probeAt);
    expect(getUpstreamHostHealth(key)).toMatchObject({
      cooldownUntil: probeAt + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
    });
  });

  test("releasing a half-open request adds no evidence and permits another probe", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 1, 6_000);
    const probeAt = 6_000 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS;
    const before = getUpstreamHostHealth(key);
    const first = admit(key, 1, probeAt);
    expect(releaseUpstreamHostAdmission(first, probeAt)).toBe(true);
    expect(getUpstreamHostHealth(key)).toMatchObject({
      consecutiveFailures: before!.consecutiveFailures,
      lastFailureAt: before!.lastFailureAt,
      lastFailureCode: before!.lastFailureCode,
      cooldownUntil: before!.cooldownUntil,
    });
    expect(admit(key, 1, probeAt).halfOpen).toBe(true);
  });

  test("an HTTP response preserves a concurrent lease and its later failure authority", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const first = admit(key, 3, 7_000);
    const concurrent = admit(key, 3, 7_000);
    expect(resetUpstreamHostHealth(key, first, 7_001)).toBe(true);
    expect(getUpstreamHostHealth(key)).toBeNull();

    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: 7_002,
      threshold: 3,
      lease: concurrent,
    });
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });
  });

  test("a stale completion cannot mutate the generation that opened the circuit", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const stale = admit(key, 1, 8_000);
    fail(key, 1, 8_001);
    const before = getUpstreamHostHealth(key);

    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: 8_002,
      threshold: 1,
      lease: stale,
    });
    expect(getUpstreamHostHealth(key)).toEqual(before);
  });

  test("a later physical retry without its lease cannot close a newer circuit", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 1, 9_000);
    const before = getUpstreamHostHealth(key);

    expect(resetUpstreamHostHealth(key, null, 9_001)).toBe(false);
    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: 9_002,
      threshold: 1,
      lease: null,
    });
    // Unwired observational callers are also unable to mutate circuit-owned state.
    recordUpstreamHostFailure(key, { code: "ECONNREFUSED", now: 9_003 });

    expect(getUpstreamHostHealth(key)).toEqual(before);
  });
});
