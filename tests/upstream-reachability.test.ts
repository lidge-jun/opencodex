import { beforeEach, describe, expect, test } from "bun:test";
import {
  classifyTransportFailureKind,
  isPreConnectReachabilityError,
  transportErrorCode,
  MAX_REACHABILITY_CAUSE_DEPTH,
} from "../src/lib/upstream-reachability";
import { UpstreamRetryEvidenceError } from "../src/lib/upstream-retry";
import {
  UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
  UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,
  UPSTREAM_HOST_FAILURE_WINDOW_MS,
  UPSTREAM_HOST_HEALTH_MAX_ENTRIES,
  acquireUpstreamHostAdmission,
  clearUpstreamHostHealth,
  disableUpstreamHostCircuitForKey,
  getUpstreamHostHealth,
  normalizeUpstreamHostCircuitThreshold,
  recordUpstreamHostFailure,
  releaseUpstreamHostAdmission,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  type UpstreamHostAdmissionLease,
} from "../src/codex/upstream-host-health";
import {
  maybePrimeSubagentQuota,
  resetSubagentModelFallbackStateForTests,
  setSubagentQuotaPrimeForTests,
} from "../src/codex/subagent-model-fallback";
import type { OcxConfig } from "../src/types";

beforeEach(() => {
  clearUpstreamHostHealth();
  resetSubagentModelFallbackStateForTests();
});

function coded(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause !== undefined ? { cause } : {}) });
}

describe("isPreConnectReachabilityError", () => {
  test("accepts Bun and Node pre-connect codes at cause depth 0-2", () => {
    for (const code of ["ConnectionRefused", "FailedToOpenSocket", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH"]) {
      expect(isPreConnectReachabilityError(coded("x", code))).toBe(true);
    }
    expect(isPreConnectReachabilityError(
      new Error("outer", { cause: coded("mid", "ENOENT", coded("inner", "ECONNREFUSED")) }),
    )).toBe(true);
  });

  test("rejects at the bounded depth, on cycles, non-Errors, and message-only text", () => {
    // depth-3 chain: beyond MAX_REACHABILITY_CAUSE_DEPTH.
    let deep: unknown = coded("inner", "ECONNREFUSED");
    for (let i = 0; i < MAX_REACHABILITY_CAUSE_DEPTH; i++) deep = new Error(`wrap${i}`, { cause: deep });
    expect(isPreConnectReachabilityError(deep)).toBe(false);

    const a: { cause?: unknown } = new Error("a");
    const b: { cause?: unknown } = new Error("b");
    a.cause = b; b.cause = a;
    expect(isPreConnectReachabilityError(a)).toBe(false);

    expect(isPreConnectReachabilityError("ECONNREFUSED")).toBe(false);
    expect(isPreConnectReachabilityError(new Error("ECONNREFUSED api.example.com"))).toBe(false);
    expect(isPreConnectReachabilityError(null)).toBe(false);
  });

  test("reset/TLS/unknown shapes stay out of the pre-connect set", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ERR_TLS_CERT_ALTNAME_INVALID", "EPROTO", "ETIMEDOUT"]) {
      expect(isPreConnectReachabilityError(coded("x", code))).toBe(false);
    }
    expect(isPreConnectReachabilityError(new Error("socket hang up"))).toBe(false);
  });
});

