// Fixtures for per-message effort history (#6895), ported from rkb32's Bun fixtures
// (gist 69ee9faf767de6aae0369244aaa0d654). Every body and output item comes from the real
// Anthropic adapter, Responses parser and bridge; the module decides from those. No network.
import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { createAnthropicAdapter } from "../../src/adapters/anthropic";
import { parseRequest } from "../../src/responses/parser";
import { isCompactionItemType } from "../../src/responses/compaction";
import type { AdapterEvent, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../helpers/translator-budget";
import { createStore, decide, commit, abandon, effectiveLimit, hashItems, kindOf, lineageFromMetadata } from "../../src/responses/effort-history";
import { userMessageWireIndex } from "../../src/adapters/anthropic/per-message-effort";

const MODEL = "claude-opus-5-5";
const FIXED_MODEL = "claude-mythos-5-1";
const keyProvider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-test" } as OcxProviderConfig;
// A configured output budget above the adaptive ceiling (40192) keeps max_tokens constant across efforts.
const pinnedProvider = { ...keyProvider, defaultMaxOutputTokens: 64000 } as OcxProviderConfig;
const ON = { enabled: true, activated: true, compactionMarkerIdentified: true };
const NEW_META = JSON.stringify({ history_initialization: "New" });
const scope = {
  cohort: "cohort-1", provider: "anthropic", destination: "api.anthropic.com",
  adapter: "anthropic", model: MODEL, credential: "acct-1", authMode: "apiKey",
};
const INSTRUCTIONS = "You are a coding agent.";
const TOOLS = [{ type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];

const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function outputItemsOf(sse: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const json = JSON.parse(line.slice(6)) as { type?: string; item?: Record<string, unknown> };
      if (json.type === "response.output_item.done" && json.item) items.push(json.item);
    } catch { /* partial frame */ }
  }
  return items;
}

// The adapter that built the latest request parses its response, as one request does in the server
// (its Opus 5.5 progress-update mode is set by buildRequest).
let lastAdapter: ReturnType<typeof createAnthropicAdapter> | undefined;

/** One Responses request through the real parser and Anthropic serializer. */
async function serialize(input: unknown[], effort: string, opts: { model?: string; provider?: OcxProviderConfig; maxOutput?: number; summary?: string } = {}) {
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(opts.provider ?? keyProvider, "short"));
  const responses = {
    model: opts.model ?? MODEL, instructions: INSTRUCTIONS, tools: TOOLS, input, stream: true,
    reasoning: { effort, ...(opts.summary ? { summary: opts.summary } : {}) }, ...(opts.maxOutput !== undefined ? { max_output_tokens: opts.maxOutput } : {}),
  };
  const request = await adapter.buildRequest(parseRequest(responses), {} as never);
  lastAdapter = adapter;
  return JSON.parse(request.body) as Record<string, any>;
}

/** A synthetic Anthropic stream through the real adapter parser and the real Responses bridge. */
async function respond(opts: { thinking?: string; text?: string; cacheRead?: number; stop?: boolean; model?: string } = {}) {
  const frames = [
    frame("message_start", { message: { id: "msg_up", usage: { input_tokens: 50, cache_read_input_tokens: opts.cacheRead ?? 0 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: opts.thinking ?? "look at it" } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SigAbc1234567890==" } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "text_delta", text: opts.text ?? "done" } }),
    frame("content_block_stop", { index: 1 }),
    ...(opts.stop === false ? [] : [
      frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      frame("message_stop", {}),
    ]),
  ];
  const adapter = lastAdapter ?? withTestTranslatorBudget(createAnthropicAdapter(keyProvider, "short"));
  const events: AdapterEvent[] = [];
  async function* tap() {
    for await (const event of adapter.parseStream(new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } }), createTestTranslatorBudget())) {
      events.push(event);
      yield event;
    }
  }
  const sse = await drain(bridgeToResponsesSSE(tap(), opts.model ?? MODEL));
  return { items: outputItemsOf(sse), sse, events, messageStop: sse.includes("\"response.completed\"") };
}

