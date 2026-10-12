import { describe, expect, test } from "bun:test";
import { buildInitProviders } from "../../src/cli/init";
import { deriveProviderPresets } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { pinSponsorRows, pinSponsorsWithinKind } from "../../src/providers/sponsor-order";

/**
 * The registry `sponsor` field is the only thing that marks a paid sponsor, and SPONSORS.md
 * promises it changes nothing but picker placement and a label. These pin the wire shape the
 * dashboard and `ocx provider presets` read, and that every sponsor entry carries a landing URL.
 */
describe("sponsor presets", () => {
  test("registry sponsor entries surface tier and URL on the derived preset", () => {
    const sponsors = PROVIDER_REGISTRY.filter(entry => entry.sponsor);
    const presets = deriveProviderPresets();
    for (const entry of sponsors) {
      const preset = presets.find(p => p.id === entry.id);
      expect(preset, entry.id).toBeDefined();
      expect(preset?.sponsor).toBe(entry.sponsor!.tier);
      expect(preset?.sponsorUrl).toBe(entry.sponsor!.url);
      expect(entry.sponsor!.url.startsWith("https://")).toBe(true);
    }
  });

  test("non-sponsor presets carry no sponsor keys at all", () => {
    const sponsorIds = new Set(PROVIDER_REGISTRY.filter(entry => entry.sponsor).map(entry => entry.id));
    for (const preset of deriveProviderPresets()) {
      if (sponsorIds.has(preset.id)) continue;
      expect("sponsor" in preset, preset.id).toBe(false);
      expect("sponsorUrl" in preset, preset.id).toBe(false);
    }
  });

  test("derived preset order is registry order — pinning is the picker's job", () => {
    const ids = deriveProviderPresets().map(p => p.id).filter(id => id !== "custom");
    const registryOrder = PROVIDER_REGISTRY.map(e => e.id).filter(id => ids.includes(id));
    const seen = new Set<string>();
    const deduped = registryOrder.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
    expect(ids).toEqual(deduped);
  });

  test("ocx init moves sponsors to the start of the first run of their kind, alphabetical by label", () => {
    const rows = pinSponsorsWithinKind(buildInitProviders());
    const sponsorIds = PROVIDER_REGISTRY.filter(entry => entry.sponsor).map(entry => entry.id);
    expect(sponsorIds.length).toBeGreaterThan(0);
    const firstKey = rows.findIndex(row => row.kind === "key");
    const leading = rows.slice(firstKey, firstKey + sponsorIds.length);
    expect(leading.map(row => row.id).sort()).toEqual([...sponsorIds].sort());
    const labels = leading.map(row => row.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    // Same rows; non-sponsor rows keep their order, so the heading sequence is unchanged.
    expect(rows.map(row => row.id).sort()).toEqual(buildInitProviders().map(row => row.id).sort());
    const rest = (list: { id: string }[]) => list.map(row => row.id).filter(id => !sponsorIds.includes(id));
    expect(rest(rows)).toEqual(rest(buildInitProviders()));
    const kinds = (list: { kind: string }[]) => list.map(row => row.kind).filter((kind, i, all) => kind !== all[i - 1]);
    expect(kinds(rows)).toEqual(kinds(buildInitProviders()));
  });

  test("pinSponsorRows orders Main before Standard and keeps the rest in caller order", () => {
    const rows = [
      { id: "a", label: "Zed" }, { id: "b", label: "beta", tier: "standard" as const },
      { id: "c", label: "Mid" }, { id: "d", label: "Alpha", tier: "standard" as const },
      { id: "e", label: "Omega", tier: "main" as const },
    ];
    const pinned = pinSponsorRows(rows, row => row.tier, row => row.label).map(row => row.id);
    expect(pinned).toEqual(["e", "d", "b", "a", "c"]);
  });

  test("a run that opens with a sponsor keeps its place in the kind sequence", () => {
    type Row = { id: string; label: string; kind: string; tier?: "main" | "standard" };
    const rows: Row[] = [
      { id: "s1", label: "Sponsor B", kind: "key", tier: "standard" },
      { id: "o1", label: "OAuth", kind: "oauth" },
      { id: "k1", label: "Key", kind: "key" },
      { id: "s2", label: "Sponsor A", kind: "key", tier: "standard" },
      { id: "s3", label: "Only", kind: "local", tier: "main" },
    ];
    const pinned = pinSponsorsWithinKind(rows, row => row.tier).map(row => row.id);
    expect(pinned).toEqual(["s2", "s1", "o1", "k1", "s3"]);
  });
});
