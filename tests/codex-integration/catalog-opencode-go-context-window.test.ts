import { describe, expect, test } from "bun:test";
import { buildCatalogEntries } from "../../src/codex/catalog";
import { applyCatalogModelMetadata } from "../../src/codex/catalog/effort";
import { applyCatalogMetadata, ensureStrictCatalogFields } from "../../src/codex/catalog/parsing";
import type { CatalogModel, RawEntry } from "../../src/codex/catalog/parsing";
import { getModelMetadata } from "../../src/generated/model-metadata";
import { getProviderRegistryEntry } from "../../src/providers/registry";

/**
 * Regression coverage for #4944.
 *
 * OpenCode Go's /v1/models returns id/object/created/owned_by and no context field at
 * all, so a live-discovered row reaches the catalog with neither contextWindow nor
 * contextCap set on its CatalogModel. On that path `applyCatalogMetadata` is the only
 * writer that can still supply a window: it reads the generated registry keyed by
 * provider and model id and returns early on `if (!meta) return;`. An id missing from
 * that table therefore gets nothing written, `ensureStrictCatalogFields` stamps its
 * 128000 routed default, and a 1M-class model advertises 128k while chained clients
 * compact at ~121k. Nothing reports the loss, which is what made this silent.
 *
 * The repair is data: the vendored snapshot scripts/model-metadata.source.json gained the
 * served ids, so the generated registry now answers for them. These tests pin the derived
 * window rather than the snapshot text, because the snapshot is only a defect when it
 * fails to reach a routed row.
 */

/** models.dev `limit.context` for the ids OpenCode Go serves without publishing a window. */
const EXPECTED_WINDOWS = [
  ["qwen3.8-flash", 1_000_000],
  ["qwen3.8-max", 1_000_000],
  ["hy4-preview", 1_024_000],
  ["omen-alpha", 500_000],
  ["union-alpha", 262_144],
  ["longcat-2.0", 1_000_000],
  ["gpt-5.6-luna", 1_050_000],
  ["muse-spark-1.3-contributor", 1_048_576],
  // Second pass over the same payload: the remaining ids models.dev publishes for this
  // provider, so the bundle is now complete as far as the authoritative source goes.
  ["glm-5.3-flash", 1_000_000],
  ["muse-spark-1.2-contributor", 1_048_576],
  ["ox-alpha-free", 1_000_000],
] as const;

/** The 128k value `ensureStrictCatalogFields` stamps when nothing supplied a window. */
const STRICT_FALLBACK_WINDOW = 128_000;

/**
 * Mirrors the real write order in src/codex/catalog/sync.ts: generated metadata first,
 * then the CatalogModel's own fields, then strict normalization. A hand-written row
 * would pass while the writer emitted nothing.
 */
function serialize(model: CatalogModel): RawEntry {
  const entry: RawEntry = { slug: model.provider + "/" + model.id } as RawEntry;
  applyCatalogMetadata(entry, model.provider, model.id, model.contextCap);
  applyCatalogModelMetadata(entry, model);
  return ensureStrictCatalogFields(entry, { isRouted: true });
}

/** A live-discovered row: no window, no cap, exactly what /v1/models yields. */
function discovered(id: string): CatalogModel {
  return { provider: "opencode-go", id, owned_by: "opencode-go" };
}

describe("OpenCode Go routed context windows (#4944)", () => {
  test("the generated registry answers for every served id", () => {
    for (const [id, contextWindow] of EXPECTED_WINDOWS) {
      expect(getModelMetadata("opencode-go", id)?.contextWindow, id).toBe(contextWindow);
    }
  });

  test("a row with no published window serializes with the registry window", () => {
    for (const [id, contextWindow] of EXPECTED_WINDOWS) {
      const entry = serialize(discovered(id));

      expect(entry.context_window, id).toBe(contextWindow);
      expect(entry.max_context_window, id).toBe(contextWindow);
      // The defect is silent, so assert the fallback explicitly: 128000 is what a
      // missing registry row produces, and every id here is well above it.
      expect(entry.context_window, id).not.toBe(STRICT_FALLBACK_WINDOW);
    }
  });

  test("the derived catalog entry carries the window end to end", () => {
    // Through deriveEntry rather than the composition above: the routed fallback path
    // applies the same metadata, and this is the row Codex actually reads.
    for (const [id, contextWindow] of EXPECTED_WINDOWS) {
      const slug = "opencode-go/" + id;
      const entry = buildCatalogEntries(null, [], [discovered(id)])
        .find(row => row.slug === slug);

      expect(entry, slug).toBeDefined();
      expect(entry?.context_window, slug).toBe(contextWindow);
      expect(entry?.auto_compact_token_limit, slug).toBe(Math.floor(contextWindow * 0.9));
    }
  });

  test("the generated table never undercuts the registry's declared DeepSeek windows", () => {
    // models.dev publishes 1000000 for opencode-go/deepseek-v4.1-flash and
    // opencode-go/deepseek-v4-flash-vision-exp, but this repository deliberately declares
    // 1_048_576 for both in src/providers/registry/entries-core.ts, citing DeepSeek's official
    // Codex setup script and calling the 1,000,000 figure a rounded approximation. The registry
    // hint wins wherever it applies, so copying the lower number into the snapshot would fix
    // nothing and would silently lower the window on any row that does not receive provider
    // hints. They are therefore left out of the snapshot refresh.
    //
    // This is the invariant, not the omission: a later refresh may add these ids, but only
    // carrying a window at least as large as the one the registry already promises.
    const declared = getProviderRegistryEntry("opencode-go")?.modelContextWindows;

    for (const id of ["deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp"] as const) {
      const registryWindow = declared?.[id];
      expect(registryWindow, id).toBe(1_048_576);

      const generated = getModelMetadata("opencode-go", id)?.contextWindow;
      if (generated !== undefined) expect(generated, id).toBeGreaterThanOrEqual(registryWindow!);
    }
  });
});
