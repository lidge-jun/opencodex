import { expect, test } from "bun:test";
import { applyFullModelPickerOrder, deriveEntry, mergeCatalogEntriesForSync, SPAWN_PRIORITY_FIELD } from "../../src/codex/catalog/sync";

test("native-first picker order preserves Go subagent ranks and is repeatable", () => {
  const rows: any[] = [
    { slug: "opencode-go/glm-5.3", priority: 0 },
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "gpt-6-astra", priority: 9 },
  ];
  const order = ["gpt-6-astra", "gpt-5.6-sol", "opencode-go/glm-5.3"];
  applyFullModelPickerOrder(rows, order);
  expect([...rows].sort((a,b) => a.priority-b.priority).map(r => r.slug)).toEqual(order);
  expect(rows.map(r => r[SPAWN_PRIORITY_FIELD])).toEqual([0,9,9]);
  const once = structuredClone(rows);
  applyFullModelPickerOrder(rows, order);
  expect(rows).toEqual(once);
});

test("existing routed-only ordering retains its behavior", () => {
  const rows: any[] = [{ slug: "opencode-go/glm-5.3", priority: 1000 }];
  applyFullModelPickerOrder(rows, ["opencode-go/glm-5.3"]);
  expect(rows).toEqual([{ slug: "opencode-go/glm-5.3", priority: 1000 }]);
});


test("sync refreshes native spawn rank when featured models change", () => {
  const sol = deriveEntry(null, "gpt-5.6-sol", "Sol", 105);
  const order = ["gpt-5.6-sol"];
  applyFullModelPickerOrder([sol], order);
  expect(sol[SPAWN_PRIORITY_FIELD]).toBe(105);

  const baseline = new Map([["gpt-5.6-sol", 9]]);
  const promoted = mergeCatalogEntriesForSync([sol], [], baseline, ["gpt-5.6-sol"], false);
  applyFullModelPickerOrder(promoted, order);
  expect(promoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(0);

  const demoted = mergeCatalogEntriesForSync(promoted, [], baseline, ["opencode-go/glm-5.3"], false);
  applyFullModelPickerOrder(demoted, order);
  expect(demoted.find(entry => entry.slug === sol.slug)?.[SPAWN_PRIORITY_FIELD]).toBe(101);
});


test("bare native ids and routed slugs match exactly, without suffix aliases", () => {
  const rows: any[] = [
    { slug: "openai/gpt-5.6-sol", priority: 2 },
    { slug: "gpt-5.6-sol", priority: 9 },
    { slug: "other/gpt-5.6-sol", priority: 3 },
  ];
  applyFullModelPickerOrder(rows, ["gpt-5.6-sol", "openai/gpt-5.6-sol"]);
  expect(rows.map(row => row.priority)).toEqual([1, 0, 5]);
  expect(rows.map(row => row[SPAWN_PRIORITY_FIELD])).toEqual([2, 9, 3]);
});
