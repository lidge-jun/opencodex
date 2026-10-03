import { describe, expect, test } from "bun:test";
import type { OcxConfig } from "../../src/types";
import { reconcileSuccessfulModelDiscoveries } from "../../src/providers/new-model-policy";
import {
  antigravityEffortFamilyIds, antigravityFamilyDisabled, collapseAntigravityPublicModels,
  projectAntigravitySelectedModels, type AntigravityEffortFamilyRow,
} from "../../src/providers/antigravity-effort-families";

const provider = "google-antigravity";
const base = "claude-opus-5-5";
const tiers = ["claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high"];
const now = "2026-10-03T01:00:00Z";
const family = {
  provider, id: base,
  antigravityEffortWireModelIds: { low: tiers[0]!, medium: tiers[1]!, high: tiers[2]! },
};

function configFor(ids = tiers): OcxConfig {
  return {
    port: 10100, defaultProvider: provider, providers: { [provider]: {} },
    modelDiscovery: {
      newModelPolicy: "off",
      knownModels: { [provider]: { ids: [...ids], removed: [], updatedAt: now } },
    },
  };
}

const wireRows: AntigravityEffortFamilyRow[] = tiers.map(id => ({ provider, id }));
const retainedRows = [family, ...wireRows];
function reconcile(config: OcxConfig, models: AntigravityEffortFamilyRow[] = retainedRows) {
  return reconcileSuccessfulModelDiscoveries({ config, models, authoritativeProviders: [provider], now });
}

describe("Antigravity effort family projections", () => {
  test("only a complete exact map supplies family evidence", () => {
    expect(antigravityEffortFamilyIds(family)).toEqual(tiers);
    for (const row of [
      { provider, id: base },
      { ...family, custom: true },
      { ...family, catalogKind: "custom-model-v1" },
      { ...family, antigravityEffortWireModelIds: { low: tiers[0]!, high: tiers[2]! } },
      { ...family, antigravityEffortWireModelIds: { ...family.antigravityEffortWireModelIds, medium: "another-medium" } },
    ]) expect(antigravityEffortFamilyIds(row)).toBeUndefined();
  });

  test("public collapse preserves custom, combo and unrelated rows and does not mutate internal targets", () => {
    const custom = { ...wireRows[0]!, custom: true };
    const catalogCustom = { ...wireRows[1]!, catalogKind: "custom-model-v1" };
    const combo = { provider: "combo", id: tiers[2]! };
    const unrelated = { provider: "other", id: tiers[0]! };
    const rows = [...wireRows, custom, family, catalogCustom, combo, unrelated];
    const before = structuredClone(rows);
    expect(collapseAntigravityPublicModels(rows)).toEqual([custom, family, catalogCustom, combo, unrelated]);
    expect(rows).toEqual(before);
    expect(collapseAntigravityPublicModels(wireRows)).toEqual(wireRows);
  });

  test("suffix allowlist admits the base once while preserving the saved selection", () => {
    const selected = [tiers[2]!, "unrelated"];
    expect(projectAntigravitySelectedModels(provider, selected, retainedRows)).toEqual([...selected, base]);
    expect(selected).toEqual(["claude-opus-5-5-high", "unrelated"]);
    expect(projectAntigravitySelectedModels(provider, [base, tiers[0]!], retainedRows)).toEqual([base, tiers[0]!]);
    expect(projectAntigravitySelectedModels(provider, [], retainedRows)).toEqual([]);
    expect(projectAntigravitySelectedModels("other", selected, retainedRows)).toEqual(selected);
    expect(projectAntigravitySelectedModels(provider, selected, [{ ...family, custom: true }])).toEqual(selected);
  });

  test("allowlist and disabled projection reuse raw/encoded slug equivalence", () => {
    const row = {
      provider, id: "claude/opus",
      antigravityEffortWireModelIds: { low: "claude/opus-low", medium: "claude/opus-medium", high: "claude/opus-high" },
    };
    expect(projectAntigravitySelectedModels(provider, ["claude-opus-high"], [row]))
      .toEqual(["claude-opus-high", "claude/opus"]);
    const config = configFor(["claude/opus-high"]);
    config.disabledModels = ["google-antigravity/claude-opus-high"];
    expect(antigravityFamilyDisabled(config, row)).toBe(true);
    config.disabledModels = ["google-antigravity/claude-opus"];
    expect(antigravityFamilyDisabled(config, row)).toBe(true);
  });

  test("partial family evidence leaves public rows, selections and inherited disabled state untouched", () => {
    const partial = { ...family, antigravityEffortWireModelIds: { low: tiers[0]!, high: tiers[2]! } };
    const rows = [partial, ...wireRows];
    expect(collapseAntigravityPublicModels(rows)).toEqual(rows);
    expect(projectAntigravitySelectedModels(provider, [tiers[0]!], rows)).toEqual([tiers[0]!]);
    const config = configFor();
    config.disabledModels = tiers.map(id => `${provider}/${id}`);
    expect(antigravityFamilyDisabled(config, partial)).toBe(false);
  });
});