/** The slice request for one serialized turn. Every compared value is the emitted one. */
function sliceRequest(input: unknown[], parentLength: number, body: Record<string, any>, effort: string, extra: Record<string, unknown> = {}) {
  return {
    chatLineage: "chat-1", scope, frame: "frame-A", generation: "g1",
    cacheControl: JSON.stringify(body).includes("\"cache_control\""),
    stripped: false,
    thinking: body.thinking,
    emittedMaxTokens: body.max_tokens,
    effort,
    turnMetadata: parentLength === 0 ? NEW_META : undefined,
    // Test-only stand-in: no lifecycle owner emits a new-transcript receipt yet.
    newTranscriptReceipt: parentLength === 0,
    transport: "http",
    parent: input.slice(0, parentLength),
    suffix: input.slice(parentLength),
    // The production seam's mapping from this turn's user message to its Anthropic message index.
    changeWireIndex: userMessageWireIndex(body.messages, input.slice(parentLength)),
    ...extra,
  };
}

/** Turn 1 of a chat, committed with the real output items. Returns what the client now holds. */
async function firstTurn(store: ReturnType<typeof createStore>, opts: { provider?: OcxProviderConfig; effort?: string; text?: string } = {}) {
  const input = [userMsg(opts.text ?? "fix the bug")];
  const effort = opts.effort ?? "high";
  const body = await serialize(input, effort, { provider: opts.provider ?? pinnedProvider });
  const d = decide(store, sliceRequest(input, 0, body, effort), ON);
  expect(d.action).toBe("send");
  const reply = await respond();
  expect(commit(store, d.pendingToken, { messageStop: reply.messageStop, cacheRead: 0, P: 100, outputItems: reply.items, generation: "g1" }).action).toBe("committed");
  return { body, transcript: [...input, ...reply.items], reply };
}

// Strip cache breakpoints and normalize string content, so two serializations compare by content.
function contentOf(messages: Array<Record<string, any>>) {
  return messages.map(m => ({
    role: m.role,
    content: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content)
      .map(({ cache_control: _cc, ...block }: Record<string, unknown>) => block),
  }));
}

describe("positive control: serializer to next request", () => {
  test("echoed output rebuilds the same prefix, and the slice matches it as a change point", async () => {
    const store = createStore();
    const { body: body1, transcript, reply } = await firstTurn(store);
    const input2 = [...transcript, userMsg("now the tests")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });

    // The prefix content is unchanged: turn 1's user message, then the assistant turn rebuilt from
    // the echoed output (signed thinking, then the final text).
    expect(contentOf(body2.messages.slice(0, 1))).toEqual(contentOf(body1.messages));
    expect(contentOf([body2.messages[1]])).toEqual([{ role: "assistant", content: [
      { type: "thinking", thinking: "look at it", signature: "SigAbc1234567890==" },
      { type: "text", text: "done" },
    ] }]);
    // The output the client echoes is proxy-minted: reasoning and message ids, and the ocxr1 envelope.
    // Opus 5.5 progress updates add a commentary message before the final answer.
    expect(reply.items.map(i => [kindOf(i), i.phase])).toEqual([["other:reasoning", undefined], ["assistant", "commentary"], ["assistant", "final_answer"]]);
    expect(String(reply.items[0].encrypted_content)).toStartWith("ocxr1:");

    // Today the effort change rewrites the top-level field, which is what breaks the cache.
    expect(body1.output_config).toEqual({ effort: "high" });
    expect(body2.output_config).toEqual({ effort: "low" });
    // Adaptive thinking emits no budget_tokens, so the emitted thinking field is unchanged.
    expect(body2.thinking).toEqual(body1.thinking);
    expect(body2.max_tokens).toBe(body1.max_tokens);

    const d = decide(store, sliceRequest(input2, transcript.length, body2, "low"), ON);
    expect(d).toMatchObject({ action: "send", kind: "matched", changePoint: true, shape: "a", insert: { at: transcript.length, effort: "low" } });
  });

  test("the slice's derived output limit equals the serializer's max_tokens for every effort", async () => {
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const body = await serialize([userMsg("x")], effort);
      expect(effectiveLimit({ effort })).toBe(body.max_tokens);
    }
  });
});

