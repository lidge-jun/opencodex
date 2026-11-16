/** Configuration rules for the Antigravity ACP provider (plan 080, B2/R2-1). */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getDefaultConfig, validateConfigCandidate } from "../../src/config";
import { AGY_ACP_DEFAULT_MODEL, AGY_ACP_PROVIDER_ID, AGY_ACP_SEED_MODELS, agyAcpConfigIssues, selectorCandidateProviders } from "../../src/config/schema/agy-acp-references";
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

  test("validation is structural: the resolver imports nothing, so it can read no credential or runtime state", () => {
    const source = readFileSync(repoPath("src/config/schema/agy-acp-references.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    // Its restated seed must match the registry row the router reads.
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