describe("Antigravity effort family reconciliation", () => {
  test("policy off preserves the screenshot's enabled high tier when low and medium are disabled", () => {
    const config = configFor();
    config.disabledModels = ["google-antigravity/claude-opus-5-5-low", "google-antigravity/claude-opus-5-5-medium"];
    expect(reconcileSuccessfulModelDiscoveries({
      config, models: [family], authoritativeProviders: [provider], now,
    })).toBe(true);
    expect(config.modelDiscovery!.knownModels![provider]!.ids).toEqual([base]);
    expect(config.modelDiscovery!.recentArrivals).toBeUndefined();
    expect(config.disabledModels).toEqual([
      "google-antigravity/claude-opus-5-5-low", "google-antigravity/claude-opus-5-5-medium",
    ]);
  });

  test("all prior tiers disabled transfers once and a manual base re-enable survives", () => {
    const config = configFor();
    const suffixDisables = tiers.map(id => `${provider}/${id}`);
    config.disabledModels = [...suffixDisables];
    expect(antigravityFamilyDisabled(config, family)).toBe(true);
    expect(reconcile(config)).toBe(true);
    expect(config.disabledModels).toEqual([...suffixDisables, "google-antigravity/claude-opus-5-5"]);
    expect(reconcile(config)).toBe(false);
    config.disabledModels = [...suffixDisables];
    expect(antigravityFamilyDisabled(config, family)).toBe(false);
    expect(reconcile(config)).toBe(false);
    expect(config.disabledModels).toEqual(suffixDisables);
  });

  test("only known prior tiers participate, and an unknown family cannot inherit disables", () => {
    const config = configFor([tiers[2]!]);
    config.disabledModels = ["google-antigravity/claude-opus-5-5-high"];
    expect(antigravityFamilyDisabled(config, family)).toBe(true);
    expect(reconcile(config)).toBe(true);
    expect(config.disabledModels).toContain("google-antigravity/claude-opus-5-5");
    config.modelDiscovery = {};
    config.disabledModels = tiers.map(id => `${provider}/${id}`);
    expect(antigravityFamilyDisabled(config, family)).toBe(false);
  });

  test("an explicit base disable wins, and either active or removed base history prevents inheritance", () => {
    for (const removed of [false, true]) {
      const config = configFor(tiers);
      config.modelDiscovery!.knownModels![provider]![removed ? "removed" : "ids"].push(base);
      config.disabledModels = tiers.map(id => `${provider}/${id}`);
      expect(antigravityFamilyDisabled(config, family)).toBe(false);
      config.disabledModels.push("google-antigravity/claude-opus-5-5");
      expect(antigravityFamilyDisabled(config, family)).toBe(true);
    }
  });

  test("retained combo targets never return as arrivals and reconciliation is a byte-stable no-op", () => {
    const config = configFor();
    config.providers[provider]!.selectedModels = [tiers[2]!];
    config.providers[provider]!.defaultModel = tiers[0]!;
    config.combos = { pinned: { targets: [{ provider, model: tiers[1]! }] } };
    const untouched = structuredClone({ providers: config.providers, combos: config.combos });
    expect(reconcile(config)).toBe(true);
    expect(config.modelDiscovery!.knownModels![provider]!.ids).toEqual([base]);
    expect(config.modelDiscovery!.recentArrivals).toBeUndefined();
    expect({ providers: config.providers, combos: config.combos }).toEqual(untouched);
    const before = JSON.stringify(config);
    expect(reconcileSuccessfulModelDiscoveries({
      config, models: retainedRows, authoritativeProviders: [provider], now: "2026-10-04T01:00:00Z",
    })).toBe(false);
    expect(JSON.stringify(config)).toBe(before);
  });

  test("active, removed and missing suffix identities all normalize without false arrivals", () => {
    const config = configFor([tiers[0]!, tiers[2]!]);
    config.modelDiscovery!.knownModels![provider]!.removed = [tiers[1]!];
    config.modelDiscovery!.knownModels![provider]!.missing = { [tiers[0]!]: 2, [tiers[2]!]: 1 };
    expect(reconcile(config)).toBe(true);
    expect(config.modelDiscovery!.knownModels![provider]).toEqual({ ids: [base], removed: [base], updatedAt: now });
    expect(config.modelDiscovery!.recentArrivals).toBeUndefined();
    expect(reconcile(config)).toBe(false);
  });

  test("a removed suffix family reappears as known rather than a new off arrival", () => {
    const config = configFor([]);
    config.modelDiscovery!.knownModels![provider]!.removed = [...tiers];
    expect(reconcile(config)).toBe(true);
    expect(config.disabledModels).toBeUndefined();
    expect(config.modelDiscovery!.recentArrivals).toBeUndefined();
    expect(config.modelDiscovery!.knownModels![provider]!.removed).toEqual([base]);
  });

  test("a genuinely new future family obeys policy off exactly once", () => {
    const config = configFor(["older-model"]);
    const rows = [{ provider, id: "older-model" }, ...retainedRows];
    expect(reconcile(config, rows)).toBe(true);
    expect(config.disabledModels).toEqual(["google-antigravity/claude-opus-5-5"]);
    expect(config.modelDiscovery!.recentArrivals![provider]).toEqual([{ id: base, at: now }]);
    expect(reconcile(config, rows)).toBe(false);
  });

  test("an existing raw base disable is not rewritten into an extra encoded record", () => {
    const config = configFor(["claude/opus"]);
    config.disabledModels = ["google-antigravity/claude/opus"];
    const row = {
      provider, id: "claude/opus",
      antigravityEffortWireModelIds: { low: "claude/opus-low", medium: "claude/opus-medium", high: "claude/opus-high" },
    };
    const before = structuredClone(config);
    expect(reconcile(config, [row])).toBe(false);
    expect(config).toEqual(before);
  });

  test("custom evidence and unrelated providers cannot normalize Antigravity's baseline", () => {
    for (const row of [{ ...family, custom: true }, { ...family, catalogKind: "custom-model-v1" }, { ...family, provider: "other" }]) {
      const config = configFor([...tiers].sort());
      const before = structuredClone(config);
      expect(reconcile(config, [row, ...wireRows])).toBe(false);
      expect(config).toEqual(before);
    }
  });

  test("partial evidence leaves existing baseline identities intact", () => {
    const config = configFor([base, ...tiers].sort());
    const partial = { ...family, antigravityEffortWireModelIds: { low: tiers[0]!, high: tiers[2]! } };
    const before = structuredClone(config);
    expect(reconcile(config, [partial, ...wireRows])).toBe(false);
    expect(config).toEqual(before);
  });

  test("degraded and static providers never consume evidence or inherited disables", () => {
    for (const liveModels of [true, false]) {
      const config = configFor();
      config.providers[provider]!.liveModels = liveModels;
      config.disabledModels = tiers.map(id => `${provider}/${id}`);
      const before = structuredClone(config);
      expect(reconcileSuccessfulModelDiscoveries({
        config, models: retainedRows, authoritativeProviders: liveModels ? [] : [provider], now,
      })).toBe(false);
      expect(config).toEqual(before);
    }
  });
});

