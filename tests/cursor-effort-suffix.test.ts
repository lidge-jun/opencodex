import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { cursorEffortSuffix, cursorModelEffortLadder } from "../src/adapters/cursor/effort-map";
import type { OcxParsedRequest } from "../src/types";

function modelIdFor(modelId: string, reasoning?: string): string {
  const parsed: OcxParsedRequest = {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: false,
    options: reasoning ? { reasoning } : {},
  };
  return createCursorRequest(parsed).modelId;
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

  test("model ladders are deduped and sorted in canonical Codex order", () => {
    expect(cursorModelEffortLadder("claude-opus-4-8")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cursorModelEffortLadder("glm-5.2")).toEqual(["high", "max"]);
    expect(cursorModelEffortLadder("composer-2.5")).toBeUndefined();
  });
});