describe("eligibility from emitted fields", () => {
  test("omitted cap (Codex default): max_tokens follows effort, so every effort change is off", async () => {
    const store = createStore();
    const { body: body1, transcript } = await firstTurn(store, { provider: keyProvider });
    const input2 = [...transcript, userMsg("now the tests")];
    const body2 = await serialize(input2, "low");
    expect([body1.max_tokens, body2.max_tokens]).toEqual([24576, 12288]);
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low"), ON)).toMatchObject({ action: "off", reason: "limit-differs" });
  });

  test("explicit caller cap: unchanged limit, so the change point is admitted", async () => {
    const store = createStore();
    const input = [userMsg("fix the bug")];
    const body1 = await serialize(input, "high", { maxOutput: 32000 });
    const d1 = decide(store, sliceRequest(input, 0, body1, "high"), ON);
    const reply = await respond();
    commit(store, d1.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: reply.items, generation: "g1" });
    const input2 = [...input, ...reply.items, userMsg("next")];
    const body2 = await serialize(input2, "low", { maxOutput: 32000 });
    expect(body2.max_tokens).toBe(32000);
    expect(decide(store, sliceRequest(input2, input.length + reply.items.length, body2, "low"), ON)).toMatchObject({ kind: "matched", changePoint: true });
  });

  test("fixed-budget branch: the emitted budget_tokens changes with effort, so it is a thinking change", async () => {
    const store = createStore();
    const input = [userMsg("fix the bug")];
    const body1 = await serialize(input, "high", { model: FIXED_MODEL, maxOutput: 40000 });
    const fixedScope = { ...scope, model: FIXED_MODEL };
    const d1 = decide(store, sliceRequest(input, 0, body1, "high", { scope: fixedScope }), ON);
    const reply = await respond({ model: FIXED_MODEL });
    commit(store, d1.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: reply.items, generation: "g1" });
    const input2 = [...input, ...reply.items, userMsg("next")];
    const body2 = await serialize(input2, "low", { model: FIXED_MODEL, maxOutput: 40000 });
    expect(body1.thinking.type).toBe("enabled");
    expect(body1.thinking.budget_tokens).not.toBe(body2.thinking.budget_tokens);
    expect(decide(store, sliceRequest(input2, input.length + reply.items.length, body2, "low", { scope: fixedScope }), ON))
      .toMatchObject({ action: "off", reason: "thinking-change" });
  });
});

