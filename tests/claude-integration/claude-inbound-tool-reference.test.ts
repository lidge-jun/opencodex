import { describe, expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { parseRequest } from "../../src/responses/parser";
import { responsesRequestSchema } from "../../src/responses/schema";

function request(content: unknown[], isError = false) {
  return {
    model: "routed-model", max_tokens: 256,
    tools: [{ name: "ToolSearch", input_schema: { type: "object", properties: {} } }],
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "search_1", name: "ToolSearch", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "search_1", is_error: isError, content }] },
      { role: "user", content: "Continue the original task." },
    ],
  };
}

describe("translated Claude tool references", () => {
  test("reference-only ToolSearch results survive schema parsing and retain the call slot", () => {
    const raw = request([
      { type: "tool_reference", tool_name: "WebFetch" },
      { type: "tool_reference", tool_name: "mcp__docs__lookup" },
    ]);
    const before = JSON.stringify(raw);
    const body = anthropicToResponsesBody(raw);
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    expect(() => parseRequest(body)).not.toThrow();
    expect(body.input).toEqual([
      { type: "function_call", call_id: "search_1", name: "ToolSearch", arguments: "{}" },
      { type: "function_call_output", call_id: "search_1", output: [
        { type: "input_text", text: "Tool loaded: WebFetch\n" },
        { type: "input_text", text: "Tool loaded: mcp__docs__lookup\n" },
      ] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue the original task." }] },
    ]);
    expect(JSON.stringify(raw)).toBe(before);
    // A result describes client-loaded tools; it must not add executable declarations.
    expect(body.tools).toHaveLength(1);
  });

  test("mixed output preserves order and errors without mutating frozen references", () => {
    const reference = Object.freeze({ type: "tool_reference", tool_name: "Read" });
    const body = anthropicToResponsesBody(request([
      { type: "text", text: "Before" }, reference,
      { type: "image", source: { type: "url", url: "https://example.invalid/fixture.png" } },
      { type: "text", text: "After" },
    ], true));
    expect(body.input[1]).toEqual({ type: "function_call_output", call_id: "search_1", output: [
      { type: "input_text", text: "[tool error]" },
      { type: "input_text", text: "Before" },
      { type: "input_text", text: "\nTool loaded: Read\n" },
      { type: "input_image", image_url: "https://example.invalid/fixture.png" },
      { type: "input_text", text: "After" },
    ] });
    expect(reference).toEqual({ type: "tool_reference", tool_name: "Read" });
  });

  test("loaded names stay line-separated after the parser joins text-only output", () => {
    const parsed = parseRequest(anthropicToResponsesBody(request([
      { type: "text", text: "Before" },
      { type: "tool_reference", tool_name: "Read" },
      { type: "tool_reference", tool_name: "Write" },
      { type: "text", text: "After" },
    ])));
    const result = parsed.context.messages.find((message) => message.role === "toolResult");
    expect(result?.content).toBe("Before\nTool loaded: Read\nTool loaded: Write\nAfter");
    const onlyRefs = parseRequest(anthropicToResponsesBody(request([
      { type: "tool_reference", tool_name: "WebFetch" },
      { type: "tool_reference", tool_name: "mcp__docs__lookup" },
    ])));
    expect(onlyRefs.context.messages.find((message) => message.role === "toolResult")?.content)
      .toBe("Tool loaded: WebFetch\nTool loaded: mcp__docs__lookup\n");
  });

  test("missing, non-string and empty names do not fabricate loaded tools", () => {
    const body = anthropicToResponsesBody(request([
      { type: "tool_reference" }, { type: "tool_reference", tool_name: 42 },
      { type: "tool_reference", tool_name: "" }, { type: "text", text: "Still present" },
    ]));
    expect(body.input[1]).toEqual({ type: "function_call_output", call_id: "search_1", output: [
      { type: "input_text", text: "Still present" },
    ] });
  });
});
