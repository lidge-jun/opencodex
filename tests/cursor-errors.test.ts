import { describe, expect, test } from "bun:test";
import {
  classifyCursorError,
  isCursorBenignCancelError,
  safeCursorErrorMessage,
} from "../src/adapters/cursor/cursor-errors";

describe("classifyCursorError", () => {
  test("rate limit / resource exhausted", () => {
    expect(classifyCursorError("resource_exhausted: too many concurrent requests")).toBe("Cursor rate limit exceeded");
    expect(classifyCursorError("rate limit exceeded for model")).toBe("Cursor rate limit exceeded");
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
});
