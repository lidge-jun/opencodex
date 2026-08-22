import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import { KEY_LOGIN_PROVIDERS } from "../src/oauth/key-providers";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

const OFFICIAL_CLINE_PASS_MODELS = [
  "cline-pass/glm-5.3",
  "cline-pass/glm-5.2",
  "cline-pass/kimi-k3",
  "cline-pass/kimi-k2.7-code",
  "cline-pass/kimi-k2.6",
  "cline-pass/deepseek-v4-pro",
  "cline-pass/deepseek-v4-flash",
  "cline-pass/mimo-v2.5",
  "cline-pass/mimo-v2.5-pro",
  "cline-pass/minimax-m3",
  "cline-pass/qwen3.8-max",
  "cline-pass/qwen3.7-max",
  "cline-pass/qwen3.7-plus",
];

function parsed(modelId: string, reasoning: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    stream: false,
    options: { reasoning },
  };
}

function registryEntry() {
  const entry = PROVIDER_REGISTRY.find(provider => provider.id === "cline-pass");
  if (!entry) throw new Error("missing ClinePass registry entry");
  return entry;
}

async function parseNonStream(body: Record<string, unknown>) {
  const provider = providerConfigSeed(registryEntry());
  const adapter = createOpenAIChatAdapter({ ...provider, apiKey: "cline-test-key" });
  const budget = createTranslatorBudget();
  try {
    return await adapter.parseResponse!(new Response(JSON.stringify(body)), budget);
  } finally {
    budget.dispose();
  }
}

