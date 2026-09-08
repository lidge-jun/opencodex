import { describe, expect, test } from "bun:test";
import { anthropicToResponsesBody } from "../../src/claude/inbound";

describe("Claude source envelope boundaries", () => {
  test("nested tool results retain only bounded structured content", () => {
    const body = anthropicToResponsesBody({
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [
          { type: "text", text: "ok" },
          { type: "document", title: "report" },
          { type: "future_block", payload: "secret-payload" },
        ] }] },
      ],
    }) as any;
    expect(body.input.map((item: any) => item.type)).toEqual(["function_call", "function_call_output"]);
    expect(body.input[1].output).toEqual([
      { type: "input_text", text: "ok" },
      { type: "input_text", text: "[document: report]" },
    ]);
    expect(JSON.stringify(body)).not.toContain("secret-payload");
  });

  test("malformed tool results fail closed instead of becoming an unpaired output", () => {
    expect(() => anthropicToResponsesBody({
      model: "m", messages: [{ role: "user", content: [{ type: "tool_result", content: "secret-payload" }] }],
    })).toThrow(/unknown|unpaired|tool/i);
  });
});
