/**
 * Alibaba Token Plan (Beijing) serves the same models over both Chat Completions and an
 * OpenAI-compatible Responses API on the same /compatible-mode/v1 base, and Alibaba ships an
 * official Codex integration guide on wire_api = "responses" (#5097). Three models carry live
 * end-to-end evidence on that gateway: qwen3.8-flash, qwen3.7-plus and glm-5.3.
 *
 * That evidence now backs the registry modelWireDefaults pin in
 * alibaba-token-plan-wire-defaults.test.ts together with the entry-level
 * preserveResponsesReasoningContent flag: the flag that was the open delta when the opt-in
 * landed (#5198) is measured live on this gateway (#5188), because the entry preserves
 * plaintext reasoning content on the Chat wire through preserveReasoningContentModels, and
 * the Responses serializer reads the separate flag. Z.AI and DeepSeek set both flags for
 * exactly this reason.
 *
 * These cases lock the documented per-model modelAdapters opt-in for the REST of the family
 * (and the opt-out against the pins) so neither can silently regress, and keep the guard that
 * a Responses wire default must carry the Responses-side preservation beside it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { routeModel } from "../../src/router";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { buildOpenAIChatPassthroughRequest } from "../../src/adapters/openai-chat/passthrough";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { handleResponses } from "../../src/server/responses/core";
import { ALIBABA_TOKEN_PLAN_PRESERVE_REASONING } from "../../src/providers/registry/model-seeds";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const LIVE_VERIFIED = ["qwen3.8-flash", "qwen3.7-plus", "glm-5.3"] as const;
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

function tokenPlanProvider(): OcxProviderConfig {
  return { ...providerConfigSeed(getProviderRegistryEntry("alibaba-token-plan")!), apiKey: "sk-test" };
}

describe("chat and anthropic inbound keep the provider chat wire", () => {
  for (const model of LIVE_VERIFIED) {
    for (const inbound of ["chat", "anthropic"] as const) {
      test(`${model} stays on the provider chat wire for ${inbound} inbound`, () => {
        expect(resolveWireProtocolOverride("alibaba-token-plan", model, tokenPlanProvider(), inbound).adapter)
          .toBe("openai-chat");
      });
    }
  }

  test("the pins are exactly the live-verified models, scoped to responses inbound", () => {
    const entry = getProviderRegistryEntry("alibaba-token-plan")!;
    expect(Object.keys(entry.modelWireDefaults ?? {}).sort()).toEqual([...LIVE_VERIFIED].sort());
    for (const declared of Object.values(entry.modelWireDefaults ?? {})) {
      expect(typeof declared === "string" ? undefined : declared.inbound).toEqual(["responses"]);
    }
  });
});

describe("the documented Responses opt-in resolves and reaches the native wire", () => {
  for (const model of LIVE_VERIFIED) {
    test(`modelAdapters selects openai-responses for ${model}`, () => {
      const provider = { ...tokenPlanProvider(), modelAdapters: { [model]: "openai-responses" } };
      const resolved = resolveWireProtocolOverride("alibaba-token-plan", model, provider, "responses");
      expect(resolved.adapter).toBe("openai-responses");
      expect(resolved.apiKey).toBe("sk-test");
      expect(resolved.baseUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    });
  }

  test("an unrelated provider is untouched by the opt-in", () => {
    const other: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://example.com/v1", apiKey: "sk-test" };
    for (const inbound of INBOUNDS) {
      expect(resolveWireProtocolOverride("some-custom", "qwen3.8-flash", other, inbound).adapter)
        .toBe("openai-chat");
    }
  });
});

describe("the opt-in survives the handleResponses replay", () => {
  const originalFetch = globalThis.fetch;
  let releaseSpendHome: (() => void) | undefined;

  afterEach(() => {
    releaseSpendHome?.();
    releaseSpendHome = undefined;
    globalThis.fetch = originalFetch;
  });

  // A resolver-only assertion would pass even if the replay flipped the wire back, so the
  // upstream URL the request actually reached is what these cases read.
  async function drive(model: string, modelAdapters?: Record<string, string>): Promise<string> {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const provider = modelAdapters ? { ...tokenPlanProvider(), modelAdapters } : tokenPlanProvider();
    const config = { providers: { "alibaba-token-plan": provider } } as unknown as OcxConfig;
    releaseSpendHome ??= acquireOwnedSpendHome();
    await handleResponses(
      new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: `alibaba-token-plan/${model}`, input: "ping", stream: true }),
      }),
      config,
      { model: "", provider: "" },
      { inboundWire: "responses" },
    );
    return urls[0] ?? "";
  }

  test("qwen3.8-flash reaches /responses once opted in", async () => {
    const url = await drive("qwen3.8-flash", { "qwen3.8-flash": "openai-responses" });
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });

  test("an unpinned family member reaches /chat/completions without the opt-in", async () => {
    const url = await drive("qwen3.8-max");
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("chat/completions");
  });

  test("an unpinned family member reaches /responses once opted in", async () => {
    const url = await drive("qwen3.8-max", { "qwen3.8-max": "openai-responses" });
    expect(url).toContain("token-plan.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("chat/completions");
  });
});

describe("a Responses default flip must carry Responses-side reasoning preservation", () => {
  test("the Chat wire already preserves reasoning content for the live-verified models", () => {
    for (const model of LIVE_VERIFIED) {
      expect(ALIBABA_TOKEN_PLAN_PRESERVE_REASONING).toContain(model);
    }
    expect(getProviderRegistryEntry("alibaba-token-plan")!.preserveReasoningContentModels)
      .toEqual(ALIBABA_TOKEN_PLAN_PRESERVE_REASONING);
  });

  // The guard, not a restatement of the case above: preserveReasoningContentModels is read by the
  // Chat adapter only. If this entry ever declares a Responses wire default, the Responses
  // serializer's own flag has to be set too, or the pinned models silently start replaying with
  // blanked reasoning content.
  test("declaring a Responses wire default without the Responses flag fails here", () => {
    const entry = getProviderRegistryEntry("alibaba-token-plan")!;
    const pinsResponses = Object.values(entry.modelWireDefaults ?? {})
      .some(declared => (typeof declared === "string" ? declared : declared.wire) === "openai-responses");
    if (!pinsResponses) {
      expect(entry.preserveResponsesReasoningContent).toBeUndefined();
      return;
    }
    expect(entry.preserveResponsesReasoningContent).toBe(true);
  });
});


describe("1017 exact-ID Token Plan adapter policy", () => {
  const model = "deepseek-v4.1-flash-1017";
  const schema = { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true };
  for (const id of ["alibaba-token-plan", "alibaba-token-plan-intl"]) {
    const entry = getProviderRegistryEntry(id)!;
    const route = (overrides: Partial<OcxProviderConfig> = {}, requestedModel = model) => routeModel({
      port: 10100, defaultProvider: id,
      providers: { [id]: { ...providerConfigSeed(entry), apiKey: "sk-test", ...overrides } },
    } as OcxConfig, `${id}/${requestedModel}`);

    test(`${id} routes the documented ladder and high default without a Responses pin`, () => {
      const resolved = route();
      expect(resolved.provider.modelReasoningEfforts?.[model]).toEqual(["low", "high", "max"]);
      expect(resolved.provider.modelDefaultReasoningEfforts?.[model]).toBe("high");
      expect(resolved.provider.modelInputModalities?.[model]).toEqual(["text", "image"]);
      expect(resolved.provider.modelContextWindows?.[model]).toBe(1_000_000);
      expect(resolved.provider.modelMaxOutputTokens?.[model]).toBe(393_216);
      for (const inbound of INBOUNDS) {
        expect(resolveWireProtocolOverride(id, model, resolved.provider, inbound).adapter).toBe("openai-chat");
      }
      for (const [effort, expected] of [["low", "low"], ["medium", "high"], ["xhigh", "high"], ["max", "max"]]) {
        const request = createOpenAIChatAdapter(resolved.provider).buildRequest({
          modelId: model, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
          options: { reasoning: effort }, stream: false,
        });
        const body = JSON.parse(request.body as string);
        expect(body.reasoning_effort).toBe(expected);
        expect(body.thinking_budget).toBeUndefined();
      }
    });

    test(`${id} omits unknown structured-output formats on both Chat paths`, () => {
      const resolved = route({ noStructuredOutputModels: ["operator-model", model] });
      expect(resolved.provider.noStructuredOutputModels).toEqual([model, "operator-model"]);
      expect(resolved.provider.noJsonSchemaModels).not.toContain(model);
      for (const format of [schema, { type: "json_object" }]) {
        const request = createOpenAIChatAdapter(resolved.provider).buildRequest({
          modelId: model, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
          options: { textFormat: format }, stream: false,
        });
        expect(JSON.parse(request.body as string).response_format).toBeUndefined();
        const native = buildOpenAIChatPassthroughRequest(resolved.provider, {
          messages: [{ role: "user", content: "hi" }], response_format: format,
        }, model, false);
        expect(JSON.parse(native.body as string).response_format).toBeUndefined();
      }
      // Existing bare-ID evidence stays separate: its verified JSON fallback still applies.
      const bare = route({}, "deepseek-v4.1-flash");
      const request = createOpenAIChatAdapter(bare.provider).buildRequest({
        modelId: bare.modelId, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
        options: { textFormat: schema }, stream: false,
      });
      expect(JSON.parse(request.body as string).response_format).toEqual({ type: "json_object" });
    });
  }
});


describe("custom Beijing destination structured-output policy", () => {
  const model = "deepseek-v4.1-flash-1017";
  for (const baseUrl of ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"]) {
    for (const enriched of [false, true]) {
      test(`${baseUrl} enriched=${enriched} preserves destination opt-outs`, () => {
        const provider: OcxProviderConfig = {
          adapter: "openai-chat", authMode: "key", apiKey: "test-key", baseUrl,
          noStructuredOutputModels: ["operator-model"],
        };
        if (enriched) enrichProviderFromRegistry("custom-beijing", provider);
        const resolved = routeModel({ port: 10100, defaultProvider: "custom-beijing",
          providers: { "custom-beijing": provider } } as OcxConfig, `custom-beijing/${model}`);
        expect(resolved.provider.modelDefaultReasoningEfforts?.[model]).toBe("high");
        expect(resolved.provider.modelReasoningEffortMap?.[model]?.medium).toBe("high");
        if (enriched) {
          expect(provider.modelDefaultReasoningEfforts?.[model]).toBe("high");
          expect(provider.modelReasoningEffortMap?.[model]?.medium).toBe("high");
        }
        const effort = createOpenAIChatAdapter(resolved.provider).buildRequest({
          modelId: model, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
          options: { reasoning: "medium" }, stream: false,
        });
        expect(JSON.parse(effort.body as string).reasoning_effort).toBe("high");
        expect(resolved.provider.noStructuredOutputModels).toContain("operator-model");
        expect(resolved.provider.noStructuredOutputModels).toContain(model);
        for (const format of [{ type: "json_object" }, { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true }]) {
          const native = buildOpenAIChatPassthroughRequest(resolved.provider, {
            messages: [{ role: "user", content: "hi" }], response_format: format,
          }, model, false);
          expect(JSON.parse(native.body as string).response_format).toBeUndefined();
          const translated = createOpenAIChatAdapter(resolved.provider).buildRequest({
            modelId: model, context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
            options: { textFormat: format }, stream: false,
          });
          expect(JSON.parse(translated.body as string).response_format).toBeUndefined();
        }
        expect(resolved.provider.noStructuredOutputModels).toEqual([model, "operator-model"]);
        const overridden: OcxProviderConfig = {
          ...provider,
          modelDefaultReasoningEfforts: { [model]: "max" },
          modelReasoningEffortMap: { [model]: { medium: "low" } },
        };
        if (enriched) enrichProviderFromRegistry("custom-beijing", overridden);
        const explicit = routeModel({ port: 10100, providers: { "custom-beijing": overridden } } as OcxConfig, `custom-beijing/${model}`);
        expect(explicit.provider.modelDefaultReasoningEfforts?.[model]).toBe("max");
        expect(explicit.provider.modelReasoningEffortMap?.[model]?.medium).toBe("low");

      });
    }
  }
  test.each([
    { adapter: "openai-chat", baseUrl: "https://example.test/v1" },
    { adapter: "anthropic", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" },
    // Undocumented for Token Plan; must not be treated as the Beijing destination.
    { adapter: "openai-chat", baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1" },
    { adapter: "openai-chat", baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1" },
    { adapter: "openai-chat", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" },
  ])("nonmatching custom destination keeps operator policy: $adapter $baseUrl", ({ adapter, baseUrl }) => {
    const provider: OcxProviderConfig = { adapter, baseUrl, noStructuredOutputModels: ["operator-model"] };
    enrichProviderFromRegistry("custom", provider);
    const resolved = routeModel({ port: 10100, providers: { custom: provider } } as OcxConfig, `custom/${model}`);
    expect(resolved.provider.noStructuredOutputModels).toEqual(["operator-model"]);
    expect(resolved.provider.baseUrl).toBe(baseUrl);
    expect(resolved.provider.adapter).toBe(adapter);
  });
});
