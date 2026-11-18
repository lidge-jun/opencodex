import { describe, expect, test } from "bun:test";
import { DEVIN_MODEL_CONTEXT_WINDOWS, DEVIN_STATIC_MODELS } from "../../src/adapters/devin/live-models";
import { kiroNativeEffortField, kiroReasoningMode } from "../../src/adapters/kiro/reasoning";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../../src/providers/registry";
import { resolveWireProtocolOverride } from "../../src/server/adapter-resolve";
import { EXPECTED_PRICE_OVERLAYS } from "../../src/usage/expected-prices";

const SOL61 = "gpt-6.1-sol";
const GPT62 = ["gpt-6.2-sol", "gpt-6.2-astra"] as const;
const INBOUNDS = ["responses", "chat", "anthropic"] as const;

describe("GPT-6.2 preemptive provider rows", () => {
  test("every non-Cursor GPT-6.1 Sol seed also carries both GPT-6.2 rows", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.id === "cursor") continue;
      for (const id of entry.models ?? []) {
        if (!/gpt-6[.-]1-sol$/.test(id)) continue;
        for (const model of GPT62) {
          const expected = id.replace(/gpt-6[.-]1-sol$/, matched => matched.includes(".") ? model : model.replaceAll(".", "-"));
          expect(entry.models, `${entry.id}: ${id}`).toContain(expected);
        }
      }
    }
  });

  test.each(["codebuddy", "kiro"])("%s mirrors its own GPT-6.1 Sol metadata", provider => {
    const entry = getProviderRegistryEntry(provider)!;
    for (const model of GPT62) {
      expect(entry.models).toContain(model);
      for (const field of ["modelContextWindows", "modelMaxOutputTokens", "modelReasoningEfforts",
        "modelDefaultReasoningEfforts", "modelInputModalities"] as const) {
        expect(entry[field]?.[model], `${model} ${field}`).toEqual(entry[field]?.[SOL61]);
      }
    }
  });

  test("Kiro uses the GPT-6.1 Sol native effort field", () => {
    for (const model of GPT62) {
      for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
        expect(kiroNativeEffortField(`kiro/${model.replaceAll(".", "-")}-${effort}`, effort)).toBe("reasoning");
        expect(kiroReasoningMode(model, effort)).toBe(kiroReasoningMode(SOL61, effort));
      }
    }
  });

  test("Devin seeds dashed uids with the GPT-6.1 Sol window, ladder and derived price", () => {
    const entry = getProviderRegistryEntry("devin")!;
    for (const model of GPT62.map(id => id.replaceAll(".", "-"))) {
      expect(DEVIN_STATIC_MODELS).toContain(model);
      expect(entry.models).toContain(model);
      expect(DEVIN_MODEL_CONTEXT_WINDOWS[model]).toBe(1_000_000);
      expect(entry.modelReasoningEfforts?.[model]).toEqual(entry.modelReasoningEfforts?.["gpt-6-1-sol"]);
      for (const provider of ["devin", "devin-cli"]) {
        const row = EXPECTED_PRICE_OVERLAYS.find(o => o.provider === provider && o.modelId === model);
        expect(row?.status, `${provider} ${model}`).toBe("verified-derived");
      }
    }
  });

  test.each(["github-copilot", "tokenlab"])("%s mirrors GPT-6.1 Sol wire selection", provider => {
    const entry = getProviderRegistryEntry(provider)!;
    const seed = providerConfigSeed(entry);
    for (const model of GPT62) {
      expect(entry.models).toContain(model);
      for (const inbound of INBOUNDS) {
        expect(resolveWireProtocolOverride(provider, model, seed, inbound).adapter)
          .toBe(resolveWireProtocolOverride(provider, SOL61, seed, inbound).adapter);
      }
    }
  });

  test("TokenLab keeps its default and seeds API limits; OpenRouter opts both routes into Fast", () => {
    const tokenlab = getProviderRegistryEntry("tokenlab")!;
    const openrouter = getProviderRegistryEntry("openrouter")!;
    expect(tokenlab.defaultModel).toBe("gpt-5.6-terra");
    for (const model of GPT62) {
      expect(tokenlab.modelContextWindows?.[model]).toBe(1_050_000);
      expect(tokenlab.modelMaxOutputTokens?.[model]).toBe(128_000);
      expect(tokenlab.modelInputModalities?.[model]).toEqual(["text", "image"]);
      expect(openrouter.modelSupportsServiceTier?.[`openai/${model}`]).toBe(true);
    }
  });

  test("GPT-6.2 is never a provider default and Cursor has no seed", () => {
    for (const entry of PROVIDER_REGISTRY) expect(entry.defaultModel ?? "").not.toMatch(/gpt-6[.-]2-/);
    for (const model of GPT62) expect(getProviderRegistryEntry("cursor")!.models).not.toContain(model);
  });
});
