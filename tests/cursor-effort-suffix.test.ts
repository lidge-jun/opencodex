import { describe, expect, test } from "bun:test";
import { createCursorRequest } from "../src/adapters/cursor/request-builder";
import type { OcxParsedRequest } from "../src/types";

function req(modelId: string, reasoning?: string): OcxParsedRequest {
  return {
    modelId,
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    stream: false,
    options: reasoning ? { reasoning } : {},
  };
}

describe("Cursor model-id reasoning-effort suffix", () => {
  test("appends the mapped effort suffix to a bare reasoning model", () => {
    expect(createCursorRequest(req("cursor/claude-4.6-opus", "high")).modelId).toBe("claude-4.6-opus-high");
    expect(createCursorRequest(req("cursor/claude-4.6-opus", "medium")).modelId).toBe("claude-4.6-opus-medium");
    expect(createCursorRequest(req("cursor/claude-4.6-opus", "minimal")).modelId).toBe("claude-4.6-opus-low");
    expect(createCursorRequest(req("cursor/claude-4.6-opus", "xhigh")).modelId).toBe("claude-4.6-opus-max");
  });

  test("defaults to -high when effort is none/absent (bare ids are rejected by Cursor)", () => {
    expect(createCursorRequest(req("cursor/claude-4.6-opus")).modelId).toBe("claude-4.6-opus-high");
    expect(createCursorRequest(req("cursor/claude-4.6-opus", "none")).modelId).toBe("claude-4.6-opus-high");
  });

  test("leaves an already effort-suffixed id unchanged", () => {
    expect(createCursorRequest(req("cursor/claude-4.6-opus-max", "low")).modelId).toBe("claude-4.6-opus-max");
    expect(createCursorRequest(req("cursor/claude-4.6-opus-high-thinking")).modelId).toBe("claude-4.6-opus-high-thinking");
  });

  test("does not add a suffix to Cursor's non-reasoning models", () => {
    expect(createCursorRequest(req("cursor/composer-2.5", "high")).modelId).toBe("composer-2.5");
    expect(createCursorRequest(req("cursor/auto")).modelId).toBe("auto");
  });
});
