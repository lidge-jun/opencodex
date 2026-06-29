import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";

describe("Responses parser", () => {
  test("preserves allowed_tools tool_choice instead of widening it to auto", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "search",
      tools: [
        {
          type: "function",
          name: "web_search",
          description: "Search",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
        {
          type: "function",
          name: "run_tests",
          description: "Run tests",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "function", name: "web_search" }],
      },
    });

    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["web_search"], mode: "required" });
  });

  test("maps hosted allowed_tools entries to their synthetic routed tool names", () => {
    const parsed = parseRequest({
      model: "umans/umans-kimi-k2.7",
      input: "search",
      tools: [{ type: "web_search", search_context_size: "medium" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "required",
        tools: [{ type: "web_search" }],
      },
    });

    expect(parsed._webSearch).toEqual({ type: "web_search", search_context_size: "medium" });
    expect(parsed.options.toolChoice).toEqual({ allowedTools: ["web_search"], mode: "required" });
  });

  test("preserves requested service_tier for request logging", () => {
    const parsed = parseRequest({
      model: "gpt-5.5",
      input: "fast check",
      stream: true,
      service_tier: "priority",
    });

    expect(parsed.options.serviceTier).toBe("priority");
  });

  test("preserves input_image blocks from function_call_output", () => {
    const parsed = parseRequest({
      model: "kiro/claude-sonnet-4.5",
      input: [
        { type: "function_call", call_id: "call-1", name: "get_app_state", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [
            { type: "output_text", text: "Looked at Google Chrome" },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=", detail: "high" },
          ],
        },
      ],
    });
    const result = parsed.context.messages.find(m => m.role === "toolResult");

    expect(result?.content).toEqual([
      { type: "text", text: "Looked at Google Chrome" },
      { type: "image", imageUrl: "data:image/png;base64,aGVsbG8=", detail: "high" },
    ]);
  });
});
