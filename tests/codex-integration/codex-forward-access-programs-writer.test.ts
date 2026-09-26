import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, mergeCatalogEntriesForSync } from "../../src/codex/catalog/build-entries";
import { CODEX_CUSTOM_MODEL_CATALOG_KIND } from "../../src/codex/catalog/parsing";

describe("serialized Codex forward catalog", () => {
  test("keeps pinned programs on an exact forward alias through the writer merge only", () => {
    const fresh = buildCatalogEntries(null, [], [{
      provider: "openai",
      id: "gpt-6-sol",
      catalogKind: CODEX_CUSTOM_MODEL_CATALOG_KIND,
      codexForwardNativeCapabilityAlias: true,
    }]);
    const forward = fresh.find(row => row.slug === "openai/gpt-6-sol");
    expect(forward?.available_access_programs).toEqual({ cyber: ["standard"] });

    const foreign = {
      ...structuredClone(forward),
      slug: "other/gpt-6-sol",
      opencodex_catalog_kind: "routed-provider",
      available_access_programs: { cyber: ["daybreak_blue"] },
    };
    const merged = mergeCatalogEntriesForSync([], [...fresh, foreign], new Map(), [], false);
    const serialized = JSON.parse(JSON.stringify({ models: merged })) as {
      models: Array<Record<string, unknown>>;
    };
    expect(serialized.models.find(row => row.slug === "openai/gpt-6-sol")?.available_access_programs)
      .toEqual({ cyber: ["standard"] });
    expect(serialized.models.find(row => row.slug === "other/gpt-6-sol"))
      .not.toHaveProperty("available_access_programs");
  });
});
