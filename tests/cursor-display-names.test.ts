import { describe, expect, test } from "bun:test";
import { cursorModelDisplayNames, CURSOR_STATIC_MODELS, isCursorBrandedLabel } from "../src/adapters/cursor/discovery";
import { cursorUmbrellaRows } from "../src/adapters/cursor/catalog";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { configuredModelDisplayName } from "../src/codex/catalog/provider-fetch";
import type { OcxProviderConfig } from "../src/types";

/**
 * `routedDisplayName` (codex/catalog/sync.ts) passes a routed slug through unchanged, so a
 * Cursor row reads `cursor/kimi-k3` like every other provider's rows. #3222 labeled every
 * seeded row and the picker lost its `cursor/` prefix, which made Cursor rows
 * indistinguishable from the same model under another provider. Only labels that carry
 * Cursor's own brand ("Cursor Grok 4.6") are published; the rest keep the routed slug.
 * These assert the full registry -> config -> catalog-hint path, not just that a label
 * table exists.
 */
describe("cursor picker labels reach the catalog", () => {
  const cursorEntry = () => {
    const entry = getProviderRegistryEntry("cursor");
    if (!entry) throw new Error("cursor registry entry missing");
    return entry;
  };

  test("the registry entry labels only Cursor-branded rows", () => {
    const labels = cursorModelDisplayNames();
    expect(cursorEntry().modelDisplayNames).toEqual(labels);
    const seededIds = new Set(CURSOR_STATIC_MODELS.map(model => model.id));
    for (const [id, label] of Object.entries(labels)) {
      expect(seededIds.has(id)).toBe(true);
      expect(isCursorBrandedLabel(label)).toBe(true);
    }
    for (const row of cursorUmbrellaRows()) {
      if (isCursorBrandedLabel(row.displayName)) expect(labels[row.id]).toBe(row.displayName);
      else expect(labels).not.toHaveProperty(row.id);
    }
    // Cursor's own product name stays; a third-party model keeps its `cursor/<id>` slug.
    expect(labels["grok-4.6"]).toBe("Cursor Grok 4.6");
    expect(labels["grok-4.5"]).toBe("Cursor Grok 4.5");
    expect(labels).not.toHaveProperty("kimi-k3");
    expect(labels).not.toHaveProperty("claude-opus-5");
    expect(labels).not.toHaveProperty("auto");
    expect(labels).not.toHaveProperty("composer-2.5");
  });

  test("a fresh seed exposes only the branded labels through configuredModelDisplayName", () => {
    const seeded = providerConfigSeed(cursorEntry());
    expect(configuredModelDisplayName(seeded, "grok-4.6")).toBe("Cursor Grok 4.6");
    expect(configuredModelDisplayName(seeded, "kimi-k3")).toBeUndefined();
    expect(configuredModelDisplayName(seeded, "claude-4-sonnet-1m")).toBeUndefined();
    expect(configuredModelDisplayName(seeded, "composer-2.5-fast")).toBeUndefined();
  });

  test("enrich backfills an existing install per model, preserving operator renames", () => {
    const existing = {
      adapter: "cursor",
      baseUrl: "https://api2.cursor.sh",
      modelDisplayNames: { "kimi-k3": "My K3" },
    } as OcxProviderConfig;
    enrichProviderFromRegistry("cursor", existing);
    // Operator value survives...
    expect(configuredModelDisplayName(existing, "kimi-k3")).toBe("My K3");
    // ...the branded row gains its label, and an unbranded row stays on its routed slug.
    expect(configuredModelDisplayName(existing, "grok-4.6")).toBe("Cursor Grok 4.6");
    expect(configuredModelDisplayName(existing, "claude-opus-5")).toBeUndefined();
  });
});
