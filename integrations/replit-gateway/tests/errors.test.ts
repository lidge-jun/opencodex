import { describe, expect, test } from "bun:test";
import { classifyGatewayError, classifyRelayFailure, gatewayErrorResponse } from "../src/errors";

describe("gateway error classification", () => {
  test("classifies abort errors from client signals", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(classifyGatewayError(err, { source: "client" })).toBe("client_aborted");
  });

  test("classifies abort errors from upstream timeouts", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(classifyGatewayError(err, { source: "upstream", timedOut: true })).toBe(
      "upstream_timeout",
    );
  });

  test("classifies ordinary upstream failures as upstream_error", () => {
    expect(classifyGatewayError(new Error("network down"), { source: "upstream" })).toBe(
      "upstream_error",
    );
    expect(classifyGatewayError(new Error("502 bad gateway"), { source: "upstream" })).toBe(
      "upstream_error",
    );
  });

  test("classifies upstream abort without timeout as upstream_error", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(classifyGatewayError(err, { source: "upstream", timedOut: false })).toBe(
      "upstream_error",
    );
  });

  test("classifyRelayFailure distinguishes caller abort, client deadline, and upstream deadline", () => {
    expect(classifyRelayFailure(new Error("aborted"), {
      callerAborted: true,
      clientTimedOut: false,
      upstreamTimedOut: false,
    })).toBe("client_aborted");
    expect(classifyRelayFailure(new Error("aborted"), {
      callerAborted: false,
      clientTimedOut: true,
      upstreamTimedOut: false,
    })).toBe("client_timeout");
    expect(classifyRelayFailure(new Error("aborted"), {
      callerAborted: false,
      clientTimedOut: false,
      upstreamTimedOut: true,
    })).toBe("upstream_timeout");
  });

  test("maps categories to safe JSON responses without bodies", () => {
    const res = gatewayErrorResponse("auth_failed", 401);
    expect(res.status).toBe(401);
    return res.json().then((body) => {
      expect(body).toEqual({
        error: {
          type: "auth_failed",
          message: "Gateway authentication failed",
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/AI_INTEGRATIONS/);
    });
  });
});
