import { describe, expect, test } from "bun:test";
import { candidateCapabilityEvidence } from "../src/routing/capability";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import { modelRecordValue } from "../src/reasoning-effort";
import { isModelTextOnly } from "../src/vision";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

/**
 * `candidateCapabilityEvidence` describes what the resolver will do with a candidate,
 * so it has to match the resolver. Every runtime reader of `modelContextWindows`,
 * `modelInputModalities` and `modelReasoningEfforts` goes through `modelRecordValue`
 * (`src/reasoning-effort.ts:108`, `src/server/effort-policy.ts:122`,
 * `src/vision/index.ts:34`, `src/codex/catalog/provider-fetch.ts:612`), which accepts a
 * family entry for a tagged id. This file pins the evidence to that same rule.
 *
 * The window matters most: a bare lookup did not degrade to unknown there, it fell
 * through to the provider-wide `contextWindow` — a definite wrong answer, which the
 * module's own "unknown is not zero" contract is written to avoid.
 */

function providerWithFamilyEntries(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: "https://example.test/v1",
    contextWindow: 8_000,
    models: ["gpt-oss:120b"],
    modelContextWindows: { "gpt-oss": 131_072 },
    modelInputModalities: { "gpt-oss": ["text"] },
    modelReasoningEfforts: { "gpt-oss": ["low", "high"] },
  } as unknown as OcxProviderConfig;
}

function configFor(provider: OcxProviderConfig): OcxConfig {
  return { providers: { custom: provider } } as unknown as OcxConfig;
}

describe("candidateCapabilityEvidence model matching", () => {
  test("a family entry covers its tagged siblings, as the resolver does", () => {
    const provider = providerWithFamilyEntries();

    // Ground truth first: what the runtime itself resolves off this config.
    expect(modelRecordValue(provider.modelContextWindows, "gpt-oss:120b")).toBe(131_072);
    expect(isModelTextOnly(provider, "gpt-oss:120b")).toBe(true);

    const evidence = candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:120b");
    expect(evidence.contextWindow).toBe(131_072);
    expect(evidence.image).toBe(false);
    expect(evidence.reasoningEfforts).toEqual(["low", "high"]);
  });

  test("the window does not fall through to the provider-wide value", () => {
    // The specific regression: the provider-wide 8_000 is not "unknown", it is a
    // definite answer belonging to a different model, and routing would act on it.
    // Asserted as the exact expected number rather than `not.toBe(8_000)`, which
    // would also pass for `undefined` or any other wrong value.
    const evidence = candidateCapabilityEvidence(
      configFor(providerWithFamilyEntries()),
      "custom",
      "gpt-oss:120b",
    );
    expect(evidence.contextWindow).toBe(131_072);
  });

  test("an exact entry still wins over the family entry", () => {
    const provider = {
      ...providerWithFamilyEntries(),
      modelContextWindows: { "gpt-oss": 131_072, "gpt-oss:20b": 32_000 },
    } as unknown as OcxProviderConfig;
    expect(candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:20b").contextWindow)
      .toBe(32_000);
  });

  test("an unrelated model still falls back to the provider-wide window", () => {
    const evidence = candidateCapabilityEvidence(
      configFor(providerWithFamilyEntries()),
      "custom",
      "some-other-model",
    );
    expect(evidence.contextWindow).toBe(8_000);
    expect(evidence.reasoningEfforts).toBeUndefined();
  });

  test("a registry entry covers its tagged siblings with no provider configured", () => {
    // The three registry lookups (capability.ts lines 170/180/206) are a separate branch
    // from the configured-provider ones above: they are only reached when the provider is
    // absent from the config, which every other case here supplies.
    const registryEntry = PROVIDER_REGISTRY.find(entry => entry.id === "xai");
    if (!registryEntry) throw new Error("fixture drift: no `xai` entry in PROVIDER_REGISTRY");

    // Pin the fixture's shape rather than its values, so registry churn does not turn
    // into a false failure here while real drift still does.
    const family = "grok-4.6";
    expect(registryEntry.modelContextWindows?.[family]).toBeNumber();
    expect(registryEntry.modelInputModalities?.[family]).toBeArray();
    expect(registryEntry.modelReasoningEfforts?.[family]).toBeArray();

    const emptyConfig = { providers: {} } as unknown as OcxConfig;
    const evidence = candidateCapabilityEvidence(emptyConfig, "xai", `${family}:latest`);

    expect(evidence.contextWindow).toBe(registryEntry.modelContextWindows![family]);
    expect(evidence.image).toBe(registryEntry.modelInputModalities![family].includes("image"));
    expect(evidence.reasoningEfforts).toEqual(registryEntry.modelReasoningEfforts![family]);
  });

  test("noVisionModels beats an exact modality entry, as isModelTextOnly does", () => {
    // `isModelTextOnly` matches the no-vision list and returns true before it ever
    // reads `modelInputModalities`, so the `gpt-oss` no-vision entry wins over an
    // exact `gpt-oss:120b` entry listing "image". Evidence that disagrees here is
    // worse than a wrong window: routing selects the candidate for image work and
    // execution then refuses it.
    const provider = {
      ...providerWithFamilyEntries(),
      noVisionModels: ["gpt-oss"],
      modelInputModalities: { "gpt-oss:120b": ["text", "image"] },
    } as unknown as OcxProviderConfig;

    // Ground truth first: the resolver this evidence claims to describe says text-only.
    expect(isModelTextOnly(provider, "gpt-oss:120b")).toBe(true);

    const evidence = candidateCapabilityEvidence(configFor(provider), "custom", "gpt-oss:120b");
    expect(evidence.image).toBe(false);
  });

  test("a model outside noVisionModels keeps its declared image modality", () => {
    // The negative half: the no-vision check must not spread to models the list does
    // not cover, or the fix would trade a false positive for a false negative.
    const provider = {
      ...providerWithFamilyEntries(),
      models: ["gpt-oss:120b", "llava:13b"],
      noVisionModels: ["gpt-oss"],
      modelInputModalities: { "llava:13b": ["text", "image"] },
    } as unknown as OcxProviderConfig;

    expect(isModelTextOnly(provider, "llava:13b")).toBe(false);
    expect(candidateCapabilityEvidence(configFor(provider), "custom", "llava:13b").image).toBe(true);
  });

  test("a prototype-shaped model id resolves nothing", () => {
    // modelRecordValue uses hasOwnProperty; a bare lookup would return Object.prototype
    // members here and hand routing a function as evidence.
    for (const modelId of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const evidence = candidateCapabilityEvidence(
        configFor(providerWithFamilyEntries()),
        "custom",
        modelId,
      );
      expect(evidence.contextWindow).toBe(8_000);
      expect(evidence.reasoningEfforts).toBeUndefined();
      expect(evidence.image).toBeUndefined();
    }
  });
});
