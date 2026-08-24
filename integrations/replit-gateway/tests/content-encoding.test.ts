import { describe, expect, test } from "bun:test";
import { validateRequestContentEncoding } from "../src/body";
import { createGatewayServer } from "../src/server/create-server";
import { loadGatewayConfigFromEnv } from "../src/config";

const VALID_ENV = {
  REPLIT_GATEWAY_KEY: "gateway-key-01234567890123456789012",
  REPLIT_GATEWAY_PUBLIC_ORIGIN: "https://my-app.replit.app",
  REPLIT_GATEWAY_OPENAI_MODELS: "gpt-4o",
  REPLIT_GATEWAY_ANTHROPIC_MODELS: "claude-sonnet-4-6",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "https://integrations.replit.com/openai/v1",
  AI_INTEGRATIONS_OPENAI_API_KEY: "replit-openai-secret",
  AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "https://integrations.replit.com/anthropic",
  AI_INTEGRATIONS_ANTHROPIC_API_KEY: "replit-anthropic-secret",
};

describe("request content encoding policy", () => {
  test("accepts absent or identity encoding", () => {
    expect(validateRequestContentEncoding(new Request("https://x.test", { method: "POST" })).ok).toBe(true);
    expect(
      validateRequestContentEncoding(new Request("https://x.test", {
        method: "POST",
        headers: { "content-encoding": "identity" },
      })).ok,
    ).toBe(true);
  });

  test("rejects compressed request bodies", () => {
    const result = validateRequestContentEncoding(new Request("https://x.test", {
      method: "POST",
      headers: { "content-encoding": "gzip" },
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("unsupported_content_encoding");
  });

  test("server rejects gzip-encoded relay requests before upstream fetch", async () => {
    const server = createGatewayServer(loadGatewayConfigFromEnv(VALID_ENV));
    const res = await server.fetch(new Request("https://gateway.test/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${VALID_ENV.REPLIT_GATEWAY_KEY}`,
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: JSON.stringify({ model: "gpt-4o", messages: [] }),
    }));
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error.type).toBe("unsupported_content_encoding");
    await server.stop();
  });
});
