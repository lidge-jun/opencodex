import { afterEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses/core";
import {
  inspectResponseLogJson, inspectResponseLogSsePayload, type RequestLogContext,
} from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

afterEach(() => {
  // Release the lease before later teardown can replace the preload sandbox home.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
});

function routedConfig(
  providerName: string,
  adapter: OcxProviderConfig["adapter"],
  model: string,
  wireAdapter?: OcxProviderConfig["adapter"],
): OcxConfig {
  return {
    port: 0,
    defaultProvider: providerName,
    providers: {
      [providerName]: {
        adapter,
        baseUrl: "https://provider.example.test/v1",
        authMode: "key",
        apiKey: "test-key",
        ...(wireAdapter ? { modelAdapters: { [model]: wireAdapter } } : {}),
      },
    },
  } as OcxConfig;
}

describe("a passthrough openai-model header is kept only as a known model id", () => {
  const PROVIDER_KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
  test.each([
    [PROVIDER_KEY, undefined],
    ["gpt-5.6-sol", "gpt-5.6-sol"],
  ])("upstream reports %s", async (reported, expected) => {
    releaseSpendHome = acquireOwnedSpendHome();
    // No body model, so only the header can set the served model.
    globalThis.fetch = (async () => new Response(JSON.stringify(responseSnapshot(undefined)), {
      status: 200,
      headers: { "content-type": "application/json", "openai-model": reported, "x-codex-safety-buffering-faster-model": reported },
    })) as unknown as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-openai/gpt-5.5", input: "hi", stream: false }),
    }), routedConfig("fixture-openai", "openai-responses", "gpt-5.5"), logCtx, {});
    const body = await response.text();
    // Non-vacuous: the passthrough answered and its row context was filled in.
    expect(response.status).toBe(200);
    expect(logCtx.provider).toBe("fixture-openai");
    expect(response.headers.get("openai-model") ?? undefined).toBe(expected);
    expect(response.headers.get("x-codex-safety-buffering-faster-model") ?? undefined).toBe(expected);
    expect(logCtx.servedModel).toBe(expected);
    expect(JSON.stringify([...response.headers, body, logCtx.servedModel, logCtx.resolvedModel])).not.toContain(PROVIDER_KEY);
  });
});

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
  wireAdapter?: OcxProviderConfig["adapter"];
  stream?: boolean;
}): Promise<{ response: Response; upstreamModel: unknown; logCtx: RequestLogContext }> {
  const providerName = args.providerName ?? "fixture-anthropic";
  const adapter = args.adapter ?? "anthropic";
  const effectiveAdapter = args.wireAdapter ?? adapter;
  const stream = args.stream ?? false;
  let upstreamModel: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    upstreamModel = (await request.clone().json() as Record<string, unknown>).model;
    if (effectiveAdapter === "openai-responses") {
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
  // Direct dispatch needs the writer lease that prevents spend-ledger ownership failures.
  releaseSpendHome = acquireOwnedSpendHome();
  const response = await handleResponses(
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: args.model, input: "ping", stream }),
    }),
    routedConfig(providerName, adapter, args.model.includes("/") ? args.model.slice(args.model.indexOf("/") + 1) : args.model, args.wireAdapter),
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

describe("Anthropic response model identity", () => {
  test("preserves a provider-qualified selector in bridged JSON", async () => {
    const result = await post({ model: "fixture-anthropic/claude-sonnet-5" });
    const body = await result.response.text();

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect((JSON.parse(body) as Record<string, unknown>).model).toBe("fixture-anthropic/claude-sonnet-5");
    expect(result.logCtx.resolvedModel).toBe("claude-sonnet-5");
    // The server's deferred logger reads this client-facing body; the selector in it is
    // ocx's own echo, so it must not become the served model (a false reroute in Logs).
    inspectResponseLogJson(result.logCtx, body);
    expect(result.logCtx.servedModel).toBeUndefined();
    expect(result.logCtx.resolvedModel).toBe("claude-sonnet-5");
  });

  test("keeps a legacy bare selector byte-identical in bridged JSON", async () => {
    const result = await post({ model: "claude-sonnet-5" });

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect((await result.response.json() as Record<string, unknown>).model).toBe("claude-sonnet-5");
  });

  test("preserves a provider-qualified selector in bridged SSE", async () => {
    const result = await post({ model: "fixture-anthropic/claude-sonnet-5", stream: true });
    const body = await result.response.text();
    const models = responseModelsFromSse(body);

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models)).toEqual(new Set(["fixture-anthropic/claude-sonnet-5"]));
    for (const block of body.split(/\r?\n\r?\n/)) {
      inspectResponseLogSsePayload(result.logCtx, block.split(/\r?\n/).find(line => line.startsWith("data: "))?.slice(6) ?? null);
    }
    expect(result.logCtx.servedModel).toBeUndefined();
  });

  test("rewrites Responses passthrough JSON while logging the physical model", async () => {
    const result = await post({
      model: "fixture-anthropic/claude-sonnet-5",
      wireAdapter: "openai-responses",
    });

    expect(result.upstreamModel).toBe("claude-sonnet-5");
    expect((await result.response.json() as Record<string, unknown>).model)
      .toBe("fixture-anthropic/claude-sonnet-5");
    expect(result.logCtx.resolvedModel).toBe("claude-sonnet-5");
  });

  test("rewrites every Responses passthrough SSE snapshot", async () => {
    const result = await post({
      model: "fixture-anthropic/claude-sonnet-5",
      wireAdapter: "openai-responses",
      stream: true,
    });

    expect(responseModelsFromSse(await result.response.text())).toEqual([
      "fixture-anthropic/claude-sonnet-5",
      "fixture-anthropic/claude-sonnet-5",
    ]);
    expect(result.logCtx.resolvedModel).toBe("claude-sonnet-5");
    // Passthrough inspects the upstream bytes before the rewrite, so the real model survives.
    expect(result.logCtx.servedModel).toBe("claude-sonnet-5");
  });

  test("non-Anthropic qualified selectors retain their pre-fix response model", async () => {
    const result = await post({
      model: "fixture-openai/wire-model",
      providerName: "fixture-openai",
      adapter: "openai-responses",
    });

    expect(result.upstreamModel).toBe("wire-model");
    expect((await result.response.json() as Record<string, unknown>).model).toBe("wire-model");
    expect(result.logCtx.resolvedModel).toBe("wire-model");
  });
});
