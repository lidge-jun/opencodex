import { describe, expect, test } from "bun:test";
import {
  classifyTransportFailureKind,
  isPreConnectReachabilityError,
  transportErrorCode,
  MAX_REACHABILITY_CAUSE_DEPTH,
} from "../src/lib/upstream-reachability";
import { UpstreamRetryEvidenceError } from "../src/lib/upstream-retry";
import {
  clearUpstreamHostHealth,
  getUpstreamHostHealth,
  recordUpstreamHostFailure,
  resetUpstreamHostHealth,
  upstreamHostHealthKey,
  UPSTREAM_HOST_FAILURE_WINDOW_MS,
  UPSTREAM_HOST_HEALTH_MAX_ENTRIES,
} from "../src/codex/upstream-host-health";

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
