/**
 * Morph Ultra plan preset (morph).
 *
 * Sources, verified 2026-11-13: https://www.morphllm.com/products/ultra and
 * https://docs.morphllm.com/ultra-plan (the plan covers Kimi K3.1 and DeepSeek V4.1 Flash),
 * https://docs.morphllm.com/sdk/components/fast-models (1,048,576-token window, text+image,
 * tools, streaming, reasoning ladders) and https://www.morphllm.com/pricing (list prices).
 *
 * The roster is deliberately only the Ultra-covered rows: the abliterated variant needs
 * privileged-access approval and every other Morph model bills per token, so seeding them
 * would advertise capability the subscription does not include.
 */
import { describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../../src/adapters/openai-chat";
import { parseRequest } from "../../src/responses/parser";
import { buildCatalogEntries } from "../../src/codex/catalog";
import { providerConfigSeed } from "../../src/providers/derive";
import { FREE_PROVIDER_DIRECTORY } from "../../src/providers/free-directory";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { findExpectedPriceOverlay } from "../../src/usage/expected-prices";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxParsedRequest } from "../../src/types";

const KIMI = "morph-kimik31";
const FLASH = "morph-dsv41flash-1017";
const REASONING = "I need to read the file before answering.";

function entry() {
  const found = getProviderRegistryEntry("morph");
  if (!found) throw new Error("missing morph registry entry");
  return found;
}

describe("Morph Ultra provider preset", () => {
  test("serves the Ultra plan on the OpenAI chat-completions wire", () => {
    expect(entry()).toMatchObject({
      id: "morph",
      adapter: "openai-chat",
      authKind: "key",
      baseUrl: "https://api.morphllm.com/v1",
      dashboardUrl: "https://www.morphllm.com/dashboard/api-keys",
      defaultModel: FLASH,
    });
  });

  test("seeds only the Ultra-covered models", () => {
    // morph-dsv41flash is the same Flash pool under its undated id and the abliterated variant
    // needs privileged-access approval; both stay out so the picker cannot offer them.
    expect(entry().models).toEqual([KIMI, FLASH]);
    expect(entry().models).not.toContain("morph-dsv41flash-abliterated");
    expect(entry().models).not.toContain("morph-glm53-744b");
  });

  test("discovery stays off so per-token rows cannot re-enter the roster", () => {
    expect(entry().liveModels).toBe(false);
  });

  test("publishes the documented 1M window and text+image input for both models", () => {
    for (const id of [KIMI, FLASH]) {
      expect(entry().modelContextWindows?.[id]).toBe(1_048_576);
      expect(entry().modelInputModalities?.[id]).toEqual(["text", "image"]);
    }
  });

  test("advertises each model's own reasoning ladder", () => {
    expect(entry().modelReasoningEfforts?.[KIMI]).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    // DeepSeek V4.1 Flash documents none/low/high/xhigh/max: medium is folded onto high.
    expect(entry().modelReasoningEfforts?.[FLASH]).toEqual(["none", "low", "high", "xhigh", "max"]);
    // `none` is an identity entry on both models: without it the adapter omits the field and
    // Morph reads that as reasoning on, which is the opposite of the picker's off switch.
    expect(entry().modelReasoningEffortMap?.[FLASH]).toEqual({ none: "none", medium: "high" });
    expect(entry().modelReasoningEffortMap?.[KIMI]).toEqual({ none: "none" });
  });

  test("the seeded config keeps the preset's roster and endpoint", () => {
    const seed = providerConfigSeed(entry());
    expect(seed.baseUrl).toBe("https://api.morphllm.com/v1");
    expect(seed.adapter).toBe("openai-chat");
    expect(seed.models).toEqual([KIMI, FLASH]);
  });

  test("routing morph/<model> keeps the Morph destination", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "morph",
      providers: { morph: { ...providerConfigSeed(entry()), apiKey: "morph-test-key" } },
    };
    const routed = routeModel(config, `morph/${KIMI}`);
    expect(routed.modelId).toBe(KIMI);
    expect(routed.provider).toMatchObject({ baseUrl: "https://api.morphllm.com/v1", adapter: "openai-chat" });
  });

  test("the registry seed reaches the Codex catalog row with the 1M window and its ladder", () => {
    const seed = providerConfigSeed(entry());
    for (const id of [KIMI, FLASH]) {
      const row = buildCatalogEntries(null, [], [{
        provider: "morph",
        id,
        owned_by: "morph",
        contextWindow: seed.modelContextWindows?.[id],
        inputModalities: seed.modelInputModalities?.[id],
        reasoningEfforts: seed.modelReasoningEfforts?.[id],
      }]).find(candidate => candidate.slug === "morph/" + id);
      expect(row?.context_window, id).toBe(1_048_576);
      expect(row?.input_modalities, id).toEqual(["text", "image"]);
      const levels = (row?.supported_reasoning_levels ?? []).map(level => level.effort);
      for (const effort of seed.modelReasoningEfforts?.[id] ?? []) expect(levels, id).toContain(effort);
    }
  });

  test("list-price overlays resolve so usage cost is not blank", () => {
    for (const id of [KIMI, FLASH]) {
      const overlay = findExpectedPriceOverlay("morph", id);
      expect(overlay?.status, id).toBe("verified-derived");
    }
    expect(findExpectedPriceOverlay("morph", KIMI)?.cost4).toEqual({ input: 2.5, output: 14, cacheRead: 0.29, cacheWrite: 0 });
    expect(findExpectedPriceOverlay("morph", FLASH)?.cost4).toEqual({ input: 0.12, output: 0.8, cacheRead: 0.008, cacheWrite: 0 });
  });

  test("the shared free-directory row still points at the same endpoint", () => {
    // The registry canonicalizes a saved provider onto this base URL, so a disagreement would
    // send a user's key somewhere the directory never described.
    const directoryRow = FREE_PROVIDER_DIRECTORY.find(row => row.id === "morph");
    expect(directoryRow?.baseUrl).toBe(entry().baseUrl);
  });
  test("sends reasoning_effort none so the picker's off switch reaches Morph", () => {
    // Morph enables Flash reasoning by default, so an omitted field reads as "on". `none` must
    // travel as an explicit wire value on both models (identity map entry per model).
    for (const modelId of [KIMI, FLASH]) {
      const request = createOpenAIChatAdapter({ ...providerConfigSeed(entry()), apiKey: "morph-test-key" }).buildRequest({
        modelId,
        context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
        stream: false,
        options: { reasoning: "none" },
      });
      const body = JSON.parse(request.body as string) as Record<string, unknown>;
      expect(body.reasoning_effort, modelId).toBe("none");
    }
  });

  test("folds DeepSeek Flash medium onto the documented high wire value", () => {
    const body = JSON.parse(createOpenAIChatAdapter({ ...providerConfigSeed(entry()), apiKey: "morph-test-key" }).buildRequest({
      modelId: FLASH,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: false,
      options: { reasoning: "medium" },
    }).body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
  });

  test("Kimi K3.1 keeps medium as its own wire value", () => {
    const body = JSON.parse(createOpenAIChatAdapter({ ...providerConfigSeed(entry()), apiKey: "morph-test-key" }).buildRequest({
      modelId: KIMI,
      context: { messages: [{ role: "user", content: "ping", timestamp: 0 }] },
      stream: false,
      options: { reasoning: "medium" },
    }).body as string) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("medium");
  });

  test("a pre-existing custom provider named morph keeps its own destination", () => {
    // Registering the preset must not retarget a key a user already saved elsewhere.
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "morph",
      providers: {
        morph: {
          adapter: "openai-chat",
          baseUrl: "https://custom-morph.example.test/v1",
          apiKey: "user-key",
          models: ["custom-model"],
        },
      },
    };
    const routed = routeModel(config, "morph/custom-model");
    expect(routed.provider.baseUrl).toBe("https://custom-morph.example.test/v1");
    expect(routed.modelId).toBe("custom-model");
  });
