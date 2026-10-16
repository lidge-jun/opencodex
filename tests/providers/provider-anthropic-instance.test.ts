import { describe, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import {
  ANTHROPIC_INSTANCE_IDS,
  anthropicInstanceRowShapeMatches,
  configuredAnthropicInstance,
  isAnthropicInstanceId,
  isAnthropicOAuthInstance,
  isBuiltinAnthropicInstanceRow,
} from "../../src/providers/anthropic-instance";
import {
  deriveJawcodeAliases,
  deriveOAuthIds,
  deriveOAuthProviderConfig,
  deriveProviderPresets,
  enrichProviderFromRegistry,
  providerConfigSeed,
} from "../../src/providers/derive";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "../../src/providers/registry";
import { resolveMetadataProvider } from "../../src/generated/model-metadata";
import { routeModel } from "../../src/router";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const builtin: OcxProviderConfig = {
  adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", anthropicOAuthInstance: "anthropic2",
};

/** Compare every container recursively, including nested model lists and Fast wire metadata. */
function expectDetached(left: unknown, right: unknown): void {
  if (!left || typeof left !== "object") return;
  expect(right).not.toBe(left);
  for (const [key, child] of Object.entries(left)) {
    expectDetached(child, (right as Record<string, unknown>)[key]);
  }
}

describe("Anthropic OAuth instance identity", () => {
  test("only the two exact registry identities are Anthropic OAuth instances", () => {
    expect(ANTHROPIC_INSTANCE_IDS).toEqual(["anthropic", "anthropic2"]);
    for (const id of ANTHROPIC_INSTANCE_IDS) {
      expect(isAnthropicInstanceId(id)).toBe(true);
      expect(isAnthropicOAuthInstance(id)).toBe(true);
    }
    expect(getProviderRegistryEntry("xiaomi")?.adapter).toBe("anthropic");
    for (const id of ["anthropic-apikey", "anthropic-key", "claude-cli", "xiaomi", "anthropic-compatible",
      "anthropic3", "anthropic2-custom", "Anthropic", "", undefined]) {
      expect(isAnthropicInstanceId(id)).toBe(false);
      expect(isAnthropicOAuthInstance(id)).toBe(false);
    }
    expect(isAnthropicInstanceId(null)).toBe(false);
    expect(isAnthropicInstanceId({ id: "anthropic2" })).toBe(false);
  });

  test("exact names alone cannot bypass the registry family/auth declaration", () => {
    for (const id of ANTHROPIC_INSTANCE_IDS) {
      const row = getProviderRegistryEntry(id)!;
      const previous = { oauthFamily: row.oauthFamily, oauthId: row.oauthId, authKind: row.authKind };
      try {
        row.oauthFamily = undefined;
        expect(isAnthropicOAuthInstance(id)).toBe(false);
        row.oauthFamily = previous.oauthFamily;
        row.oauthId = "other-oauth";
        expect(isAnthropicOAuthInstance(id)).toBe(false);
        row.oauthId = previous.oauthId;
        row.authKind = "key";
        expect(isAnthropicOAuthInstance(id)).toBe(false);
      } finally {
        Object.assign(row, previous);
      }
      expect(isAnthropicOAuthInstance(id)).toBe(true);
    }
  });

  test("B requires explicit own provenance while A retains its historical identity", () => {
    expect(anthropicInstanceRowShapeMatches("anthropic2", undefined)).toBe(false);
    expect(anthropicInstanceRowShapeMatches("anthropic2", { adapter: "anthropic", authMode: "oauth" })).toBe(false);
    expect(anthropicInstanceRowShapeMatches("anthropic2", { ...builtin, baseUrl: undefined })).toBe(true);
    expect(anthropicInstanceRowShapeMatches("anthropic2", Object.create(builtin))).toBe(false);
    for (const marker of [undefined, null, false, "anthropic", "Anthropic2", {}]) {
      expect(anthropicInstanceRowShapeMatches("anthropic2", { ...builtin, anthropicOAuthInstance: marker })).toBe(false);
    }
    for (const baseUrl of ["https://api.anthropic.com", " https://api.anthropic.com/// ", "https://gateway.example/v1",
      "https://api.anthropic.com/v1", "https://api.anthropic.com.evil.example", ""]) {
      expect(isBuiltinAnthropicInstanceRow("anthropic2", { ...builtin, baseUrl })).toBe(true);
    }
    for (const row of [
      { ...builtin, authMode: "key" as const },
      { ...builtin, authMode: undefined },
      { ...builtin, adapter: "openai-chat" },
      { ...builtin, anthropicOAuthInstance: undefined },
    ]) {
      expect(isBuiltinAnthropicInstanceRow("anthropic2", row)).toBe(false);
      expect(providerMatchesRegistryTransport("anthropic2", row)).toBe(false);
      expect(isBuiltinAnthropicInstanceRow("anthropic", row)).toBe(true);
      expect(providerMatchesRegistryTransport("anthropic", row)).toBe(true);
    }
    expect(isBuiltinAnthropicInstanceRow("anthropic", undefined)).toBe(true);
    expect(providerMatchesRegistryTransport("anthropic2", builtin)).toBe(true);
    expect(isBuiltinAnthropicInstanceRow("anthropic-apikey", builtin)).toBe(false);
  });

  test("B is configured only when enabled with the builtin row shape", () => {
    const config = getDefaultConfig();
    expect(configuredAnthropicInstance(config, "anthropic")).toBe("anthropic");
    expect(configuredAnthropicInstance(config, "anthropic2")).toBeUndefined();
    config.providers.anthropic2 = { ...builtin, disabled: true };
    expect(configuredAnthropicInstance(config, "anthropic2")).toBeUndefined();
    config.providers.anthropic2 = { ...builtin, baseUrl: "https://gateway.example/v1" };
    expect(configuredAnthropicInstance(config, "anthropic2")).toBe("anthropic2");
    delete config.providers.anthropic2.anthropicOAuthInstance;
    expect(configuredAnthropicInstance(config, "anthropic2")).toBeUndefined();
    config.providers.anthropic2 = { ...builtin };
    expect(configuredAnthropicInstance(config, "anthropic2")).toBe("anthropic2");
  });
});

describe("Anthropic registry seeds", () => {
  test("A retains its fields and B differs only in declared instance metadata", () => {
    const a = getProviderRegistryEntry("anthropic")!;
    const b = getProviderRegistryEntry("anthropic2")!;
    expect(a).toMatchObject({
      id: "anthropic", label: "Anthropic Claude", adapter: "anthropic",
      baseUrl: "https://api.anthropic.com", authKind: "oauth", allowBaseUrlOverride: true,
      featured: true, oauthId: "anthropic", oauthFamily: "anthropic", jawcodeBundle: "anthropic",
      note: "Log in with your Claude account", defaultModel: "claude-sonnet-5",
      defaultMaxOutputTokens: 64_000, fastOptIn: true,
      fastWire: { kind: "anthropic-speed", canonicalToWire: { priority: "fast" }, foreignCallerTiers: "drop" },
    });
    expect(b).toMatchObject({
      id: "anthropic2", label: "Anthropic · Pool 2", oauthId: "anthropic2", oauthFamily: "anthropic",
      note: "Independent Claude account pool — log in with a separate Claude account", allowBaseUrlOverride: true,
    });
    const instanceFields = new Set(["id", "label", "oauthId", "note", "allowBaseUrlOverride"]);
    const familyFields = (row: typeof a) => Object.fromEntries(Object.entries(row).filter(([key]) => !instanceFields.has(key)));
    expect(familyFields(b)).toEqual(familyFields(a));
    expectDetached(familyFields(a), familyFields(b));
  });

  test("mutating a B materialized seed cannot affect A or either registry row", () => {
    const a = getProviderRegistryEntry("anthropic")!;
    const b = getProviderRegistryEntry("anthropic2")!;
    const snapshotA = structuredClone(a);
    const snapshotB = structuredClone(b);
    const aSeed = providerConfigSeed(a);
    const bSeed = providerConfigSeed(b);
    expect(bSeed).toEqual({ ...aSeed, anthropicOAuthInstance: "anthropic2" });
    expect(aSeed.anthropicOAuthInstance).toBeUndefined();
    expectDetached(aSeed, bSeed);
    bSeed.models!.push("fixture-only");
    bSeed.modelInputModalities![b.models![0]].push("fixture-only");
    bSeed.modelReasoningEfforts![b.models![0]].push("fixture-only");
    bSeed.modelContextWindows![b.models![0]] = 1;
    expect(a).toEqual(snapshotA);
    expect(b).toEqual(snapshotB);
    expect(aSeed.models).not.toContain("fixture-only");
    expect(aSeed.modelInputModalities![a.models![0]]).not.toContain("fixture-only");
    expect(aSeed.modelReasoningEfforts![a.models![0]]).not.toContain("fixture-only");
  });

  test("custom same-named rows are not enriched with B's registry defaults", () => {
    for (const provider of [
      { ...builtin, authMode: "key" as const, baseUrl: "https://gateway.example/v1" },
      { ...builtin, anthropicOAuthInstance: undefined, baseUrl: "https://gateway.example/v1" },
      { ...builtin, adapter: "openai-chat", baseUrl: "https://gateway.example/v1" },
      { ...builtin, anthropicOAuthInstance: undefined },
    ]) {
      const before = structuredClone(provider);
      enrichProviderFromRegistry("anthropic2", provider);
      expect(provider).toEqual(before);
    }
  });

  test("B is addable through OAuth presets but is never a fresh-install default", () => {
    expect(Object.hasOwn(getDefaultConfig().providers, "anthropic2")).toBe(false);
    expect(deriveOAuthIds()).toContain("anthropic2");
    expect(deriveOAuthProviderConfig("anthropic2")).toMatchObject(builtin);
    expect(deriveProviderPresets().find(row => row.id === "anthropic2")).toMatchObject({
      label: "Anthropic · Pool 2", auth: "oauth", oauthProvider: "anthropic2", adapter: "anthropic",
    });
    expect(deriveJawcodeAliases().anthropic2).toBe("anthropic");
    expect(resolveMetadataProvider("anthropic2")).toBe("anthropic");
  });
});

describe("REG-02 bare model inference never selects the marked Pool 2 row", () => {
  const catalog = { models: ["claude-sonnet-5", "claude-haiku-4-5"], defaultModel: "claude-sonnet-5" };
  /** Pool 2 is inserted first so insertion order alone would have picked it. */
  function pools(mutate?: (config: OcxConfig) => void): OcxConfig {
    const config = getDefaultConfig();
    config.providers = {
      openai: config.providers.openai!,
      anthropic2: { ...builtin, ...catalog, models: [...catalog.models] },
      anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", ...catalog, models: [...catalog.models] },
    };
    mutate?.(config);
    return config;
  }

  test("configured default model and model list resolve to A even when B is inserted first", () => {
    for (const model of ["claude-sonnet-5", "claude-haiku-4-5"]) {
      expect(routeModel(pools(), model).providerName).toBe("anthropic");
    }
    expect(routeModel(pools(), "anthropic2/claude-sonnet-5")).toMatchObject({
      providerName: "anthropic2", modelId: "claude-sonnet-5", routeReason: "explicit-provider-namespace",
    });
  });

  test("with A disabled a bare Claude model falls to the default provider instead of B", () => {
    const config = pools(next => { next.providers.anthropic!.disabled = true; });
    expect(routeModel(config, "claude-sonnet-5")).toMatchObject({ providerName: "openai", routeReason: "default-provider" });
    expect(routeModel(config, "anthropic2/claude-sonnet-5").providerName).toBe("anthropic2");
  });

  test("an alias both pools declare is not ambiguous and stays on A; B keeps its qualified alias", () => {
    // A user alias on both rows: built-in aliases step aside whenever a catalog carries two matching
    // models (two Haiku generations, for example), so they cannot pin this contract reliably.
    const aliased = (next: OcxConfig) => {
      next.providers.anthropic!.modelAliases = { "claude-haiku-4-5": "quick" };
      next.providers.anthropic2!.modelAliases = { "claude-haiku-4-5": "quick" };
    };
    const config = pools(aliased);
    expect(routeModel(config, "quick")).toMatchObject({
      providerName: "anthropic", modelId: "claude-haiku-4-5", routeReason: "model-alias",
    });
    expect(routeModel(config, "anthropic2/quick")).toMatchObject({ providerName: "anthropic2", modelId: "claude-haiku-4-5" });
    const onlyB = pools(next => { aliased(next); next.providers.anthropic!.disabled = true; });
    expect(routeModel(onlyB, "quick").providerName).not.toBe("anthropic2");
  });

  test("an explicit B default provider and an unmarked custom anthropic2 row keep their behaviour", () => {
    const defaultB = pools(next => { next.defaultProvider = "anthropic2"; next.providers.anthropic!.disabled = true; });
    expect(routeModel(defaultB, "claude-sonnet-5")).toMatchObject({ providerName: "anthropic2", routeReason: "default-provider" });
    const custom = pools(next => {
      next.providers.anthropic2 = {
        adapter: "anthropic", authMode: "key", baseUrl: "https://gateway.example/v1", apiKey: "sk-fixture-gateway",
        models: ["gateway-model"],
      };
    });
    expect(routeModel(custom, "gateway-model")).toMatchObject({ providerName: "anthropic2", routeReason: "configured-model-list" });
  });
});
