import { describe, expect, test } from "bun:test";
import { redactGatewaySecrets, safeLogRecord } from "../src/logging";

describe("safe logging", () => {
  test("redacts AI integration secrets and gateway keys", () => {
    const input = [
      "AI_INTEGRATIONS_OPENAI_API_KEY=super-secret",
      "Bearer gateway-key-01234567890123456789012",
      "path=/v1/models status=200",
    ].join(" ");
    const redacted = redactGatewaySecrets(input);
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("gateway-key-01234567890123456789012");
    expect(redacted).toContain("/v1/models");
  });

  test("redacts JSON and colon secret forms plus configured secret values", () => {
    const secret = "replit-managed-upstream-key-value";
    const input = [
      '{"AI_INTEGRATIONS_OPENAI_API_KEY":"replit-managed-upstream-key-value"}',
      "AI_INTEGRATIONS_OPENAI_API_KEY: replit-managed-upstream-key-value",
      secret,
    ].join(" ");
    const redacted = redactGatewaySecrets(input, [secret]);
    expect(redacted).not.toContain(secret);
  });

  test("emits metadata-only log records", () => {
    const record = safeLogRecord({
      requestId: "req-1",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      durationMs: 42,
      category: "upstream_error",
    });
    expect(record).toEqual({
      requestId: "req-1",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      durationMs: 42,
      category: "upstream_error",
    });
    expect(Object.keys(record)).not.toContain("body");
    expect(Object.keys(record)).not.toContain("authorization");
  });
});
