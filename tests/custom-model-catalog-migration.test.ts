import { describe, expect, test } from "bun:test";

import {
  projectCustomModelCatalogMigration,
  legacyCustomModelCatalogSlugs,
} from "../src/codex/custom-model-catalog-migration";
import type { OcxConfig, OcxCustomModel } from "../src/types";

function config(customModels?: OcxCustomModel[]): OcxConfig {
  return {
    port: 10100,
    providers: {
      routed: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
      },
    },
    defaultProvider: "routed",
    ...(customModels ? { customModels } : {}),
  };
}

function custom(modelId: string): OcxCustomModel {
  return {
    id: `id-${modelId}`,
    provider: "routed",
    modelId,
  };
}

describe("custom-model catalog ownership migration", () => {
  test("leaves configs without custom models untouched", () => {
    const projected = projectCustomModelCatalogMigration(config(), config());
    expect(projected.customModelCatalogMigration).toBeUndefined();
  });

  test("captures only pre-version models and versions a fresh add with an empty ledger", () => {
    const added = projectCustomModelCatalogMigration(config(), config([custom("new-model")]));
    expect(legacyCustomModelCatalogSlugs(added)).toEqual(new Set());
    expect(added.customModelCatalogMigration).toEqual({
      version: 1,
      legacyOwnedSlugs: [],
    });

    const removed = projectCustomModelCatalogMigration(
      config([custom("old-model")]),
      config(),
    );
    expect(legacyCustomModelCatalogSlugs(removed)).toEqual(new Set(["routed/old-model"]));

    const renamed = projectCustomModelCatalogMigration(
      config([custom("old-model")]),
      config([custom("new-model")]),
    );
    expect(legacyCustomModelCatalogSlugs(renamed)).toEqual(new Set(["routed/old-model"]));
  });

  test("canonicalizes a legacy raw routed id", () => {
    const projected = projectCustomModelCatalogMigration(
      config([custom("vendor/model")]),
      config(),
    );
    expect(legacyCustomModelCatalogSlugs(projected)).toEqual(
      new Set(["routed/vendor-model"]),
    );
  });

  test("post-version add and delete never expands legacy ownership", () => {
    const versioned = {
      ...config(),
      customModelCatalogMigration: { version: 1, legacyOwnedSlugs: [] },
    };
    const afterAdd = projectCustomModelCatalogMigration(
      versioned,
      { ...config([custom("new-model")]), customModelCatalogMigration: versioned.customModelCatalogMigration },
    );
    const afterDelete = projectCustomModelCatalogMigration(afterAdd, {
      ...config(),
      customModelCatalogMigration: afterAdd.customModelCatalogMigration,
    });
    expect(legacyCustomModelCatalogSlugs(afterDelete)).toEqual(new Set());
  });

  test("a repaired malformed custom-model surface still establishes an empty cutover", () => {
    const malformed = { ...config(), customModels: "bad" };
    const afterRepair = projectCustomModelCatalogMigration(
      malformed,
      config([custom("new-model")]),
    );
    expect(afterRepair.customModelCatalogMigration).toEqual({
      version: 1,
      legacyOwnedSlugs: [],
    });

    const afterDelete = projectCustomModelCatalogMigration(afterRepair, {
      ...config(),
      customModelCatalogMigration: afterRepair.customModelCatalogMigration,
    });
    expect(legacyCustomModelCatalogSlugs(afterDelete)).toEqual(new Set());
  });

  test("a stale candidate cannot discard existing legacy ownership evidence", () => {
    const persisted = {
      ...config(),
      customModelCatalogMigration: {
        version: 1,
        legacyOwnedSlugs: ["routed/old-model"],
      },
    };
    const projected = projectCustomModelCatalogMigration(persisted, config());
    expect(legacyCustomModelCatalogSlugs(projected)).toEqual(new Set(["routed/old-model"]));
  });

  test("unknown or malformed state is preserved and grants no deletion authority", () => {
    const future = {
      ...config([custom("old-model")]),
      customModelCatalogMigration: {
        version: 2,
        opaque: { keep: true },
      },
    };
    const projected = projectCustomModelCatalogMigration(future, config());
    expect(projected.customModelCatalogMigration).toEqual(future.customModelCatalogMigration);
    expect(legacyCustomModelCatalogSlugs(projected)).toEqual(new Set());

    const malformed = {
      ...config(),
      customModelCatalogMigration: {
        version: 1,
        legacyOwnedSlugs: ["routed/good", 42],
      },
    };
    expect(legacyCustomModelCatalogSlugs(malformed)).toEqual(new Set());
  });
});
