import { describe, expect, test } from "bun:test";
import { buildKiroPayload } from "../../../src/adapters/kiro/payload";
import { kiroNativeEffortField } from "../../../src/adapters/kiro/reasoning";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../../src/bridge";
import { parseRequest } from "../../../src/responses/parser";
import { decodeReasoningEnvelope } from "../../../src/responses/reasoning-envelope";
import type { AdapterEvent } from "../../../src/types";
import type { OcxProviderConfig } from "../../../src/types";
import { createKiroAdapter as createKiroAdapterProduction } from "../../../src/adapters/kiro";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { createTranslatorBudget } from "../../../src/lib/translator-budget";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

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

// The blob has two possible homes on a replayed `assistantResponseMessage`, and the wire validates
// the SHAPE of each: `signature` takes the emitted string verbatim, while `redactedContent` is a
// base64 member. The ".KTR~~…" value the GPT-5.6 family returns is not base64, which is why
// replaying it as `redactedContent` — what the proxy did before the field was measured — came back
// as REQUEST_BODY_INVALID. Which field a blob arrived on therefore has to survive the whole
// round-trip, not just the parse.
describe("kiro reasoning blob — the wire field it replays on", () => {
  const SIGNATURE = ".KTR~~eyJlbmNyeXB0aW9uUmVnaW9uIjoidXMtZWFzdC0xIiwic2xvdHMiOltdfQ==";

  interface HistoryEntry {
    assistantResponseMessage?: { reasoningContent?: unknown };
  }

  /** Round-trip one blob the way Codex does — bridge, history replay, then the next Kiro body. */
  function replayedReasoningContent(blob: string): unknown {
    const response = buildResponseJSON([
      { type: "text_delta", text: "the answer" },
      { type: "kiro_redacted_reasoning", data: blob },
      { type: "done", usage: { inputTokens: 1, outputTokens: 2 }, endTurn: true },
    ], "kiro/gpt-5.6-luna");
    const items = (response.output as Record<string, unknown>[]).map(({ status: _status, ...item }) => item);
    // Kiro requires the request to end with a user turn, so the replayed turn is followed by one.
    const parsed = parseRequest({
      model: "kiro/gpt-5.6-luna",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        ...items,
        { type: "message", role: "user", content: [{ type: "input_text", text: "again" }] },
      ],
    });
    const { payload } = buildKiroPayload(parsed, undefined, "disabled", "ide");
    const history = (payload.conversationState as { history?: HistoryEntry[] }).history ?? [];
    return history.find(entry => entry.assistantResponseMessage?.reasoningContent)
      ?.assistantResponseMessage?.reasoningContent;
  }

  test("a signature blob is replayed verbatim on `signature`", () => {
    expect(replayedReasoningContent(`signature:${SIGNATURE}`)).toEqual({ signature: SIGNATURE });
  });

  test("an untagged blob keeps the base64 `redactedContent` shape", () => {
    expect(replayedReasoningContent(BLOB)).toEqual({ redactedContent: BLOB });
  });

  test("the tag never reaches the wire as part of the blob", () => {
    const replayed = replayedReasoningContent(`signature:${SIGNATURE}`) as { signature?: string };
    expect(replayed.signature).toBe(SIGNATURE);
    expect(JSON.stringify(replayed)).not.toContain("signature:");
  });
});

