import { describe, expect, test } from "bun:test";
import {
  classifyTransportFailureKind,
  isPreConnectReachabilityError,
  MAX_REACHABILITY_CAUSE_DEPTH,
  transportErrorCode,
  transportFailureHost,
} from "../src/lib/upstream-reachability";
import { TransientRetryEvidenceError } from "../src/lib/upstream-retry";

function errorWithCode(code: string | undefined, message: string, cause?: unknown): Error {
  const err = new Error(message) as Error & { code?: string; cause?: unknown };
  if (code !== undefined) err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

// Shapes observed on Bun 1.3.14 (probe run 2026-08-04): DNS failure and TCP
// refusal both surface as ConnectionRefused / FailedToOpenSocket, errno 0, no
// cause, alternating between labels as the DNS cache is evicted.
describe("isPreConnectReachabilityError", () => {
  test.each([
    ["Bun DNS failure", errorWithCode("ConnectionRefused", "Unable to connect. Is the computer able to access the url?")],
    ["Bun TCP refusal", errorWithCode("FailedToOpenSocket", "Was there a typo in the url or port?")],
    ["Bun alternated label", errorWithCode("FailedToOpenSocket", "Unable to connect. Is the computer able to access the url?")],
    ["Node DNS failure", errorWithCode("ENOTFOUND", "getaddrinfo ENOTFOUND api.example.com")],
    ["Node resolver transient", errorWithCode("EAI_AGAIN", "getaddrinfo EAI_AGAIN api.example.com")],
    ["Node TCP refusal", errorWithCode("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443")],
    ["Node network unreachable", errorWithCode("ENETUNREACH", "connect ENETUNREACH 10.0.0.1:443")],
    ["Node network down", errorWithCode("ENETDOWN", "connect ENETDOWN")],
    ["Node host unreachable", errorWithCode("EHOSTUNREACH", "connect EHOSTUNREACH")],
  ])("classifies the %s shape as pre-connect", (_label, err) => {
    expect(isPreConnectReachabilityError(err)).toBe(true);
  });

  test.each([
    ["established-socket reset", errorWithCode("ECONNRESET", "The socket connection was closed unexpectedly")],
    ["pipeline close", errorWithCode("EPIPE", "broken pipe")],
    ["TLS certificate mismatch", errorWithCode("ERR_TLS_CERT_ALTNAME_INVALID", 'ERR_TLS_CERT_ALTNAME_INVALID fetching "https://api.example.com"')],
    ["unknown code", errorWithCode("SomethingElse", "boom")],
    ["no code at all", new Error("boom")],
    ["non-Error rejection", "socket hang up"],
    ["null rejection", null],
  ])("does not classify the %s shape as pre-connect", (_label, err) => {
    expect(isPreConnectReachabilityError(err)).toBe(false);
  });

  test("message-only matches are rejected even when the text quotes the code", () => {
    // The reporter-required negative: a message that merely contains the code
    // (e.g. an upstream echoing it back) must not fire the classifier.
    expect(isPreConnectReachabilityError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(false);
    expect(isPreConnectReachabilityError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(false);
  });

  test("inspects a bounded cause chain", () => {
    const inner = errorWithCode("ENOTFOUND", "getaddrinfo ENOTFOUND");
    const mid = errorWithCode(undefined, "wrapped", inner);
    const outer = errorWithCode(undefined, "wrapped again", mid);
    expect(isPreConnectReachabilityError(outer)).toBe(true);
  });

  test("does not recurse past the depth bound", () => {
    let current = errorWithCode("ENOTFOUND", "deep");
    for (let i = 0; i < MAX_REACHABILITY_CAUSE_DEPTH; i++) {
      current = errorWithCode(undefined, `layer ${i}`, current);
    }
    expect(isPreConnectReachabilityError(current)).toBe(false);
  });

  test("stops at a non-Error cause instead of descending through it", () => {
    const wrapped = errorWithCode(undefined, "wrapped", "string cause");
    expect(isPreConnectReachabilityError(wrapped)).toBe(false);
  });

  test("a self-referential cause does not loop forever", () => {
    const cyclic = new Error("cycle") as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isPreConnectReachabilityError(cyclic)).toBe(false);
  });
});

describe("classifyTransportFailureKind", () => {
  test("a timeout keeps its existing identity", () => {
    const timeout = Object.assign(new Error("Timeout elapsed"), { name: "TimeoutError" });
    expect(classifyTransportFailureKind(timeout)).toBe("timeout");
  });

  test("proven pre-connect shapes become neutral", () => {
    expect(classifyTransportFailureKind(errorWithCode("ConnectionRefused", "unreachable"))).toBe("connect_neutral");
    expect(classifyTransportFailureKind(errorWithCode("ENOTFOUND", "unreachable"))).toBe("connect_neutral");
  });

  test("everything else keeps the existing account-attributed connect_error", () => {
    expect(classifyTransportFailureKind(errorWithCode("ECONNRESET", "reset"))).toBe("connect_error");
    expect(classifyTransportFailureKind(errorWithCode("EPIPE", "pipe"))).toBe("connect_error");
    expect(classifyTransportFailureKind(new Error("getaddrinfo ENOTFOUND"))).toBe("connect_error");
    expect(classifyTransportFailureKind("string rejection")).toBe("connect_error");
    expect(classifyTransportFailureKind(undefined)).toBe("connect_error");
  });

  test("a rejection after a transient 5xx stays account-attributed, never neutral", () => {
    // Mixed 5xx -> rejection: the upstream already answered 503 before the final
    // attempt rejected, so the host and credential path were reached. The
    // evidence wrapper must keep the failure out of the pre-connect class.
    const wrapped = new TransientRetryEvidenceError(
      [503],
      errorWithCode("ConnectionRefused", "Unable to connect. Is the computer able to access the url?"),
    );
    expect(classifyTransportFailureKind(wrapped)).toBe("connect_error");
  });

  test("a timeout after a transient 5xx keeps the timeout identity", () => {
    const rejection = Object.assign(new Error("Timeout elapsed"), { name: "TimeoutError" });
    const wrapped = new TransientRetryEvidenceError([503], rejection);
    expect(classifyTransportFailureKind(wrapped)).toBe("timeout");
  });

  test("an evidence wrapper without prior statuses classifies by its cause", () => {
    const wrapped = new TransientRetryEvidenceError(
      [],
      errorWithCode("ConnectionRefused", "Unable to connect. Is the computer able to access the url?"),
    );
    expect(classifyTransportFailureKind(wrapped)).toBe("connect_neutral");
  });

  test("the evidence wrapper preserves the final rejection and its statuses", () => {
    const rejection = errorWithCode("ConnectionRefused", "Unable to connect");
    const wrapped = new TransientRetryEvidenceError([503, 502], rejection);
    expect(wrapped.cause).toBe(rejection);
    expect(wrapped.transientStatuses).toEqual([503, 502]);
    expect(transportErrorCode(wrapped)).toBeUndefined();
  });
});

describe("transport error helpers", () => {
  test("transportErrorCode returns only a stable string code", () => {
    expect(transportErrorCode(errorWithCode("ConnectionRefused", "x"))).toBe("ConnectionRefused");
    expect(transportErrorCode(errorWithCode("", "x"))).toBeUndefined();
    expect(transportErrorCode(new Error("x"))).toBeUndefined();
    expect(transportErrorCode("not an error")).toBeUndefined();
  });

  test("transportFailureHost extracts the host or returns null", () => {
    expect(transportFailureHost("https://api.chatgpt.com/backend-api/x")).toBe("api.chatgpt.com");
    expect(transportFailureHost("http://127.0.0.1:1/x")).toBe("127.0.0.1:1");
    expect(transportFailureHost("not a url")).toBeNull();
  });
});
