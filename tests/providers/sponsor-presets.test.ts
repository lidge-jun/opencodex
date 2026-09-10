import { describe, expect, test } from "bun:test";
import { deriveProviderPresets } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

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
});
