import { describe, expect, test } from "bun:test";
import { cursorModelDisplayNames } from "../src/adapters/cursor/discovery";
import { cursorUmbrellaRows } from "../src/adapters/cursor/catalog";
import { enrichProviderFromRegistry, providerConfigSeed } from "../src/providers/derive";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { configuredModelDisplayName } from "../src/codex/catalog/provider-fetch";
import type { OcxProviderConfig } from "../src/types";

/**
 * The Codex picker showed raw slugs (`cursor/kimi-k3`) because `routedDisplayName`
 * (codex/catalog/sync.ts) passes a routed slug through unchanged, and nothing carried
 * Cursor's labels into `providers.cursor.modelDisplayNames` — the registry entry type had
 * no such field. These assert the full registry -> config -> catalog-hint path, not just
 * that a label table exists (devlog 260902_cursor_unified_identity).
 */
describe("cursor picker labels reach the catalog", () => {
  const cursorEntry = () => {
    const entry = getProviderRegistryEntry("cursor");
    if (!entry) throw new Error("cursor registry entry missing");
    return entry;
  };

  test("the registry entry carries a label for every seeded row", () => {
    const labels = cursorModelDisplayNames();
    expect(cursorEntry().modelDisplayNames).toEqual(labels);
    for (const row of cursorUmbrellaRows()) {
      expect(labels[row.id]).toBe(row.displayName);
    }
    // The label is a human name, never the id echoed back.
    expect(labels["kimi-k3"]).toBe("Kimi K3");
    expect(labels["grok-4.6"]).toBe("Cursor Grok 4.6");
    expect(labels["claude-opus-5"]).toBe("Claude Opus 5");
    expect(labels.auto).toBe("Auto");
  });

  test("a fresh seed exposes the labels through configuredModelDisplayName", () => {
    const seeded = providerConfigSeed(cursorEntry());
    expect(configuredModelDisplayName(seeded, "kimi-k3")).toBe("Kimi K3");
    expect(configuredModelDisplayName(seeded, "claude-4-sonnet-1m")).toBe("Claude Sonnet 4 (1M)");
    expect(configuredModelDisplayName(seeded, "composer-2.5-fast")).toBe("Composer 2.5 Fast");
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
    // ...while every other row still gains its label instead of staying unlabeled.
    expect(configuredModelDisplayName(existing, "grok-4.6")).toBe("Cursor Grok 4.6");
  });
});
