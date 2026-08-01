import { describe, expect, test } from "bun:test";
import {
  comboIdLabel,
  isProviderFallbackComboId,
  providerFallbackError,
  providerFallbackIssues,
  providerFallbackPlan,
  providerFallbackTargets,
} from "../src/providers/fallback";
import { isValidComboId } from "../src/combos";
import type { OcxConfig } from "../src/types";

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
      c: { adapter: "openai-chat", baseUrl: "https://c.example/v1", apiKey: "kc", models: ["m3"] },
    },
    ...overrides,
  };
}

function withFallback(fallback: unknown, overrides: Partial<OcxConfig> = {}): OcxConfig {
  const config = baseConfig(overrides);
  (config.providers.a as Record<string, unknown>).fallback = fallback;
  return config;
}

describe("provider fallback validation", () => {
  test("accepts an ordered list of configured targets", () => {
    const providers = baseConfig().providers;
    const issues = providerFallbackIssues("a", [
      { provider: "b", model: "m2" },
      { provider: "c", model: "m3" },
    ], providers);
    expect(issues).toEqual([]);
  });

  test("omitted fallback is not an error", () => {
    expect(providerFallbackIssues("a", undefined, baseConfig().providers)).toEqual([]);
  });

  test("rejects a non-array", () => {
    expect(providerFallbackError("a", { provider: "b", model: "m2" }, baseConfig().providers))
      .toBe("fallback must be an array of { provider, model } targets");
  });

  test("rejects an unconfigured provider", () => {
    expect(providerFallbackError("a", [{ provider: "nope", model: "m2" }], baseConfig().providers))
      .toBe('fallback[0].provider "nope" is not configured');
  });

  test("rejects a missing model", () => {
    expect(providerFallbackError("a", [{ provider: "b" }], baseConfig().providers))
      .toBe("fallback[0].model is required");
  });

  test("rejects a self-referencing target", () => {
    expect(providerFallbackError("a", [{ provider: "a", model: "m1" }], baseConfig().providers))
      .toBe('fallback[0] must not point back at "a"');
  });

  test("rejects duplicate targets", () => {
    expect(providerFallbackError("a", [
      { provider: "b", model: "m2" },
      { provider: "b", model: "m2" },
    ], baseConfig().providers)).toBe('duplicate fallback target "b/m2"');
  });
});

describe("provider fallback targets", () => {
  test("trims entries and drops malformed ones", () => {
    const config = withFallback([
      { provider: " b ", model: " m2 " },
      { provider: "", model: "m3" },
      null,
      "c/m3",
    ]);
    expect(providerFallbackTargets(config.providers.a)).toEqual([{ provider: "b", model: "m2" }]);
  });

  test("no fallback yields an empty list", () => {
    expect(providerFallbackTargets(baseConfig().providers.a)).toEqual([]);
  });
});

describe("provider fallback plan", () => {
  test("puts the request's own route first, then the configured chain", () => {
    const config = withFallback([{ provider: "b", model: "m2" }, { provider: "c", model: "m3" }]);
    const plan = providerFallbackPlan(config, { provider: "a", modelId: "m1" });
    expect(plan).not.toBeNull();
    expect(plan!.config.combos![plan!.comboId]).toEqual({
      strategy: "failover",
      targets: [
        { provider: "a", model: "m1" },
        { provider: "b", model: "m2" },
        { provider: "c", model: "m3" },
      ],
    });
  });

  test("leaves the caller's config untouched", () => {
    const config = withFallback([{ provider: "b", model: "m2" }]);
    providerFallbackPlan(config, { provider: "a", modelId: "m1" });
    expect(config.combos).toBeUndefined();
  });

  test("preserves configured combos alongside the synthetic one", () => {
    const config = withFallback([{ provider: "b", model: "m2" }], {
      combos: { free: { targets: [{ provider: "a", model: "m1" }] } },
    });
    const plan = providerFallbackPlan(config, { provider: "a", modelId: "m1" })!;
    expect(Object.keys(plan.config.combos!).sort()).toEqual([plan.comboId, "free"].sort());
  });

  test("no plan when the provider has no fallback", () => {
    expect(providerFallbackPlan(baseConfig(), { provider: "a", modelId: "m1" })).toBeNull();
  });

  test("skips disabled fallback providers and yields no plan when none remain", () => {
    const config = withFallback([{ provider: "b", model: "m2" }]);
    config.providers.b!.disabled = true;
    expect(providerFallbackPlan(config, { provider: "a", modelId: "m1" })).toBeNull();
  });

  test("skips fallback targets whose provider was deleted", () => {
    const config = withFallback([{ provider: "gone", model: "m9" }, { provider: "c", model: "m3" }]);
    const plan = providerFallbackPlan(config, { provider: "a", modelId: "m1" })!;
    expect(plan.config.combos![plan.comboId]!.targets).toEqual([
      { provider: "a", model: "m1" },
      { provider: "c", model: "m3" },
    ]);
  });

  test("declines to shadow a physical provider named \"combo\"", () => {
    const config = withFallback([{ provider: "b", model: "m2" }]);
    config.providers.combo = { adapter: "openai-chat", baseUrl: "https://combo.example/v1" };
    expect(providerFallbackPlan(config, { provider: "a", modelId: "m1" })).toBeNull();
  });
});

describe("synthetic combo ids", () => {
  test("cannot collide with a user-configurable combo id", () => {
    const config = withFallback([{ provider: "b", model: "m2" }]);
    const { comboId } = providerFallbackPlan(config, { provider: "a", modelId: "m1" })!;
    expect(isProviderFallbackComboId(comboId)).toBe(true);
    expect(isValidComboId(comboId)).toBe(false);
  });

  test("are distinct per provider/model so cooldowns do not bleed across routes", () => {
    const config = withFallback([{ provider: "b", model: "m2" }]);
    const first = providerFallbackPlan(config, { provider: "a", modelId: "m1" })!;
    const second = providerFallbackPlan(config, { provider: "a", modelId: "m9" })!;
    expect(first.comboId).not.toBe(second.comboId);
  });

  test("render readably in logs and error messages", () => {
    const config = withFallback([{ provider: "b", model: "m2" }]);
    const { comboId } = providerFallbackPlan(config, { provider: "a", modelId: "m1" })!;
    expect(comboIdLabel(comboId)).toBe("fallback:a/m1");
    expect(comboIdLabel("free")).toBe("free");
  });
});
