import { describe, expect, test } from "bun:test";
import { comboCatalogOmissionReason, deriveComboCatalogModel } from "../../src/codex/catalog";
import { unionEfforts } from "../../src/combos/capability-policy";
import { normalizeComboConfig, type NormalizedComboConfig } from "../../src/combos/types";

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

  test("context window, input and output limits stay the minimum under union", () => {
    const row = deriveComboCatalogModel("x", combo({ capabilityPolicy: "union" }), [imageMember, textMember]);
    expect(row?.contextWindow).toBe(128_000);
    expect(row?.maxInputTokens).toBe(100_000);
    expect(row?.maxOutputTokens).toBe(32_000);
  });

  test("unionEfforts sorts known rungs by rank and keeps unknown rungs last in first-seen order", () => {
    expect(unionEfforts([["high", "custom-b"], ["low", "max", "custom-a"], ["medium"]]))
      .toEqual(["low", "medium", "high", "max", "custom-b", "custom-a"]);
  });
});
