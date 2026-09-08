import { describe, expect, test } from "bun:test";
import { analyzeClaudeCompatibility, isClaudeCompatibilityMode } from "../../src/claude/compatibility";

// Shapes from Anthropic's thinking, tool-search, strict-tool-use and Messages docs:
// https://platform.claude.com/docs/en/build-with-claude/thinking
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use
// https://platform.claude.com/docs/en/api/http/messages/create
const userBlock = (block: Record<string, unknown>) => ({ messages: [{ role: "user", content: [block] }] });
const assistantBlock = (block: Record<string, unknown>) => ({ messages: [{ role: "assistant", content: [block] }] });
const functionTool = { name: "lookup", input_schema: { type: "object", properties: {} } };

describe("Claude translated compatibility", () => {
  const rejected: Array<[string, Record<string, unknown>, string[]]> = [
    ["document", userBlock({ type: "document", source: { type: "text", media_type: "text/plain", data: "private-fixture" } }), ["documents"]],
    ["nested document", userBlock({ type: "tool_result", tool_use_id: "t1", content: [{ type: "document" }] }), ["documents"]],
    ["thinking replay", assistantBlock({ type: "thinking", thinking: "private-fixture", signature: "private-signature" }), ["thinking_replay"]],
    ["redacted replay", assistantBlock({ type: "redacted_thinking", data: "opaque-fixture" }), ["thinking_replay"]],
    ["hosted search", { tools: [{ type: "tool_search_tool_regex_20251119", name: "tool_search" }] }, ["tool_search"]],
    ["hosted search history", assistantBlock({ type: "server_tool_use", name: "tool_search", id: "srv1", input: {} }), ["tool_search"]],
    ["search result", userBlock({ type: "tool_search_tool_result", tool_use_id: "srv1", content: { type: "tool_search_tool_search_result", tool_references: [] } }), ["tool_search"]],
    ["client search reference", userBlock({ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_reference", tool_name: "lookup" }] }), ["tool_reference"]],
    ["deferred tool", { tools: [{ ...functionTool, defer_loading: true }] }, ["deferred_tools"]],
    ["strict tool", { tools: [{ ...functionTool, strict: true }] }, ["strict_tools"]],
    ["programmatic caller", { tools: [{ ...functionTool, allowed_callers: ["code_execution_20260120"] }] }, ["caller_mode"]],
    ["caller replay", assistantBlock({ type: "tool_use", name: "lookup", id: "t1", input: {}, caller: { type: "code_execution_20260120", tool_id: "srv1" } }), ["caller_mode"]],
    ["structured output", { output_config: { format: { type: "json_schema", schema: { type: "object" } } } }, ["structured_output"]],
    ["service tier", { service_tier: "standard_only" }, ["service_tier"]],
    ["MCP connector", { mcp_servers: [{ type: "url", url: "https://example.invalid/mcp", authorization_token: "private-fixture" }] }, ["mcp_tool"]],
    ["MCP toolset", { tools: [{ type: "mcp_toolset", mcp_server_name: "example" }] }, ["mcp_tool"]],
    ["MCP replay", assistantBlock({ type: "mcp_tool_use", id: "t1", name: "lookup" }), ["mcp_tool"]],
    ["web search controls", { tools: [{ type: "web_search_20250305", name: "web_search", allowed_domains: ["example.invalid"], max_uses: 1 }] }, ["web_search_tool"]],
    ["web search result", userBlock({ type: "web_search_tool_result", content: [] }), ["web_search_tool"]],
    ["code execution", { tools: [{ type: "code_execution_20260120", name: "code_execution" }] }, ["code_execution"]],
    ["computer toolset", { tools: [{ type: "computer_toolset_20260801", name: "computer" }] }, ["computer_use"]],
    ["context editing", { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }, ["context_management"]],
    ["container", { container: "private-container" }, ["container"]],
    ["placement", { inference_geo: "us" }, ["inference_geo"]],
    ["profile", { user_profile_id: "private-profile" }, ["user_profile"]],
    ["unknown body field", { future_option: "private-fixture" }, ["unknown_body_field"]],
    ["unknown content", userBlock({ type: "future_block", payload: "private-fixture" }), ["unknown_content_block"]],
    ["nested unknown content", userBlock({ type: "tool_result", tool_use_id: "t1", content: [{ type: "future_block" }] }), ["unknown_content_block"]],
    ["name cannot hide unsupported type", { tools: [{ type: "future_server_tool", name: "tool_search", input_schema: {} }] }, ["server_tool"]],
  ];
  for (const [name, body, featureCodes] of rejected) {
    test(`rejects ${name} in enforce and observes it in shadow`, () => {
      const enforce = analyzeClaudeCompatibility(body, { mode: "enforce" });
      expect(enforce).toMatchObject({ decision: "reject", compatible: false, featureCodes });
      const shadow = analyzeClaudeCompatibility(body, { mode: "shadow" });
      expect(shadow).toMatchObject({ decision: "shadow", compatible: false, featureCodes });
      for (const result of [enforce, shadow]) {
        expect(result.reason?.length).toBeLessThanOrEqual(512);
        expect(JSON.stringify(result)).not.toContain("private-");
        expect(JSON.stringify(result)).not.toContain("example.invalid");
      }
    });
  }

  test("ordinary client names, schemas and arguments are not protocol declarations", () => {
    for (const name of ["mcp_lookup", "tool_search", "tool_search_tool_local", "safe_code_execution", "computer"]) {
      const result = analyzeClaudeCompatibility({
        tools: [{ ...functionTool, name, type: "function", input_schema: {
          type: "object", properties: { cache_control: { type: "string" }, strict: { const: true } },
        } }],
        messages: [{ role: "assistant", content: [{ type: "tool_use", name, id: "t1", input: {
          type: "document", defer_loading: true, mcp_servers: [],
        } }] }],
      }, { mode: "enforce" });
      expect(result).toEqual({ decision: "allow", compatible: true, featureCodes: [] });
    }
  });

  test("inactive flags and direct callers remain ordinary tools", () => {
    expect(analyzeClaudeCompatibility({
      defer_tools: false, deferred_tools: [],
      tools: [{ ...functionTool, strict: false, defer_loading: false, allowed_callers: ["direct"] }],
      messages: [{ role: "assistant", content: [{ type: "tool_use", name: "lookup", id: "t1", input: {}, caller: { type: "direct" } }] }],
    }, { mode: "enforce" })).toEqual({ decision: "allow", compatible: true, featureCodes: [] });
  });

  test("cache hints, examples and thinking settings are explicitly tolerated degradation", () => {
    for (const thinking of [{ type: "disabled" }, { type: "enabled", budget_tokens: 2048 }, { type: "adaptive" }]) {
      expect(analyzeClaudeCompatibility({
        thinking,
        system: [{ type: "text", text: "private-fixture", cache_control: { type: "ephemeral", ttl: "1h" } }],
        tools: [{ ...functionTool, input_examples: [{ value: "private-example" }] }],
      }, { mode: "enforce" })).toEqual({
        decision: "allow", compatible: true, featureCodes: ["cache_control", "input_examples", "thinking_settings"],
      });
    }
  });

  test("header volume cannot hide semantic rejection or persist header text", () => {
    const result = analyzeClaudeCompatibility(userBlock({ type: "document" }), {
      mode: "enforce", anthropicBeta: Array.from({ length: 100 }, (_, i) => `private-header-${i}`).join(","),
    });
    expect(result).toEqual({
      decision: "reject", compatible: false, featureCodes: ["documents", "unknown_beta"],
      reason: "unsupported translated Claude features: documents",
    });
    expect(analyzeClaudeCompatibility({}, { mode: "enforce", anthropicBeta: "private-header" })).toEqual({
      decision: "allow", compatible: true, featureCodes: ["unknown_beta"],
    });
  });

  test("mode recognition is exact", () => {
    expect(isClaudeCompatibilityMode("shadow")).toBe(true);
    expect(isClaudeCompatibilityMode("enforce")).toBe(true);
    for (const value of [undefined, null, false, 1, {}, [], "ENFORCE", "enforce ", "invalid"]) {
      expect(isClaudeCompatibilityMode(value)).toBe(false);
    }
  });
});
