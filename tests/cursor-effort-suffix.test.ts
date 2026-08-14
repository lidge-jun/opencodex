import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { cursorEffortSuffix, cursorModelEffortLadder } from "../src/adapters/cursor/effort-map";
import type { OcxParsedRequest } from "../src/types";

// Static fixture recorded from Cursor GetUsableModels on 2026-08-06. This pins the
// exact wire ids observed during the incident; live availability normalization is
// covered separately in cursor-discovery.test.ts.
const RECORDED_CURSOR_GROK_45_DISCOVERY_IDS = [
  "cursor-grok-4.5-low",
  "cursor-grok-4.5-medium",
  "cursor-grok-4.5-high",
] as const;

// Account-visible Cursor CLI lineup recorded on 2026-08-13. Grok 4.6 adds a
// real Extra High tier in both regular and Fast forms; 4.5 still tops out at high.
const RECORDED_CURSOR_GROK_46_DISCOVERY_IDS = [
  "cursor-grok-4.6-low",
  "cursor-grok-4.6-medium",
  "cursor-grok-4.6-high",
  "cursor-grok-4.6-xhigh",
  "cursor-grok-4.6-low-fast",
  "cursor-grok-4.6-medium-fast",
  "cursor-grok-4.6-high-fast",
  "cursor-grok-4.6-xhigh-fast",
] as const;

function modelIdFor(modelId: string, reasoning?: string): string {
  const parsed: OcxParsedRequest = {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: false,
    options: reasoning ? { reasoning } : {},
  };
  return createCursorRequest(parsed).modelId;
}

function selectionFor(modelId: string, reasoning?: string) {
  const parsed: OcxParsedRequest = {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: false,
    options: reasoning ? { reasoning } : {},
  };
  const request = createCursorRequest(parsed);
  return { modelId: request.modelId, parameters: request.requestedModelParameters };
}

