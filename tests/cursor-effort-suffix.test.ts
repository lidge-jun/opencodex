import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import { cursorEffortSuffix } from "../src/adapters/cursor/effort-map";
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
  test("Codex top effort maps to the model's top tier (max-models -> max)", () => {
    expect(modelIdFor("cursor/claude-4.6-opus", "high")).toBe("claude-4.6-opus-max");
    expect(cursorEffortSuffix("claude-4.6-opus", "high")).toBe("max");
  });

  test("xhigh-models map the top effort to xhigh", () => {
    expect(modelIdFor("cursor/claude-opus-4-8", "high")).toBe("claude-opus-4-8-xhigh");
    expect(modelIdFor("cursor/claude-opus-4-8", "low")).toBe("claude-opus-4-8-low");
    expect(modelIdFor("cursor/claude-opus-4-8", "medium")).toBe("claude-opus-4-8-high");
  });

  test("lower Codex efforts clamp to the model's lower tiers", () => {
    expect(modelIdFor("cursor/claude-4.6-opus", "low")).toBe("claude-4.6-opus-high"); // tiers[0]
    expect(modelIdFor("cursor/claude-4.6-opus", "medium")).toBe("claude-4.6-opus-high");
    expect(modelIdFor("cursor/claude-4.6-opus", "none")).toBe("claude-4.6-opus-high");
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
});
