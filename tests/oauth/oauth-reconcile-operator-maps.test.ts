import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, setPersistedConfigMutationBeforeCommitForTests } from "../../src/config";
import { OAUTH_PROVIDERS, reconcileOAuthProviders, upsertOAuthProvider } from "../../src/oauth";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
const homes: string[] = [];
afterEach(() => {
  setPersistedConfigMutationBeforeCommitForTests(null);
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

function configFor(name: string, overrides: Partial<OcxProviderConfig>): OcxConfig {
  const home = mkdtempSync(join(tmpdir(), "ocx-oauth-operator-maps-"));
  homes.push(home);
  process.env.OPENCODEX_HOME = home;
  return {
    port: 10100, defaultProvider: name,
    providers: { [name]: { ...structuredClone(OAUTH_PROVIDERS[name]!.providerConfig), ...overrides } },
  };
}

function restorePreset(preset: OcxProviderConfig, snapshot: OcxProviderConfig): void {
  for (const field of Object.keys(preset) as (keyof OcxProviderConfig)[]) delete preset[field];
  Object.assign(preset, snapshot);
}

describe("OAuth reconciliation operator maps (#7092)", () => {
  test.each([false, true])("Copilot keeps long-context evidence through two startups and login (persist=%s)", persist => {
    expect(OAUTH_PROVIDERS["github-copilot"]!.providerConfig.modelContextWindows).toBeUndefined();
    const windows = { "gpt-6.1-sol": 1_050_000 };
    const tiers = { "gpt-6.1-sol": "long_context" } as const;
    let config = configFor("github-copilot", {
      models: ["stale-catalog"], modelContextWindows: windows, modelContextTiers: tiers,
      contextWindow: 1_100_000, modelMaxInputTokens: { "gpt-6.1-sol": 900_000 },
    });
    saveConfig(config);
    for (let startup = 0; startup < 2; startup++) {
      reconcileOAuthProviders(config, persist);
      const row = config.providers["github-copilot"]!;
      expect(row.modelContextWindows).toEqual(windows);
      expect(row.modelContextTiers).toEqual(tiers);
      expect(row.contextWindow).toBe(1_100_000);
      expect(row.modelMaxInputTokens).toEqual({ "gpt-6.1-sol": 900_000 });
      expect(row.models).toEqual(OAUTH_PROVIDERS["github-copilot"]!.providerConfig.models);
      if (persist) config = loadConfig();
    }
    upsertOAuthProvider(config, "github-copilot");
    expect(config.providers["github-copilot"]!.modelContextWindows).toEqual(windows);
    expect(config.providers["github-copilot"]!.modelContextWindows).not.toBe(windows);
    expect(config.providers["github-copilot"]!.modelContextTiers).toEqual(tiers);
  });

  test("xAI keeps explicit windows over registry seeds and fills other seeded models", () => {
    const preset = OAUTH_PROVIDERS.xai!.providerConfig;
    expect(preset.modelContextWindows?.["grok-4.5"]).toBe(500_000);
    const seedBefore = structuredClone(preset);
    const windows = { "grok-4.5": 200_000, "grok-composer-2.5-fast": 200_000 };
    let config = configFor("xai", { modelContextWindows: windows, models: ["stale-catalog"] });
    saveConfig(config);
    for (let startup = 0; startup < 2; startup++) {
      reconcileOAuthProviders(config);
      expect(config.providers.xai!.modelContextWindows).toMatchObject(windows);
      expect(config.providers.xai!.modelContextWindows?.["grok-4.6"]).toBe(preset.modelContextWindows?.["grok-4.6"]);
      expect(config.providers.xai!.models).toEqual(preset.models);
      config = loadConfig();
    }
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.modelContextWindows).toMatchObject(windows);
    expect(reconcileOAuthProviders(config, false)).toBe(false);
    expect(preset).toEqual(seedBefore);
  });

  test.each([
    ["modelMaxOutputTokens", { custom: 32_000 }, { custom: 1, seeded: 16_000 }],
    ["modelInputModalities", { custom: ["text"] }, { custom: ["text", "image"], seeded: ["text"] }],
    ["modelReasoningEffortMap", { custom: { high: "operator" } }, { custom: { high: "seed" }, seeded: { low: "low" } }],
    ["reasoningEffortMap", { high: "operator" }, { high: "seed", low: "low" }],
  ] as const)("%s preserves explicit entries with and without preset defaults", (field, operator, seed) => {
    const preset = OAUTH_PROVIDERS.xai!.providerConfig;
    const original = preset[field];
    try {
      for (const seeded of [false, true]) {
        if (seeded) preset[field] = structuredClone(seed) as never;
        else delete preset[field];
        const config = configFor("xai", { [field]: structuredClone(operator), models: ["stale-catalog"] });
        const expected = seeded ? { ...seed, ...operator } : operator;
        reconcileOAuthProviders(config, false);
        expect(config.providers.xai![field]).toEqual(expected);
        upsertOAuthProvider(config, "xai");
        expect(config.providers.xai![field]).toEqual(expected);
        expect(reconcileOAuthProviders(config, false)).toBe(false);
      }
    } finally {
      if (original === undefined) delete preset[field];
      else preset[field] = original as never;
    }
  });

  test("a provider-wide operator limit wins over seeded limits during startup and login", () => {
    const config = configFor("anthropic", { contextWindow: 128_000, defaultMaxOutputTokens: 8_000, models: ["stale"] });
    reconcileOAuthProviders(config, false);
    upsertOAuthProvider(config, "anthropic");
    expect(config.providers.anthropic!.contextWindow).toBe(128_000);
    expect(config.providers.anthropic!.defaultMaxOutputTokens).toBe(8_000);
  });

  test("model keys fold case and saved per-model alias maps remain detached", () => {
    const preset = OAUTH_PROVIDERS.xai!.providerConfig;
    const original = structuredClone(preset);
    try {
      preset.modelContextWindows = { Model: 500_000, seeded: 100_000 };
      preset.modelReasoningEffortMap = {
        Model: { high: "seed", low: "low" }, empty: { high: "seed" },
      };
      const config = configFor("xai", {
        models: ["stale"], modelContextWindows: { MODEL: 200_000 },
        modelReasoningEffortMap: { MODEL: { high: "operator" }, EMPTY: {} },
      });
      reconcileOAuthProviders(config, false);
      upsertOAuthProvider(config, "xai");
      const row = config.providers.xai!;
      expect(row.modelContextWindows).toEqual({ seeded: 100_000, MODEL: 200_000 });
      expect(row.modelReasoningEffortMap).toEqual({ MODEL: { high: "operator" }, EMPTY: {} });
      expect(reconcileOAuthProviders(config, false)).toBe(false);
      row.modelReasoningEffortMap!.MODEL!.high = "changed";
      expect(preset.modelReasoningEffortMap.Model!.high).toBe("seed");
    } finally {
      restorePreset(preset, original);
    }
  });

  test("unseeded reasoning tiers survive startup and login while seeded catalog tiers refresh", () => {
    const config = configFor("github-copilot", {
      models: ["stale"], reasoningEfforts: ["low", "high"],
      modelReasoningEfforts: { "gpt-6.1-sol": [] },
    });
    const preset = OAUTH_PROVIDERS["github-copilot"]!.providerConfig;
    const original = structuredClone(preset);
    try {
      delete preset.reasoningEfforts;
      delete preset.modelReasoningEfforts;
      reconcileOAuthProviders(config, false);
      upsertOAuthProvider(config, "github-copilot");
      expect(config.providers["github-copilot"]!.reasoningEfforts).toEqual(["low", "high"]);
      expect(config.providers["github-copilot"]!.modelReasoningEfforts).toEqual({ "gpt-6.1-sol": [] });
      preset.reasoningEfforts = ["low", "medium", "high"];
      preset.modelReasoningEfforts = { "gpt-6.1-sol": ["low", "medium", "high"] };
      config.providers["github-copilot"]!.modelReasoningEfforts!.custom = [];
      reconcileOAuthProviders(config, false);
      expect(config.providers["github-copilot"]!.reasoningEfforts).toEqual(preset.reasoningEfforts);
      expect(config.providers["github-copilot"]!.modelReasoningEfforts).toEqual({
        custom: [], "gpt-6.1-sol": ["low", "medium", "high"],
      });
      upsertOAuthProvider(config, "github-copilot");
      expect(reconcileOAuthProviders(config, false)).toBe(false);
    } finally {
      restorePreset(preset, original);
    }
  });

  test("authoritative operator reasoning tiers win over seeded catalog tiers", () => {
    const config = configFor("xai", {
      models: ["stale"], modelReasoningEffortsAuthoritative: true,
      modelReasoningEfforts: { "grok-4.6": [] },
    });
    reconcileOAuthProviders(config, false);
    upsertOAuthProvider(config, "xai");
    expect(config.providers.xai!.modelReasoningEfforts?.["grok-4.6"]).toEqual([]);
    expect(reconcileOAuthProviders(config, false)).toBe(false);
  });

  test("absent limits receive preset defaults without altering non-OAuth rows", () => {
    const config = configFor("anthropic", { models: ["stale"] });
    delete config.providers.anthropic!.contextWindow;
    delete config.providers.anthropic!.defaultMaxOutputTokens;
    reconcileOAuthProviders(config, false);
    expect(config.providers.anthropic!.defaultMaxOutputTokens)
      .toBe(OAUTH_PROVIDERS.anthropic!.providerConfig.defaultMaxOutputTokens);
    config.providers.anthropic!.authMode = "key";
    config.providers.anthropic!.models = ["operator"];
    config.providers.anthropic!.modelContextWindows = { custom: 123_000 };
    const before = structuredClone(config.providers.anthropic);
    reconcileOAuthProviders(config, false);
    expect(config.providers.anthropic).toEqual(before);
  });

  test("persistence rebases onto the latest operator map instead of the loaded copy", () => {
    const config = configFor("xai", { models: ["stale"], modelContextWindows: { custom: 100_000 } });
    saveConfig(config);
    setPersistedConfigMutationBeforeCommitForTests(() => {
      setPersistedConfigMutationBeforeCommitForTests(null);
      const latest = loadConfig();
      latest.providers.xai!.modelContextWindows = { custom: 200_000 };
      saveConfig(latest);
    });
    reconcileOAuthProviders(config);
    expect(config.providers.xai!.modelContextWindows?.custom).toBe(200_000);
    expect(loadConfig().providers.xai!.modelContextWindows?.custom).toBe(200_000);
  });
});