test("overlapping complete family bases remain public and are not policy aliases", () => {
  const provider = "google-antigravity";
  const rows = ["foo", "foo-low"].map(id => ({ provider, id,
    antigravityEffortWireModelIds: { low: `${id}-low`, medium: `${id}-medium`, high: `${id}-high` } }));
  expect(collapseAntigravityPublicModels(rows).map(row => row.id)).toEqual(["foo", "foo-low"]);
  const config: OcxConfig = { port: 0, defaultProvider: provider, providers: { [provider]: {} },
    modelDiscovery: { knownModels: { [provider]: { ids: ["foo", "foo-low"], removed: [], updatedAt: now } } } };
  expect(reconcileSuccessfulModelDiscoveries({ config, models: rows, authoritativeProviders: [provider], now })).toBe(false);
  expect(config.modelDiscovery!.knownModels![provider]!.ids).toEqual(["foo", "foo-low"]);
});

test("overlapping families project only the original selection in either order", () => {
  const provider = "google-antigravity";
  const rows = ["foo", "foo-low"].map(id => ({ provider, id,
    antigravityEffortWireModelIds: { low: `${id}-low`, medium: `${id}-medium`, high: `${id}-high` } }));
  for (const ordered of [rows, [...rows].reverse()]) {
    expect(projectAntigravitySelectedModels(provider, ["foo-low"], ordered)).toEqual(["foo-low"]);
    expect(projectAntigravitySelectedModels(provider, ["foo-low-high"], ordered)).toEqual(["foo-low-high", "foo-low"]);
    const config: OcxConfig = { port: 0, defaultProvider: provider, providers: { [provider]: {} },
      disabledModels: [`${provider}/foo-low`],
      modelDiscovery: { knownModels: { [provider]: { ids: ["foo-low"], removed: [], updatedAt: now } } } };
    expect(antigravityFamilyDisabled(config, rows[0]!, ordered)).toBe(false);
  }
});
