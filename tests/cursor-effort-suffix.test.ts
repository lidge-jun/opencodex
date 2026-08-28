import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { CANONICAL_EFFORT_SUFFIXES, cursorEffortSuffix, cursorModelEffortLadder, cursorWireModelIdWithEffort, CURSOR_THINKING_MODEL_IDS } from "../src/adapters/cursor/effort-map";
import { CURSOR_STATIC_MODELS, isCursorModelAvailableForAccount } from "../src/adapters/cursor/discovery";
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

// Umbrella-merge note (devlog 260828_cursor_umbrella_catalog): bare claude
// base ids now route their THINKING variant — the wire ids below carry the
// family's thinking marker. Effort semantics (literal-first, rank clamp,
// #545 none->lowest) are unchanged; only the variant dimension moved.
describe("Cursor per-model reasoning-effort suffix", () => {
  test("literal requested efforts pass through when the model supports that tier", () => {
    expect(modelIdFor("cursor/claude-4.6-opus", "high")).toBe("claude-4.6-opus-high-thinking");
    expect(modelIdFor("cursor/claude-4.6-opus", "max")).toBe("claude-4.6-opus-max-thinking");
    expect(modelIdFor("cursor/claude-4.6-opus", "xhigh")).toBe("claude-4.6-opus-max-thinking");
    expect(cursorEffortSuffix("claude-4.6-opus", "high")).toBe("high");
  });

  test("models with both max and xhigh preserve the exact named tier", () => {
    expect(modelIdFor("cursor/claude-opus-4-8", "low")).toBe("claude-opus-4-8-thinking-low");
    expect(modelIdFor("cursor/claude-opus-4-8", "medium")).toBe("claude-opus-4-8-thinking-medium");
    expect(modelIdFor("cursor/claude-opus-4-8", "high")).toBe("claude-opus-4-8-thinking-high");
    expect(modelIdFor("cursor/claude-opus-4-8", "max")).toBe("claude-opus-4-8-thinking-max");
    expect(modelIdFor("cursor/claude-opus-4-8", "xhigh")).toBe("claude-opus-4-8-thinking-xhigh");
    expect(modelIdFor("cursor/claude-opus-4-8", "ultra")).toBe("claude-opus-4-8-thinking-max");
  });

  test("efforts outside the model tier set clamp by Codex rank", () => {
    expect(modelIdFor("cursor/claude-4.6-opus", "low")).toBe("claude-4.6-opus-high-thinking"); // tiers[0]
    expect(modelIdFor("cursor/claude-4.6-opus", "medium")).toBe("claude-4.6-opus-high-thinking");
    expect(modelIdFor("cursor/claude-4.6-opus", "none")).toBe("claude-4.6-opus-high-thinking");
    expect(modelIdFor("cursor/claude-4.6-opus")).toBe("claude-4.6-opus-max-thinking");
  });

  // #545 made Claude Desktop's `thinking:{type:"disabled"}` survive translation as the "none"
  // sentinel instead of being dropped. For a modelMap that routes such a request to Cursor,
  // that changes the selected tier — pin it so the cross-provider effect is deliberate.
  //
  // Cursor has no "off" for a reasoning model, so the lowest tier is the closest honest
  // reading of "do not think". Dropping the instruction sent these to the model's TOP tier,
  // which is the opposite of what the caller asked for.
  test("an explicit 'none' picks the lowest tier, not the top one (#545)", () => {
    expect(modelIdFor("cursor/claude-opus-4-8", "none")).toBe("claude-opus-4-8-thinking-low");
    expect(modelIdFor("cursor/claude-opus-4-8")).toBe("claude-opus-4-8-thinking-max");
  });

  test("single-tier models always use their one tier", () => {
    expect(modelIdFor("cursor/gpt-5.5-extra", "low")).toBe("gpt-5.5-extra-high");
    expect(modelIdFor("cursor/claude-4.6-sonnet", "high")).toBe("claude-4.6-sonnet-medium-thinking");
    expect(modelIdFor("cursor/claude-4.5-opus", "low")).toBe("claude-4.5-opus-high-thinking");
  });

  test("non-reasoning models and already-qualified ids are left bare", () => {
    expect(modelIdFor("cursor/composer-2.5", "high")).toBe("composer-2.5");
    expect(modelIdFor("cursor/grok-4.3", "high")).toBe("grok-4.3");
    expect(modelIdFor("cursor/claude-4.6-opus-max", "low")).toBe("claude-4.6-opus-max");
    expect(cursorEffortSuffix("composer-2.5", "high")).toBeUndefined();
  });

  test("claude-sonnet-5 and glm-5.2 map to live effort suffixes", () => {
    expect(modelIdFor("cursor/claude-sonnet-5", "low")).toBe("claude-sonnet-5-thinking-low");
    expect(modelIdFor("cursor/claude-sonnet-5", "high")).toBe("claude-sonnet-5-thinking-high");
    expect(modelIdFor("cursor/claude-sonnet-5", "max")).toBe("claude-sonnet-5-thinking-max");
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

describe("#2569 Cursor catalog tracks the live GetUsableModels roster", () => {
  test("the two Gemini families the live roster exposes are catalogued", () => {
    const ids = new Set(CURSOR_STATIC_MODELS.map(model => model.id));
    expect(ids.has("gemini-3.6-flash")).toBe(true);
    expect(ids.has("gemini-3.7-flash")).toBe(true);
  });

  test("gemini-3.6-flash exposes its minimal rung in the picker ladder", () => {
    // minimal is not in the canonical five-rung order, so the ladder filter dropped it and the
    // tier was unreachable from Codex even though the wire accepts it.
    expect(cursorModelEffortLadder("gemini-3.6-flash")).toEqual(["minimal", "low", "medium", "high"]);
    expect(cursorEffortSuffix("gemini-3.6-flash", "minimal")).toBe("minimal");
    expect(CANONICAL_EFFORT_SUFFIXES.has("minimal")).toBe(true);
  });

  test("gemini-3.7-flash carries the low/medium/high ladder the wire lists", () => {
    expect(cursorModelEffortLadder("gemini-3.7-flash")).toEqual(["low", "medium", "high"]);
  });

  test("both families survive live-discovery filtering from effort-suffixed wire ids", () => {
    // The live roster lists ONLY suffixed ids for these models; a base id that does not match
    // one of them is dropped from the routed catalog.
    expect(isCursorModelAvailableForAccount("gemini-3.6-flash", ["gemini-3.6-flash-minimal"])).toBe(true);
    expect(isCursorModelAvailableForAccount("gemini-3.7-flash", ["gemini-3.7-flash-high"])).toBe(true);
  });
});

describe("#2569 Cursor explicit-thinking variants", () => {
  /**
   * Suffix ORDER differs per family and the wrong one is rejected ERROR_BAD_MODEL_NAME.
   * Cases recorded from the live GetUsableModels roster on 2026-08-25.
   */
  const WIRE_CASES: ReadonlyArray<readonly [string, string, string]> = [
    ["claude-opus-5-thinking", "high", "claude-opus-5-thinking-high"],
    ["claude-opus-5-thinking-fast", "max", "claude-opus-5-thinking-max-fast"],
    ["claude-opus-4-8-thinking", "low", "claude-opus-4-8-thinking-low"],
    ["claude-opus-4-8-thinking-fast", "xhigh", "claude-opus-4-8-thinking-xhigh-fast"],
    ["claude-sonnet-5-thinking", "medium", "claude-sonnet-5-thinking-medium"],
    ["claude-fable-5-thinking", "xhigh", "claude-fable-5-thinking-xhigh"],
    // The marker moves to the END for these families.
    ["claude-4.6-opus-thinking", "max", "claude-4.6-opus-max-thinking"],
    ["claude-4.5-opus-thinking", "high", "claude-4.5-opus-high-thinking"],
    ["claude-4.6-sonnet-thinking", "medium", "claude-4.6-sonnet-medium-thinking"],
  ];

  for (const [id, effort, expected] of WIRE_CASES) {
    test(`${id} at ${effort} composes ${expected}`, () => {
      expect(cursorWireModelIdWithEffort(id, effort)).toBe(expected);
    });
  }

  test("families with no effort rung send the bare thinking id", () => {
    expect(cursorWireModelIdWithEffort("claude-4.5-sonnet-thinking", "high")).toBe("claude-4.5-sonnet-thinking");
    expect(cursorWireModelIdWithEffort("claude-4-sonnet-thinking", "low")).toBe("claude-4-sonnet-thinking");
    expect(cursorModelEffortLadder("claude-4.5-sonnet-thinking")).toBeUndefined();
  });

  test("thinking variants folded into umbrella rows but still match live-discovery filtering", () => {
    // Umbrella merge (devlog 260828): the 13 separate -thinking picker rows are
    // gone — the BASE row carries the thinking default. Live thinking wire ids
    // must therefore prove the BASE's availability, and legacy thinking slugs
    // keep matching too (alias retention).
    const ids = new Set(CURSOR_STATIC_MODELS.map(model => model.id));
    for (const id of CURSOR_THINKING_MODEL_IDS) expect(ids.has(id)).toBe(false);
    expect(isCursorModelAvailableForAccount("claude-opus-5", ["claude-opus-5-thinking-high"])).toBe(true);
    expect(isCursorModelAvailableForAccount("claude-4.6-opus", ["claude-4.6-opus-max-thinking"])).toBe(true);
    expect(isCursorModelAvailableForAccount("claude-opus-5-thinking", ["claude-opus-5-thinking-high"])).toBe(true);
    expect(isCursorModelAvailableForAccount("claude-4.5-sonnet-thinking", ["claude-4.5-sonnet-thinking"])).toBe(true);
  });

  test("a thinking variant never collapses onto its non-thinking source", () => {
    expect(cursorWireModelIdWithEffort("claude-opus-5", "high")).toBe("claude-opus-5-high");
    expect(cursorWireModelIdWithEffort("claude-opus-5-fast", "high")).toBe("claude-opus-5-high-fast");
  });
});
