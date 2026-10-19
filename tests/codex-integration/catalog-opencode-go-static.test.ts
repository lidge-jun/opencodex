import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../../src/codex/catalog";
import { enrichProviderFromRegistry } from "../../src/providers/derive";
import { providerMatchesRegistryTransportWithStaticGuards } from "../../src/providers/static-model-discovery";
import { routedProviderConfig } from "../../src/router";
import type { OcxProviderConfig } from "../../src/types";
import { getModelMetadata } from "../../src/generated/model-metadata";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("static opencode-go catalog destination ownership (#7097)", () => {
  for (const models of [undefined, [] as string[]]) {
    const label = models === undefined ? "omitted" : "empty";
    for (const destination of [
      { baseUrl: "https://opencode.ai/zen/go/v1", defaultModel: undefined, expected: ["kimi-k2.7-code"] },
      { baseUrl: "https://opencode.ai/inference/go/v1", defaultModel: undefined, expected: ["kimi-k2.7-code"] },
      { baseUrl: "https://custom.invalid/v1", defaultModel: undefined, expected: ["kimi-k2.7-code"] },
      { baseUrl: "https://custom.invalid/v1", defaultModel: "custom-model", expected: ["custom-model"] },
    ]) {
      test(`${label} models at ${destination.baseUrl} with ${destination.defaultModel ?? "no explicit default"}`, async () => {
        const provider: OcxProviderConfig = {
          adapter: "openai-chat", baseUrl: destination.baseUrl, apiKey: "sk-test", liveModels: false,
          ...(models === undefined ? {} : { models }),
          ...(destination.defaultModel === undefined ? {} : { defaultModel: destination.defaultModel }),
        };
        expect(providerMatchesRegistryTransportWithStaticGuards("opencode-go", provider)).toBe(true);
        const enriched = structuredClone(provider);
        enrichProviderFromRegistry("opencode-go", enriched);
        expect(enriched.baseUrl).toBe(destination.baseUrl);
        expect(enriched.defaultModel).toBe(destination.expected[0]);
        expect(enriched.models).toEqual(models);
        const routed = routedProviderConfig("opencode-go", enriched);
        expect(routed.baseUrl).toBe("https://opencode.ai/zen/go/v1");
        expect(routed.defaultModel).toBe(destination.expected[0]);
        let fetchCalls = 0;
        globalThis.fetch = (async () => {
          fetchCalls += 1;
          throw new Error("static Go catalog gathering must not fetch models");
        }) as typeof fetch;
        const outcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
        const gathered = await gatherRoutedModels({ providers: { "opencode-go": provider } }, { providerModelOutcomes: outcomes });
        expect(gathered.map(model => `${model.provider}/${model.id}`))
          .toEqual(destination.expected.map(id => `opencode-go/${id}`));
        expect(outcomes).toEqual([{ provider: "opencode-go", state: "authoritative" }]);
        expect(fetchCalls).toBe(0);
      });
    }
  }
});

describe("static opencode-go model metadata additions", () => {
  const ADDED_MODELS = [
    { id: "gemini-4-argon-contributor", contextWindow: 1048576, maxTokens: 65536, reasoning: true },
    { id: "gpt-6-luna", contextWindow: 1050000, maxTokens: 128000, reasoning: true },
    // The registry declares 1_048_576 (catalog-opencode-go-context-window.test.ts); never undercut it.
    { id: "deepseek-v4.1-flash", contextWindow: 1048576, maxTokens: 384000, reasoning: true },
    { id: "longcat-2.5-preview-free", contextWindow: 1000000, maxTokens: 131072, reasoning: true },
    { id: "step-5-preview", contextWindow: 256000, maxTokens: 64000, reasoning: true },
    { id: "space-bunny", contextWindow: 1000000, maxTokens: 131072, reasoning: true },
    { id: "beam-free", contextWindow: 1000000, maxTokens: 131072, reasoning: true },
  ] as const;

  for (const { id, contextWindow, maxTokens, reasoning } of ADDED_MODELS) {
    test(`${id} exposes valid metadata in static catalog`, () => {
      const meta = getModelMetadata("opencode-go", id);
      expect(meta).toBeDefined();
      expect(meta?.contextWindow).toBe(contextWindow);
      expect(meta?.maxTokens).toBe(maxTokens);
      expect(meta?.reasoning).toBe(reasoning);
    });
  }

  // Peak/off-peak (DeepSeek V4.1 Flash) and prompt-length tiers (GPT-6 Luna) have no single
  // honest rate, so their cost stays unknown instead of encoding one unconditional price.
  test.each(["deepseek-v4.1-flash", "gpt-6-luna"])("%s leaves tiered pricing unset", id => {
    expect(getModelMetadata("opencode-go", id)?.cost).toBeUndefined();
  });
});
