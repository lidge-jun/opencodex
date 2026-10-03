import { describe, expect, test } from "bun:test";
import {
  draftEquals,
  jevDecisionSummary,
  jevEffectiveFallbackLevel,
  jevLevelCandidateLabel,
  jevStaleLevelCandidates,
  parseComboList,
  toPutBody,
} from "../../gui/src/combo-workspace-data";

const row = {
  id: "tev-auto",
  strategy: "jev",
  decisionProvider: "tev-local",
  decisionMode: "level",
  decisionFallbackLevel: "hard",
  decisionLevels: {
    hard: { candidates: [{ provider: "openai", model: "gpt-6-astra", effort: "xhigh" }, { provider: "cursor", model: "claude-sonnet-5-5" }] },
    trivial: { description: "Tiny.", candidates: [{ provider: "openai", model: "gpt-6-luna", effort: "low" }, "junk", { provider: 1 }] },
    expert: { candidates: [{ provider: "openai", model: "gpt-6-astra" }] },
  },
  targets: [{ provider: "openai", model: "gpt-6-astra" }],
};

describe("dashboard level-mode data", () => {
  test("within-level route is sparse, dirty, summarized, and explicitly cleared on PUT", () => {
    const [plain] = parseComboList({ combos: [row] });
    const [routed] = parseComboList({ combos: [{ ...row, decisionLevelSelect: "route" }] });
    expect(plain).not.toHaveProperty("decisionLevelSelect");
    expect(routed!.decisionLevelSelect).toBe("route");
    expect(draftEquals(plain!, routed!)).toBeFalse();
    expect(toPutBody(routed!).combo.decisionLevelSelect).toBe("route");
    expect(toPutBody(plain!).combo.decisionLevelSelect).toBeNull();
    expect(toPutBody({ ...routed!, decisionMode: undefined }).combo.decisionLevelSelect).toBeNull();
    expect(jevDecisionSummary(routed!, [])?.levelSelect).toBe("route");
  });
  test("parses level mode, levels in canonical order, and the fallback level read-only", () => {
    const [item] = parseComboList({ combos: [row] });
    expect(item!.decisionMode).toBe("level");
    expect(item!.decisionFallbackLevel).toBe("hard");
    expect(item!.decisionLevels).toEqual([
      { id: "trivial", description: "Tiny.", candidates: [{ provider: "openai", model: "gpt-6-luna", effort: "low" }] },
      { id: "hard", candidates: [{ provider: "openai", model: "gpt-6-astra", effort: "xhigh" }, { provider: "cursor", model: "claude-sonnet-5-5" }] },
    ]);
    expect(item!.decisionLevels!.map(level => level.candidates.map(jevLevelCandidateLabel))).toEqual([
      ["openai/gpt-6-luna:low"],
      ["openai/gpt-6-astra:xhigh", "cursor/claude-sonnet-5-5"],
    ]);
    const [plain] = parseComboList({ combos: [{ ...row, decisionMode: "route", decisionLevels: [], decisionFallbackLevel: "expert" }] });
    for (const field of ["decisionMode", "decisionLevels", "decisionFallbackLevel"]) expect(plain).not.toHaveProperty(field);
    expect(jevEffectiveFallbackLevel(plain!)).toBe("routine");
    expect(jevEffectiveFallbackLevel(item!)).toBe("hard");
  });

  test("the PUT body carries only the mode, never the levels, so the server keeps them", () => {
    const [item] = parseComboList({ combos: [row] });
    const level = toPutBody(item!).combo;
    expect(level.decisionMode).toBe("level");
    expect(level).not.toHaveProperty("decisionLevels");
    expect(level).not.toHaveProperty("decisionFallbackLevel");
    expect(toPutBody({ ...item!, decisionMode: undefined }).combo.decisionMode).toBeNull();
    expect(toPutBody({ ...item!, strategy: "failover" }).combo).not.toHaveProperty("decisionMode");
  });

  test("a mode switch makes the draft dirty and shows in the summary", () => {
    const [item] = parseComboList({ combos: [row] });
    expect(draftEquals(item!, { ...item! })).toBeTrue();
    expect(draftEquals(item!, { ...item!, decisionMode: undefined })).toBeFalse();
    expect(jevDecisionSummary(item!, [])?.mode).toBe("level");
    expect(jevDecisionSummary({ ...item!, decisionMode: undefined }, [])?.mode).toBe("route");
  });

  test("flags level candidates whose target or effort the draft no longer has", () => {
    const [item] = parseComboList({ combos: [row] });
    // `cursor/claude-sonnet-5-5` and `openai/gpt-6-luna:low` are not targets of this row.
    expect(jevStaleLevelCandidates(item!)).toEqual(["openai/gpt-6-luna:low", "cursor/claude-sonnet-5-5"]);
    const complete = {
      ...item!,
      targets: [
        { provider: "openai", model: "gpt-6-astra", reasoningEfforts: ["xhigh" as const] },
        { provider: "openai", model: "gpt-6-luna" },
        { provider: "cursor", model: "claude-sonnet-5-5" },
      ],
    };
    expect(jevStaleLevelCandidates(complete)).toEqual([]);
    const effortGone = { ...complete, targets: [{ ...complete.targets[0]!, reasoningEfforts: ["low" as const] }, ...complete.targets.slice(1)] };
    expect(jevStaleLevelCandidates(effortGone)).toEqual(["openai/gpt-6-astra:xhigh"]);
    expect(jevStaleLevelCandidates({ ...item!, strategy: "failover" })).toEqual([]);
    expect(jevStaleLevelCandidates({ ...item!, clearDecisionLevels: true })).toEqual([]);
  });

  test("an explicit clear sends null levels and fallback, only in route mode", () => {
    const [item] = parseComboList({ combos: [row] });
    const cleared = { ...item!, decisionMode: undefined, decisionLevels: undefined, clearDecisionLevels: true as const };
    expect(toPutBody(cleared).combo).toMatchObject({ decisionMode: null, decisionLevels: null, decisionFallbackLevel: null });
    expect(toPutBody({ ...item!, clearDecisionLevels: true }).combo).not.toHaveProperty("decisionLevels");
    expect(draftEquals(item!, { ...item!, clearDecisionLevels: true })).toBeFalse();
  });
});