+  test("replays the assistant's reasoning_content on the next tool turn", () => {
    // Morph requires the complete assistant message, reasoning_content included, to come back
    // every turn (https://www.morphllm.com/kimi-k3-1-api, "The Thinking-Replay Gotcha"). Neither
    // seeded id matches the DeepSeek name fallback, so without an explicit declaration the
    // serializer drops the reasoning and the model degrades after a few turns.
    for (const modelId of [KIMI, FLASH]) {
      const parsed = parseRequest({
        model: modelId,
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the repo" }] },
          { type: "reasoning", id: "rs_1", summary: [], content: [{ type: "reasoning_text", text: REASONING }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
          { type: "function_call_output", call_id: "call_1", output: "contents" },
        ],
      });
      const provider = { ...providerConfigSeed(entry()), apiKey: "morph-test-key" };
      const request = createOpenAIChatAdapter(provider).buildRequest({ ...parsed, modelId } as OcxParsedRequest);
      const body = JSON.parse(request.body as string) as { messages: Array<Record<string, unknown>> };
      const assistant = body.messages.find(message => message.role === "assistant" && Array.isArray(message.tool_calls));
      expect(assistant, modelId).toBeDefined();
      expect(assistant!["reasoning_content"], modelId).toBe(REASONING);
      // The tool call itself must survive alongside the reasoning.
      expect((assistant!["tool_calls"] as Array<Record<string, unknown>>).length, modelId).toBe(1);
    }
  });

});
