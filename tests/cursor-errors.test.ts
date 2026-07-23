import { describe, expect, test } from "bun:test";
import {
  classifyCursorError,
  isCursorBenignCancelError,
  isCursorInvalidArgumentError,
  safeCursorErrorMessage,
} from "../src/adapters/cursor/cursor-errors";

describe("classifyCursorError", () => {
  test("rate limit and resource exhaustion stay distinct", () => {
    expect(classifyCursorError("resource_exhausted: tool registration too large")).toBe("Cursor resource limit exceeded");
    expect(classifyCursorError("rate limit exceeded for model")).toBe("Cursor rate limit exceeded");
  });

  test("generic resource_exhausted is quota-style rate limiting, not a too-large request", () => {
    // The live retry-storm shape: no detail beyond "Error" — must map to 429 so Codex backs off.
    expect(classifyCursorError("Cursor Connect error resource_exhausted: Error")).toBe("Cursor rate limit exceeded");
    expect(classifyCursorError("resource_exhausted: too many requests")).toBe("Cursor rate limit exceeded");
    expect(classifyCursorError("resource_exhausted while loading tool catalog: quota exhausted")).toBe("Cursor rate limit exceeded");
    // Concurrency limits are quota shapes, not request-size overflow (a bare "limit"
    // tail must not satisfy the size patterns).
    expect(classifyCursorError("resource_exhausted: request exceeds concurrent request limit")).toBe("Cursor rate limit exceeded");
    expect(classifyCursorError("resource_exhausted: request exceeds per-user concurrent requests limit")).toBe("Cursor rate limit exceeded");
  });

  test("explicit request-size overflow keeps the too-large classification", () => {
    expect(classifyCursorError("resource_exhausted: tool catalog too large")).toBe("Cursor resource limit exceeded");
    expect(classifyCursorError("resource_exhausted: request exceeds maximum allowed size")).toBe("Cursor resource limit exceeded");
    expect(classifyCursorError("resource_exhausted: too many tools")).toBe("Cursor resource limit exceeded");
    // Explicit body/size subject keeps overflow semantics even with a "limit" tail.
    expect(classifyCursorError("resource_exhausted: request body exceeds maximum allowed limit")).toBe("Cursor resource limit exceeded");
    expect(classifyCursorError("resource_exhausted: request size exceeds maximum allowed limit")).toBe("Cursor resource limit exceeded");
  });

  test("authentication / permission denied", () => {
    expect(classifyCursorError("unauthenticated: invalid bearer token")).toBe("Cursor authentication failed");
    expect(classifyCursorError("permission_denied: account suspended")).toBe("Cursor authentication failed");
  });

  test("server overloaded / unavailable", () => {
    expect(classifyCursorError("Cursor gRPC error unavailable")).toBe("Cursor server overloaded");
    expect(classifyCursorError("server is busy, try later")).toBe("Cursor server overloaded");
  });

  test("invalid request / not found", () => {
    expect(classifyCursorError("model not found: bad-model-id")).toBe("Cursor invalid request");
    expect(classifyCursorError("invalid request: malformed tool schema")).toBe("Cursor invalid request");
  });

  test("timeout / deadline", () => {
    expect(classifyCursorError("Cursor transport timed out before first response")).toBe("Cursor request timed out");
    expect(classifyCursorError("deadline exceeded")).toBe("Cursor request timed out");
  });

  test("connection failures", () => {
    expect(classifyCursorError("read ECONNRESET")).toBe("Cursor connection failed");
    expect(classifyCursorError("connect ECONNREFUSED 1.2.3.4:443")).toBe("Cursor connection failed");
    expect(classifyCursorError("Stream closed with GOAWAY")).toBe("Cursor connection failed");
  });

  test("client-tool suspend cancel is not a connection failure", () => {
    expect(classifyCursorError("Cursor connection failed: Stream closed with error code NGHTTP2_CANCEL")).toBe("Cursor stream suspended");
  });

  test("unknown / generic", () => {
    expect(classifyCursorError("something unexpected happened")).toBe("Cursor upstream error");
  });
});

describe("isCursorBenignCancelError", () => {
  test("recognizes NGHTTP2_CANCEL and suspension markers", () => {
    expect(isCursorBenignCancelError(Object.assign(new Error("Stream closed with error code NGHTTP2_CANCEL"), { code: "ERR_HTTP2_STREAM_ERROR" }))).toBe(true);
    expect(isCursorBenignCancelError("Cursor stream suspended after client tools")).toBe(true);
    expect(isCursorBenignCancelError(new Error("read ECONNRESET"))).toBe(false);
  });
});

describe("safeCursorErrorMessage", () => {
  test("redacts Bearer tokens", () => {
    // Placeholder token shape is constrained by scripts/privacy-scan.ts's tests/ allowlist.
    const msg = safeCursorErrorMessage("unauthenticated: Bearer access-token-value-testonly123");
    expect(msg).toContain("Cursor authentication failed");
    expect(msg).not.toContain("access-token-value-testonly123");
    expect(msg).toContain("[REDACTED]");
  });

  test("redacts absolute paths", () => {
    const msg = safeCursorErrorMessage("config error in /Users/example/.cursor/settings.json");
    expect(msg).not.toContain("/Users/example/");
    expect(msg).toContain("[REDACTED_PATH]");
  });

  test("truncates very long messages", () => {
    const long = "x".repeat(1000);
    expect(safeCursorErrorMessage(long).length).toBeLessThanOrEqual(530);
  });

  test("does not present resource exhaustion as a billing or quota rate limit", () => {
    const msg = safeCursorErrorMessage("resource_exhausted: tool catalog too large");
    expect(msg).toContain("Cursor resource limit exceeded");
    expect(msg).not.toContain("resource_exhausted");
    expect(msg).not.toContain("rate limit");
  });

  test("end-to-end: quota-style resource exhaustion carries the rate-limit prefix", () => {
    expect(safeCursorErrorMessage("Cursor Connect error resource_exhausted: Error"))
      .toContain("Cursor rate limit exceeded");
    expect(safeCursorErrorMessage("resource_exhausted: too many requests"))
      .toContain("Cursor rate limit exceeded");
    expect(safeCursorErrorMessage("resource_exhausted while loading tool catalog: quota exhausted"))
      .toContain("Cursor rate limit exceeded");
    // Explicit overflow still reads as the 400-style prefix end-to-end.
    expect(safeCursorErrorMessage("resource_exhausted: request exceeds maximum allowed size"))
      .toContain("Cursor resource limit exceeded");
  });
});


describe("isCursorInvalidArgumentError", () => {
  test("matches Connect invalid_argument code and message", () => {
    expect(isCursorInvalidArgumentError({ code: "invalid_argument", message: "Cursor invalid request" })).toBe(true);
    expect(isCursorInvalidArgumentError(new Error("Cursor invalid request: Cursor Connect error invalid_argument: Error"))).toBe(true);
    expect(isCursorInvalidArgumentError(new Error("Cursor connection failed"))).toBe(false);
  });
});