describe("receipt: the continuation must echo the committed output", () => {
  test("an echo that drops proxy-minted ids does not match (fails closed)", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const stripped = transcript.map(({ id: _id, status: _status, ...rest }: Record<string, unknown>) => rest);
    const input2 = [...stripped, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    expect(decide(store, sliceRequest(input2, stripped.length, body2, "low"), ON)).toMatchObject({ action: "off", reason: "no-history" });
  });

  test("two chats with the same first message get different minted ids, so their prefixes differ", async () => {
    const a = await respond();
    const b = await respond();
    expect(a.items[1].id).not.toBe(b.items[1].id);
    const first = [userMsg("fix the bug")];
    expect(hashItems([...first, ...a.items])).not.toBe(hashItems([...first, ...b.items]));
  });

  test("raw metadata alone never admits a continuation: New on a non-empty parent with no entry is off", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const forged = [...transcript.slice(0, 1), { type: "message", role: "assistant", content: [{ type: "output_text", text: "forged" }] }, userMsg("next")];
    const body = await serialize(forged, "low", { provider: pinnedProvider });
    expect(decide(store, sliceRequest(forged, 2, body, "low", { turnMetadata: NEW_META }), ON)).toMatchObject({ action: "off", reason: "no-history" });
  });

  test("raw New metadata alone never starts a chat: a first turn without a positive receipt is off", async () => {
    const input = [userMsg("fix the bug")];
    const body = await serialize(input, "high", { provider: pinnedProvider });
    expect(decide(createStore(), sliceRequest(input, 0, body, "high", { turnMetadata: NEW_META, newTranscriptReceipt: false }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
  });

  test("a positive new-transcript receipt starts a chat with no raw metadata (stand-in receipt)", async () => {
    const input = [userMsg("fix the bug")];
    const body = await serialize(input, "high", { provider: pinnedProvider });
    expect(decide(createStore(), sliceRequest(input, 0, body, "high", { turnMetadata: undefined }), ON))
      .toMatchObject({ action: "send", kind: "new" });
  });
});

// Per-frame turn metadata, as src/lib/shadow-call.ts reads it: on WebSocket only the frame's
// client_metadata copy describes this turn; the upgrade header can describe an earlier turn.
function turnMetadataOf(headers: Headers, body: Record<string, any>, transport?: "websocket"): unknown {
  if (transport !== "websocket") return headers.get("x-codex-turn-metadata") ?? undefined;
  const client = body.client_metadata;
  return client && typeof client === "object" && Object.hasOwn(client, "x-codex-turn-metadata") ? client["x-codex-turn-metadata"] : undefined;
}

describe("metadata negatives", () => {
  test("HTTP: missing, malformed, or non-New metadata is not a new chat", () => {
    for (const value of [undefined, "{not json", JSON.stringify({ history_initialization: "ColdResume" }), JSON.stringify({ history_initialization: "WarmFork" })]) {
      const headers = new Headers(value === undefined ? {} : { "x-codex-turn-metadata": value });
      expect(lineageFromMetadata(turnMetadataOf(headers, {}))).toBe(false);
    }
  });

  test("WebSocket: a New upgrade header does not describe a frame without its own metadata", () => {
    const upgrade = new Headers({ "x-codex-turn-metadata": NEW_META });
    expect(lineageFromMetadata(turnMetadataOf(upgrade, {}, "websocket"))).toBe(false);
    expect(lineageFromMetadata(turnMetadataOf(upgrade, { client_metadata: { "x-codex-turn-metadata": NEW_META } }, "websocket"))).toBe(true);
  });

  test("WebSocket before activation is off regardless of metadata", async () => {
    const input = [userMsg("hi")];
    const body = await serialize(input, "high", { provider: pinnedProvider });
    expect(decide(createStore(), sliceRequest(input, 0, body, "high", { transport: "websocket" }), ON)).toMatchObject({ reason: "websocket-before-activation" });
  });
});

describe("compaction", () => {
  test("both compaction item types are recognized by the parser and never start or extend a history", async () => {
    expect(isCompactionItemType("compaction")).toBe(true);
    expect(isCompactionItemType("context_compaction")).toBe(true);
    for (const marker of [{ type: "context_compaction" }, { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" }]) {
      const store = createStore();
      const { transcript } = await firstTurn(store);
      // New history after compaction: marker plus summary, then the next user message.
      const compacted = [marker, userMsg("summary of earlier work"), userMsg("continue")];
      const body = await serialize(compacted, "low", { provider: pinnedProvider });
      expect(decide(store, sliceRequest(compacted, 0, body, "low"), ON)).toMatchObject({ action: "off", reason: "no-history" });
      // A marker appended to a matched parent is an unclassified suffix: off, and the parent is deleted.
      const appended = [...transcript, marker, userMsg("continue")];
      const body2 = await serialize(appended, "low", { provider: pinnedProvider });
      expect(decide(store, sliceRequest(appended, transcript.length, body2, "low"), ON))
        .toMatchObject({ action: "off", reason: "unclassified-suffix", deleted: true });
      expect(store.entries.size).toBe(0);
    }
  });
});

// Off paths must leave the request bytes and the store exactly as they were. The slice never edits a body.
describe("receipt-less and misplaced starts: off, request and store unchanged", () => {
  test("HTTP first turn with a raw New header and no receipt: off, nothing written", async () => {
    const store = createStore();
    const input = [userMsg("fix the bug")];
    const body = await serialize(input, "high", { provider: pinnedProvider });
    const before = JSON.stringify(body);
    expect(decide(store, sliceRequest(input, 0, body, "high", { turnMetadata: NEW_META, newTranscriptReceipt: false }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
    expect(JSON.stringify(body)).toBe(before);
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("WebSocket first turn with a New frame header and no receipt: off, nothing written", async () => {
    const store = createStore();
    const input = [userMsg("fix the bug")];
    const body = await serialize(input, "high", { provider: pinnedProvider });
    const before = JSON.stringify(body);
    const req = sliceRequest(input, 0, body, "high", { transport: "websocket", turnMetadata: NEW_META, newTranscriptReceipt: false });
    expect(decide(store, req, { ...ON, websocketHeaderRead: true })).toMatchObject({ action: "off", reason: "no-history" });
    expect(JSON.stringify(body)).toBe(before);
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("compaction request with no receipt: off (slice level; handleResponsesCompact is not in the slice), nothing written", async () => {
    const store = createStore();
    const compacted = [{ type: "context_compaction" }, userMsg("summary of earlier work"), userMsg("continue")];
    const body = await serialize(compacted, "low", { provider: pinnedProvider });
    const before = JSON.stringify(body);
    expect(decide(store, sliceRequest(compacted, 0, body, "low", { newTranscriptReceipt: false }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
    expect(JSON.stringify(body)).toBe(before);
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("compaction request with a receipt and the summary flag: off by the compaction-summary rule, nothing written", async () => {
    const store = createStore();
    const compacted = [{ type: "context_compaction" }, userMsg("summary of earlier work"), userMsg("continue")];
    const body = await serialize(compacted, "low", { provider: pinnedProvider });
    const before = JSON.stringify(body);
    expect(decide(store, sliceRequest(compacted, 0, body, "low", { newTranscriptReceipt: true, compactionSummary: true }), ON))
      .toMatchObject({ action: "off", reason: "compaction-summary" });
    expect(JSON.stringify(body)).toBe(before);
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("mid-thread with a positive receipt and no stored entry: off, nothing written", async () => {
    const { transcript } = await firstTurn(createStore());
    const store = createStore();
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    const before = JSON.stringify(body2);
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low", { newTranscriptReceipt: true }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
    expect(JSON.stringify(body2)).toBe(before);
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("the same request serialized twice is byte-identical, and an off decision changes neither copy", async () => {
    const input = [userMsg("fix the bug")];
    const a = await serialize(input, "high", { provider: pinnedProvider });
    const b = await serialize(input, "high", { provider: pinnedProvider });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const store = createStore();
    expect(decide(store, sliceRequest(input, 0, a, "high", { newTranscriptReceipt: false }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(store.entries.size + store.pending.size).toBe(0);
  });
});

describe("concurrent forks", () => {
  test("two sends on one parent: the second collides, both are dropped, and the parent is gone", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const forkA = [...transcript, userMsg("branch A")];
    const forkB = [...transcript, userMsg("branch B")];
    const a = decide(store, sliceRequest(forkA, transcript.length, await serialize(forkA, "low", { provider: pinnedProvider }), "low"), ON);
    const b = decide(store, sliceRequest(forkB, transcript.length, await serialize(forkB, "low", { provider: pinnedProvider }), "low"), ON);
    expect(a.kind).toBe("matched");
    expect(b).toMatchObject({ action: "off", reason: "in-flight-collision", deleted: true });
    const replyA = await respond({ text: "A" });
    expect(commit(store, a.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: replyA.items, generation: "g1" }))
      .toMatchObject({ action: "dropped", reason: "pending-missing" });
    expect(decide(store, sliceRequest(forkA, transcript.length, await serialize(forkA, "low", { provider: pinnedProvider }), "low"), ON)).toMatchObject({ reason: "no-history" });
  });
});

describe("ambiguous sends", () => {
  test("a stream cut before message_stop is not committed, and the parent is not restored", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    const d = decide(store, sliceRequest(input2, transcript.length, body2, "low"), ON);
    const cut = await respond({ stop: false });
    expect(cut.messageStop).toBe(false);
    expect(commit(store, d.pendingToken, { messageStop: cut.messageStop, cacheRead: 100, P: 100, outputItems: cut.items, generation: "g1" }))
      .toMatchObject({ action: "deleted", reason: "uncertain-outcome" });
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low"), ON)).toMatchObject({ action: "off" });
  });

  test("a client disconnect after the send deletes the parent by default", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const d = decide(store, sliceRequest(input2, transcript.length, await serialize(input2, "low", { provider: pinnedProvider }), "low"), ON);
    expect(abandon(store, d.pendingToken, { sent: true })).toMatchObject({ action: "deleted", reason: "abandoned" });
    expect(store.entries.size).toBe(0);
  });
});

describe("stale credential generations", () => {
  test("a rotated generation before the next turn is off, and the parent is deleted", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low", { generation: "g2" }), ON))
      .toMatchObject({ action: "off", reason: "generation-mismatch", deleted: true });
    expect(store.entries.size).toBe(0);
  });

  test("a generation that rotates while the send is in flight is not committed", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const d = decide(store, sliceRequest(input2, transcript.length, await serialize(input2, "low", { provider: pinnedProvider }), "low"), ON);
    const reply = await respond({ cacheRead: 100 });
    expect(commit(store, d.pendingToken, { messageStop: true, cacheRead: 100, P: 100, outputItems: reply.items, generation: "g2" }))
      .toMatchObject({ action: "deleted", reason: "generation-changed" });
  });
});

describe("retained transcript bytes", () => {
  const secrets = ["fix the bug", "look at it", "SigAbc1234567890", "ocxr1:", "now the tests"];
  const dump = (store: unknown) => JSON.stringify(store, (_k, v) => (v instanceof Map ? [...v.entries()] : v));

  test("neither a pending slot nor a committed entry holds transcript text", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("now the tests")];
    decide(store, sliceRequest(input2, transcript.length, await serialize(input2, "low", { provider: pinnedProvider }), "low"), ON);
    expect(store.pending.size).toBe(1);
    const text = dump(store);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});

describe("effort none", () => {
  test("Opus 5.5 none keeps the emitted thinking field, so the slice turns it off by effort, not by thinking", async () => {
    const store = createStore();
    const { body: body1, transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "none", { provider: pinnedProvider });
    expect(body2.thinking).toEqual(body1.thinking);
    expect(body2.output_config).toBeUndefined();
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "none"), ON)).toMatchObject({ action: "off", reason: "no-effort-level" });
  });
});

describe("thinking display (dev 9b78a16f4, #7728)", () => {
  test("Opus 5.5: a reasoning.summary change mid-chat changes the emitted display, so it is a thinking change", async () => {
    const store = createStore();
    const { body: body1, transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider, summary: "detailed" });
    expect(body1.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(body2.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low"), ON)).toMatchObject({ action: "off", reason: "thinking-change" });
  });
});

// Round 13: the slice's change point is a Responses input index. The adapter maps it to an Anthropic
// message index by serializing the prefix, and the fixtures check that mapping against the real serializer.
async function messageIndexOf(input: unknown[], at: number, effort = "low") {
  const prefix = await serialize(input.slice(0, at), effort, { provider: pinnedProvider });
  return prefix.messages.length;
}
function insertEffortAt(messages: Array<Record<string, unknown>>, index: number, effort: string) {
  return [...messages.slice(0, index), { role: "system", content: [], output_config: { effort } }, ...messages.slice(index)];
}
const callItem = { type: "function_call", call_id: "call_1", name: "shell", arguments: "{\"cmd\":\"ls\"}" };
const outItem = { type: "function_call_output", call_id: "call_1", output: "a.txt" };
const devItem = { type: "message", role: "developer", content: [{ type: "input_text", text: "env" }] };

describe("change point position through the real serializer (round 13)", () => {
  test("tool loop: the change point lands after the tool result and before the new user message", async () => {
    const store = createStore();
    const input1 = [userMsg("fix the bug")];
    const body1 = await serialize(input1, "high", { provider: pinnedProvider });
    const d1 = decide(store, sliceRequest(input1, 0, body1, "high"), ON);
    commit(store, d1.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [callItem], generation: "g1" });
    const input2 = [...input1, callItem, outItem, userMsg("now the tests")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    const d2 = decide(store, sliceRequest(input2, 2, body2, "low"), ON);
    expect(d2).toMatchObject({ kind: "matched", changePoint: true });
    const idx = await messageIndexOf(input2, d2.insert.at);
    expect(d2.insert.wireIndex).toBe(idx);
    expect(body2.messages[idx]).toMatchObject({ role: "user" });
    expect(JSON.stringify(body2.messages[idx])).toContain("now the tests");
    expect(JSON.stringify(body2.messages[idx - 1])).toContain("tool_result");
    expect(insertEffortAt(body2.messages, idx, "low")[idx]).toEqual({ role: "system", content: [], output_config: { effort: "low" } });
  });

  test("developer item in the new suffix: the index still lands before the user message", async () => {
    const store = createStore();
    const input1 = [userMsg("fix the bug")];
    const body1 = await serialize(input1, "high", { provider: pinnedProvider });
    const d1 = decide(store, sliceRequest(input1, 0, body1, "high"), ON);
    const reply = (await respond()).items;
    commit(store, d1.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: reply, generation: "g1" });
    const input2 = [...input1, ...reply, devItem, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    const d2 = decide(store, sliceRequest(input2, input1.length + reply.length, body2, "low"), ON);
    expect(d2.kind).toBe("matched");
    const idx = await messageIndexOf(input2, d2.insert.at);
    expect(d2.insert.wireIndex).toBe(idx);
    expect(JSON.stringify(body2.messages[idx])).toContain("next");
    expect(JSON.stringify(body2.messages[idx - 1])).toContain("env");
  });
});

// Round 13: projection covers items the serializer drops, and an orphan tool call is never a matched history.
describe("projection: dropped and orphan items (round 13)", () => {
  test("a configuration_update in the prefix: the serializer drops it, but the key still changes", async () => {
    const cfg = { type: "configuration_update", reasoning: { effort: "high" } };
    const withCfg = [userMsg("fix"), cfg, userMsg("next")];
    const without = [userMsg("fix"), userMsg("next")];
    const a = await serialize(withCfg, "low", { provider: pinnedProvider });
    const b = await serialize(without, "low", { provider: pinnedProvider });
    expect(contentOf(a.messages)).toEqual(contentOf(b.messages));
    expect(hashItems([userMsg("fix"), cfg])).not.toBe(hashItems([userMsg("fix")]));
  });

  test("an orphan tool call (no output yet) in the new suffix is not a matched turn", async () => {
    const store = createStore();
    const input1 = [userMsg("fix the bug")];
    const body1 = await serialize(input1, "high", { provider: pinnedProvider });
    const d1 = decide(store, sliceRequest(input1, 0, body1, "high"), ON);
    commit(store, d1.pendingToken, { messageStop: true, cacheRead: 0, P: 100, outputItems: [callItem], generation: "g1" });
    const input2 = [...input1, callItem, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    const d2 = decide(store, sliceRequest(input2, 2, body2, "low"), ON);
    expect(d2.action).toBe("off");
  });
});

// Round 13: the real WebSocket functions, not a copy of their logic.
import { prepareCodexWsRequest, CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { shadowCallPreservesSelectedModel } from "../../src/lib/shadow-call";

describe("real WebSocket metadata functions (round 13)", () => {
  test("the canonical WS path copies an upgrade-time turn-metadata header into a frame that has none", () => {
    const upgradeMeta = JSON.stringify({ history_initialization: "New" });
    const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, {
      method: "POST",
      headers: { "x-codex-turn-metadata": upgradeMeta, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: [], client_metadata: {} }),
    } as RequestInit);
    expect(prepared).not.toBeNull();
    const frame = JSON.parse(prepared!.frameText);
    expect(frame.client_metadata["x-codex-turn-metadata"]).toBe(upgradeMeta);
  });

  test("a frame's own turn-metadata wins over the upgrade copy", () => {
    const own = JSON.stringify({ history_initialization: "ColdResume" });
    const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, {
      method: "POST",
      headers: { "x-codex-turn-metadata": JSON.stringify({ history_initialization: "New" }), "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: [], client_metadata: { "x-codex-turn-metadata": own } }),
    } as RequestInit);
    const frame = JSON.parse(prepared!.frameText);
    expect(frame.client_metadata["x-codex-turn-metadata"]).toBe(own);
  });

  test("the real WS reader ignores the upgrade header: only the frame's client_metadata counts", () => {
    const meta = JSON.stringify({ request_kind: "turn", thread_source: "user" });
    expect(shadowCallPreservesSelectedModel({ client_metadata: {} }, new Headers({ "x-codex-turn-metadata": meta }), "websocket")).toBe(false);
    expect(shadowCallPreservesSelectedModel({ client_metadata: { "x-codex-turn-metadata": meta } }, new Headers(), "websocket")).toBe(true);
  });
});

const COLD_RESUME_META = JSON.stringify({ history_initialization: "ColdResume" });

describe("resume, restart, and scope change through the real serializer", () => {
  test("HTTP resume: a ColdResume request over a transcript with no stored entry is off", async () => {
    const { transcript } = await firstTurn(createStore());
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    expect(decide(createStore(), sliceRequest(input2, transcript.length, body2, "low", { turnMetadata: COLD_RESUME_META }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
  });

  test("HTTP restart: a New request over a transcript with no stored entry is off", async () => {
    const { transcript } = await firstTurn(createStore());
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    expect(decide(createStore(), sliceRequest(input2, transcript.length, body2, "low", { turnMetadata: NEW_META }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
  });

  test("WebSocket resume and restart: the frame's own metadata, read through the real WS path, is off with no stored entry", async () => {
    const { transcript } = await firstTurn(createStore());
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    for (const meta of [COLD_RESUME_META, NEW_META]) {
      const prepared = prepareCodexWsRequest(CODEX_RESPONSES_HTTP_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5", input: [], client_metadata: { "x-codex-turn-metadata": meta } }),
      } as RequestInit);
      const turnMetadata = JSON.parse(prepared!.frameText).client_metadata["x-codex-turn-metadata"];
      const req = sliceRequest(input2, transcript.length, body2, "low", { transport: "websocket", turnMetadata });
      expect(decide(createStore(), req, { ...ON, websocketHeaderRead: true })).toMatchObject({ action: "off", reason: "no-history" });
    }
  });

  test("account change mid-chat: the new credential has no entry, so the request is off, and the old chat's entry is deleted", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider });
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low", { scope: { ...scope, credential: "acct-2" } }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
    expect(store.entries.size).toBe(0);
  });

  test("model change mid-chat: a different in-scope model has no entry, so the request is off, and the old chat's entry is deleted", async () => {
    const store = createStore();
    const { transcript } = await firstTurn(store);
    const input2 = [...transcript, userMsg("next")];
    const body2 = await serialize(input2, "low", { provider: pinnedProvider, model: FIXED_MODEL });
    expect(decide(store, sliceRequest(input2, transcript.length, body2, "low", { scope: { ...scope, model: FIXED_MODEL } }), ON))
      .toMatchObject({ action: "off", reason: "no-history" });
    expect(store.entries.size).toBe(0);
  });
});
