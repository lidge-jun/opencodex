import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
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
});
