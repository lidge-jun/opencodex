import { expect, test } from "bun:test";
import { deriveEntry, mergeCatalogEntriesForSync } from "../../src/codex/catalog/sync";

for (const template of [null, { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "ultra" }] }]) {
  test(`Go preserves exact configured efforts (${template ? "template" : "fallback"})`, () => {
    for (const [id, efforts] of [
      ["glm-5.3", ["high", "max"]],
      ["glm-5.3-flash", ["high", "max"]],
      ["omen-alpha", ["high", "max"]],
      ["deepseek-v4-flash-vision-exp", ["high", "max"]],
      ["muse-spark-1.3-contributor", ["high", "xhigh"]],
    ] as const) {
      const entry = deriveEntry(template, `opencode-go/${id}`, "Go", 1, {
        provider: "opencode-go", id, reasoningEfforts: [...efforts], defaultReasoningEffort: efforts[1],
      });
      expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual([...efforts]);
      expect(entry.default_reasoning_level).toBe(efforts[1]);
    }
  });
}

test("other providers retain their existing virtual tiers", () => {
  const entry = deriveEntry(null, "other/model", "Other", 1, {
    provider: "other", id: "model", reasoningEfforts: ["high"],
  });
  expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["high", "max", "ultra"]);
});

test("sync does not reintroduce max for Muse", () => {
  const muse = deriveEntry(null, "opencode-go/muse-spark-1.3-contributor", "Muse", 1, {
    provider: "opencode-go", id: "muse-spark-1.3-contributor",
    reasoningEfforts: ["high", "xhigh"], defaultReasoningEffort: "xhigh",
  });
  for (const [disk, fresh] of [[[muse], []], [[], [muse]]]) {
    const entries = mergeCatalogEntriesForSync(disk, fresh, new Map(), [], false);
    const entry = entries.find(e => e.slug === muse.slug)!;
    expect(entry.supported_reasoning_levels.map((level: { effort: string }) => level.effort)).toEqual(["high", "xhigh"]);
  }
});
