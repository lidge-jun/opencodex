import { describe, expect, test } from "bun:test";
import { createGithubCopilotResponsesBlockRewrite } from "../src/server/github-copilot-responses-repair";
import { relaySseWithBlockRewrite } from "../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function streamFromChunks(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function frame(type: string, payload: Record<string, unknown>, newline = "\n"): string {
  return `event: ${type}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`;
}

function parsedFrames(text: string): Array<{ event?: string; payload: Record<string, unknown> }> {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.find(line => line.startsWith("data:"))?.slice(5).trim();
      if (!data || data === "[DONE]") return null;
      return { event, payload: JSON.parse(data) as Record<string, unknown> };
    })
    .filter((entry): entry is { event?: string; payload: Record<string, unknown> } => entry !== null);
}

describe("GitHub Copilot Responses SSE repair", () => {
  test("reconstructs a custom-tool input as separately named plaintext frames", async () => {
    const upstream = [
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 40,
        item: { type: "custom_tool_call", id: "ctc-first", call_id: "call-1", name: "apply_patch", input: "" },
      }),
      frame("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        output_index: 0,
        item_id: "ctc-cipher-delta",
        sequence_number: 41,
        delta: "cipher-tool-input",
        obfuscation: "padding-or-key",
      }),
      frame("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        output_index: 0,
        item_id: "ctc-cipher-input-done",
        sequence_number: 42,
        input: "*** Begin Patch\n*** End Patch",
      }),
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 43,
        item: {
          type: "custom_tool_call",
          id: "ctc-cipher-item-done",
          call_id: "call-1",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
      }),
    ].join("");

    const budget = createTestTranslatorBudget();
    const splitAt = upstream.indexOf("cipher-tool-input") + 5;
    expect(splitAt).toBeGreaterThan(5);
    const rewritten = await readAll(relaySseWithBlockRewrite(
      streamFromChunks(upstream.slice(0, splitAt), upstream.slice(splitAt)),
      createGithubCopilotResponsesBlockRewrite(budget),
      budget,
    ));
    const events = parsedFrames(rewritten);

    expect(events.map(event => event.payload.type)).toEqual([
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
    ]);
    expect(events.map(event => event.event)).toEqual(events.map(event => event.payload.type));
    expect(events.map(event => event.payload.sequence_number)).toEqual([0, 1, 2, 3]);
    expect(events.slice(1, 3).map(event => event.payload.item_id)).toEqual([
      "ctc-first",
      "ctc-first",
    ]);
    expect(events.slice(1, 3).map(event => event.payload.delta ?? event.payload.input)).toEqual([
      "*** Begin Patch\n*** End Patch",
      "*** Begin Patch\n*** End Patch",
    ]);
    expect((events[3]!.payload.item as { id: string }).id).toBe("ctc-first");
    expect(rewritten).not.toContain("obfuscation");
    expect(rewritten).not.toContain("cipher-tool-input");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("continues relaying when output-index retention reaches its count cap", async () => {
    const upstream = Array.from({ length: 257 }, (_, outputIndex) => frame(
      "response.output_item.added",
      {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "message", id: `message-${outputIndex}`, role: "assistant", content: [] },
      },
    )).join("");
    const budget = createTestTranslatorBudget();

    const rewritten = await readAll(relaySseWithBlockRewrite(
      streamFromChunks(upstream),
      createGithubCopilotResponsesBlockRewrite(budget),
      budget,
    ));
    const events = parsedFrames(rewritten);

    expect(events).toHaveLength(257);
    expect((events[0]!.payload.item as { id: string }).id).toBe("message-0");
    expect((events[255]!.payload.item as { id: string }).id).toBe("message-255");
    expect((events[256]!.payload.item as { id: string }).id).toBe("message-256");
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("preserves readable delta content when OpenAI-style padding is present", async () => {
    const upstream = frame("response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg-readable",
      sequence_number: 7,
      delta: "bonjour",
      obfuscation: "random-padding",
    });
    const budget = createTestTranslatorBudget();
    const rewritten = await readAll(relaySseWithBlockRewrite(
      streamFromChunks(upstream),
      createGithubCopilotResponsesBlockRewrite(budget),
      budget,
    ));

    expect(rewritten).toContain('"delta":"bonjour"');
    expect(rewritten).not.toContain("obfuscation");
  });

  test("removes encrypted reasoning state, preserves readable summaries, and pins ids", async () => {
    const upstream = [
      frame("response.created", {
        type: "response.created",
        sequence_number: 10,
        response: { id: "resp-first", status: "in_progress", output: [] },
      }),
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 11,
        item: { type: "reasoning", id: "rs-first", summary: [], encrypted_content: "reasoning-cipher-1" },
      }),
      frame("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        item_id: "rs-cipher-delta",
        summary_index: 0,
        sequence_number: 12,
        delta: "plan lisible",
        obfuscation: "padding-or-key",
      }),
      frame("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 13,
        item: {
          type: "reasoning",
          id: "rs-cipher-done",
          summary: [{ type: "summary_text", text: "plan lisible" }],
          encrypted_content: "reasoning-cipher-2",
        },
      }),
      frame("response.completed", {
        type: "response.completed",
        sequence_number: 14,
        response: {
          id: "resp-cipher-completed",
          status: "completed",
          output: [{
            type: "reasoning",
            id: "rs-cipher-completed",
            summary: [{ type: "summary_text", text: "plan lisible" }],
            encrypted_content: "reasoning-cipher-3",
          }],
        },
      }),
    ].join("");
    const budget = createTestTranslatorBudget();
    const rewritten = await readAll(relaySseWithBlockRewrite(
      streamFromChunks(upstream),
      createGithubCopilotResponsesBlockRewrite(budget),
      budget,
    ));
    const events = parsedFrames(rewritten);

    expect(rewritten).not.toContain("encrypted_content");
    expect(rewritten).not.toContain("reasoning-cipher");
    expect(events[2]!.payload.delta).toBe("plan lisible");
    expect(events[2]!.payload.item_id).toBe("rs-first");
    expect((events[3]!.payload.item as { id: string }).id).toBe("rs-first");
    const completed = events[4]!.payload.response as { id: string; output: Array<{ id: string; summary: unknown[] }> };
    expect(completed.id).toBe("resp-first");
    expect(completed.output[0]!.id).toBe("rs-first");
    expect(completed.output[0]!.summary).toEqual([{ type: "summary_text", text: "plan lisible" }]);
  });

  test("consolidates unpadded function arguments and preserves CRLF framing", async () => {
    const upstream = [
      frame("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 0,
        item: { type: "function_call", id: "fc-first", call_id: "call-fn", name: "shell", arguments: "" },
      }, "\r\n"),
      frame("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        item_id: "fc-cipher",
        sequence_number: 1,
        delta: "function-cipher",
      }, "\r\n"),
      frame("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        output_index: 0,
        item_id: "fc-done-cipher",
        sequence_number: 2,
        arguments: "{\"command\":\"pwd\"}",
      }, "\r\n"),
    ].join("");
    const budget = createTestTranslatorBudget();
    const rewritten = await readAll(relaySseWithBlockRewrite(
      streamFromChunks(upstream),
      createGithubCopilotResponsesBlockRewrite(budget),
      budget,
    ));
    const events = parsedFrames(rewritten);

    expect(events.map(event => event.payload.type)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
    ]);
    expect(events[1]!.payload.delta).toBe('{"command":"pwd"}');
    expect(events.slice(1).every(event => event.payload.item_id === "fc-first")).toBe(true);
    expect(rewritten).not.toContain("function-cipher");
    expect(rewritten).toContain("\r\n\r\n");
    expect(rewritten.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("passes malformed and sentinel blocks through without throwing", () => {
    const rewrite = createGithubCopilotResponsesBlockRewrite();
    expect(rewrite("event: message\ndata: {not-json")).toEqual(["event: message\ndata: {not-json"]);
    expect(rewrite("data: [DONE]")).toEqual(["data: [DONE]"]);
    rewrite.dispose?.();
  });
});
