import { expect, test } from "bun:test";
import { deriveComboCatalogModel } from "../../src/codex/catalog/aggregation";
import { buildCatalogEntries } from "../../src/codex/catalog/build-entries";
import { upstreamNativeEntry } from "../../src/codex/catalog/metadata";
import type { CatalogModel } from "../../src/codex/catalog/parsing";
import { normalizeComboConfig } from "../../src/combos";

const members: CatalogModel[] = [
  { provider: "a", id: "m1", contextWindow: 200_000, reasoningEfforts: ["low", "medium", "high"] },
  { provider: "b", id: "m2", contextWindow: 128_000, reasoningEfforts: ["low", "medium"] },
];

for (const [mode, efforts, defaultEffort] of [
  [undefined, [], undefined],
  ["decide", [], undefined],
  ["client", ["low", "medium"], "medium"],
] as const) {
  test(`JEV catalog publishes the expected effort controls in ${mode ?? "default"} mode`, () => {
    const combo = normalizeComboConfig({
      targets: members.map(({ provider, id }) => ({ provider, model: id })),
      strategy: "jev",
      ...(mode === undefined ? {} : { jevEffortMode: mode }),
      defaultEffort: "medium",
    });
    const model = deriveComboCatalogModel("jev-picker", combo, members);
    expect(model?.reasoningEfforts).toEqual(efforts);
    expect(model?.defaultReasoningEffort).toBe(defaultEffort);

    const slug = "combo/jev-picker";
    const template = upstreamNativeEntry("gpt-5.6-sol");
    expect(template).toBeTruthy();
    for (const base of [template!, null]) {
      const row = buildCatalogEntries(base, [], [model!], undefined, false, "default", new Set([slug]))
        .find(entry => entry.slug === slug);
      const levels = row?.supported_reasoning_levels as { effort: string }[] | undefined;
      expect(levels?.map(level => level.effort)).toEqual(efforts);
      if (defaultEffort === undefined) {
        expect(row).not.toHaveProperty("default_reasoning_level");
      } else {
        expect(row?.default_reasoning_level).toBe(defaultEffort);
      }
    }
  });
}
