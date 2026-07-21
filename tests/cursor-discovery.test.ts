import { describe, expect, test } from "bun:test";
import {
  CURSOR_AUTO_WIRE_MODEL_ID,
  CURSOR_DEFAULT_CONTEXT_WINDOW,
  CURSOR_STATIC_MODELS,
  cursorCodexToWireModelId,
  filterCursorConfiguredModelsByLiveDiscovery,
  isCursorModelAvailableForAccount,
  cursorModelContextWindows,
  cursorModelIds,
  cursorModelInputModalities,
  cursorModelReasoningEfforts,
  inferCursorContextWindow,
  normalizeCursorModels,
} from "../src/adapters/cursor/discovery";

describe("Cursor discovery metadata", () => {
  test("static seed includes Cursor's public model families plus the safe auto model", () => {
    const ids = cursorModelIds(CURSOR_STATIC_MODELS);

    expect(ids.length).toBeGreaterThanOrEqual(38);
    expect(ids).toContain("auto");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).toContain("composer-2.5");
    expect(ids).toContain("composer-2.5-fast");
    expect(ids).toContain("claude-4.6-sonnet");
    expect(ids).toContain("gemini-2.5-flash");
    expect(ids).toContain("gemini-3-pro-image-preview");
    expect(ids).toContain("gemini-3.5-flash");
    expect(ids).toContain("gpt-5-codex");
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("glm-5.2");
    expect(ids).toContain("kimi-k2.7-code");
    expect(ids).toContain("claude-opus-4-7-fast");
    // 260709 refresh: stale ids dropped from the static seed (cursor.com docs); gpt-5.5-extra
    // stays — it survives the live GetUsableModels filter (004_live_snapshot.md).
    expect(ids).not.toContain("grok-4.20");
    expect(ids).not.toContain("grok-4.3");
    expect(ids).not.toContain("kimi-k2.5");
    expect(ids).toContain("gpt-5.5-extra");
    expect(ids).not.toContain("composer-2");
    // `auto` mirrors the jawcode SOT `default` entry (200k), not the generic fallback window.
    expect(cursorModelContextWindows(CURSOR_STATIC_MODELS).auto).toBe(200_000);
    expect(cursorModelContextWindows(CURSOR_STATIC_MODELS)["composer-2.5-fast"]).toBe(200_000);
  });

  test("auto is not activated by live GetUsableModels wire ids alone", () => {
    expect(isCursorModelAvailableForAccount("gpt-5.4", ["gpt-5.4-high"])).toBe(true);
    expect(isCursorModelAvailableForAccount("claude-fable-5", ["gpt-5.4-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("auto", ["default"])).toBe(false);
    // Sibling model ids must not activate a different base: only effort suffixes count.
    expect(isCursorModelAvailableForAccount("claude-4-sonnet", ["claude-4-sonnet-1m"])).toBe(false);
    expect(isCursorModelAvailableForAccount("gpt-5.5", ["gpt-5.5-extra-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("gpt-5.5-extra", ["gpt-5.5-extra-high"])).toBe(true);

    // Issue #117: Cursor GetUsableModels may return ids with a `cursor-` wire prefix.
    expect(isCursorModelAvailableForAccount("grok-4.5", ["cursor-grok-4.5-high"])).toBe(true);
    expect(isCursorModelAvailableForAccount("grok-4.5-fast", ["cursor-grok-4.5-fast-medium"])).toBe(true);
    expect(isCursorModelAvailableForAccount("gpt-5.4", ["cursor-gpt-5.4-high"])).toBe(true);
    // Prefixed sibling rejection: cursor- prefix must not bypass sibling-model checks.
    expect(isCursorModelAvailableForAccount("gpt-5.5", ["cursor-gpt-5.5-extra-high"])).toBe(false);
    expect(isCursorModelAvailableForAccount("claude-4-sonnet", ["cursor-claude-4-sonnet-1m"])).toBe(false);

    const filtered = filterCursorConfiguredModelsByLiveDiscovery(
      [{ id: "gpt-5.4" }, { id: "claude-fable-5" }],
      ["gpt-5.4-high"],
    );
    expect(filtered.map(model => model.id)).toEqual(["gpt-5.4"]);
  });

  test("live discovery filter always keeps auto even when GetUsableModels omits it", () => {
    const filtered = filterCursorConfiguredModelsByLiveDiscovery(
      [{ id: "auto" }, { id: "gpt-5.4" }, { id: "claude-fable-5" }],
      ["gpt-5.4-high"],
    );
    expect(filtered.map(model => model.id)).toEqual(["auto", "gpt-5.4"]);
  });

  test("auto maps to default on the Cursor wire", () => {
    expect(cursorCodexToWireModelId("auto")).toBe(CURSOR_AUTO_WIRE_MODEL_ID);
    expect(cursorCodexToWireModelId("cursor/auto")).toBe(CURSOR_AUTO_WIRE_MODEL_ID);
    expect(cursorCodexToWireModelId("gpt-5.4")).toBe("gpt-5.4");
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
    expect(models.find(model => model.id === "gpt-5.5")?.contextWindow).toBe(272_000);
    expect(models.find(model => model.id === "claude-4.5-sonnet")?.contextWindow).toBe(200_000);
  });

  test("context-window inference uses conservative defaults", () => {
    expect(inferCursorContextWindow("unknown-model")).toBe(CURSOR_DEFAULT_CONTEXT_WINDOW);
    expect(inferCursorContextWindow("claude-4.5-sonnet")).toBe(200_000);
    expect(inferCursorContextWindow("claude-opus-4.8")).toBe(200_000);
    expect(inferCursorContextWindow("gemini-3.5-flash")).toBe(1_000_000);
    expect(inferCursorContextWindow("glm-5.2")).toBe(1_000_000);
    expect(inferCursorContextWindow("grok-4.3")).toBe(256_000);
    expect(inferCursorContextWindow("gpt-5.5")).toBe(272_000);
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
      { id: "claude-opus-4-8", supportsReasoningEffort: true },
      { id: "glm-5.2", supportsReasoningEffort: true },
      { id: "grok-4.3", supportsReasoningEffort: true },
      { id: "unknown-reasoning-model", supportsReasoningEffort: true },
      { id: "composer-2.5", supportsReasoningEffort: false },
    ]);

    expect(efforts.auto).toEqual([]);
    expect(efforts["gpt-5.5"]).toEqual(["low", "medium", "high"]);
    expect(efforts["claude-opus-4-8"]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(efforts["glm-5.2"]).toEqual(["high", "max"]);
    expect(efforts["grok-4.3"]).toEqual([]);
    expect(efforts["unknown-reasoning-model"]).toEqual([]);
    expect(efforts["composer-2.5"]).toEqual([]);
  });
});
