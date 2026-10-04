import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../../../src/adapters/ollama-native";
import { parseRequest } from "../../../src/responses/parser";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const provider = { adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
  apiKey: "inert-fixture-key", liveModels: false, models: ["deepseek-v4.1-flash"] } as OcxProviderConfig;
const user = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const exec = { type: "custom_tool_call", call_id: "call_A", name: "exec", input: "notify('progress')" };
const output = (text: string) => ({ type: "custom_tool_call_output", call_id: "call_A", output: text });
const wait = { type: "function_call", call_id: "call_B", name: "wait", arguments: '{"cell_id":"31"}' };
const waitOutput = { type: "function_call_output", call_id: "call_B", output: "Script completed" };
const tools = [{ type: "custom", name: "exec", description: "Run code" },
  { type: "function", name: "wait", description: "Wait", parameters: { type: "object", properties: {} } }];

/** Exercise the real Responses parser and native builder without sending an upstream request. */
function build(input: unknown[]) {
  const parsed = parseRequest({ model: "deepseek-v4.1-flash", stream: true, input, tools } as any);
  return JSON.parse(createOllamaNativeAdapter(provider).buildRequest(parsed).body).messages;
}

describe("Ollama code-mode additional output replay (#6574)", () => {
  test("the single-output control keeps its ordinary native tool carrier", () => {
    const messages = build([user("start"), exec, output("done"), user("continue")]);
    expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2]).toMatchObject({ tool_call_id: "call_A", content: "done" });
  });

  test("yield and notify outputs share one tool result in arrival order", () => {
    const messages = build([user("start"), exec, output("Script running with cell ID 31"),
      output("progress 1"), output("progress 2"), user("continue")]);
    expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2]).toMatchObject({ tool_call_id: "call_A",
      content: "Script running with cell ID 31\nprogress 1\nprogress 2" });
  });

  test("late notify output stays visible after a completed wait batch", () => {
    const messages = build([user("start"), exec, output("Script running with cell ID 31"),
      wait, waitOutput, output("late progress"), user("continue")]);
    expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "user", "user"]);
    expect(messages[4]).toMatchObject({ tool_call_id: "call_B", content: "Script completed" });
    expect(messages[5].content).toContain("[ocx] additional output");
    expect(messages[5].content).toContain("call_A");
    expect(messages[5].content).toContain("late progress");
    expect(messages[5]).not.toHaveProperty("tool_call_id");
  });

  test("a late result cannot split the next pending call/result pair", () => {
    const messages = build([user("start"), exec, output("yield"), wait, output("late progress"), waitOutput]);
    expect(messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "user"]);
    expect(messages[4].tool_call_id).toBe("call_B");
    expect(messages[5].content).toContain("late progress");
  });

  test("merged errors and images remain visible without mutating frozen source messages", () => {
    const call = { role: "assistant", timestamp: 0,
      content: [{ type: "toolCall", id: "call_A", name: "exec", namespace: "ops", arguments: {} }] };
    const result = { role: "toolResult", toolCallId: "call_A", toolName: "exec", toolNamespace: "ops",
      content: "yield", isError: false, timestamp: 1 };
    const second = { ...result, content: [{ type: "text", text: "failed fragment" },
      { type: "image", imageUrl: "data:image/png;base64,AA==" }], isError: true, timestamp: 2 };
    const parsed = { modelId: "deepseek-v4.1-flash", stream: true, options: {}, context: { messages: [call, result, second] } };
    const before = JSON.stringify(parsed);
    const freeze = (value: any): void => { if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child); Object.freeze(value);
    } };
    freeze(parsed);
    const messages = JSON.parse(createOllamaNativeAdapter(provider).buildRequest(parsed as OcxParsedRequest).body).messages;
    expect(messages[1].content).toContain("yield");
    expect(messages[1].content).toContain("ERROR:");
    expect(messages[1].content).toContain("failed fragment");
    expect(messages[1].images).toEqual(["AA=="]);
    expect(JSON.stringify(parsed)).toBe(before);
  });

  test("late output still validates the originating name and namespace", () => {
    const call = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id,
      name: "exec", namespace: "ops", arguments: {} }], timestamp: 0 });
    for (const invalid of [{ toolName: "other", toolNamespace: "ops" }, { toolName: "exec", toolNamespace: "other" }]) {
      const parsed = { modelId: "deepseek-v4.1-flash", stream: true, options: {}, context: { messages: [call("old"), call("new"),
        { role: "toolResult", toolCallId: "old", content: "bad", isError: false, timestamp: 1, ...invalid }] } };
      expect(() => createOllamaNativeAdapter(provider).buildRequest(parsed as OcxParsedRequest)).toThrow(/wrong originating tool/);
    }
  });

  test("unknown IDs are not repaired into invented tool calls", () => {
    const ghost = { type: "custom_tool_call_output", call_id: "never-issued", output: "ghost" };
    expect(() => build([user("start"), ghost])).toThrow(/orphan tool result/);
    expect(() => build([exec, output("done"), wait, ghost])).toThrow(/has no originating call/);
  });
});
