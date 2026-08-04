import { expect, test } from "bun:test";
import { grokGroupView, type GrokCandidate } from "../src/pages/grok-groups";

const CANDIDATES: GrokCandidate[] = [
  { id: "gpt-5.6-sol", contextWindow: 372_000, native: true },
  { id: "gpt-5.5", contextWindow: 272_000, native: true },
  { id: "cursor/grok-4.5", contextWindow: 500_000, native: false },
  { id: "kimi/k3[1m]", contextWindow: 1_048_576, native: false },
];

const ALIASES = new Map([
  ["gpt-5.6-sol", "ocx-gpt-5-6-sol"],
  ["cursor/grok-4.5", "ocx-cursor-grok-4-5"],
]);

test("groups partition native from routed", () => {
  const native = grokGroupView(CANDIDATES, ALIASES, new Set(), "native");
  expect(native.total).toBe(2);
  expect(native.rows.map(r => r.id)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
  const routed = grokGroupView(CANDIDATES, ALIASES, new Set(), "routed");
  expect(routed.total).toBe(2);
});

test("enabled count reflects the exclusion set", () => {
  const view = grokGroupView(CANDIDATES, ALIASES, new Set(["gpt-5.5"]), "native");
  expect(view.enabled).toBe(1);
  expect(view.total).toBe(2);
});

test("registered models sort first, stably", () => {
  const view = grokGroupView(CANDIDATES, ALIASES, new Set(["gpt-5.6-sol"]), "native");
  expect(view.rows.map(r => r.id)).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  expect(view.rows[0]!.enabled).toBe(true);
  expect(view.rows[1]!.enabled).toBe(false);
});

// A switched-off or not-yet-applied model has no alias: the page must show "—" from a
// null, never a computed guess. Aliases are the writer's output only.
test("a model not in the fence has a null alias", () => {
  const view = grokGroupView(CANDIDATES, ALIASES, new Set(), "routed");
  const kimi = view.rows.find(r => r.id === "kimi/k3[1m]");
  const cursor = view.rows.find(r => r.id === "cursor/grok-4.5");
  expect(kimi!.alias).toBeNull();
  expect(cursor!.alias).toBe("ocx-cursor-grok-4-5");
});