describe("classifyTransportFailureKind", () => {
  test("TimeoutError keeps its own identity", () => {
    const err = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(classifyTransportFailureKind(err)).toBe("timeout");
  });

  test("plain pre-connect rejection is account-neutral", () => {
    expect(classifyTransportFailureKind(coded("refused", "ECONNREFUSED"))).toBe("connect_neutral");
    expect(classifyTransportFailureKind(coded("refused", "ConnectionRefused"))).toBe("connect_neutral");
  });

  test("reset, TLS, and unknown rejections stay account-attributed", () => {
    expect(classifyTransportFailureKind(coded("reset", "ECONNRESET"))).toBe("connect_error");
    expect(classifyTransportFailureKind(coded("tls", "ERR_TLS_CERT_ALTNAME_INVALID"))).toBe("connect_error");
    expect(classifyTransportFailureKind(new Error("socket hang up"))).toBe("connect_error");
  });

  test("a transient 5xx before the rejection erases the neutral class (mixed evidence)", () => {
    const err = new UpstreamRetryEvidenceError([503], coded("refused", "ECONNREFUSED"));
    expect(classifyTransportFailureKind(err)).toBe("connect_error");
  });

  test("a credential-visible reset before the rejection erases the neutral class", () => {
    const err = new UpstreamRetryEvidenceError([], coded("refused", "ECONNREFUSED"), true);
    expect(classifyTransportFailureKind(err)).toBe("connect_error");
  });

  test("an evidence wrapper without credential-visible evidence keeps the neutral class", () => {
    const err = new UpstreamRetryEvidenceError([], coded("refused", "ECONNREFUSED"));
    expect(classifyTransportFailureKind(err)).toBe("connect_neutral");
  });

  test("transportErrorCode unwraps the evidence error", () => {
    const err = new UpstreamRetryEvidenceError([502], coded("refused", "ECONNREFUSED"));
    expect(transportErrorCode(err)).toBe("ECONNREFUSED");
    expect(transportErrorCode(new Error("x"))).toBeUndefined();
  });
});