describe("Cursor per-model reasoning-effort suffix", () => {
  test("literal requested efforts pass through when the model supports that tier", () => {
    expect(modelIdFor("cursor/claude-4.6-opus", "high")).toBe("claude-4.6-opus-high");
    expect(modelIdFor("cursor/claude-4.6-opus", "max")).toBe("claude-4.6-opus-max");
    expect(modelIdFor("cursor/claude-4.6-opus", "xhigh")).toBe("claude-4.6-opus-max");
    expect(cursorEffortSuffix("claude-4.6-opus", "high")).toBe("high");
  });

  test("models with both max and xhigh preserve the exact named tier", () => {
    expect(modelIdFor("cursor/claude-opus-4-8", "low")).toBe("claude-opus-4-8-low");
    expect(modelIdFor("cursor/claude-opus-4-8", "medium")).toBe("claude-opus-4-8-medium");
    expect(modelIdFor("cursor/claude-opus-4-8", "high")).toBe("claude-opus-4-8-high");
    expect(modelIdFor("cursor/claude-opus-4-8", "max")).toBe("claude-opus-4-8-max");
    expect(modelIdFor("cursor/claude-opus-4-8", "xhigh")).toBe("claude-opus-4-8-xhigh");
    expect(modelIdFor("cursor/claude-opus-4-8", "ultra")).toBe("claude-opus-4-8-max");
  });

  test("efforts outside the model tier set clamp by Codex rank", () => {
    expect(modelIdFor("cursor/claude-4.6-opus", "low")).toBe("claude-4.6-opus-high"); // tiers[0]
    expect(modelIdFor("cursor/claude-4.6-opus", "medium")).toBe("claude-4.6-opus-high");
    expect(modelIdFor("cursor/claude-4.6-opus", "none")).toBe("claude-4.6-opus-high");
    expect(modelIdFor("cursor/claude-4.6-opus")).toBe("claude-4.6-opus-max");
  });

  // #545 made Claude Desktop's `thinking:{type:"disabled"}` survive translation as the "none"
  // sentinel instead of being dropped. For a modelMap that routes such a request to Cursor,
  // that changes the selected tier — pin it so the cross-provider effect is deliberate.
  //
  // Cursor has no "off" for a reasoning model, so the lowest tier is the closest honest
  // reading of "do not think". Dropping the instruction sent these to the model's TOP tier,
  // which is the opposite of what the caller asked for.
  test("an explicit 'none' picks the lowest tier, not the top one (#545)", () => {
    expect(modelIdFor("cursor/claude-opus-4-8", "none")).toBe("claude-opus-4-8-low");
    expect(modelIdFor("cursor/claude-opus-4-8")).toBe("claude-opus-4-8-max");
  });

  test("single-tier models always use their one tier", () => {
    expect(modelIdFor("cursor/gpt-5.5-extra", "low")).toBe("gpt-5.5-extra-high");
    expect(modelIdFor("cursor/claude-4.6-sonnet", "high")).toBe("claude-4.6-sonnet-medium");
    expect(modelIdFor("cursor/claude-4.5-opus", "low")).toBe("claude-4.5-opus-high");
  });

  test("non-reasoning models and already-qualified ids are left bare", () => {
    expect(modelIdFor("cursor/composer-2.5", "high")).toBe("composer-2.5");
    expect(modelIdFor("cursor/grok-4.3", "high")).toBe("grok-4.3");
    expect(modelIdFor("cursor/claude-4.6-opus-max", "low")).toBe("claude-4.6-opus-max");
    expect(cursorEffortSuffix("composer-2.5", "high")).toBeUndefined();
  });

  test("claude-sonnet-5 and glm-5.2 map to live effort suffixes", () => {
    expect(modelIdFor("cursor/claude-sonnet-5", "low")).toBe("claude-sonnet-5-low");
    expect(modelIdFor("cursor/claude-sonnet-5", "high")).toBe("claude-sonnet-5-high");
    expect(modelIdFor("cursor/claude-sonnet-5", "max")).toBe("claude-sonnet-5-max");
    expect(modelIdFor("cursor/glm-5.2", "low")).toBe("glm-5.2-high");
    expect(modelIdFor("cursor/glm-5.2", "medium")).toBe("glm-5.2-high");
    expect(modelIdFor("cursor/glm-5.2", "high")).toBe("glm-5.2-high");
    expect(modelIdFor("cursor/glm-5.2", "max")).toBe("glm-5.2-max");
  });

  test("grok-4.5 uses current tiers and sends Fast as a separate model parameter", () => {
    expect(modelIdFor("cursor/grok-4.5", "low")).toBe("cursor-grok-4.5-low");
    expect(modelIdFor("cursor/grok-4.5", "medium")).toBe("cursor-grok-4.5-medium");
    expect(modelIdFor("cursor/grok-4.5", "high")).toBe("cursor-grok-4.5-high");
    expect(modelIdFor("cursor/grok-4.5", "xhigh")).toBe("cursor-grok-4.5-high");
    expect(modelIdFor("cursor/grok-4.5")).toBe("cursor-grok-4.5-high");
    expect(selectionFor("cursor/grok-4.5", "high")).toEqual({
      modelId: "cursor-grok-4.5-high",
      parameters: undefined,
    });
    expect(selectionFor("cursor/grok-4.5-fast", "low")).toEqual({
      modelId: "grok-4.5",
      parameters: [{ id: "effort", value: "low" }, { id: "fast", value: "true" }],
    });
    expect(selectionFor("cursor/grok-4.5-fast", "medium")).toEqual({
      modelId: "grok-4.5",
      parameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }],
    });
    expect(selectionFor("cursor/grok-4.5-fast", "high")).toEqual({
      modelId: "grok-4.5",
      parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
    });
    // Codex-only upper tiers and an omitted effort clamp to Cursor's current top tier.
    expect(selectionFor("cursor/grok-4.5-fast", "xhigh")).toEqual({
      modelId: "grok-4.5",
      parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
    });
    expect(selectionFor("cursor/grok-4.5-fast")).toEqual({
      modelId: "grok-4.5",
      parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }],
    });
    expect(cursorModelEffortLadder("grok-4.5")).toEqual(["low", "medium", "high"]);
    expect(cursorModelEffortLadder("grok-4.5-fast")).toEqual(["low", "medium", "high"]);
  });

  test("regular grok-4.5 request ids match the recorded discovery fixture", () => {
    for (const effort of ["low", "medium", "high"] as const) {
      const requestModelId = modelIdFor("cursor/grok-4.5", effort);
      expect(requestModelId).toBe(`cursor-grok-4.5-${effort}`);
      expect(RECORDED_CURSOR_GROK_45_DISCOVERY_IDS).toContain(requestModelId);
    }
  });

  test("grok-4.6 exposes xhigh and sends Extra High Fast as parameters", () => {
    expect(modelIdFor("cursor/grok-4.6", "low")).toBe("cursor-grok-4.6-low");
    expect(modelIdFor("cursor/grok-4.6", "medium")).toBe("cursor-grok-4.6-medium");
    expect(modelIdFor("cursor/grok-4.6", "high")).toBe("cursor-grok-4.6-high");
    expect(modelIdFor("cursor/grok-4.6", "xhigh")).toBe("cursor-grok-4.6-xhigh");
    expect(modelIdFor("cursor/grok-4.6", "max")).toBe("cursor-grok-4.6-xhigh");
    expect(selectionFor("cursor/grok-4.6")).toEqual({
      modelId: "cursor-grok-4.6-xhigh",
      parameters: undefined,
    });
    expect(selectionFor("cursor/grok-4.6-fast", "xhigh")).toEqual({
      modelId: "grok-4.6",
      parameters: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "true" }],
    });
    expect(selectionFor("cursor/grok-4.6-fast", "max")).toEqual({
      modelId: "grok-4.6",
      parameters: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "true" }],
    });
    expect(selectionFor("cursor/grok-4.6-fast")).toEqual({
      modelId: "grok-4.6",
      parameters: [{ id: "effort", value: "xhigh" }, { id: "fast", value: "true" }],
    });
    expect(cursorModelEffortLadder("grok-4.6")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cursorModelEffortLadder("grok-4.6-fast")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  test("regular grok-4.6 request ids match the recorded discovery fixture", () => {
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      const requestModelId = modelIdFor("cursor/grok-4.6", effort);
      expect(requestModelId).toBe(`cursor-grok-4.6-${effort}`);
      expect(RECORDED_CURSOR_GROK_46_DISCOVERY_IDS).toContain(requestModelId);
    }
    expect(RECORDED_CURSOR_GROK_46_DISCOVERY_IDS).toContain("cursor-grok-4.6-xhigh-fast");
  });

  test("kimi-k3 maps to its live effort-suffixed variants", () => {
    expect(modelIdFor("cursor/kimi-k3", "low")).toBe("kimi-k3-low");
    expect(modelIdFor("cursor/kimi-k3", "medium")).toBe("kimi-k3-high");
    expect(modelIdFor("cursor/kimi-k3", "high")).toBe("kimi-k3-high");
    expect(modelIdFor("cursor/kimi-k3", "max")).toBe("kimi-k3-max");
    // Bare id (no requested effort) resolves to the model's top tier; upstream rejects the bare id.
    expect(modelIdFor("cursor/kimi-k3")).toBe("kimi-k3-max");
    expect(cursorModelEffortLadder("kimi-k3")).toEqual(["low", "high", "max"]);
  });

  test("model ladders are deduped and sorted in canonical Codex order", () => {
    expect(cursorModelEffortLadder("claude-opus-4-8")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cursorModelEffortLadder("glm-5.2")).toEqual(["high", "max"]);
    expect(cursorModelEffortLadder("composer-2.5")).toBeUndefined();
  });
});
