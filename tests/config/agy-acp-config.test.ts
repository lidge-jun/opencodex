/** Configuration rules for the Antigravity ACP provider (plan 080, B2/R2-1). */
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig, readConfigDiagnostics, validateConfigCandidate } from "../../src/config";
import { configSchema } from "../../src/config/schema/config-schema";
import { warnAndBackupInvalidConfig } from "../../src/config/salvage";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";
import { AGY_ACP_PROVIDER_ID, agyAcpConfigIssues, selectorCandidateProviders } from "../../src/config/schema/agy-acp-references";
import { AGY_ACP_DEFAULT_MODEL, AGY_ACP_SEED_MODELS } from "../../src/providers/registry/agy-acp-models";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";

const acp = { adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp", models: ["gemini-3.8-flash"] };
const google = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "${keychain:ocx-test-google}", models: ["gemini-3.8-flash", "gemini-4-argon"] };

function config(extra: Record<string, unknown> = {}, providers: Record<string, unknown> = {}): OcxConfig {
  return {
    ...getDefaultConfig(),
    defaultProvider: "google",
    providers: { google, "antigravity-acp": { ...acp }, ...providers },
    ...extra,
  } as unknown as OcxConfig;
}

const messages = (result: ReturnType<typeof validateConfigCandidate>) => (result.ok ? "" : result.error);

