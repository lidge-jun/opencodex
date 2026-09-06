import { describe, expect, test } from "bun:test";
import {
  analyzeClaudeCompatibility,
  collectClaudeFeatureCodes,
  isClaudeCompatibilityMode,
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

  test("does not mistake a client function name for MCP admission", () => {
    const result = analyzeClaudeCompatibility({ tools: [{ type: "function", name: "mcp_lookup", input_schema: { type: "object" } }] }, { mode: "enforce", adapter: "openai-chat" });
    expect(result).toMatchObject({ compatible: true, decision: "allow" });
    expect(result.featureCodes).not.toContain("mcp_tool");
  });

  test("does not mistake a client function name for hosted code execution", () => {
    const result = analyzeClaudeCompatibility({
      tools: [{ type: "function", name: "safe_code_execution", input_schema: { type: "object" } }],
    }, { mode: "enforce", adapter: "openai-chat" });
    expect(result).toMatchObject({ compatible: true, decision: "allow" });
    expect(result.featureCodes).not.toContain("code_execution");
  });

  test("does not mistake client function names or tool_use blocks for hosted tool search", () => {
    const result = analyzeClaudeCompatibility({
      tools: [{ type: "function", name: "tool_search_tool_local", input_schema: { type: "object" } }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", name: "tool_search", id: "toolu_1", input: {} }] }],
    }, { mode: "enforce", adapter: "openai-chat" });
    expect(result).toMatchObject({ compatible: true, decision: "allow" });
    expect(result.featureCodes).not.toContain("tool_search");
  });

  test("classifies hosted tool search without also adding generic server-tool evidence", () => {
    const result = collectClaudeFeatureCodes({
      messages: [{ role: "assistant", content: [{ type: "server_tool_use", name: "tool_search", id: "srvtoolu_1", input: {} }] }],
    });
    expect(result).toEqual(["tool_search"]);
  });

  test("recognizes cache control only at Anthropic block positions", () => {
    expect(collectClaudeFeatureCodes({
      tools: [{
        type: "function",
        name: "lookup",
        input_schema: {
          type: "object",
          properties: { cache_control: { type: "string" } },
        },
      }],
    })).not.toContain("cache_control");
    expect(collectClaudeFeatureCodes({
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
    })).toContain("cache_control");
    expect(analyzeClaudeCompatibility({
      system: [{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }],
    }, { mode: "enforce", adapter: "openai-chat" })).toMatchObject({ compatible: true, decision: "allow" });
  });

  test("recognizes deferred tools by activation value, not field presence", () => {
    expect(collectClaudeFeatureCodes({ defer_tools: false, deferred_tools: [] })).not.toContain("deferred_tools");
    expect(collectClaudeFeatureCodes({ tools: [{ type: "function", name: "later", defer_loading: true }] })).toContain("deferred_tools");
    expect(collectClaudeFeatureCodes({ deferred_tools: ["later"] })).toContain("deferred_tools");
  });

  test("shadow mode reports, but does not reject, an incompatible feature", () => {
    const result = analyzeClaudeCompatibility({ context_management: { edits: [{ op: "remove" }] } }, { mode: "shadow", adapter: "openai-chat" });
    expect(result).toMatchObject({ compatible: true, decision: "shadow" });
    expect(result.reason).toContain("context_management");
  });

  test("feature evidence is bounded", () => {
    const betas = Array.from({ length: 40 }, (_, index) => `feature-${index}-${"x".repeat(100)}`).join(",");
    const codes = collectClaudeFeatureCodes({}, betas);
    expect(codes).toHaveLength(32);
    expect(codes.every(code => code.length <= 53)).toBe(true);
  });

  test("mode recognition is strict", () => {
    expect(isClaudeCompatibilityMode("shadow")).toBe(true);
    expect(isClaudeCompatibilityMode("enforce")).toBe(true);
    expect(isClaudeCompatibilityMode("invalid")).toBe(false);
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
