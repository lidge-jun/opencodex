import { describe, expect, test } from "bun:test";
import { comboCatalogOmissionReason, deriveComboCatalogModel } from "../../src/codex/catalog";
import { comboContextWindowPolicy, normalizeComboContextWindowPolicy, unionEfforts } from "../../src/combos/capability-policy";
import { normalizeComboConfig, type NormalizedComboConfig } from "../../src/combos/types";
import { clampAutoCompactTokenLimit } from "../../src/providers/auto-compact-budget";

const imageMember = {
  provider: "a",
  id: "m1",
  contextWindow: 200_000,
  maxInputTokens: 180_000,
  maxOutputTokens: 64_000,
  inputModalities: ["text", "image"],
  reasoningEfforts: ["low", "medium", "high"],
};
const textMember = {
  provider: "b",
  id: "m2",
  contextWindow: 128_000,
  maxInputTokens: 100_000,
  maxOutputTokens: 32_000,
  inputModalities: ["text"],
  reasoningEfforts: ["medium", "high", "xhigh", "max"],
};

function combo(overrides: Record<string, unknown> = {}): NormalizedComboConfig {
  return normalizeComboConfig({
    targets: [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
    defaultEffort: "medium",
    ...overrides,
  });
}

describe("combo capabilityPolicy: catalog", () => {
  test("defaults to intersection and keeps today's row", () => {
    const normalized = combo();
    expect(normalized).not.toHaveProperty("capabilityPolicy");
    expect(normalized).not.toHaveProperty("onUnservable");
    const row = deriveComboCatalogModel("x", normalized, [imageMember, textMember]);
    expect(row?.inputModalities).toEqual(["text"]);
    expect(row?.reasoningEfforts).toEqual(["medium", "high"]);
  });

  test("union advertises image when any member serves it", () => {
    const row = deriveComboCatalogModel("x", combo({ capabilityPolicy: "union" }), [imageMember, textMember]);
    expect(row?.inputModalities).toEqual(["text", "image"]);
  });

  test("union omits video until dispatch can verify the wire, even with unanimous declarations", () => {
    const video = { ...imageMember, inputModalities: ["text", "image", "video"] };
    const policy = combo({ capabilityPolicy: "union" });
    expect(deriveComboCatalogModel("x", policy, [video, textMember])?.inputModalities).toEqual(["text", "image"]);
    const secondVideo = { ...textMember, inputModalities: ["text", "video"] };
    expect(deriveComboCatalogModel("x", policy, [video, secondVideo])?.inputModalities).toEqual(["text", "image"]);
    expect(deriveComboCatalogModel("x", combo(), [video, secondVideo])?.inputModalities).toContain("video");
  });

  test("union does not omit a combo whose modalities do not intersect", () => {
    const imageOnly = { ...imageMember, inputModalities: ["image"] };
    expect(comboCatalogOmissionReason(combo(), [imageOnly, textMember])).toBe("incompatible_modalities");
    expect(comboCatalogOmissionReason(combo({ capabilityPolicy: "union" }), [imageOnly, textMember])).toBeNull();
  });

  test("imageInput disabled still removes image under union", () => {
    const row = deriveComboCatalogModel("x", combo({ capabilityPolicy: "union", imageInput: "disabled" }), [imageMember, textMember]);
    expect(row?.inputModalities).toEqual(["text"]);
  });

  test("union + adaptive advertises the rank-ordered union of effort ladders", () => {
    const row = deriveComboCatalogModel(
      "x",
      combo({ capabilityPolicy: "union", reasoningEffortMode: "adaptive" }),
      [imageMember, textMember],
    );
    expect(row?.reasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(row?.defaultReasoningEffort).toBe("medium");
  });

  test("adaptive without union keeps the intersection", () => {
    const row = deriveComboCatalogModel("x", combo({ reasoningEffortMode: "adaptive" }), [imageMember, textMember]);
    expect(row?.reasoningEfforts).toEqual(["medium", "high"]);
  });

  test("union + strict still intersects efforts, because strict promises every member serves the rung as is", () => {
    const row = deriveComboCatalogModel("x", combo({ capabilityPolicy: "union" }), [imageMember, textMember]);
    expect(row?.reasoningEfforts).toEqual(["medium", "high"]);
  });

  test("union + adaptive drops empty ladders before the union", () => {
    const row = deriveComboCatalogModel(
      "x",
      combo({ capabilityPolicy: "union", reasoningEffortMode: "adaptive" }),
      [imageMember, { ...textMember, reasoningEfforts: [] }],
    );
    expect(row?.reasoningEfforts).toEqual(["low", "medium", "high"]);
  });

  test("union advertises the minimum window and bounded token limits", () => {
    const row = deriveComboCatalogModel("x", combo({ capabilityPolicy: "union" }), [imageMember, textMember]);
    expect(row?.contextWindow).toBe(128_000);
    expect(row?.maxInputTokens).toBe(100_000);
    expect(row?.maxOutputTokens).toBe(32_000);
    expect(row?.autoCompactTokenLimit).toBeLessThanOrEqual(100_000);
  });

  test("intersection keeps the smallest window, input limit, output limit and auto-compact", () => {
    const row = deriveComboCatalogModel("x", combo(), [imageMember, textMember]);
    expect(row?.contextWindow).toBe(128_000);
    expect(row?.maxInputTokens).toBe(100_000);
    expect(row?.maxOutputTokens).toBe(32_000);
    expect(row?.autoCompactTokenLimit).toBeLessThanOrEqual(100_000);
  });

  test.each(["intersection", "union"] as const)("%s omits max output if one member lacks a positive limit", capabilityPolicy => {
    const row = deriveComboCatalogModel("x", combo({ capabilityPolicy }), [imageMember, { ...textMember, maxOutputTokens: undefined }]);
    expect(row?.maxOutputTokens).toBeUndefined();
  });

  test("unionEfforts sorts known rungs by rank and keeps unknown rungs last in first-seen order", () => {
    expect(unionEfforts([["high", "custom-b"], ["low", "max", "custom-a"], ["medium"]]))
      .toEqual(["low", "medium", "high", "max", "custom-b", "custom-a"]);
  });

  test("union + contextWindowPolicy max advertises the largest member window, input limit, and auto-compact budget", () => {
    const compactMember = {
      ...textMember,
      contextWindow: 131_072,
      maxInputTokens: 120_000,
      maxOutputTokens: 16_384,
    };
    const millionMember = {
      ...imageMember,
      contextWindow: 1_048_576,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 64_000,
    };

    const unionMax = deriveComboCatalogModel(
      "x",
      combo({ capabilityPolicy: "union", contextWindowPolicy: "max" }),
      [millionMember, compactMember],
    );
    expect(unionMax?.contextWindow).toBe(1_048_576);
    expect(unionMax?.maxInputTokens).toBe(1_000_000);
    expect(unionMax?.maxOutputTokens).toBe(16_384);
    expect(unionMax?.autoCompactTokenLimit).toBe(
      clampAutoCompactTokenLimit(1_048_576, 1_000_000, undefined),
    );

    // Explicit autoCompactTokenLimit on the largest member is respected and clamped.
    const withCustomCompact = deriveComboCatalogModel(
      "x",
      combo({ capabilityPolicy: "union", contextWindowPolicy: "max" }),
      [{ ...millionMember, autoCompactTokenLimit: 800_000 }, compactMember],
    );
    expect(withCustomCompact?.autoCompactTokenLimit).toBe(800_000);

    // Partial maxInputTokens: undefined on the largest member falls back to its own contextWindow.
    const millionWithoutMaxInput = {
      ...imageMember,
      contextWindow: 1_000_000,
      maxInputTokens: undefined,
      maxOutputTokens: 64_000,
    };
    const partialMaxInput = deriveComboCatalogModel(
      "x",
      combo({ capabilityPolicy: "union", contextWindowPolicy: "max" }),
      [millionWithoutMaxInput, { ...compactMember, contextWindow: 128_000, maxInputTokens: 120_000 }],
    );
    expect(partialMaxInput?.contextWindow).toBe(1_000_000);
    expect(partialMaxInput?.maxInputTokens).toBe(1_000_000);
    expect(partialMaxInput?.autoCompactTokenLimit).toBe(
      clampAutoCompactTokenLimit(1_000_000, undefined, undefined),
    );

    // Asymmetric largest-window member: contextWindow, maxInputTokens, and autoCompactTokenLimit
    // all derive strictly from limitingMembers (never borrowing a smaller member's higher maxInputTokens).
    const asymmetricLargest = {
      ...imageMember,
      contextWindow: 1_050_000,
      maxInputTokens: 922_000,
      autoCompactTokenLimit: 829_800,
    };
    const asymmetricSmaller = {
      ...textMember,
      contextWindow: 1_000_000,
      maxInputTokens: undefined,
    };
    const asymmetric = deriveComboCatalogModel(
      "x",
      combo({ capabilityPolicy: "union", contextWindowPolicy: "max" }),
      [asymmetricLargest, asymmetricSmaller],
    );
    expect(asymmetric?.contextWindow).toBe(1_050_000);
    expect(asymmetric?.maxInputTokens).toBe(922_000);
    expect(asymmetric?.autoCompactTokenLimit).toBe(829_800);

    // Default union (omitted or explicit "min") and intersection (even with "max") keep Math.min.
    for (const cfg of [
      combo({ capabilityPolicy: "union" }),
      combo({ capabilityPolicy: "union", contextWindowPolicy: "min" }),
      combo({ capabilityPolicy: "intersection", contextWindowPolicy: "max" }),
      combo({ contextWindowPolicy: "max" }),
    ]) {
      const row = deriveComboCatalogModel("x", cfg, [millionMember, compactMember]);
      expect(row?.contextWindow).toBe(131_072);
      expect(row?.maxInputTokens).toBe(120_000);
      expect(row?.autoCompactTokenLimit).toBe(
        clampAutoCompactTokenLimit(131_072, 120_000, undefined),
      );
    }
  });

  test("contextWindowPolicy helpers stay sparse at the min default", () => {
    expect(normalizeComboContextWindowPolicy(undefined)).toBeUndefined();
    expect(normalizeComboContextWindowPolicy("min")).toBeUndefined();
    expect(normalizeComboContextWindowPolicy("max")).toBe("max");
    expect(comboContextWindowPolicy(undefined)).toBe("min");
    expect(comboContextWindowPolicy(combo())).toBe("min");
    expect(comboContextWindowPolicy(combo({ contextWindowPolicy: "min" }))).toBe("min");
    expect(comboContextWindowPolicy(combo({ contextWindowPolicy: "max" }))).toBe("max");
    expect(combo({ contextWindowPolicy: "min" })).not.toHaveProperty("contextWindowPolicy");
    expect(combo({ contextWindowPolicy: "max" }).contextWindowPolicy).toBe("max");
  });
});
