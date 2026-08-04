import { expect, test } from "bun:test";
import { comboConfigError } from "../src/combos";
import { providerContextCap } from "../src/providers/context-cap";
import { rewriteProviderReferences } from "../src/providers/provider-id-rewrite";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const FROM = "alibaba-token-plan";
const TO = "alibaba-token-plan-intl";

test("rewrites every routed-string site", () => {
  const config = {
    defaultProvider: FROM,
    disabledModels: [`${FROM}/glm-5.2`, "anthropic/claude-sonnet-5"],
    subagentModels: [`${FROM}/qwen3.7-max`],
    subagentModelFallback: [`${FROM}/qwen3.6-flash`],
    injectionModel: `${FROM}/qwen3.7-plus`,
    shadowCallIntercept: { model: `${FROM}/qwen3.6-flash` },
    webSearchSidecar: { model: `${FROM}/qwen3.7-max` },
    visionSidecar: { model: `${FROM}/qwen3.7-max` },
    claudeCode: {
      model: `${FROM}/qwen3.7-max`,
      smallFastModel: `${FROM}/qwen3.6-flash`,
      tierModels: { opus: `${FROM}/qwen3.7-max` },
      modelMap: { "claude-opus-5": `${FROM}/qwen3.7-max` },
      webSearchSidecar: { model: `${FROM}/qwen3.7-max` },
      visionSidecar: { model: `${FROM}/qwen3.7-max` },
    },
  } as unknown as OcxConfig;

  // 14 sites: defaultProvider, one of two disabledModels, subagentModels,
  // subagentModelFallback, injectionModel, shadowCallIntercept.model,
  // webSearchSidecar.model, visionSidecar.model, and the six claudeCode entries.
  expect(rewriteProviderReferences(config, FROM, TO)).toEqual({ changed: 14, collisions: [] });
  expect(JSON.stringify(config)).not.toContain(`"${FROM}/`);
  expect(config.disabledModels).toContain("anthropic/claude-sonnet-5");
});

test("moves a providerContextCaps entry by key, not by prefix", () => {
  const config = { providerContextCaps: { [FROM]: 500_000, anthropic: 200_000 } } as unknown as OcxConfig;
  expect(rewriteProviderReferences(config, FROM, TO)).toEqual({ changed: 1, collisions: [] });
  // Asserted through the consumer, so a shape mistake cannot pass.
  expect(providerContextCap(config, TO)).toBe(500_000);
  expect(providerContextCap(config, FROM)).toBeUndefined();
  expect(providerContextCap(config, "anthropic")).toBe(200_000);
});

test("reports a providerContextCaps collision instead of overwriting it", () => {
  const config = { providerContextCaps: { [FROM]: 500_000, [TO]: 900_000 } } as unknown as OcxConfig;
  const result = rewriteProviderReferences(config, FROM, TO);
  expect(result.collisions).toEqual([`providerContextCaps.${TO}`]);
  expect(providerContextCap(config, TO)).toBe(900_000);
  expect(providerContextCap(config, FROM)).toBe(500_000);
});

test("re-points combo targets so the migrated config still validates", () => {
  const providers = { [TO]: { adapter: "openai-chat" } } as unknown as Record<string, OcxProviderConfig>;
  const combo = { targets: [{ provider: FROM, model: "qwen3.7-max" }] };
  const config = { providers, combos: { fast: combo } } as unknown as OcxConfig;

  expect(comboConfigError("fast", combo, providers)).toContain("not configured");
  rewriteProviderReferences(config, FROM, TO);
  expect(comboConfigError("fast", config.combos!.fast!, providers)).toBeNull();
});

test("re-points customModels[].provider", () => {
  const config = {
    customModels: [
      { id: "a", provider: FROM, modelId: "qwen3.7-max" },
      { id: "b", provider: "anthropic", modelId: "claude-sonnet-5" },
    ],
  } as unknown as OcxConfig;
  expect(rewriteProviderReferences(config, FROM, TO).changed).toBe(1);
  expect(config.customModels!.map(m => m.provider)).toEqual([TO, "anthropic"]);
});

test("rewrites both halves of the Desktop profile", () => {
  const config = {
    claudeCode: {
      desktopProfile: {
        version: 1,
        assignments: { [`${FROM}/qwen3.7-max`]: { family: "opus", alias: "a" } },
        defaults: { opus: `${FROM}/qwen3.7-max`, fable: null, sonnet: null, haiku: null },
      },
    },
  } as unknown as OcxConfig;
  rewriteProviderReferences(config, FROM, TO);
  const profile = config.claudeCode!.desktopProfile!;
  expect(Object.keys(profile.assignments)).toEqual([`${TO}/qwen3.7-max`]);
  expect(profile.defaults.opus).toBe(`${TO}/qwen3.7-max`);
});

test("reports a Desktop assignment collision instead of overwriting it", () => {
  const config = {
    claudeCode: {
      desktopProfile: {
        version: 1,
        assignments: {
          [`${FROM}/qwen3.7-max`]: { family: "opus", alias: "from" },
          [`${TO}/qwen3.7-max`]: { family: "opus", alias: "already-there" },
        },
        defaults: { opus: null, fable: null, sonnet: null, haiku: null },
      },
    },
  } as unknown as OcxConfig;
  const result = rewriteProviderReferences(config, FROM, TO);
  expect(result.collisions).toEqual([`claudeCode.desktopProfile.assignments.${TO}/qwen3.7-max`]);
  expect(result.changed).toBe(0);
  expect(config.claudeCode!.desktopProfile!.assignments[`${TO}/qwen3.7-max`]!.alias).toBe("already-there");
});

test("leaves foreign prefixes and unrelated providers alone", () => {
  const config = {
    defaultProvider: `${FROM}-other`,
    disabledModels: [`${FROM}-other/x`, `${TO}/glm-5.2`],
    providerContextCaps: { [`${FROM}-other`]: 1000 },
  } as unknown as OcxConfig;
  const before = structuredClone(config);
  expect(rewriteProviderReferences(config, FROM, TO)).toEqual({ changed: 0, collisions: [] });
  expect(config).toEqual(before);
  // Absent fields must stay absent: an unconditional list assignment would add
  // `subagentModels: undefined` as an own property and deep-equality would miss it.
  expect(Object.keys(config).sort()).toEqual(Object.keys(before).sort());
});

test("does not touch providers[*].selectedModels", () => {
  // Native ids may contain a slash, so a prefix rewrite here could mangle an
  // unrelated provider's allowlist.
  const config = {
    providers: { openrouter: { adapter: "openai-chat", selectedModels: [`${FROM}/qwen3.7-max`] } },
  } as unknown as OcxConfig;
  expect(rewriteProviderReferences(config, FROM, TO).changed).toBe(0);
  expect(config.providers.openrouter!.selectedModels).toEqual([`${FROM}/qwen3.7-max`]);
});
