import { describe, expect, test } from "bun:test";
import { cheapestSufficientCandidate, classifyRoleModelCandidates, type RoleModelCandidate } from "../../src/codex/role-auto-assign";

const candidate = (model: string, unitPrice: number | null): RoleModelCandidate => ({ model, unitPrice, efforts: [] });

describe("measured role tiers", () => {
  test("equal scores share a tier regardless of provider order", () => {
    const pool = [candidate("native/model-a", 1), candidate("routed/model-a", 5), candidate("model-b", 9)];
    const scores = new Map([["native/model-a", 1500], ["routed/model-a", 1500], ["model-b", 1550]]);
    for (const candidates of [pool, [...pool].reverse()]) {
      const classified = classifyRoleModelCandidates(candidates, {}, scores);
      expect(classified.find(row => row.model === "native/model-a")?.tier).toBe("standard");
      expect(classified.find(row => row.model === "routed/model-a")?.tier).toBe("standard");
      expect(classified.find(row => row.model === "model-b")?.tier).toBe("frontier");
      expect(cheapestSufficientCandidate(classified, "standard")?.model).toBe("native/model-a");
    }
  });

  test("all equal measured scores share the top-anchored tier", () => {
    const classified = classifyRoleModelCandidates([candidate("a", 1), candidate("b", 2)], {}, new Map([["a", 50], ["b", 50]]));
    expect(classified.map(row => [row.tier, row.tierSource])).toEqual([["frontier", "measured"], ["frontier", "measured"]]);
  });

  test("one measured candidate still falls back to price and explicit mappings still win", () => {
    const classified = classifyRoleModelCandidates(
      [candidate("a", 1), candidate("b", 9), candidate("mapped", null)],
      { fast: ["mapped"] }, new Map([["a", 50], ["mapped", 100]]),
    );
    expect(classified.map(row => [row.tier, row.tierSource])).toEqual([
      ["standard", "price"], ["frontier", "price"], ["fast", "mapping"],
    ]);
  });

  test("measured tiering can propose unpriced models but price tiering cannot", () => {
    const pool = [candidate("a", null), candidate("b", null)];
    const measured = classifyRoleModelCandidates(pool, {}, new Map([["a", 50], ["b", 100]]));
    expect(cheapestSufficientCandidate(measured, "standard")?.model).toBe("a");
    expect(cheapestSufficientCandidate(measured, "frontier")?.model).toBe("b");
    expect(cheapestSufficientCandidate(classifyRoleModelCandidates(pool), "fast")).toBeNull();
  });
});
