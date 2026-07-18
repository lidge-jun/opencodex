import { describe, expect, test } from "bun:test";
import {
  buildComboAttention,
  filterCombos,
  groupCombos,
  isValidComboId,
  parseComboList,
  toPutBody,
  validateComboDraft,
} from "../gui/src/combo-workspace-data";

describe("combo-workspace-data", () => {
  test("parseComboList normalizes strategy and targets", () => {
    const items = parseComboList({
      combos: [{
        id: "free",
        model: "combo/free",
        strategy: "failover",
        stickyLimit: 1,
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2", weight: 2 },
        ],
      }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.model).toBe("combo/free");
    expect(items[0]!.targets[1]!.weight).toBe(2);
  });

  test("group and filter", () => {
    const items = parseComboList({
      combos: [
        { id: "a", strategy: "failover", targets: [{ provider: "p", model: "m" }] },
        { id: "b", strategy: "round-robin", stickyLimit: 3, targets: [{ provider: "q", model: "n" }] },
      ],
    });
    const g = groupCombos(items);
    expect(g.failover.map((x) => x.id)).toEqual(["a"]);
    expect(g.roundRobin.map((x) => x.id)).toEqual(["b"]);
    expect(filterCombos(items, "combo/b").map((x) => x.id)).toEqual(["b"]);
    expect(filterCombos(items, "q").map((x) => x.id)).toEqual(["b"]);
  });

  test("attention flags thin chains", () => {
    const items = parseComboList({
      combos: [
        { id: "thin", targets: [{ provider: "p", model: "m" }] },
        { id: "ok", targets: [{ provider: "p", model: "m" }, { provider: "q", model: "n" }] },
      ],
    });
    expect(buildComboAttention(items).map((x) => x.id)).toEqual(["thin"]);
  });

  test("validate and put body", () => {
    expect(isValidComboId("free")).toBe(true);
    expect(isValidComboId("-bad")).toBe(false);
    const draft = {
      id: "free",
      model: "combo/free",
      strategy: "round-robin" as const,
      stickyLimit: 2,
      defaultEffort: "medium" as const,
      targets: [
        { provider: "a", model: "m1", weight: 3 },
        { provider: "b", model: "m2" },
      ],
    };
    expect(validateComboDraft(draft, [], true)).toBeNull();
    expect(validateComboDraft({ ...draft, id: "" }, [], true)).toBe("missingId");
    const body = toPutBody(draft);
    expect(body.combo.strategy).toBe("round-robin");
    expect(body.combo.stickyLimit).toBe(2);
    expect(body.combo.defaultEffort).toBe("medium");
    expect(body.combo.targets[0]!.weight).toBe(3);
  });
});