describe("ClinePass provider", () => {
  test("registry exposes the official API-key transport and static subscription catalog", () => {
    const entry = registryEntry();

    expect(entry).toMatchObject({
      label: "ClinePass",
      adapter: "openai-chat",
      baseUrl: "https://api.cline.bot/api/v1",
      authKind: "key",
      dashboardUrl: "https://app.cline.bot",
      defaultModel: "cline-pass/kimi-k3",
      preserveCustomDestination: true,
      reasoningWireFormat: "gateway-object",
    });
    expect(entry?.models).toEqual(OFFICIAL_CLINE_PASS_MODELS);
    expect(entry?.models).toContain(entry?.defaultModel);
    expect(entry?.liveModels).toBeUndefined();
    expect(entry?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(entry?.modelReasoningEfforts).toBeUndefined();
    expect(entry?.modelMaxInputTokens).toBeUndefined();
    expect(entry?.noVisionModels).toEqual([
      "cline-pass/glm-5.3",
      "cline-pass/glm-5.2",
      "cline-pass/deepseek-v4-pro",
      "cline-pass/deepseek-v4-flash",
      "cline-pass/mimo-v2.5-pro",
      "cline-pass/qwen3.7-max",
    ]);
    expect(entry?.modelContextWindows?.["cline-pass/qwen3.8-max"]).toBeUndefined();
    expect(entry?.modelInputModalities?.["cline-pass/qwen3.8-max"]).toBeUndefined();
    expect(entry?.modelInputModalities?.["cline-pass/kimi-k3"]).toEqual(["text", "image"]);
    expect(entry?.modelInputModalities?.["cline-pass/glm-5.2"]).toEqual(["text"]);
    expect(KEY_LOGIN_PROVIDERS["cline-pass"]?.models).toEqual(OFFICIAL_CLINE_PASS_MODELS);
    expect(KEY_LOGIN_PROVIDERS["cline-pass"]?.noVisionModels).toEqual(entry.noVisionModels);
    const seed = providerConfigSeed(entry);
    expect(seed).toMatchObject({ reasoningWireFormat: "gateway-object" });
    expect(seed).not.toHaveProperty("preserveCustomDestination");
  });

  test("catalog enrichment repairs the low-only ladder persisted by older ClinePass presets", () => {
    const stale = providerConfigSeed(registryEntry());
    stale.reasoningEfforts = ["low"];

    enrichProviderFromRegistry("cline-pass", stale);

    expect(stale.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);

    const custom = { ...stale, baseUrl: "https://custom.example/v1", reasoningEfforts: ["low"] };
    enrichProviderFromRegistry("cline-pass", custom);
    expect(custom.reasoningEfforts).toEqual(["low"]);
  });

  test("routing keeps the full upstream model slug and emits the Cline gateway reasoning object", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "cline-pass",
      providers: {
        "cline-pass": {
          adapter: "openai-chat",
          baseUrl: "https://api.cline.bot/api/v1",
          apiKey: "cline-test-key",
          authMode: "key",
        },
      },
    };
    const route = routeModel(config, "cline-pass/cline-pass/kimi-k3");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, "high"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(route.modelId).toBe("cline-pass/kimi-k3");
    expect(route.provider).toMatchObject({ reasoningWireFormat: "gateway-object" });
    expect(body.model).toBe("cline-pass/kimi-k3");
    expect(body.reasoning).toEqual({ enabled: true, effort: "high" });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(request.reasoningLog).toEqual({
      effectiveEffort: "high",
      wireField: "reasoning.effort",
      wireValue: "high",
    });
  });

  test("explicit reasoning disable uses the gateway object instead of leaking reasoning_effort", () => {
    const provider = providerConfigSeed(PROVIDER_REGISTRY.find(entry => entry.id === "cline-pass")!);
    const request = createOpenAIChatAdapter({ ...provider, apiKey: "cline-test-key" })
      .buildRequest(parsed("cline-pass/glm-5.2", "none"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body.reasoning).toEqual({ enabled: false });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(request.reasoningLog).toEqual({
      effectiveEffort: "none",
      wireField: "reasoning.enabled",
      wireValue: false,
    });
  });

  test("noReasoningModels suppresses the gateway object for explicit disable", () => {
    const provider = providerConfigSeed(registryEntry());
    const request = createOpenAIChatAdapter({
      ...provider,
      apiKey: "cline-test-key",
      noReasoningModels: ["cline-pass/glm-5.2"],
    }).buildRequest(parsed("cline-pass/glm-5.2", "none"));
    const body = JSON.parse(request.body) as Record<string, unknown>;

    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(request.reasoningLog).toBeUndefined();
  });

  test("routing preserves an explicitly configured ClinePass reasoning wire format", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "cline-pass",
      providers: {
        "cline-pass": {
          adapter: "openai-chat",
          baseUrl: "https://api.cline.bot/api/v1",
          apiKey: "cline-test-key",
          authMode: "key",
          reasoningWireFormat: "gateway-object",
        },
      },
    };

    const route = routeModel(config, "cline-pass/cline-pass/kimi-k3");

    expect(route.provider.reasoningWireFormat).toBe("gateway-object");
  });

  test("same-named custom provider keeps its own destination and credential boundary", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "cline-pass",
      providers: {
        "cline-pass": {
          adapter: "openai-chat",
          baseUrl: "https://custom.example/v1",
          apiKey: "custom-key",
          authMode: "key",
        },
      },
    };
    const route = routeModel(config, "cline-pass/custom-model");
    const request = createOpenAIChatAdapter(route.provider).buildRequest(parsed(route.modelId, "none"));

    expect(route.provider.baseUrl).toBe("https://custom.example/v1");
    expect(route.provider.apiKey).toBe("custom-key");
    expect(route.provider.reasoningWireFormat).toBeUndefined();
    expect(request.url).toBe("https://custom.example/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer custom-key");
  });

  test("unwraps the Cline API non-stream response envelope", async () => {
    const events = await parseNonStream({
      success: true,
      error: null,
      data: {
        choices: [{
          finish_reason: "stop",
          index: 0,
          message: { content: "OK", reasoning: "thinking", role: "assistant" },
        }],
        usage: {
          completion_tokens: 3,
          completion_tokens_details: { reasoning_tokens: 2 },
          prompt_tokens: 4,
          total_tokens: 7,
        },
      },
    });

    expect(events).toContainEqual({ type: "reasoning_raw_delta", text: "thinking" });
    expect(events).toContainEqual({ type: "text_delta", text: "OK" });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      usage: { inputTokens: 4, outputTokens: 3, reasoningOutputTokens: 2 },
    });
  });

  test("non-stream finish reasons preserve truncation, filtering, and choice-scoped errors", async () => {
    const length = await parseNonStream({
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    });
    expect(length.at(-1)).toEqual({
      type: "done",
      usage: undefined,
      stopReason: "max_tokens",
    });

    const filtered = await parseNonStream({
      success: true,
      data: { choices: [{ finish_reason: "content_filter", message: { content: "partial" } }] },
    });
    expect(filtered.at(-1)).toEqual({
      type: "done",
      usage: undefined,
      stopReason: "content_filter",
    });

    const failed = await parseNonStream({
      choices: [{
        finish_reason: "error",
        error: { code: "rate_limit", message: "ClinePass limit reached" },
      }],
    });
    expect(failed).toEqual([{ type: "error", code: "rate_limit", message: "ClinePass limit reached" }]);

    const stringError = await parseNonStream({
      success: false,
      error: "ClinePass quota exhausted",
    });
    expect(stringError).toEqual([{ type: "error", message: "ClinePass quota exhausted" }]);

    const secretErrors = await Promise.all([
      parseNonStream({ error: "Denied Bearer cline-secret-token" }),
      parseNonStream({ error: { message: "Rejected api_key=sk-cline-secret" } }),
    ]);
    expect(secretErrors).toEqual([
      [{ type: "error", message: "Denied Bearer [REDACTED]" }],
      [{ type: "error", message: "Rejected api_key=[REDACTED]" }],
    ]);

    const numericCode = await parseNonStream({
      error: {
        code: 429,
        message: "ClinePass limit reached",
        metadata: { request_id: "req_cline_429" },
      },
    });
    expect(numericCode).toEqual([{
      type: "error",
      code: "429",
      status: 429,
      message: "ClinePass limit reached (request ID: req_cline_429)",
    }]);

    const secretShapedMetadata = await parseNonStream({
      error: {
        code: 429,
        message: "ClinePass limit reached",
        metadata: { request_id: ["sk", "test", "secret-shaped-request-id"].join("-") },
      },
    });
    expect(secretShapedMetadata).toEqual([{
      type: "error",
      code: "429",
      status: 429,
      message: "ClinePass limit reached",
    }]);
  });

  test("rejects contradictory or malformed failure envelopes", async () => {
    const contradictory = await parseNonStream({
      success: false,
      data: {
        choices: [{ finish_reason: "stop", message: { content: "must not pass" } }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      },
    });
    expect(contradictory).toEqual([{
      type: "error",
      message: "upstream reported failure without an error payload",
      usage: { inputTokens: 7, outputTokens: 2 },
    }]);

    const nestedError = await parseNonStream({
      success: false,
      data: { error: { code: "server_error", message: "nested failure" } },
    });
    expect(nestedError).toEqual([{
      type: "error",
      code: "server_error",
      message: "nested failure",
    }]);
  });
});
