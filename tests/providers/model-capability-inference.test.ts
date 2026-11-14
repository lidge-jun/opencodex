import { describe, expect, test } from "bun:test";
import { capabilityInferenceKey, createModelCapabilityInference } from "../../src/providers/model-capability-inference";
import { modelCapabilitySourceResolver } from "../../src/server/management/model-capability-sources";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const relay = (extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig => ({
  adapter: "openai-chat", baseUrl: "https://relay.example/v1", apiKey: "k", models: ["claude-opus-5-5"], liveModels: false, ...extra,
});

describe("same-name capability inference", () => {
  test("normalizes vendor prefixes, case, dots and bracket suffixes", () => {
    expect(capabilityInferenceKey("Anthropic/Claude-Opus-5.5[1m]")).toBe("claude-opus-5-5");
  });

  test("a relay's Claude model infers all three axes from the built-in Anthropic registry", () => {
    const inferred = createModelCapabilityInference({ port: 0, providers: { zayu: relay() } } as OcxConfig)("claude-opus-5-5", "zayu");
    expect(inferred.contextWindow).toEqual({ value: 1_000_000, basis: { source: "registry", provider: "anthropic", modelId: "claude-opus-5-5" } });
    expect(inferred.inputModalities?.value).toContain("image");
    expect(inferred.inputModalities?.basis.source).toBe("registry");
    expect(inferred.reasoningEfforts?.value).toEqual(expect.arrayContaining(["low", "high"]));
  });

  test("another configured provider's declaration answers when no bundled source knows the model", () => {
    const config = {
      port: 0,
      providers: {
        zayu: relay({ models: ["house-model-7"] }),
        other: relay({ models: ["house-model-7"], modelContextWindows: { "house-model-7": 64_000 }, modelReasoningEfforts: { "house-model-7": ["low", "high"] } }),
      },
    } as OcxConfig;
    const inferred = createModelCapabilityInference(config)("house-model-7", "zayu");
    expect(inferred.contextWindow).toEqual({ value: 64_000, basis: { source: "provider", provider: "other", modelId: "house-model-7" } });
    expect(inferred.reasoningEfforts?.value).toEqual(["low", "high"]);
    // The provider itself is excluded: its own declaration is manual, not an inference.
    expect(createModelCapabilityInference(config)("house-model-7", "other").contextWindow).toBeUndefined();
  });

  test("conflicting declarations in one tier answer nothing instead of picking one", () => {
    const config = {
      port: 0,
      providers: {
        a: relay({ models: ["house-model-8"], modelContextWindows: { "house-model-8": 64_000 } }),
        b: relay({ models: ["house-model-8"], modelContextWindows: { "house-model-8": 128_000 } }),
      },
    } as OcxConfig;
    expect(createModelCapabilityInference(config)("house-model-8", "zayu").contextWindow).toBeUndefined();
  });

  test("an unknown model infers nothing", () => {
    expect(createModelCapabilityInference()("no-such-model-xyz")).toEqual({});
  });
});

describe("capability sources on /api/models rows", () => {
  const config = (extra: Partial<OcxProviderConfig> = {}) => ({ port: 0, providers: { zayu: relay(extra) } } as OcxConfig);
  const row = { provider: "zayu", id: "claude-opus-5-5" };

  test("an id-only relay row is unknown on every axis and carries the same-name estimates", () => {
    const fields = modelCapabilitySourceResolver(config())(row, {});
    expect(fields.capabilitySources).toEqual({ contextWindow: "unknown", inputModalities: "unknown", reasoningEfforts: "unknown" });
    expect(fields.inferredCapabilities?.contextWindow?.value).toBe(1_000_000);
  });

  test("manual beats reported beats inferred, and a probe-written declaration is labeled probed", () => {
    const resolve = modelCapabilitySourceResolver(config({
      modelCapabilityProbes: { "claude-opus-5-5": { probedAt: "2026-11-13T00:00:00.000Z", inputModalities: true } },
    }));
    const fields = resolve(
      { ...row, contextWindow: 200_000, inputModalities: ["text", "image"] },
      { contextWindowDeclared: 200_000, inputModalitiesDeclared: ["text", "image"], reasoningEfforts: ["low"] },
    );
    expect(fields.capabilitySources).toEqual({ contextWindow: "manual", inputModalities: "probed", reasoningEfforts: "reported" });
    const inferredRow = resolve({ ...row, contextWindow: 1_000_000, contextWindowInference: { source: "vendor", provider: "anthropic", modelId: "claude-opus-5-5", contextWindow: 1_000_000 } }, {});
    expect(inferredRow.capabilitySources.contextWindow).toBe("inferred");
  });
});
