import { describe, expect, test } from "bun:test";
import {
  CURSOR_DEFAULT_CONTEXT_WINDOW,
  CURSOR_STATIC_MODELS,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
  inferCursorContextWindow,
  normalizeCursorModels,
} from "../src/adapters/cursor/discovery";

describe("Cursor discovery metadata", () => {
  test("static seed includes the safe auto model", () => {
    expect(cursorModelIds(CURSOR_STATIC_MODELS)).toContain("auto");
    expect(cursorModelContextWindows(CURSOR_STATIC_MODELS).auto).toBe(CURSOR_DEFAULT_CONTEXT_WINDOW);
  });

  test("normalization trims, deduplicates, sorts, and fills context windows", () => {
    const models = normalizeCursorModels([
      { id: " gpt-5.5 ", supportsReasoningEffort: true },
      { id: "" },
      { id: "auto" },
      { id: "gpt-5.5", contextWindow: 1 },
      { id: "claude-4.5-sonnet" },
    ]);

    expect(models.map(model => model.id)).toEqual(["auto", "claude-4.5-sonnet", "gpt-5.5"]);
    expect(models.find(model => model.id === "gpt-5.5")?.contextWindow).toBe(400_000);
    expect(models.find(model => model.id === "claude-4.5-sonnet")?.contextWindow).toBe(200_000);
  });

  test("context-window inference uses conservative defaults", () => {
    expect(inferCursorContextWindow("unknown-model")).toBe(CURSOR_DEFAULT_CONTEXT_WINDOW);
    expect(inferCursorContextWindow("claude-4.5-sonnet")).toBe(200_000);
    expect(inferCursorContextWindow("gpt-5.5")).toBe(400_000);
  });

  test("input modalities are cloned per model", () => {
    const modalities = cursorModelInputModalities([{ id: "auto" }]);

    expect(modalities.auto).toEqual(["text", "image"]);
    modalities.auto.push("mutated");
    expect(cursorModelInputModalities([{ id: "auto" }]).auto).toEqual(["text", "image"]);
  });

  test("reasoning efforts are explicit per model", () => {
    const efforts = cursorModelReasoningEfforts([
      { id: "auto", supportsReasoningEffort: false },
      { id: "gpt-5.5", supportsReasoningEffort: true },
    ]);

    expect(efforts.auto).toEqual([]);
    expect(efforts["gpt-5.5"]).toEqual(["low", "medium", "high"]);
  });
});
