import { describe, expect, test } from "bun:test";
import { normalizeOpenGatewayResponsesInput } from "../../../src/adapters/openai-responses/opengateway-input";

const url = "https://apis.opengateway.ai/v1/responses";
const image = (id: string, detail = "original") => ({
  type: "input_image",
  image_url: `data:image/png;base64,${id}`,
  detail,
});

function project(input: unknown[], destination = url): unknown[] {
  const body = { model: "m", input };
  const snapshot = JSON.stringify(body);
  const normalized = normalizeOpenGatewayResponsesInput(body, destination) as { input: unknown[] };
  expect(JSON.stringify(body)).toBe(snapshot);
  return normalized.input;
}

describe("OpenGateway input normalization", () => {
  test("a query-routed variant stays untouched under the exact-URL contract", () => {
    const body = { input: [{ type: "function_call_output", call_id: "a", output: [{ type: "input_text", text: "synthetic" }] }] };
    expect(normalizeOpenGatewayResponsesInput(body, "https://apis.opengateway.ai/v1/responses?route=custom")).toBe(body);
  });

  test("text projection keeps call ids and does not depend on completion recovery", () => {
    const input = project([
      { type: "function_call", call_id: "call_a", name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: [
        { type: "input_text", text: "first" },
        { type: "output_text", text: "second" },
      ] },
    ]);
    expect(input.map(item => (item as { type: string }).type)).toEqual(["function_call", "function_call_output"]);
    expect(input[1]).toEqual({
      type: "function_call_output",
      call_id: "call_a",
      output: "first\nsecond",
    });
  });

  test("image messages stay after the aligned tool group, not between a call and its output", () => {
    const input = project([
      { type: "reasoning", id: "rs_1", summary: [] },
      { type: "function_call", call_id: "a", name: "echo", arguments: "{}" },
      { type: "function_call", call_id: "b", name: "echo", arguments: "{}" },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "hook" }] },
      { type: "function_call_output", call_id: "a", output: [{ type: "input_text", text: "A" }, image("AAA")] },
      { type: "function_call_output", call_id: "b", output: [{ type: "input_text", text: "B" }, image("BBB", "high")] },
    ]);
    expect(input.map(item => (item as { type: string }).type)).toEqual([
      "reasoning", "function_call", "function_call", "function_call_output", "function_call_output",
      "message", "message", "message",
    ]);
    expect(input[1]).toMatchObject({ call_id: "a" });
    expect(input[2]).toMatchObject({ call_id: "b" });
    expect(input[3]).toMatchObject({ call_id: "a", output: "A" });
    expect(input[4]).toMatchObject({ call_id: "b", output: "B" });
    expect(input[5]).toMatchObject({
      role: "user",
      content: [
        { type: "input_text", text: "[tool output for a]" },
        { type: "input_text", text: "A" },
        { ...image("AAA"), detail: "high" },
      ],
    });
    expect(input[6]).toMatchObject({ role: "user", content: expect.arrayContaining([image("BBB", "high")]) });
    expect(input[7]).toMatchObject({ role: "developer" });
  });

  test("a later tool round is not split by the previous image message", () => {
    const input = project([
      { type: "function_call", call_id: "a", name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: [image("AAA")] },
      { type: "function_call", call_id: "b", name: "echo", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: [{ type: "input_text", text: "done" }] },
    ]);
    expect(input.map(item => (item as { type?: string; call_id?: string }).call_id ?? (item as { type: string }).type)).toEqual([
      "a", "a", "b", "b", "message",
    ]);
    expect(input[1]).toMatchObject({ call_id: "a", output: "[tool output for a]" });
    expect(input[3]).toMatchObject({ call_id: "b", output: "done" });
  });

  test("unsupported or malformed result parts are refused explicitly", () => {
    for (const output of [
      [{ type: "refusal", refusal: "no" }],
      [{ type: "input_text", text: "keep-me" }, { type: "encrypted_content", encrypted_content: "opaque" }],
      [{ type: "input_image", detail: "high" }],
      [{ type: "input_image", image_url: "" }],
      [{ type: "input_image", image_url: "data:image/png;base64,AAA", detail: "unknown" }],
      [{ type: "input_image", image_url: 42, file_id: "file_1" }],
      [{ type: "input_text", text: 42 }],
      [{ type: "input_file", file_id: "file_1" }],
      [null],
    ]) {
      expect(() => project([
        { type: "function_call", call_id: "a", name: "echo", arguments: "{}" },
        { type: "function_call_output", call_id: "a", output },
      ])).toThrow("OpenGateway cannot preserve this tool result");
    }
    expect(() => project([
      { type: "function_call_output", output: [{ type: "input_text", text: "orphan" }] },
    ])).toThrow("OpenGateway cannot preserve this tool result");
  });

  test("an empty array is a string, and another destination is untouched", () => {
    expect(project([
      { type: "function_call_output", call_id: "a", output: [] },
    ])[0]).toMatchObject({ output: "" });
    const output = [{ type: "input_text", text: "stay" }, image("AAA")];
    expect(project([
      { type: "function_call_output", call_id: "a", output },
    ], "https://api.openai.com/v1")[0]).toMatchObject({ output });
  });
});
