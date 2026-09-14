/**
 * Catalog-layer registry seed fill (#4570).
 *
 * Routing already merges modelContextWindows / modelMaxOutputTokens per key
 * (mergeRecordFill in src/router.ts). The catalog used to enrich a detached
 * clone all-or-nothing, so a persisted partial window map hid newly seeded
 * keys such as glm-5.3-flash. applyRegistryCapabilitySeedFill closes that
 * divergence on the clone captureProviderGather already builds; it must not
 * live in enrichProviderFromRegistry, whose output is saved on a management
 * POST (#1409).
 */
import { describe, expect, test } from "bun:test";
import { applyRegistryCapabilitySeedFill } from "../../src/codex/catalog/provider-fetch";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { OcxProviderConfig } from "../../src/types";

function persisted(id: string, overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  const entry = getProviderRegistryEntry(id);
  if (!entry) throw new Error(`missing ${id} registry fixture`);
  return { adapter: entry.adapter, baseUrl: entry.baseUrl, ...overrides };
}

/** Mirrors detachedClone in src/codex/catalog/provider-fetch.ts. */
function detachedClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => detachedClone(item)) as T;
  if (value && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      clone[key] = detachedClone((value as Record<string, unknown>)[key]);
    }
    return clone as T;
  }
  return value;
}

describe("catalog registry capability seed fill (#4570)", () => {
  test("a partial persisted window map still receives newly seeded keys", () => {
    // #4570: an install that persisted zhipu-bigmodel-coding before glm-5.3-flash
    // joined the seed window map kept a truthy partial map (glm-5.3, glm-5.2)
    // with no flash key. Modalities already merge per key, so Flash reached
    // `ocx models live --json` with an empty contextWindow while glm-5.3
    // reported 1M and Flash's modalities were right. Routing filled the seed
    // beneath the operator map; the catalog clone did not.
    const seed = getProviderRegistryEntry("zhipu-bigmodel-coding");
    expect(seed?.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);

    const prov = persisted("zhipu-bigmodel-coding", {
      modelContextWindows: { "glm-5.3": 1_000_000, "glm-5.2": 1_000_000 },
    });
    applyRegistryCapabilitySeedFill("zhipu-bigmodel-coding", prov);

    expect(prov.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);
    expect(prov.modelContextWindows?.["glm-5.3"]).toBe(1_000_000);
    expect(prov.modelContextWindows?.["glm-5.2"]).toBe(1_000_000);
  });

  test("an operator window override outranks the seed", () => {
    // Fill is beneath the operator map, not over it. A persisted lower window
    // is an explicit cap; writing the seed on top of it would undo the only
    // knob an existing install had for that model.
    const prov = persisted("zhipu-bigmodel-coding", {
      modelContextWindows: { "glm-5.3": 32_768 },
    });
    applyRegistryCapabilitySeedFill("zhipu-bigmodel-coding", prov);

    expect(prov.modelContextWindows?.["glm-5.3"]).toBe(32_768);
    expect(prov.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);
  });

  test("modelMaxOutputTokens fills per key the same way", () => {
    // Same merge as modelContextWindows. zhipu-bigmodel-coding does not seed
    // this map; zai does, via ZAI_GLM_53_MODELS at 131_072.
    const seed = getProviderRegistryEntry("zai");
    expect(seed?.modelMaxOutputTokens?.["glm-5.3-flash"]).toBe(131_072);
    expect(seed?.modelMaxOutputTokens?.["glm-5.3"]).toBe(131_072);

    const prov = persisted("zai", {
      modelMaxOutputTokens: { "glm-5.3": 64_000 },
    });
    applyRegistryCapabilitySeedFill("zai", prov);

    expect(prov.modelMaxOutputTokens?.["glm-5.3"]).toBe(64_000);
    expect(prov.modelMaxOutputTokens?.["glm-5.3-flash"]).toBe(131_072);
  });

  test("seed fill never writes into the operator's saved config (#1409)", () => {
    // #1409 / tests/server/management-provider-validation.test.ts: a management
    // POST persists enrichment output, so a per-key seed merge inside
    // enrichProviderFromRegistry would write registry keys into user config as
    // a side effect of an unrelated save. A previous attempt at #4570 did
    // exactly that and broke "an omitted modelContextWindows keeps the user's
    // map, without registry seed keys". captureProviderGather clones first,
    // then fills the clone; the original object must keep only the operator's
    // keys.
    const configured = persisted("zhipu-bigmodel-coding", {
      modelContextWindows: { "glm-5.3": 1_000_000, "glm-5.2": 1_000_000 },
    });
    const originalWindows = configured.modelContextWindows;
    const catalogClone = detachedClone(configured);
    applyRegistryCapabilitySeedFill("zhipu-bigmodel-coding", catalogClone);

    expect(catalogClone.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);
    expect(configured.modelContextWindows).toBe(originalWindows);
    expect(configured.modelContextWindows).toEqual({ "glm-5.3": 1_000_000, "glm-5.2": 1_000_000 });
    expect(configured.modelContextWindows).not.toHaveProperty("glm-5.3-flash");
  });

  test("a retargeted provider does not inherit the named vendor's seed keys", () => {
    // Inheriting another vendor's context windows is worse than having none.
    // providerMatchesRegistryTransport is the same gate captureProviderGather
    // already uses; zhipu-bigmodel-responses opted into preserveCustomDestination,
    // so pointing baseUrl at an unrelated host must skip the seed entirely.
    const seed = getProviderRegistryEntry("zhipu-bigmodel-responses");
    expect(seed?.modelContextWindows?.["glm-5.3-flash"]).toBe(1_048_576);

    const prov = persisted("zhipu-bigmodel-responses", {
      baseUrl: "https://example.invalid/v1",
      modelContextWindows: { "glm-5.3": 1_048_576 },
    });
    applyRegistryCapabilitySeedFill("zhipu-bigmodel-responses", prov);

    expect(prov.modelContextWindows).toEqual({ "glm-5.3": 1_048_576 });
    expect(prov.modelContextWindows).not.toHaveProperty("glm-5.3-flash");
  });
});
