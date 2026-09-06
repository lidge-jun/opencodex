import { describe, expect, test } from "bun:test";
import {
  analyzeClaudeCompatibility,
  collectClaudeFeatureCodes,
  isClaudeCompatibilityMode,
  resolveClaudeCompatibilityMode,
} from "../../src/claude/compatibility";
import { AnthropicRequestError } from "../../src/claude/inbound";
import { enforceClaudeCompatibility } from "../../src/server/claude-messages";

describe("Claude routed compatibility foundation", () => {
  test("collects stable feature codes without reading credentials", () => {
    expect(collectClaudeFeatureCodes({
      model: "claude-sonnet",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }, "context-1m-2025-08-07")).toEqual(["beta_context_1m_2025_08_07", "web_search_tool"]);
  });

  test("fails closed for unmappable routed content while native Anthropic stays allowed", () => {
    const body = { messages: [{ role: "user", content: [{ type: "document", title: "x" }] }] };
    expect(analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "openai-chat" }).decision).toBe("reject");
    expect(analyzeClaudeCompatibility(body, { mode: "enforce", adapter: "anthropic" })).toMatchObject({ compatible: true, decision: "allow" });
  });

  test("shadow mode reports, but does not reject, an incompatible feature", () => {
    const result = analyzeClaudeCompatibility({ context_management: { edits: [{ op: "remove" }] } }, { mode: "shadow", adapter: "openai-chat" });
    expect(result).toMatchObject({ compatible: true, decision: "shadow" });
    expect(result.reason).toContain("context_management");
  });

  test("mode resolution is strict and defaults to enforce", () => {
    expect(isClaudeCompatibilityMode("shadow")).toBe(true);
    expect(isClaudeCompatibilityMode("invalid")).toBe(false);
    expect(resolveClaudeCompatibilityMode()).toBe("enforce");
    expect(resolveClaudeCompatibilityMode({ compatibility: "shadow" })).toBe("shadow");
  });

  test("the Messages endpoint gate is opt-in, fail-closed, and reason-bounded", () => {
    const body = { messages: [{ role: "user", content: [{ type: "document", title: "secret-name" }] }] };
    expect(() => enforceClaudeCompatibility(body, { adapter: "openai-chat" })).not.toThrow();
    expect(() => enforceClaudeCompatibility(body, { mode: "shadow", adapter: "openai-chat" })).not.toThrow();
    expect(() => enforceClaudeCompatibility(body, { mode: "enforce", adapter: "openai-chat" })).toThrow(AnthropicRequestError);
    try {
      enforceClaudeCompatibility(body, { mode: "enforce", adapter: "openai-chat" });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message.length).toBeLessThanOrEqual(512);
      expect((error as Error).message).not.toContain("secret-name");
    }
  });
});
