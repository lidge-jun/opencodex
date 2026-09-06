import { describe, expect, test } from "bun:test";
import { computeFailureFingerprint, sanitizeSignature } from "../../src/telemetry/fingerprint";
import type { FailureEvent } from "../../src/telemetry/types";

describe("computeFailureFingerprint", () => {
  test("ignores timestamps, request/session IDs, and line/column numbers", () => {
    const first: FailureEvent = {
      failureKind: "upstream_wire_error",
      provider: "openai",
      model: "gpt-5",
      signature: "Error at file.ts:12:8 request_id=req-123 session_id=s-1",
      timestamp: 1000,
      requestId: "req-123",
      sessionId: "s-1",
    };
    const second: FailureEvent = {
      ...first,
      signature: "Error at file.ts:99:42 request_id=req-999 session_id=s-9",
      timestamp: 9000,
      requestId: "req-999",
      sessionId: "s-9",
    };
    expect(computeFailureFingerprint(first)).toBe(computeFailureFingerprint(second));
    expect(computeFailureFingerprint(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("changes when stable failure identity changes", () => {
    const event: FailureEvent = { failureKind: "websocket_1006", provider: "openai", model: "gpt-5", signature: "closed" };
    expect(computeFailureFingerprint(event)).not.toBe(computeFailureFingerprint({ ...event, provider: "anthropic" }));
    expect(computeFailureFingerprint(event)).not.toBe(computeFailureFingerprint({ ...event, model: "gpt-4" }));
    expect(computeFailureFingerprint(event)).not.toBe(computeFailureFingerprint({ ...event, failureKind: "tool_loop" }));
  });

  test("excludes forbidden fields such as prompts, bodies, and credentials", () => {
    const sampleToken = ["sk", "ant", "fixture", "1234567890"].join("-");
    const baseline: FailureEvent = {
      failureKind: "upstream_wire_error",
      provider: "openai",
      model: "gpt-5",
      signature: "Connection timeout",
    };
    const withForbidden: FailureEvent = {
      ...baseline,
      prompt: "secret user prompt text",
      response: "secret assistant response text",
      body: { hidden: "payload" },
      headers: { authorization: "Bearer secret-token" },
      apiKey: sampleToken,
      accountId: "acc-secret-999",
    };
    expect(computeFailureFingerprint(baseline)).toBe(computeFailureFingerprint(withForbidden));
  });

  test("sanitizes secrets, credentials, and absolute filesystem paths inside signature", () => {
    const homePath = ["", "Users", "alice", "project", "src", "index.ts"].join("/");
    const sampleKey = ["sk", "ant", "fixture", "1234567890abcdef"].join("-");
    const raw = `Error in ${homePath}: bearer secret_token_xyz ${sampleKey}`;
    const sanitized = sanitizeSignature(raw);
    expect(sanitized).not.toContain(["", "Users", "alice"].join("/"));
    expect(sanitized).not.toContain("secret_token_xyz");
    expect(sanitized).not.toContain(sampleKey);
    expect(sanitized).toContain("[path]");
    expect(sanitized).toContain("[redacted]");
  });

  test("bounds oversized signatures", () => {
    const longSignature = "a".repeat(2000);
    const sanitized = sanitizeSignature(longSignature);
    expect(sanitized.length).toBeLessThanOrEqual(1024);
  });

  test("handles empty or malformed inputs without throwing", () => {
    const event: FailureEvent = {
      failureKind: "",
      signature: "",
    };
    const fp = computeFailureFingerprint(event);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });
});