describe("antigravity-acp configuration", () => {
  test("schema diagnostics redact credential-shaped model alias keys", () => {
    const aliasKey = "sk-proj-" + "x".repeat(44);
    const error = messages(validateConfigCandidate(config({}, {
      "antigravity-acp": { ...acp, modelAliases: { [aliasKey]: "example-alias" } },
    })));
    expect(error).toContain("schema_invalid: providers.antigravity-acp.modelAliases.[REDACTED]");
    expect(error).not.toContain(aliasKey);
  });

  test("schema issue messages redact a credential-shaped model key in diagnostics and backup logs", () => {
    const modelKey = "sk-proj-" + "y".repeat(44);
    const raw = config({}, { google: { ...google, modelMaxInputTokens: { [modelKey]: 0 } } });
    const result = configSchema.safeParse(raw);
    if (result.success) throw new Error("invalid fixture passed");
    const error = messages(validateConfigCandidate(raw));
    expect(error.includes(modelKey)).toBe(false);
    expect(error).toContain("modelMaxInputTokens.[REDACTED]");
    const print = spyOn(console, "error").mockImplementation(() => {});
    try {
      warnAndBackupInvalidConfig(join(tmpdir(), "ocx-agy-acp-missing-config.json"), result.error);
      const logged = print.mock.calls.flat().join("\n");
      expect(logged.includes(modelKey)).toBe(false);
      expect(logged).toContain("modelMaxInputTokens.[REDACTED]");
    } finally {
      print.mockRestore();
    }
  });

  test("disk loads ignore only ACP unattended targets while writes reject them", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-agy-acp-config-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const codexHome = installIsolatedCodexHome("ocx-agy-acp-config-codex-");
    process.env.OPENCODEX_HOME = home;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const raw = config({
        memoryModels: {
          extract: { model: "antigravity-acp/gemini-3.8-flash" },
          consolidation: { model: "google/gemini-3.8-flash", reasoningEffort: "medium" },
        },
        shadowCallIntercept: { enabled: true, model: "antigravity-acp/gemini-3.8-flash" },
        subagentModelFallback: ["gemini-3.8-flash", "google/gemini-3.8-flash"],
        subagentModelFallbackByModel: {
          "model-one": ["gemini-3.8-flash", "google/gemini-3.8-flash"],
          "model-two": ["google/gemini-4-argon"],
        },
      });
      expect(validateConfigCandidate(raw).ok).toBe(false);
      const path = getConfigPath();
      const bytes = JSON.stringify(raw);
      writeFileSync(path, bytes);
      const diagnostics = readConfigDiagnostics();
      for (const loaded of [loadConfig(), diagnostics.config]) {
        expect(loaded.defaultProvider).toBe("google");
        expect(loaded.providers.google?.apiKey).toBe(google.apiKey);
        expect(loaded.providers["antigravity-acp"]?.adapter).toBe("agy-acp");
        expect(loaded.memoryModels).toEqual({ consolidation: raw.memoryModels!.consolidation });
        expect(loaded.shadowCallIntercept?.enabled).toBe(false);
        expect(loaded.subagentModelFallback).toEqual(["google/gemini-3.8-flash"]);
        expect(loaded.subagentModelFallbackByModel).toEqual({
          "model-one": ["google/gemini-3.8-flash"],
          "model-two": ["google/gemini-4-argon"],
        });
      }
      expect(diagnostics.source).toBe("file");
      expect(diagnostics.error).toBeNull();
      expect(diagnostics.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining("memoryModels.extract.model"),
        expect.stringContaining("shadowCallIntercept.model"),
        expect.stringContaining("subagentModelFallback.0"),
        expect.stringContaining("subagentModelFallbackByModel.model-one.0"),
      ]));
      expect(warn).toHaveBeenCalled();
      expect(readFileSync(path, "utf8")).toBe(bytes);
    } finally {
      warn.mockRestore();
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      codexHome.restore();
      await removeTreeAfterBackgroundWork(home);
    }
  });

  test("unattended selectors can match an ACP alias generated by a provider template", () => {
    const providers = { "antigravity-acp": { ...acp, alias: "agy", aliasTemplate: "{providerAlias}-{modelBasename}" } };
    const model = "AGY-GEMINI-3.8-FLASH";
    expect(messages(validateConfigCandidate(config({ memoryModels: { extract: { model } } }, providers)))).toContain("cannot run Codex memory");
    expect(messages(validateConfigCandidate(config({ subagentModelFallback: [model] }, providers)))).toContain("cannot be a subagent fallback");
    expect(messages(validateConfigCandidate(config({ combos: { judge: {
      strategy: "jev", decisionModel: model, targets: [{ provider: "google", model: "gemini-3.8-flash" }],
    } } }, providers)))).toContain("cannot decide for a combo");
  });
  test("a keyless Gemini row is valid, and the same Gemini model on google stays usable everywhere", () => {
    expect(validateConfigCandidate(config()).ok).toBe(true);
    expect(validateConfigCandidate(config({
      subagentModelFallback: ["google/gemini-4-argon"],
      combos: { pair: { targets: [{ provider: "google", model: "gemini-3.8-flash" }, { provider: "google", model: "gemini-4-argon" }] } },
    })).ok).toBe(true);
  });

  test("no API key, key pool, account failover or credential auth mode", () => {
    for (const field of [{ apiKey: "AIza-test" }, { apiKeyPool: [{ id: "a", key: "k" }] }, { oauthAccountFailover: { enabled: true } }, { authMode: "oauth" }]) {
      const result = validateConfigCandidate(config({}, { "antigravity-acp": { ...acp, ...field } }));
      expect(result.ok).toBe(false);
      expect(messages(result)).toContain("uses the CLI's own sign-in");
    }
    // An empty key is the keyless seeding representation and stays valid.
    expect(validateConfigCandidate(config({}, { "antigravity-acp": { ...acp, apiKey: "" } })).ok).toBe(true);
  });

  test("Gemini models and aliases only, on the canonical row and on a custom agy-acp row", () => {
    expect(messages(validateConfigCandidate(config({}, { "antigravity-acp": { ...acp, models: ["claude-opus-5-5"] } })))).toContain("Gemini models only");
    expect(messages(validateConfigCandidate(config({}, { "my-agy": { ...acp, models: ["gpt-6-sol"] } })))).toContain("Gemini models only");
    expect(messages(validateConfigCandidate(config({}, { "antigravity-acp": { ...acp, modelAliases: { "claude-x": "cx" } } })))).toContain("Gemini models only");
    // A stale canonical row saved with another adapter is still the ACP provider.
    expect(messages(validateConfigCandidate(config({}, { "antigravity-acp": { ...acp, adapter: "google", apiKey: "AIza-test" } })))).toContain("uses the CLI's own sign-in");
  });

  test("never a combo target, disabled members included", () => {
    const result = validateConfigCandidate(config({ combos: { mixed: { targets: [
      { provider: "google", model: "gemini-3.8-flash" },
      { provider: "antigravity-acp", model: "gemini-3.8-flash", disabled: true },
    ] } } }));
    expect(result.ok).toBe(false);
    expect(messages(result)).toContain("cannot be a combo target");
  });

  test("never a combo's decision model: a JEV decision call is combo machinery, not a person", () => {
    const judge = (decisionModel: string) => config({ combos: { judge: { strategy: "jev", decisionModel, targets: [{ provider: "google", model: "gemini-3.8-flash" }] } } });
    for (const decisionModel of ["antigravity-acp/gemini-3.8-flash", "gemini-4-argon"]) {
      expect(messages(validateConfigCandidate(judge(decisionModel)))).toContain("cannot decide for a combo");
    }
    expect(validateConfigCandidate(judge("google/gemini-3.8-flash")).ok).toBe(true);
  });

  test("no account binding fields either", () => {
    for (const field of [{ anthropicAccountPool: { enabled: true } }, { codexAccountMode: "pool" }]) {
      expect(agyAcpConfigIssues(config({}, { "antigravity-acp": { ...acp, ...field } }) as never).map(issue => issue.message).join("\n")).toContain("uses the CLI's own sign-in");
    }
  });

  test("never a memory-pipeline model or the shadow-call target: both run unattended", () => {
    const memory = (phase: string) => config({ memoryModels: { [phase]: { model: "antigravity-acp/gemini-3.8-flash" } } });
    for (const phase of ["extract", "consolidation"]) {
      expect(messages(validateConfigCandidate(memory(phase)))).toContain("cannot run Codex memory");
    }
    expect(messages(validateConfigCandidate(config({ shadowCallIntercept: { enabled: true, model: "antigravity-acp/gemini-3.8-flash" } })))).toContain("cannot be the shadow-call target");
    expect(validateConfigCandidate(config({ memoryModels: { extract: { model: "google/gemini-3.8-flash" } }, shadowCallIntercept: { enabled: true, model: "google/gemini-3.8-flash" } })).ok).toBe(true);
  });

  test("never a subagent fallback, through a prefix, a provider alias, a model alias, a combo or the default provider", () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ subagentModelFallback: ["antigravity-acp/gemini-3.8-flash"] }, {}],
      [{ subagentModelFallback: ["agy/gemini-3.8-flash"] }, { "antigravity-acp": { ...acp, alias: "agy" } }],
      [{ subagentModelFallbackByModel: { "gpt-6-sol": ["flash-acp"] } }, { "antigravity-acp": { ...acp, modelAliases: { "gemini-3.8-flash": "flash-acp" } } }],
      [{ subagentModelFallback: ["combo/via-acp"], combos: { "via-acp": { targets: [{ provider: "antigravity-acp", model: "gemini-3.8-flash" }] } } }, {}],
    ];
    for (const [extra, providers] of cases) {
      expect(messages(validateConfigCandidate(config(extra, providers)))).toContain("cannot be a subagent fallback");
    }
    // A bare id both providers list could resolve to either: refused, conservatively.
    expect(agyAcpConfigIssues(config({ subagentModelFallback: ["gemini-3.8-flash"] }) as never)).toHaveLength(1);
    // An unplaceable id falls to the default provider.
    expect([...selectorCandidateProviders(config({ defaultProvider: "antigravity-acp" }) as never, "mystery-model")]).toEqual(["antigravity-acp"]);
  });

  test("structural validation shares static metadata with the registry without loading runtime state", () => {
    const source = readFileSync(repoPath("src/config/schema/agy-acp-references.ts"), "utf8");
    expect(source.match(/^\s*import\b[^\n]*/gm)?.map(line => line.trim())).toEqual([
      'import { AGY_ACP_DEFAULT_MODEL, AGY_ACP_SEED_MODELS } from "../../providers/registry/agy-acp-models";',
      'import { aliasTemplateError, expandAliasTemplate } from "../../providers/alias-template";',
    ]);
    const metadata = readFileSync(repoPath("src/providers/registry/agy-acp-models.ts"), "utf8");
    expect(metadata).not.toMatch(/^\s*import\s/m);
    const row = PROVIDER_REGISTRY.find(entry => entry.id === AGY_ACP_PROVIDER_ID);
    expect(row?.models).toEqual([...AGY_ACP_SEED_MODELS]);
    expect(row?.defaultModel).toBe(AGY_ACP_DEFAULT_MODEL);
  });

  test("the canonical row's seeded and default models, custom models and case-folded aliases resolve like the router", () => {
    const bare = { adapter: "agy-acp", baseUrl: "https://antigravity.google/docs/cli/acp" };
    // No models list: the router still knows the registry seed and the default model.
    expect(messages(validateConfigCandidate(config({ subagentModelFallback: ["gemini-4-argon"] }, { "antigravity-acp": bare, google: { ...google, models: ["gemini-3.8-flash"] } })))).toContain("cannot be a subagent fallback");
    expect(messages(validateConfigCandidate(config({ subagentModelFallback: ["gemini-9-custom"] }, { "my-agy": { ...bare, defaultModel: "gemini-9-custom" } })))).toContain("cannot be a subagent fallback");
    expect(messages(validateConfigCandidate(config({
      subagentModelFallback: ["gemini-9-extra"],
      customModels: [{ provider: "antigravity-acp", modelId: "gemini-9-extra" }],
    })))).toContain("cannot be a subagent fallback");
    expect(messages(validateConfigCandidate(config({ customModels: [{ provider: "antigravity-acp", modelId: "claude-x" }] })))).toContain("Gemini models only");
    // Provider and model aliases are matched case-insensitively by the router.
    expect(messages(validateConfigCandidate(config({ subagentModelFallback: ["AGY/gemini-3.8-flash"] }, { "antigravity-acp": { ...acp, alias: "agy" } })))).toContain("cannot be a subagent fallback");
    expect(messages(validateConfigCandidate(config({ subagentModelFallback: ["Flash-ACP"] }, { "antigravity-acp": { ...acp, modelAliases: { "gemini-3.8-flash": "flash-acp" } } })))).toContain("cannot be a subagent fallback");
    // A model only google lists, with the seeded canonical row present, stays allowed.
    expect(validateConfigCandidate(config({ subagentModelFallback: ["gemini-9-google-only"] }, { google: { ...google, models: ["gemini-9-google-only"] } })).ok).toBe(true);
  });
});
