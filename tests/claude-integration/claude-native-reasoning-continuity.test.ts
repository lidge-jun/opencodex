import { describe, expect, test } from "bun:test";
import { sanitizeReasoningInputContent } from "../../src/adapters/openai-responses/reasoning";
import { anthropicToResponsesBody } from "../../src/claude/inbound";
import { responsesJsonToAnthropicMessage, responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, OCX_REASONING_PREFIX } from "../../src/responses/reasoning-envelope";
import { responsesRequestSchema } from "../../src/responses/schema";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const MODEL = "ocx-claude-meta-muse--muse-spark-1.3-contributor";
const OTHER_MODEL = "ocx-claude-native--gpt-6.1-sol";
const BLOB = "Q-PaDg-provider-minted-reasoning-blob==";
const TAG = "a".repeat(64);

function sse(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < text.length; i += 7) controller.enqueue(encoder.encode(text.slice(i, i + 7)));
      controller.close();
    },
  });
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<{ name: string; data: Record<string, any> }[]> {
  const text = await new Response(stream).text();
  const events: { name: string; data: Record<string, any> }[] = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim()) continue;
    let name = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event: ")) name = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    events.push({ name, data: JSON.parse(data) });
  }
  return events;
}

async function streamedThinking(frames: string[]): Promise<{ thinking: string; signature: string }[]> {
  const events = await collectEvents(responsesSseToAnthropicSse(streamFrom([
    ...frames,
    sse("response.completed", { response: { status: "completed", usage: {} } }),
  ].join("")), MODEL, { translatorBudget: createTestTranslatorBudget(), nativeReasoningTagFor: () => TAG }));
  const blocks: { thinking: string; signature: string }[] = [];
  for (const event of events) {
    if (event.name === "content_block_start" && event.data.content_block?.type === "thinking") blocks.push({ thinking: "", signature: "" });
    const delta = event.data.delta;
    if (event.name !== "content_block_delta" || !delta) continue;
    if (delta.type === "thinking_delta") blocks[blocks.length - 1]!.thinking += delta.thinking;
    if (delta.type === "signature_delta") blocks[blocks.length - 1]!.signature += delta.signature;
  }
  return blocks;
}

function replay(model: string, thinking: string, signature: string, thinkingConfig?: Record<string, unknown>) {
  return {
    model, max_tokens: 1024,
    ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    messages: [
      { role: "user", content: "Start the task." },
      { role: "assistant", content: [{ type: "thinking", thinking, signature }, { type: "text", text: "Reading first." }] },
      { role: "user", content: "Continue." },
    ],
  };
}

