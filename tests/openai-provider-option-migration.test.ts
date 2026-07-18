import { describe, expect, test } from "bun:test";
import {
  LEGACY_OPENAI_MULTI_PROVIDER_ID,
  OpenAiTierMigrationCollisionError,
  projectOpenAiTierMigration,
} from "../src/providers/openai-tiers";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const forward: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
};

function cfg(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: { openai: { ...forward } },
    defaultProvider: "openai",
    ...overrides,
  };
}

function expectCanonical(result: ReturnType<typeof projectOpenAiTierMigration>, mode: "pool" | "direct"): void {
  expect(result.config.providers.openai).toMatchObject({ ...forward, codexAccountMode: mode });
  expect(result.config.openaiProviderTierVersion).toBe(2);
  expect(result.config.providers[LEGACY_OPENAI_MULTI_PROVIDER_ID]).toBeUndefined();
  expect(result.config.providers.chatgpt).toBeUndefined();
  expect(result.resolvedMode).toBe(mode);
}

describe("OpenAI provider option migration matrix", () => {
  test("unmarked minimal openai becomes one pool-default row", () => {
    const input = cfg();
    const before = structuredClone(input);
    const result = projectOpenAiTierMigration(input);
    expectCanonical(result, "pool");
    expect(Object.keys(result.config.providers)).toEqual(["openai"]);
    expect(result.changed).toBe(true);
    expect(input).toEqual(before);
  });

  test.each([false, true])("unmarked chatgpt (added accounts=%s) becomes one pool row without a transient Multi", hasAdded => {
    const result = projectOpenAiTierMigration(cfg({
      providers: {
        before: { adapter: "openai-chat", baseUrl: "https://before.example/v1" },
        chatgpt: { ...forward, apiKey: "discard-secret" },
        after: { adapter: "openai-chat", baseUrl: "https://after.example/v1" },
      },
      defaultProvider: "chatgpt",
      ...(hasAdded ? { codexAccounts: [{ id: "added", email: "a@example.test", isMain: false }] } : {}),
    }));
    expectCanonical(result, "pool");
    expect(Object.keys(result.config.providers)).toEqual(["before", "openai", "after"]);
    expect(result.config.defaultProvider).toBe("openai");
    expect(JSON.stringify(result.config)).not.toContain("discard-secret");
  });

  test("marker 1 Direct-only preserves direct behavior", () => {
    const result = projectOpenAiTierMigration(cfg({ openaiProviderTierVersion: 1 }));
    expectCanonical(result, "direct");
  });

  test("marker 1 enabled Multi absorbs into pool mode", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: { openai: { ...forward }, "openai-multi": { ...forward } },
    }));
    expectCanonical(result, "pool");
  });

  test("marker 1 legacy default maps to openai pool", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: { "openai-multi": { ...forward } },
      defaultProvider: "openai-multi",
    }));
    expectCanonical(result, "pool");
    expect(result.config.defaultProvider).toBe("openai");
  });

  test("disabled Multi plus enabled Direct and no Multi references resolves direct and enabled", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: { openai: { ...forward }, "openai-multi": { ...forward, disabled: true } },
    }));
    expectCanonical(result, "direct");
    expect(result.config.providers.openai.disabled).toBeUndefined();
  });

  test("marker 1 with neither forward row preserves provider absence", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://custom.example/v1" } },
      defaultProvider: "custom",
    }));
    expect(result.config.providers.openai).toBeUndefined();
    expect(result.config.providers).toEqual({ custom: { adapter: "openai-chat", baseUrl: "https://custom.example/v1" } });
    expect(result.config.openaiProviderTierVersion).toBe(2);
  });

  test("disabled-Multi-only creates disabled openai pool", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: { "openai-multi": { ...forward, disabled: true } },
      defaultProvider: "custom",
    }));
    expectCanonical(result, "pool");
    expect(result.config.providers.openai.disabled).toBe(true);
  });

  test("Direct-only with stale activeCodexAccountId stays direct and leaves ignored pool state intact", () => {
    const result = projectOpenAiTierMigration(cfg({ openaiProviderTierVersion: 1, activeCodexAccountId: "stale-added" }));
    expectCanonical(result, "direct");
    expect(result.config.activeCodexAccountId).toBe("stale-added");
  });

  test("no provider plus stale pool state preserves absence and pool state", () => {
    const accounts = [{ id: "stale-added", email: "a@example.test", isMain: false }];
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: { custom: { adapter: "openai-chat", baseUrl: "https://custom.example/v1" } },
      defaultProvider: "custom",
      activeCodexAccountId: "stale-added",
      codexAccounts: accounts,
    }));
    expect(result.config.providers.openai).toBeUndefined();
    expect(result.config.activeCodexAccountId).toBe("stale-added");
    expect(result.config.codexAccounts).toEqual(accounts);
  });

  test("rewrites every Claude model owner and only modelMap destinations", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      claudeCode: {
        model: "openai-multi/gpt-main",
        smallFastModel: "openai-multi/gpt-fast",
        tierModels: {
          opus: "openai-multi/gpt-opus",
          sonnet: "openai-multi/gpt-sonnet",
          haiku: "openai-multi/gpt-haiku",
          fable: "openai-multi/gpt-fable",
        },
        modelMap: {
          "openai-multi/source-key": "openai-multi/gpt-destination",
          stable: "openai-apikey/gpt-5.6-sol",
        },
      },
    }));
    expect(result.config.claudeCode).toMatchObject({
      model: "gpt-main",
      smallFastModel: "gpt-fast",
      tierModels: { opus: "gpt-opus", sonnet: "gpt-sonnet", haiku: "gpt-haiku", fable: "gpt-fable" },
      modelMap: {
        "openai-multi/source-key": "gpt-destination",
        stable: "openai-apikey/gpt-5.6-sol",
      },
    });
  });

  test("merges selectedModels stably and deduplicates rewritten ids", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providers: {
        openai: { ...forward, selectedModels: ["gpt-a", "openai-multi/gpt-b"] },
        "openai-multi": { ...forward, selectedModels: ["gpt-b", "gpt-c"] },
      },
    }));
    expect(result.config.providers.openai.selectedModels).toEqual(["gpt-a", "gpt-b", "gpt-c"]);
  });

  test("merges provider context caps to the lower positive cap with path-only warning", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      providerContextCaps: { openai: 300_000, "openai-multi": 200_000, custom: 100_000 },
    }));
    expect(result.config.providerContextCaps).toEqual({ openai: 200_000, custom: 100_000 });
    expect(result.warnings).toEqual(["providerContextCaps.openai + providerContextCaps.openai-multi: kept lower positive cap"]);
  });

  test("rewrites and deduplicates disabledModels and subagentModels in first-seen order", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      disabledModels: ["openai-multi/gpt-a", "gpt-a", "custom/x"],
      subagentModels: ["openai-multi/gpt-b", "gpt-b", "openai-apikey/gpt-b"],
    }));
    expect(result.config.disabledModels).toEqual(["gpt-a", "custom/x"]);
    expect(result.config.subagentModels).toEqual(["gpt-b", "openai-apikey/gpt-b"]);
  });

  test("rewrites injection, shadow, global sidecar, and Claude sidecar model references", () => {
    const result = projectOpenAiTierMigration(cfg({
      openaiProviderTierVersion: 1,
      injectionModel: "openai-multi/gpt-inject",
      shadowCallIntercept: { enabled: true, model: "openai-multi/gpt-shadow" },
      webSearchSidecar: { model: "openai-multi/gpt-web" },
      visionSidecar: { model: "openai-multi/gpt-vision" },
      claudeCode: {
        webSearchSidecar: { model: "openai-multi/gpt-cweb" },
        visionSidecar: { model: "openai-multi/gpt-cvision" },
      },
    }));
    expect(result.config).toMatchObject({
      injectionModel: "gpt-inject",
      shadowCallIntercept: { model: "gpt-shadow" },
      webSearchSidecar: { model: "gpt-web" },
      visionSidecar: { model: "gpt-vision" },
      claudeCode: { webSearchSidecar: { model: "gpt-cweb" }, visionSidecar: { model: "gpt-cvision" } },
    });
  });

  test("leaves unknown passthrough values unchanged and emits only their paths", () => {
    const input = cfg({
      openaiProviderTierVersion: 1,
      customMigrationNote: "keep openai-multi/secret-like-text verbatim",
      nestedUnknown: { model: "openai-multi/gpt-unknown" },
      injectionModel: "openai-multi/gpt-known",
    } as Partial<OcxConfig>);
    const result = projectOpenAiTierMigration(input);
    expect((result.config as OcxConfig & { customMigrationNote: string }).customMigrationNote).toContain("openai-multi");
    expect((result.config as OcxConfig & { nestedUnknown: { model: string } }).nestedUnknown.model).toBe("openai-multi/gpt-unknown");
    expect(result.config.injectionModel).toBe("gpt-known");
    expect(result.warnings).toEqual([
      "customMigrationNote: legacy OpenAI provider id left unchanged",
      "nestedUnknown.model: legacy OpenAI provider id left unchanged",
    ]);
    expect(result.warnings.join(" ")).not.toContain("secret-like-text");
  });

  test("noncanonical secret-bearing Multi collides without mutating input", () => {
    const input = cfg({
      openaiProviderTierVersion: 1,
      providers: { openai: { ...forward }, "openai-multi": { ...forward, apiKey: "must-remain-in-input" } },
    });
    const before = structuredClone(input);
    expect(() => projectOpenAiTierMigration(input)).toThrow(OpenAiTierMigrationCollisionError);
    expect(input).toEqual(before);
  });

  test("marker 2 canonical result is clone-only and warning-free", () => {
    const input = cfg({
      openaiProviderTierVersion: 2,
      providers: { openai: { ...forward, codexAccountMode: "pool" } },
      customMigrationNote: "openai-multi/history stays" as never,
    } as Partial<OcxConfig>);
    const result = projectOpenAiTierMigration(input);
    expect(result.changed).toBe(false);
    expect(result.config).toEqual(input);
    expect(result.config).not.toBe(input);
    expect(result.warnings).toEqual([]);
  });

  test("restored marker-1 split recreates identical marker-2 bytes and then becomes idempotent", () => {
    const restored = cfg({
      openaiProviderTierVersion: 1,
      providers: {
        before: { adapter: "openai-chat", baseUrl: "https://before.example/v1" },
        openai: { ...forward, selectedModels: ["gpt-a"] },
        "openai-multi": { ...forward, selectedModels: ["gpt-b"] },
        after: { adapter: "openai-chat", baseUrl: "https://after.example/v1" },
      },
      defaultProvider: "openai-multi",
    });
    const first = projectOpenAiTierMigration(restored);
    const repeatedRestore = projectOpenAiTierMigration(structuredClone(restored));
    const secondRun = projectOpenAiTierMigration(first.config);
    expect(JSON.stringify(repeatedRestore.config)).toBe(JSON.stringify(first.config));
    expect(Object.keys(first.config.providers)).toEqual(["before", "openai", "after"]);
    expect(secondRun.changed).toBe(false);
    expect(secondRun.config).toEqual(first.config);
  });
});
