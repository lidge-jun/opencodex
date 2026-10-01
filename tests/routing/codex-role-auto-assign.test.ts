import { describe, expect, test } from "bun:test";
import {
  buildRoleProposals,
  cheapestSufficientCandidate,
  classifyRoleModelCandidates,
  mapEffortToLevel,
  type RoleModelCandidate,
} from "../../src/codex/role-auto-assign";
import type { RoleSizingOutcome } from "../../src/codex/role-sizing";

const FULL = ["low", "medium", "high", "xhigh"];

function candidate(model: string, unitPrice: number | null, efforts: string[] = FULL, defaultEffort?: string): RoleModelCandidate {
  return { model, unitPrice, efforts, ...(defaultEffort ? { defaultEffort } : {}) };
}

describe("mapEffortToLevel", () => {
  test("binds intents to floor, default, above default and ceiling", () => {
    const ladder = ["xhigh", "low", "high", "medium"];
    expect(mapEffortToLevel("glance", ladder, "medium")).toBe("low");
    expect(mapEffortToLevel("measured", ladder, "medium")).toBe("medium");
    expect(mapEffortToLevel("thorough", ladder, "medium")).toBe("high");
    expect(mapEffortToLevel("exhaustive", ladder, "medium")).toBe("xhigh");
  });

  test("measured falls to the middle rung when the default is absent or off the ladder", () => {
    expect(mapEffortToLevel("measured", FULL)).toBe("medium");
    expect(mapEffortToLevel("measured", ["low", "medium", "high"], "ultra")).toBe("medium");
  });

  test("a ladder with no interior rung collapses thorough and stays inside the range", () => {
    expect(mapEffortToLevel("glance", ["low", "high"])).toBe("low");
    expect(mapEffortToLevel("measured", ["low", "high"])).toBe("low");
    expect(mapEffortToLevel("thorough", ["low", "high"])).toBe("high");
    expect(mapEffortToLevel("exhaustive", ["low", "high"])).toBe("high");
    expect(mapEffortToLevel("thorough", ["low", "medium", "high"], "high")).toBe("high");
    for (const intent of ["glance", "measured", "thorough", "exhaustive"] as const) {
      expect(mapEffortToLevel(intent, ["medium"])).toBe("medium");
    }
  });

  test("a model without reasoning levels gets no effort", () => {
    expect(mapEffortToLevel("thorough", [])).toBeNull();
    expect(mapEffortToLevel("thorough", ["turbo"])).toBeNull();
  });
});

describe("classifyRoleModelCandidates", () => {
  test("splits priced models across tiers by price rank and leaves unpriced ones out", () => {
    const classified = classifyRoleModelCandidates([
      candidate("big", 30), candidate("small", 1), candidate("mid", 5), candidate("mystery", null),
    ]);
    expect(classified.map(c => [c.model, c.tier, c.tierSource])).toEqual([
      ["big", "frontier", "price"], ["small", "fast", "price"], ["mid", "standard", "price"], ["mystery", null, null],
    ]);
  });

  test("a single priced model is frontier and a user mapping wins over price", () => {
    expect(classifyRoleModelCandidates([candidate("only", 3)])[0]!.tier).toBe("frontier");
    const classified = classifyRoleModelCandidates(
      [candidate("cheap", 1), candidate("dear", 9), candidate("local", null)],
      { fast: ["local"], frontier: ["cheap"] },
    );
    expect(classified.map(c => [c.model, c.tier, c.tierSource])).toEqual([
      ["cheap", "frontier", "mapping"], ["dear", "frontier", "price"], ["local", "fast", "mapping"],
    ]);
  });

  test("two priced models take the top two tiers, so a standard role gets the cheaper one", () => {
    const classified = classifyRoleModelCandidates([candidate("dear", 9), candidate("cheap", 1)]);
    expect(classified.map(c => [c.model, c.tier])).toEqual([["dear", "frontier"], ["cheap", "standard"]]);
    expect(cheapestSufficientCandidate(classified, "fast")!.model).toBe("cheap");
    expect(cheapestSufficientCandidate(classified, "standard")!.model).toBe("cheap");
    expect(cheapestSufficientCandidate(classified, "frontier")!.model).toBe("dear");
  });
});

describe("cheapestSufficientCandidate", () => {
  const classified = classifyRoleModelCandidates([
    candidate("p20", 20), candidate("p1", 1), candidate("p4", 4), candidate("p05", 0.5),
  ]);

  test("prefers the lowest sufficient tier, then the lowest price", () => {
    expect(classified.map(c => c.tier)).toEqual(["frontier", "standard", "standard", "fast"]);
    expect(cheapestSufficientCandidate(classified, "fast")!.model).toBe("p05");
    expect(cheapestSufficientCandidate(classified, "standard")!.model).toBe("p1");
    expect(cheapestSufficientCandidate(classified, "frontier")!.model).toBe("p20");
  });

  test("steps up a tier when the requested one is empty and returns null when none reach it", () => {
    const noStandard = classifyRoleModelCandidates(
      [candidate("fast", null), candidate("top", null)],
      { fast: ["fast"], frontier: ["top"] },
    );
    expect(cheapestSufficientCandidate(noStandard, "standard")!.model).toBe("top");
    const onlyFast = classifyRoleModelCandidates([candidate("local", null)], { fast: ["local"] });
    expect(cheapestSufficientCandidate(onlyFast, "standard")).toBeNull();
  });
});

describe("buildRoleProposals", () => {
  const sized = (tier: "fast" | "frontier", effort: "glance" | "exhaustive"): RoleSizingOutcome => ({
    sizing: { tier, effort, rationale: "r", moveUpIf: "u", moveDownIf: "d" },
  });

  test("proposes effort only for roles whose file already sets one, and keeps unsized reasons", () => {
    const classified = classifyRoleModelCandidates([candidate("cheap", 1, FULL, "medium"), candidate("dear", 9)]);
    const proposals = buildRoleProposals(
      [
        { role: "explorer", model: "dear", effort: "high" },
        { role: "worker", model: null, effort: null },
        { role: "vague", model: null, effort: null },
      ],
      new Map([["explorer", sized("fast", "glance")], ["worker", sized("frontier", "exhaustive")], ["vague", { unsized: "no JSON" }]]),
      classified,
    );
    expect(proposals[0]).toMatchObject({ status: "proposed", proposedModel: "cheap", proposedEffort: "low", tier: "fast" });
    expect(proposals[1]).toMatchObject({ status: "proposed", proposedModel: "dear", proposedEffort: null });
    expect(proposals[2]).toEqual({ role: "vague", model: null, effort: null, status: "unsized", reason: "no JSON" });
  });

  test("reports a role no candidate can serve as unassigned", () => {
    const [proposal] = buildRoleProposals(
      [{ role: "architect", model: null, effort: null }],
      new Map([["architect", sized("frontier", "exhaustive")]]),
      classifyRoleModelCandidates([candidate("local", null)], { fast: ["local"] }),
    );
    expect(proposal).toMatchObject({ status: "unassigned", proposedModel: null, reason: "no available model is classified frontier or above" });
  });
});
