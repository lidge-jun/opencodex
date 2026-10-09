import { describe, expect, test } from "bun:test";
import { providerConfigSeed } from "../../../src/providers/derive";
import { getProviderRegistryEntry } from "../../../src/providers/registry";
import {
  ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODELS,
  ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS,
} from "../../../src/providers/registry/model-seeds";
import { resolveModelPolicy } from "../../../src/providers/resolved-model-policy";
import { resolveOutputCeiling } from "../../../src/server/responses/input-admission";

// Anthropic's per-model overview pages (platform.claude.com/docs/en/models/<slug>/overview,
// read 2026-10-08) put the synchronous Messages API maximum at 128K for every seeded Claude
// model except Haiku 4.5, which is 64K. The 300K figure on those pages belongs to the Message
// Batches extended-output beta and does not apply to the synchronous route.
const HIGH_OUTPUT = 128_000;
const HAIKU = "claude-haiku-4-5";
const PROVIDERS = ["anthropic", "anthropic-apikey"] as const;

const entry = (name: string) => getProviderRegistryEntry(name)!;

function policy(providerName: string, modelId: string) {
  const registryEntry = entry(providerName);
  const authMode = providerName === "anthropic" ? "oauth" : "key";
  return resolveModelPolicy({
    providerName,
    modelId,
    provider: { adapter: registryEntry.adapter, baseUrl: registryEntry.baseUrl, authMode },
    registryEntry,
    transportMatchedRegistry: true,
    effectiveAuth: { authMode },
  });
}

describe("Anthropic per-model output maxima", () => {
  test("the table covers every seeded model except the one that really is 64K", () => {
    expect(Object.keys(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS).sort())
      .toEqual(ANTHROPIC_MODELS.filter(id => id !== HAIKU).sort());
    for (const maximum of Object.values(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS)) {
      expect(maximum).toBe(HIGH_OUTPUT);
    }
    // Haiku 4.5 carries no entry on purpose, so it must still resolve the default and not 128K.
    expect(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS[HAIKU]).toBeUndefined();
    expect(ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS).toBe(64_000);
    expect(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS["claude-haiku-5-5"]).toBe(HIGH_OUTPUT);
  });

  for (const providerName of PROVIDERS) {
    test(`${providerName} resolves each model's real ceiling rather than the 64K default`, () => {
      expect(entry(providerName).modelMaxOutputTokens).toEqual(ANTHROPIC_MODEL_MAX_OUTPUT_TOKENS);
      const provider = providerConfigSeed(entry(providerName));
      for (const modelId of ANTHROPIC_MODELS) {
        const expected = modelId === HAIKU ? ANTHROPIC_DEFAULT_MAX_OUTPUT_TOKENS : HIGH_OUTPUT;
        expect(policy(providerName, modelId).model.maxOutputTokens, modelId).toBe(expected);
        // The admission path reads the ceiling through its own resolver, so assert that too:
        // it is what the adapter budgets against when a caller declares no max_tokens, and what
        // the combo reserve is computed from.
        expect(resolveOutputCeiling(provider, providerName, modelId)).toBe(expected);
      }
    });
  }
});