describe("Claude route carries a provider's own encrypted reasoning", () => {
  test("a streamed blob with no summary still yields a signed thinking block that carries it", async () => {
    const blocks = await streamedThinking([
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_native", summary: [], encrypted_content: BLOB } }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.thinking).toBe("");
    expect(decodeReasoningEnvelope(blocks[0]!.signature)?.nat).toEqual({ enc: BLOB, model: MODEL, id: "rs_native", tag: TAG });
  });

  test("streamed summary text and the blob share one thinking block", async () => {
    const blocks = await streamedThinking([
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_native" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_native", output_index: 0, summary_index: 0, delta: "Plan: read, then edit." }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_native", encrypted_content: BLOB } }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.thinking).toBe("Plan: read, then edit.");
    const envelope = decodeReasoningEnvelope(blocks[0]!.signature);
    expect(envelope?.txt).toBe("Plan: read, then edit.");
    expect(envelope?.nat).toEqual({ enc: BLOB, model: MODEL, id: "rs_native", tag: TAG });
  });

  test("reasoning without a native blob keeps the summary-only signature", async () => {
    const blocks = await streamedThinking([
      sse("response.output_item.added", { output_index: 0, item: { type: "reasoning", id: "rs_plain" } }),
      sse("response.reasoning_summary_text.delta", { item_id: "rs_plain", output_index: 0, summary_index: 0, delta: "hmm" }),
      sse("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "rs_plain" } }),
    ]);
    expect(decodeReasoningEnvelope(blocks[0]!.signature)).toEqual({ txt: "hmm" });
  });

  test("the JSON path signs the blob into its thinking block, with or without summary text", () => {
    const message = responsesJsonToAnthropicMessage({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_a", summary: [], encrypted_content: BLOB },
        { type: "reasoning", id: "rs_b", summary: [{ type: "summary_text", text: "Next: edit." }], encrypted_content: `${BLOB}b` },
        { type: "message", content: [{ type: "output_text", text: "Done." }] },
      ],
    }, MODEL, createTestTranslatorBudget(), () => TAG);
    const thinking = (message.content as Record<string, any>[]).filter(block => block.type === "thinking");
    expect(thinking.map(block => block.thinking)).toEqual(["", "Next: edit."]);
    expect(thinking.map(block => decodeReasoningEnvelope(block.signature)?.nat)).toEqual([
      { enc: BLOB, model: MODEL, id: "rs_a", tag: TAG },
      { enc: `${BLOB}b`, model: MODEL, id: "rs_b", tag: TAG },
    ]);
  });

  test("replay to the same model restores the blob and item id, and the sanitizer forwards it", () => {
    const signature = encodeReasoningEnvelope({ txt: "Plan.", nat: { enc: BLOB, model: MODEL, id: "rs_native", tag: TAG } });
    const body = anthropicToResponsesBody(replay(MODEL, "Plan.", signature, { type: "adaptive" }));
    expect(() => responsesRequestSchema.parse(body)).not.toThrow();
    const reasoning = (body.input as Record<string, unknown>[]).filter(item => item.type === "reasoning");
    expect(reasoning).toEqual([{
      type: "reasoning", id: "rs_native",
      summary: [{ type: "summary_text", text: "Plan." }],
      encrypted_content: BLOB,
    }]);
    const sanitized = sanitizeReasoningInputContent(body) as { input: Record<string, unknown>[] };
    expect(sanitized.input.find(item => item.type === "reasoning")?.encrypted_content).toBe(BLOB);
  });

  test("replay to a different model drops the blob and keeps the visible text", () => {
    const signature = encodeReasoningEnvelope({ txt: "Plan.", nat: { enc: BLOB, model: MODEL, id: "rs_native", tag: TAG } });
    const body = anthropicToResponsesBody(replay(OTHER_MODEL, "Plan.", signature));
    const reasoning = (body.input as Record<string, unknown>[]).filter(item => item.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).not.toHaveProperty("encrypted_content");
    expect(reasoning[0]!.summary).toEqual([{ type: "summary_text", text: "Plan." }]);
    expect(JSON.stringify(body)).not.toContain(BLOB);
  });

  test("an empty thinking block for a different model leaves no reasoning item", () => {
    const signature = encodeReasoningEnvelope({ txt: "", nat: { enc: BLOB, model: MODEL, tag: TAG } });
    const body = anthropicToResponsesBody(replay(OTHER_MODEL, "", signature));
    expect((body.input as Record<string, unknown>[]).some(item => item.type === "reasoning")).toBe(false);
  });

  test("a full turn round-trips the blob back to the provider", () => {
    const message = responsesJsonToAnthropicMessage({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_turn", summary: [], encrypted_content: BLOB },
        { type: "message", content: [{ type: "output_text", text: "OK" }] },
      ],
    }, MODEL, createTestTranslatorBudget(), () => TAG);
    const body = anthropicToResponsesBody({
      model: MODEL, max_tokens: 1024, thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Remember a number privately." },
        { role: "assistant", content: message.content },
        { role: "user", content: "Which number?" },
      ],
    });
    const reasoning = (body.input as Record<string, unknown>[]).find(item => item.type === "reasoning");
    expect(reasoning).toMatchObject({ id: "rs_turn", encrypted_content: BLOB });
  });

  test("requests that reason ask for encrypted reasoning; disabled thinking does not", () => {
    const enabled = anthropicToResponsesBody({ model: MODEL, max_tokens: 64, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] });
    expect(enabled.include).toEqual(["reasoning.encrypted_content"]);
    const effort = anthropicToResponsesBody({ model: MODEL, max_tokens: 64, output_config: { effort: "high" }, messages: [{ role: "user", content: "hi" }] });
    expect(effort.include).toEqual(["reasoning.encrypted_content"]);
    const disabled = anthropicToResponsesBody({ model: MODEL, max_tokens: 64, thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }] });
    expect(disabled).not.toHaveProperty("include");
  });

  test("a malformed native field is ignored rather than trusted", () => {
    const malformed = OCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ txt: "t", nat: { enc: 7, model: MODEL } })).toString("base64");
    expect(decodeReasoningEnvelope(malformed)).toEqual({ txt: "t" });
    const noModel = OCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ nat: { enc: BLOB } })).toString("base64");
    expect(decodeReasoningEnvelope(noModel)).toBeNull();
  });
});
