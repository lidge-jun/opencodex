/**
 * Registry enrichment used to copy numeric capability maps all-or-nothing.
 * #4570 is the live-catalog symptom: a persisted zhipu-bigmodel-coding map that
 * predated glm-5.3-flash stayed truthy, so the seed was skipped entirely and
 * Flash reached the catalog with no contextWindow while its modalities (already
 * per-key filled) were correct. These cases pin the per-key fill for both
 * modelContextWindows and modelMaxOutputTokens.
 */
import { describe, expect, test } from "bun:test";
import { enrichProviderFromRegistry, providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxProviderConfig } from "../../src/types";

function persisted(id: string, overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const entry = getProviderRegistryEntry(id);
  if (!entry) throw new Error(`missing ${id} registry fixture`);
  return { adapter: entry.adapter, baseUrl: entry.baseUrl, ...overrides };
}

function seedOf(id: string): OcxProviderConfig {
  const entry = getProviderRegistryEntry(id);
  if (!entry) throw new Error(`missing ${id} registry fixture`);
  return providerConfigSeed(entry);
}

describe("registry seed fill normalization (#4570)", () => {
  test("a partial persisted window map still receives newly seeded keys", () => {
    // #4570: an install that persisted zhipu-bigmodel-coding before glm-5.3-flash
    // landed in the seed window map kept a truthy partial map (glm-5.3, glm-5.2)
    // with no flash key. All-or-nothing enrichment skipped the seed entirely, so
    // Flash reached the live catalog with no contextWindow. Modalities were
    // already per-key filled, which is why the bug showed as "modalities right,
    // context missing".
    const seed = seedOf("zhipu-bigmodel-coding");
    expect(seed.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);

    const prov = persisted("zhipu-bigmodel-coding", {
      modelContextWindows: { "glm-5.3": 1_000_000, "glm-5.2": 1_000_000 },
    });
    enrichProviderFromRegistry("zhipu-bigmodel-coding", prov);

    expect(prov.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);
    expect(prov.modelContextWindows?.["glm-5.3"]).toBe(1_000_000);
    expect(prov.modelContextWindows?.["glm-5.2"]).toBe(1_000_000);
  });

  test("an operator window override outranks the seed", () => {
    // Fill is beneath the operator map, not over it. Lowering one model's
    // window used to be the only way an existing install kept ANY windows at
    // all; that explicit value must still win after the per-key repair.
    const prov = persisted("zhipu-bigmodel-coding", {
      modelContextWindows: { "glm-5.3": 32_768 },
    });
    enrichProviderFromRegistry("zhipu-bigmodel-coding", prov);

    expect(prov.modelContextWindows?.["glm-5.3"]).toBe(32_768);
    expect(prov.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);
  });

  test("modelMaxOutputTokens fills per key the same way", () => {
    // Same all-or-nothing copy as modelContextWindows. zhipu-bigmodel-coding
    // does not seed this map, so the case uses zai, which does.
    const seed = seedOf("zai");
    expect(seed.modelMaxOutputTokens?.["glm-5.3-flash"]).toBe(131_072);

    const prov = persisted("zai", {
      modelMaxOutputTokens: { "glm-5.3": 64_000 },
    });
    enrichProviderFromRegistry("zai", prov);

    expect(prov.modelMaxOutputTokens?.["glm-5.3"]).toBe(64_000);
    expect(prov.modelMaxOutputTokens?.["glm-5.3-flash"]).toBe(131_072);
  });

  test("a provider with no persisted window map still receives the full seed", () => {
    // Unchanged behavior: an empty install, or a config saved before any window
    // map existed, must still get the whole seed rather than a per-key no-op.
    const seed = seedOf("zhipu-bigmodel-coding");
    const prov = persisted("zhipu-bigmodel-coding");
    expect(prov.modelContextWindows).toBeUndefined();

    enrichProviderFromRegistry("zhipu-bigmodel-coding", prov);

    expect(prov.modelContextWindows).toEqual(seed.modelContextWindows);
  });
});
