import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses/core";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "fixture-anthropic",
    providers: {
      "fixture-anthropic": {
        adapter: "openai-chat",
        baseUrl: "https://anthropic.example.test/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

async function post(model: string): Promise<{ response: Record<string, unknown>; upstreamModel: unknown }> {
  let upstreamModel: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamModel = (await request.clone().json() as Record<string, unknown>).model;
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: "ping", stream: false }),
    }),
    routedConfig(),
    { model: "", provider: "" },
    {},
  );

  return {
    response: await result.json() as Record<string, unknown>,
    upstreamModel,
  };
}

describe("routed response model identity", () => {
  test("preserves a provider-qualified selector in the Codex response", async () => {
    const result = await post("fixture-anthropic/claude-sonnet-5");

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect(result.response.model).toBe("fixture-anthropic/claude-sonnet-5");
  });

  test("heals a bare routed selector in the Codex response", async () => {
    const result = await post("claude-sonnet-5");

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect(result.response.model).toBe("fixture-anthropic/claude-sonnet-5");
  });
});