describe("upstream host health ledger", () => {
  test("records, windows, resets, and prunes at the 128-entry cap", () => {
    clearUpstreamHostHealth();
    const key = upstreamHostHealthKey("openai", "chatgpt.com");
    expect(key).toBe("openai|chatgpt.com");

    recordUpstreamHostFailure(key, { code: "ECONNREFUSED", now: 1000 });
    recordUpstreamHostFailure(key, { now: 2000 });
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 2, lastFailureCode: "ECONNREFUSED" });

    // Stale window: a failure after the window restarts the streak.
    recordUpstreamHostFailure(key, { now: 2000 + UPSTREAM_HOST_FAILURE_WINDOW_MS + 1 });
    expect(getUpstreamHostHealth(key)?.consecutiveFailures).toBe(1);

    resetUpstreamHostHealth(key);
    expect(getUpstreamHostHealth(key)).toBeNull();

    // Churn: many distinct providers/hosts never grow the map past the cap.
    for (let i = 0; i < UPSTREAM_HOST_HEALTH_MAX_ENTRIES * 3; i++) {
      recordUpstreamHostFailure(upstreamHostHealthKey(`p${i}`, `h${i}.test`), { now: 10_000 + i });
    }
    let size = 0;
    for (let i = 0; i < UPSTREAM_HOST_HEALTH_MAX_ENTRIES * 3; i++) {
      if (getUpstreamHostHealth(upstreamHostHealthKey(`p${i}`, `h${i}.test`))) size++;
    }
    expect(size).toBeLessThanOrEqual(UPSTREAM_HOST_HEALTH_MAX_ENTRIES);
    // The freshest entries survive stalest-first pruning.
    const freshest = UPSTREAM_HOST_HEALTH_MAX_ENTRIES * 3 - 1;
    expect(getUpstreamHostHealth(upstreamHostHealthKey(`p${freshest}`, `h${freshest}.test`))).not.toBeNull();
    clearUpstreamHostHealth();
  });
});

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
    expect(normalizeUpstreamHostCircuitThreshold(0)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold("3")).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(1.5)).toBe(0);
    expect(normalizeUpstreamHostCircuitThreshold(3)).toBe(3);
    expect(normalizeUpstreamHostCircuitThreshold(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD)).toBe(
      UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD,
    );
    expect(normalizeUpstreamHostCircuitThreshold(999)).toBe(UPSTREAM_HOST_CIRCUIT_MAX_THRESHOLD);

    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    expect(acquireUpstreamHostAdmission(key, 0, 1_000)).toEqual({
      kind: "admitted",
      lease: null,
    });
  });

  test("an open ChatGPT host circuit suppresses subagent quota priming", async () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const openedAt = 100_000;
    fail(key, 1, openedAt);
    let primeCalls = 0;
    setSubagentQuotaPrimeForTests(async () => {
      primeCalls += 1;
    });
    const config = {
      port: 10100,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
      defaultProvider: "openai",
      upstreamHostCircuitThreshold: 1,
    } as OcxConfig;

    await maybePrimeSubagentQuota(config, openedAt + 1);
    expect(primeCalls).toBe(0);
    // Even after the cooldown timestamp passes, priming stays out of the way;
    // the logical request itself owns the one half-open admission.
    await maybePrimeSubagentQuota(config, openedAt + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS + 1);
    expect(primeCalls).toBe(0);

    // Positive control: with no host circuit, the same config primes exactly once.
    clearUpstreamHostHealth();
    await maybePrimeSubagentQuota(config, openedAt + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS + 2);
    expect(primeCalls).toBe(1);
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

  test("a concurrent HTTP response can close the cooldown opened by its peer", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const failing = admit(key, 1, 7_500);
    const succeeding = admit(key, 1, 7_500);

    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: 7_501,
      threshold: 1,
      lease: failing,
    });
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBe(7_501 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS);

    expect(resetUpstreamHostHealth(key, succeeding, 7_502)).toBe(true);
    expect(getUpstreamHostHealth(key)).toBeNull();
  });

  test("a stale failure streak expires after the failure window", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 3, 12_000);
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });

    const afterWindow = 12_000 + UPSTREAM_HOST_FAILURE_WINDOW_MS + 1;
    const lease = admit(key, 3, afterWindow);
    expect(lease.halfOpen).toBe(false);
    recordUpstreamHostFailure(key, {
      code: "ECONNREFUSED",
      now: afterWindow,
      threshold: 3,
      lease,
    });
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });
  });

  test("the retention cap evicts the stalest unleased origin", () => {
    for (let i = 0; i < UPSTREAM_HOST_HEALTH_MAX_ENTRIES + 8; i += 1) {
      fail(upstreamHostHealthKey("openai", `https://h${i}.example`), 1, 13_000 + i);
    }
    expect(getUpstreamHostHealth(upstreamHostHealthKey("openai", "https://h0.example"))).toBeNull();
    expect(getUpstreamHostHealth(
      upstreamHostHealthKey("openai", `https://h${UPSTREAM_HOST_HEALTH_MAX_ENTRIES + 7}.example`),
    )).not.toBeNull();
  });

  test("retention pressure never evicts an active admission lease", () => {
    const leases: UpstreamHostAdmissionLease[] = [];
    for (let i = 0; i < UPSTREAM_HOST_HEALTH_MAX_ENTRIES + 1; i += 1) {
      leases.push(admit(upstreamHostHealthKey("openai", `https://active-${i}.example`), 1, 14_000 + i));
    }
    for (const [index, lease] of leases.entries()) {
      expect(releaseUpstreamHostAdmission(lease, index === 0 ? 15_000 : 15_001)).toBe(true);
    }
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

  test("a lease cannot settle a different host key", () => {
    const keyA = upstreamHostHealthKey("openai", "https://chatgpt.com");
    const keyB = upstreamHostHealthKey("openai", "https://api.openai.com");
    const leaseA = admit(keyA, 1, 10_000);
    expect(resetUpstreamHostHealth(keyB, leaseA, 10_001)).toBe(false);
    recordUpstreamHostFailure(keyB, {
      code: "ECONNREFUSED",
      now: 10_002,
      threshold: 1,
      lease: leaseA,
    });
    expect(getUpstreamHostHealth(keyB)).toBeNull();
    recordUpstreamHostFailure(keyA, {
      code: "ECONNREFUSED",
      now: 10_003,
      threshold: 1,
      lease: leaseA,
    });
    expect(getUpstreamHostHealth(keyA)).toMatchObject({
      consecutiveFailures: 1,
      cooldownUntil: 10_003 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS,
    });
  });

  test("disabled traffic can clear an old circuit before it is re-enabled", () => {
    const key = upstreamHostHealthKey("openai", "https://chatgpt.com");
    fail(key, 1, 11_000);
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBe(11_000 + UPSTREAM_HOST_CIRCUIT_COOLDOWN_MS);

    expect(disableUpstreamHostCircuitForKey(key, 11_001)).toBe(true);
    expect(getUpstreamHostHealth(key)).toMatchObject({ consecutiveFailures: 1 });
    expect(getUpstreamHostHealth(key)?.cooldownUntil).toBeUndefined();

    expect(resetUpstreamHostHealth(key)).toBe(true);
    expect(getUpstreamHostHealth(key)).toBeNull();
    expect(acquireUpstreamHostAdmission(key, 1, 11_002).kind).toBe("admitted");
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
