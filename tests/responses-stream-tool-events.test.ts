import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<{ event?: string; data: Record<string, unknown> }[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => {
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event: "))?.slice(7);
      const dataLine = lines.find(line => line.startsWith("data: "));
      return { event, data: JSON.parse(dataLine?.slice(6) ?? "{}") as Record<string, unknown> };
    });
}

describe("Responses streaming tool event contract", () => {
  test("undeclared upstream tool names fail closed with a compatibility error", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_bad", name: "apply_patch" },
      { type: "tool_call_delta", arguments: '{"input":"*** Begin Patch"}' },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "deepseek/deepseek-v4-flash", undefined, undefined, undefined, undefined, undefined, {
      declaredToolNames: new Set(["exec"]),
    }));

    expect(frames.some(frame => frame.event === "response.output_item.added")).toBe(false);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
    const failed = frames.find(frame => frame.event === "response.failed")?.data.response as Record<string, unknown>;
    expect((failed.error as Record<string, unknown>).message).toContain("undeclared client tool");
    expect((failed.error as Record<string, unknown>).message).toContain("apply_patch");
  });

  test("adapter tool events produce OpenAI-compatible streamed function-call frames", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_1", name: "read_file" },
      { type: "tool_call_delta", arguments: "{\"path\"" },
      { type: "tool_call_delta", arguments: ":\"a.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "cursor/composer-2.5"));

    expect(frames.some(frame => frame.event === "response.output_item.added")).toBe(true);
    expect(frames.filter(frame => frame.event === "response.function_call_arguments.delta").map(frame => frame.data.delta))
      .toEqual(["{\"path\"", ":\"a.txt\"}"]);
    expect(frames.find(frame => frame.event === "response.function_call_arguments.done")?.data.arguments)
      .toBe("{\"path\":\"a.txt\"}");
    const completed = frames.find(frame => frame.event === "response.completed")?.data.response as Record<string, unknown>;
    const output = completed.output as Record<string, unknown>[];
    expect(output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: "{\"path\":\"a.txt\"}",
      status: "completed",
    });
  });

  test("terminal error cancels an open tool call instead of completing it", async () => {
    // #765 remainder: adapter error with an open tool call must not emit
    // function_call_arguments.done / status:"completed" before response.failed.
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_bad", name: "get_weather" },
      { type: "tool_call_delta", arguments: "not json" },
      { type: "error", message: "Anthropic stream sent malformed tool_use arguments (invalid JSON)" },
    ]), "routed/model"));

    expect(frames.some(frame => frame.event === "response.function_call_arguments.done")).toBe(false);
    const itemDone = frames.filter(frame => frame.event === "response.output_item.done")
      .map(frame => frame.data.item as Record<string, unknown>)
      .find(item => item?.type === "function_call");
    expect(itemDone).toMatchObject({
      type: "function_call",
      call_id: "call_bad",
      status: "incomplete",
    });
    const failed = frames.find(frame => frame.event === "response.failed");
    expect(failed).toBeTruthy();
    const failedOutput = (failed?.data.response as Record<string, unknown>).output as Record<string, unknown>[];
    expect(failedOutput.some(item => item.type === "function_call" && item.status === "completed")).toBe(false);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
  });

  test("malformed assembled arguments at tool_call_end fail the turn without completing", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_1", name: "get_weather" },
      { type: "tool_call_delta", arguments: "not json" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "routed/model"));

    expect(frames.some(frame => frame.event === "response.function_call_arguments.done")).toBe(false);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
    const failed = frames.find(frame => frame.event === "response.failed");
    expect(failed).toBeTruthy();
    const itemDone = frames.filter(frame => frame.event === "response.output_item.done")
      .map(frame => frame.data.item as Record<string, unknown>)
      .find(item => item?.type === "function_call");
    expect(itemDone).toMatchObject({ status: "incomplete" });
  });

  test("whitespace-only assembled arguments fail instead of completing invalid JSON", async () => {
    const frames = await collectSse(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_space", name: "read_file" },
      { type: "tool_call_delta", arguments: " \t" },
      { type: "tool_call_end" },
      { type: "done" },
    ]), "cursor/composer-2.5"));

    expect(frames.some(frame => frame.event === "response.function_call_arguments.done")).toBe(false);
    expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
    const itemDone = frames.filter(frame => frame.event === "response.output_item.done")
      .map(frame => frame.data.item as Record<string, unknown>)
      .find(item => item?.type === "function_call");
    expect(itemDone).toMatchObject({ call_id: "call_space", status: "incomplete" });
    expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
  });

  test("JSON-invalid Unicode prefixes fail instead of being trimmed into valid arguments", async () => {
    for (const [index, argumentsText] of ["\u00A0{}", "\uFEFF{}"].entries()) {
      const callId = `call_unicode_${index}`;
      const frames = await collectSse(bridgeToResponsesSSE(replay([
        { type: "tool_call_start", id: callId, name: "read_file" },
        { type: "tool_call_delta", arguments: argumentsText },
        { type: "tool_call_end" },
        { type: "done" },
      ]), "cursor/composer-2.5"));

      expect(frames.some(frame => frame.event === "response.function_call_arguments.done")).toBe(false);
      expect(frames.some(frame => frame.event === "response.completed")).toBe(false);
      const itemDone = frames.filter(frame => frame.event === "response.output_item.done")
        .map(frame => frame.data.item as Record<string, unknown>)
        .find(item => item?.type === "function_call");
      expect(itemDone).toMatchObject({ call_id: callId, arguments: argumentsText, status: "incomplete" });
      expect(frames.some(frame => frame.event === "response.failed")).toBe(true);
    }
  });

  test("non-streaming malformed arguments stop before later parallel calls", () => {
    const response = buildResponseJSON([
      { type: "tool_call_start", id: "call_space", name: "read_file" },
      { type: "tool_call_delta", arguments: " \t" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "call_late", name: "write_file" },
      { type: "tool_call_delta", arguments: "{\"path\":\"safe.txt\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ], "cursor/composer-2.5");

    expect(response.status).toBe("failed");
    expect(response.error).toMatchObject({ type: "upstream_error" });
    const output = response.output as Record<string, unknown>[];
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      type: "function_call", call_id: "call_space", arguments: " \t", status: "incomplete",
    });
    expect(output.some(item => item.call_id === "call_late")).toBe(false);
  });
});
