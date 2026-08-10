import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import { decodeReasoningEnvelope } from "../src/responses/reasoning-envelope";
import type { AdapterEvent } from "../src/types";
import { createTranslatorBudget } from "../src/lib/translator-budget";

const BLOB = "LktUUn5+ZXlKbGJtTnllWEIwYVc5dVVtVm5hVzl1SWpvaQ==";

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const event of events) yield event;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** Output items in emission order, as Codex reconstructs them from the SSE stream. */
function doneItems(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown>; output_index?: number };
      if (json.type === "response.output_item.done" && json.item) {
        items.push({ ...json.item, __index: json.output_index });
      }
    } catch { /* partial frame */ }
  }
  return items;
}

/** Feed emitted items back as Responses input, the way Codex replays history next turn. */
function reparse(items: Record<string, unknown>[]) {
  return parseRequest({
    model: "kiro/gpt-5.6-sol",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ...items.map(({ __index, status, ...item }) => item),
    ],
  });
}

// Kiro emits its reasoning blob at the END of a turn, while the assistant message is still open.
// Emitting the envelope item on arrival reused the open message's output_index AND placed the blob
// before the message, where the parser's backwards pairing drops it as orphaned — silently
// defeating the round-trip. Both paths must defer it until the message has closed.
describe("kiro redacted-reasoning round-trip (bridge → parse)", () => {
  const events: AdapterEvent[] = [
    { type: "text_delta", text: "the answer" },
    { type: "kiro_redacted_reasoning", data: BLOB },
    { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, endTurn: true },
  ];

  test("SSE: the blob lands after the assistant message, on its own output index", async () => {
    const items = doneItems(await drain(bridgeToResponsesSSE(replay(events), "kiro/gpt-5.6-sol")));
    const types = items.map(i => i.type);
    expect(types).toEqual(["message", "reasoning"]);

    const indexes = items.map(i => i.__index);
    expect(new Set(indexes).size).toBe(indexes.length); // no output_index collision

    const envelope = decodeReasoningEnvelope(items[1].encrypted_content as string);
    expect(envelope?.krc).toBe(BLOB);
    expect(items[1].summary).toEqual([]);
  });

  test("SSE: replayed history attaches the blob to the assistant turn that produced it", async () => {
    const items = doneItems(await drain(bridgeToResponsesSSE(replay(events), "kiro/gpt-5.6-sol")));
    const assistant = reparse(items).context.messages.find(m => m.role === "assistant");
    expect((assistant as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBe(BLOB);
  });

  test("batch: the blob lands after the assistant message and survives replay", () => {
    const response = buildResponseJSON(
      [
        { type: "text_delta", text: "the answer" },
        { type: "kiro_redacted_reasoning", data: BLOB },
        { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, endTurn: true },
      ],
      "kiro/gpt-5.6-sol",
    );
    const output = response.output as Record<string, unknown>[];
    expect(output.map(i => i.type)).toEqual(["message", "reasoning"]);

    const assistant = reparse(output).context.messages.find(m => m.role === "assistant");
    expect((assistant as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBe(BLOB);
  });

  test("batch: the raw blob is retained then released, leaving only the finalized items", () => {
    // A big blob makes the accounting unambiguous: the raw string is an allocation distinct from
    // the finalized item that embeds its base64.
    const bigBlob = "X".repeat(4000);
    const budget = createTranslatorBudget();
    const response = buildResponseJSON(
      [
        { type: "text_delta", text: "the answer" },
        { type: "kiro_redacted_reasoning", data: bigBlob },
        { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, endTurn: true },
      ],
      "kiro/gpt-5.6-sol",
      { translatorBudget: budget },
    );
    const items = response.output as Record<string, unknown>[];
    const finalizedBytes = items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);
    const { currentBytes, highWaterBytes, overflows } = budget.snapshot();

    // EXACTLY the finalized output items remain retained. A raw blob still held would show up as
    // ~4000 extra bytes here; releasing bytes that were never charged would show up as a shortfall.
    expect(currentBytes).toBe(finalizedBytes);
    // ...and it really was charged while held, rather than never accounted for at all.
    expect(highWaterBytes).toBeGreaterThanOrEqual(finalizedBytes + bigBlob.length);
    expect(overflows).toBe(0);
  });

  test("a turn ending in a tool call still pairs the blob with that assistant turn", async () => {
    const items = doneItems(await drain(bridgeToResponsesSSE(replay([
      { type: "tool_call_start", id: "call_1", name: "bash" },
      { type: "tool_call_delta", arguments: "{\"command\":\"ls\"}" },
      { type: "tool_call_end" },
      { type: "kiro_redacted_reasoning", data: BLOB },
      { type: "done", usage: { inputTokens: 1, outputTokens: 1 }, endTurn: false },
    ]), "kiro/gpt-5.6-sol")));
    expect(items.map(i => i.type)).toEqual(["function_call", "reasoning"]);

    const assistant = reparse(items).context.messages.find(m => m.role === "assistant");
    expect((assistant as { kiroRedactedReasoning?: string }).kiroRedactedReasoning).toBe(BLOB);
  });
});
