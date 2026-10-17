import { describe, expect, spyOn, test } from "bun:test";
import { functionCallArgumentsFromText, parseRequest } from "../../src/responses/parser";

const suffix = "</function></tool_call>";

describe("MiMo function-call history envelope", () => {
  test.each([
    ['{"code":"run()' + suffix, { code: "run()" }],
    ['{"code":"run()"' + suffix, { code: "run()" }],
    ['{"code":"run()"}' + suffix, { code: "run()" }],
    ['{"code":"if (ready) {}' + suffix, { code: "if (ready) {}" }],
    ['{"code":"run()  ' + suffix, { code: "run()  " }],
  ] as const)("restores a bounded object envelope: %s", (text, expected) => {
    expect(functionCallArgumentsFromText("call_mimo", text)).toEqual(expected);
  });

  test("an escaped terminal quote remains inside the repaired string", () => {
    const expected = { code: 'print("ready")"' };
    const text = JSON.stringify(expected).slice(0, -2) + suffix;
    expect(functionCallArgumentsFromText("call_escaped", text)).toEqual(expected);
  });

  test("valid JSON preserves embedded tags and escaped quotes", () => {
    const expected = { code: `print("${suffix}")` };
    expect(functionCallArgumentsFromText("call_valid", JSON.stringify(expected))).toEqual(expected);
  });

  test.each([
    '{"code":"run()',
    '{"code":"run()' + suffix + ' trailing',
    'plain text' + suffix,
    '["run()"]' + suffix,
    '{"nested":{"code":"run()' + suffix,
  ])("unrelated malformed text retains the empty-object fallback: %s", text => {
    expect(functionCallArgumentsFromText("call_bad", text)).toEqual({});
  });

  test("parseRequest restores a call before its tool output", () => {
    const parsed = parseRequest({
      model: "mimo-test",
      input: [
        { type: "function_call", call_id: "call_history", name: "js", arguments: '{"code":"run()' + suffix },
        { type: "function_call_output", call_id: "call_history", output: "done" },
      ],
    });
    const assistant = parsed.context.messages.find(message => message.role === "assistant");
    expect(assistant?.content.find(part => part.type === "toolCall")).toMatchObject({
      type: "toolCall", id: "call_history", name: "js", arguments: { code: "run()" },
    });
  });

  test("fallback diagnostics never include raw argument content", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      functionCallArgumentsFromText("call_private", '{"private":"argument-content-marker');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("argument-content-marker");
    } finally { warn.mockRestore(); }
  });
});
