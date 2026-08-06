import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../src/server/responses/core";
import type { RequestLogContext } from "../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function routedConfig(providerName: string, adapter: OcxProviderConfig["adapter"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: providerName,
    providers: {
      [providerName]: {
        adapter,
        baseUrl: "https://provider.example.test/v1",
        authMode: "key",
        apiKey: "test-key",
      },
    },
  } as OcxConfig;
}

function responseSnapshot(model: unknown): Record<string, unknown> {
  return {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

async function post(args: {
  model: string;
  providerName?: string;
  adapter?: OcxProviderConfig["adapter"];
  stream?: boolean;
}): Promise<{ response: Response; upstreamModel: unknown; logCtx: RequestLogContext }> {
  const providerName = args.providerName ?? "fixture-anthropic";
  const adapter = args.adapter ?? "openai-chat";
  const stream = args.stream ?? false;
  let upstreamModel: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamModel = (await request.clone().json() as Record<string, unknown>).model;
    if (adapter === "openai-responses") {
      const snapshot = responseSnapshot(upstreamModel);
      if (stream) {
        const created = JSON.stringify({ type: "response.created", response: { ...snapshot, status: "in_progress" } });
        const completed = JSON.stringify({ type: "response.completed", response: snapshot });
        return new Response(
          `event: response.created\ndata: ${created}\n\nevent: response.completed\ndata: ${completed}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (stream) {
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const logCtx = { model: "", provider: "" } as RequestLogContext;
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: args.model, input: "ping", stream }),
    }),
    routedConfig(providerName, adapter),
    logCtx,
    {},
  );

  return { response, upstreamModel, logCtx };
}

function responseModelsFromSse(text: string): string[] {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const payload = block.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice(6);
    if (!payload || payload === "[DONE]") return [];
    const value = JSON.parse(payload) as { model?: unknown; response?: { model?: unknown } };
    const model = value.response?.model ?? value.model;
    return typeof model === "string" ? [model] : [];
  });
}

describe("routed response model identity", () => {
  test("preserves a canonical provider-qualified selector in JSON", async () => {
    const result = await post({ model: "fixture-anthropic/claude-sonnet-5" });

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect((await result.response.json() as Record<string, unknown>).model)
      .toBe("fixture-anthropic/claude-sonnet-5");
  });

  test("heals a bare routed selector in JSON", async () => {
    const result = await post({ model: "claude-sonnet-5" });

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect((await result.response.json() as Record<string, unknown>).model)
      .toBe("fixture-anthropic/claude-sonnet-5");
  });

  test("canonicalizes a legacy full-slash selector with the routed slug codec", async () => {
    const result = await post({
      model: "openrouter/anthropic/claude-sonnet-5",
      providerName: "openrouter",
    });

    expect(result.upstreamModel).toBe("anthropic/claude-sonnet-5");
    expect((await result.response.json() as Record<string, unknown>).model)
      .toBe("openrouter/anthropic-claude-sonnet-5");
  });

  test("all bridged SSE response snapshots use the canonical routed selector", async () => {
    const result = await post({ model: "claude-sonnet-5", stream: true });
    const models = responseModelsFromSse(await result.response.text());

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set(["fixture-anthropic/claude-sonnet-5"]));
  });

  test("Responses passthrough rewrites JSON for the client and keeps the physical log model", async () => {
    const result = await post({
      model: "claude-sonnet-5",
      adapter: "openai-responses",
    });

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect((await result.response.json() as Record<string, unknown>).model)
      .toBe("fixture-anthropic/claude-sonnet-5");
    expect(result.logCtx.resolvedModel).toBe("claude-sonnet-5");
  });

  test("Responses passthrough rewrites every SSE snapshot and keeps the upstream selector bare", async () => {
    const result = await post({
      model: "claude-sonnet-5",
      adapter: "openai-responses",
      stream: true,
    });
    const models = responseModelsFromSse(await result.response.text());

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect(models).toEqual([
      "fixture-anthropic/claude-sonnet-5",
      "fixture-anthropic/claude-sonnet-5",
    ]);
    expect(result.logCtx.resolvedModel).toBe("claude-sonnet-5");
  });

  test("virtual OpenAI API models keep the public selector while using and logging the base wire model", async () => {
    const result = await post({
      model: "openai-apikey/gpt-5.6-sol-pro",
      providerName: "openai-apikey",
      adapter: "openai-responses",
    });

    expect(result.upstreamModel).toBe("gpt-5.6-sol");
    expect((await result.response.json() as Record<string, unknown>).model)
      .toBe("openai-apikey/gpt-5.6-sol-pro");
    expect(result.logCtx.resolvedModel).toBe("gpt-5.6-sol");
  });

  test("combo responses keep the physical target while the logical log keeps the combo selector", async () => {
    let upstreamModel: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      upstreamModel = (await request.clone().json() as Record<string, unknown>).model;
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config: OcxConfig = {
      port: 0,
      defaultProvider: "member",
      providers: {
        member: {
          adapter: "openai-chat",
          baseUrl: "https://member.example.test/v1",
          authMode: "key",
          apiKey: "test-key",
        },
      },
      combos: { identity: { targets: [{ provider: "member", model: "claude-sonnet-5" }] } },
    };
    const logCtx = { model: "", provider: "" } as RequestLogContext;
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/identity", input: "ping", stream: false }),
    }), config, logCtx, {});

    expect(upstreamModel).toBe("claude-sonnet-5");
    expect((await response.json() as Record<string, unknown>).model).toBe("claude-sonnet-5");
    expect(logCtx.model).toBe("combo/identity");
    expect(logCtx.provider).toBe("combo");
    expect(logCtx.resolvedModel).toBe("claude-sonnet-5");
  });
});
