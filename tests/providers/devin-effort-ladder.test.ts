import { describe, expect, test } from "bun:test";
import {
  DEVIN_DEFAULT_EFFORTS,
  DEVIN_MODEL_EFFORTS,
  collapseDevinModelUid,
  devinReasoningRungsOf,
  sortDevinRungs,
} from "../../src/adapters/devin/live-models";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";

const devinRow = () => PROVIDER_REGISTRY.find(row => row.id === "devin")!;

describe("devin reasoning rungs come from the catalog suffixes", () => {
  // Cognition spells effort as a model-id suffix, so the variants an account has
  // ARE its ladder. The collapse used to strip that evidence and drop it.
  test.each([
    ["swe-2-high", "swe-2", ["high"]],
    ["gpt-5-6-sol-medium", "gpt-5-6-sol", ["medium"]],
    ["gpt-5-6-sol-medium-priority", "gpt-5-6-sol", ["medium"]],
    ["swe-2", "swe-2", []],
  ])("%p collapses to %p with rungs %p", (uid, base, rungs) => {
    expect(collapseDevinModelUid(uid)).toBe(base);
    expect(devinReasoningRungsOf(uid)).toEqual(rungs);
  });

  // `fast`, `priority` and `1m` are tiers and context variants. Offering them on a
  // reasoning control would name a setting that does something else.
  test.each(["gpt-5-6-sol-priority", "swe-2-fast", "kimi-k3-1m"])(
    "%p contributes no reasoning rung",
    (uid) => {
      expect(devinReasoningRungsOf(uid)).toEqual([]);
    },
  );

  test("rungs sort into ladder order, not discovery order", () => {
    expect(sortDevinRungs(["max", "low", "high", "medium"])).toEqual(["low", "medium", "high", "max"]);
    expect(sortDevinRungs(["high", "high"])).toEqual(["high"]);
  });
});

describe("devin advertises a ladder instead of inheriting the generic one", () => {
  test("the provider row carries both fields", () => {
    // modelReasoningEfforts drives the Codex picker; reasoningEfforts is what the
    // Pi-shaped client exports read. Without them the row inherited the routed
    // six-rung default and Pi drew no control at all.
    const row = devinRow();
    expect(row.modelReasoningEfforts).toBeDefined();
    expect(row.reasoningEfforts).toBeDefined();
    expect(row.reasoningEfforts!.length).toBeGreaterThan(1);
  });

  test("SWE-2 advertises only the lanes it actually runs", () => {
    // src/adapters/devin.ts SWE2_EFFORT maps every caller effort onto exactly
    // these three. Advertising low or xhigh would offer a control that silently
    // rounds to one of them.
    expect(DEVIN_MODEL_EFFORTS["swe-2"]).toEqual(["medium", "high", "max"]);
  });

  test("the fallback ladder omits ultra, which Cognition has no lane for", () => {
    expect(DEVIN_DEFAULT_EFFORTS).not.toContain("ultra");
    expect(DEVIN_DEFAULT_EFFORTS).toContain("medium");
  });

  test("every static ladder is a subset of the fallback vocabulary", () => {
    // A drift guard: a table entry naming a rung the provider vocabulary does not
    // have would advertise a control the adapter cannot honour.
    const vocabulary = new Set([...DEVIN_DEFAULT_EFFORTS, "none"]);
    for (const [model, ladder] of Object.entries(DEVIN_MODEL_EFFORTS)) {
      for (const rung of ladder) {
        expect({ model, rung, known: vocabulary.has(rung) }).toMatchObject({ known: true });
      }
    }
  });
});
