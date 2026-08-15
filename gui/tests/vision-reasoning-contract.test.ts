import { expect, test } from "bun:test";
import { visionReasoningLabel } from "../src/i18n/vision-reasoning-labels";
import {
  VISION_REASONING_LEVELS,
  clampVisionReasoningToLadder,
  visionReasoningLadder,
  visionReasoningOptionsFor,
  visionReasoningPatch,
  type ModelInfo,
} from "../src/pages/dashboard-shared";

test("vision reasoning uses advertised model ladders and clamps unsupported persisted values", () => {
  const models: ModelInfo[] = [
    { id: "gpt-5.6-luna", provider: "openai", namespaced: "gpt-5.6-luna", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "gpt-5.4-mini", provider: "openai", namespaced: "gpt-5.4-mini", reasoningEfforts: ["low", "medium", "high", "xhigh"] },
  ];

  expect(visionReasoningLadder(models, "gpt-5.6-luna")).toEqual(VISION_REASONING_LEVELS);
  const mini = visionReasoningLadder(models, "gpt-5.4-mini");
  expect(mini).toEqual(["low", "medium", "high", "xhigh"]);
  expect(clampVisionReasoningToLadder(mini, "max")).toBe("xhigh");
  expect(clampVisionReasoningToLadder(mini, "high")).toBe("high");
  expect(visionReasoningOptionsFor(mini, "max")).toEqual(mini);
});

test("vision reasoning clamp matches the server for non-prefix ladders", () => {
  expect(clampVisionReasoningToLadder(["low", "high"], "medium")).toBe("low");
  expect(clampVisionReasoningToLadder(["high", "max"], "low")).toBe("high");
  expect(clampVisionReasoningToLadder(["low", "medium", "max"], "xhigh")).toBe("medium");
});

test("missing or unusable vision capability metadata stays permissive", () => {
  const models: ModelInfo[] = [
    { id: "missing", provider: "openai", namespaced: "missing" },
    { id: "empty", provider: "openai", namespaced: "empty", reasoningEfforts: [] },
    { id: "unsupported-only", provider: "openai", namespaced: "unsupported-only", reasoningEfforts: ["ultra"] },
  ];

  expect(visionReasoningLadder([], "custom/vision-model")).toEqual(VISION_REASONING_LEVELS);
  for (const model of models) {
    expect(visionReasoningLadder(models, model.id)).toEqual(VISION_REASONING_LEVELS);
  }
});

test("vision reasoning labels are localized for every supported locale and effort", () => {
  const locales = ["en", "de", "fr", "ko", "zh", "ru", "ja"] as const;
  for (const locale of locales) {
    for (const level of VISION_REASONING_LEVELS) {
      const label = visionReasoningLabel(locale, level);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(level);
    }
  }
});

test("effort-only edits cannot rewrite the selected vision model or backend", () => {
  expect(visionReasoningPatch("high")).toEqual({ vision: { reasoning: "high" } });
});