// The parse side is where the tag is minted, so it is pinned here rather than in
// tests/providers/kiro/kiro-stream.test.ts: that file sits at its file-size-ratchet cap
// (tests/fixtures/file-size-baseline.json), and a baselined file may not grow by one line.
// An event carrying only the signature still has to emit the blob — the GPT-5.6 family can finish
// a turn with the encrypted blob and no assistant text at all.
describe("kiro reasoning blob — the stream records the field it arrived on", () => {
  const provider = {
    adapter: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    authMode: "oauth",
    apiKey: "tok-123",
  } as unknown as OcxProviderConfig;
  const enc = new TextEncoder();
  const signatureFrame = (obj: unknown) => encodeMessage(
    { ":message-type": "event", ":event-type": "reasoningContentEvent" },
    enc.encode(JSON.stringify(obj)),
  );

  function streamOf(...frames: Uint8Array[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i < frames.length) c.enqueue(frames[i++]);
        else c.close();
      },
    });
  }

  async function parse(frame: Uint8Array): Promise<AdapterEvent[]> {
    const adapter = withTestTranslatorBudget(createKiroAdapterProduction(provider));
    const out: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(new Response(streamOf(frame)))) out.push(event);
    return out;
  }

  test("a signature blob is tagged with the field it must be replayed on", async () => {
    // Every capture of the GPT-5.6 family put the blob on `signature` and left `text` as a "..."
    // placeholder. That value starts with ".KTR~~", which is NOT base64, so replaying it as
    // `redactedContent` — what the proxy used to send — is rejected as REQUEST_BODY_INVALID. A
    // `redactedContent` event stays untagged; the untagged shape is covered above.
    const signature = ".KTR~~eyJ2IjoxfQ==";
    expect(await parse(signatureFrame({ signature, text: "..." }))).toEqual([
      { type: "reasoning_raw_delta", text: "..." },
      { type: "kiro_redacted_reasoning", data: `signature:${signature}` },
      expect.objectContaining({ type: "done" }),
    ]);
  });

  test("a signature-only event still yields the tagged blob", async () => {
    // No assistant text means no terminal either: the blob is the whole turn, which is why the tag
    // must not be conditioned on `text`.
    expect((await parse(signatureFrame({ signature: ".KTR~~only" })))[0]).toEqual(
      { type: "kiro_redacted_reasoning", data: "signature:.KTR~~only" },
    );
  });
});

// The request side of the same story. luna and terra used to fall through to the emulated
// <thinking_mode> block, a strictly weaker signal: on one fixed hard prompt that channel landed
// between the model's native medium and high (21,202 / 28,302 chars) and never reached native max
// (48,594), while the native ladder itself ran 5,130 -> 48,594 from low to max. The whole GPT-5.6
// family shares the field name, but luna/terra keep xhigh emulated until verified.
describe("kiro native reasoning effort — the GPT-5.6 family", () => {
  function wireBody(modelId: string, effort = "max"): Record<string, unknown> {
    const parsed = {
      modelId,
      stream: true,
      options: { reasoning: effort, maxOutputTokens: 1000 },
      context: { messages: [{ role: "user", content: "solve" }] },
    } as unknown as Parameters<typeof buildKiroPayload>[0];
    return buildKiroPayload(parsed, undefined, "disabled", "ide").payload;
  }

  test("luna and terra send the native reasoning field instead of thinking tags", () => {
    for (const modelId of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
      for (const effort of ["low", "medium", "high", "max"]) {
        const body = wireBody(modelId, effort);
        expect(body.additionalModelRequestFields).toEqual({ reasoning: { effort } });
        // Native effort replaces the emulated thinking-tag prompt entirely.
        const current = (body.conversationState as {
          currentMessage: { userInputMessage: { content: string } };
        }).currentMessage.userInputMessage.content;
        expect(current).toBe("solve");
      }
    }
  });

  test("luna and terra keep unverified xhigh on the emulated path", () => {
    for (const modelId of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
      const body = wireBody(modelId, "xhigh");
      expect(body.additionalModelRequestFields).toBeUndefined();
      const current = (body.conversationState as {
        currentMessage: { userInputMessage: { content: string } };
      }).currentMessage.userInputMessage.content;
      expect(current).toContain("<thinking_mode>enabled</thinking_mode>");
      expect(current).toContain("<max_thinking_length>900</max_thinking_length>");
      expect(kiroNativeEffortField(modelId, "future-effort")).toBeUndefined();
    }
  });

  test("existing Sol and Opus native xhigh fields stay unchanged", () => {
    expect(wireBody("gpt-5.6-sol", "xhigh").additionalModelRequestFields)
      .toEqual({ reasoning: { effort: "xhigh" } });
    expect(wireBody("claude-opus-5", "xhigh").additionalModelRequestFields)
      .toEqual({ output_config: { effort: "xhigh" } });
  });
});
