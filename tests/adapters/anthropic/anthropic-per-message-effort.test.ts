// Production seam for the experimental Anthropic perMessageEffort option (#6895): the real adapter
// builds every body, the real parser and bridge produce every echoed item, and the process store is
// reset per case. No network.
import { beforeEach, describe, expect, test } from "bun:test";
import { createAnthropicAdapter } from "../../../src/adapters/anthropic";
import {
  applyAnthropicPerMessageEffort,
  codexTurnStartsNewHistory,
  PER_MESSAGE_EFFORT_BETA,
  perMessageEffortStoreForTests,
  rejectAnthropicPerMessageEffort,
  resetPerMessageEffortStoreForTests,
  settleAnthropicPerMessageEffort,
  shareAnthropicPerMessageEffortTurn,
  splitTurnInput,
  userMessageWireIndex,
} from "../../../src/adapters/anthropic/per-message-effort";
import { bridgeToResponsesSSE } from "../../../src/bridge";
import { parseRequest } from "../../../src/responses/parser";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { createTestTranslatorBudget, withTestTranslatorBudget } from "../../helpers/translator-budget";

const MODEL = "claude-sonnet-5-5";
const KEY_PROVIDER: OcxProviderConfig = {
  adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-test", defaultMaxOutputTokens: 64000, perMessageEffort: true,
};
const NEW_META = JSON.stringify({ history_initialization: "New" });
const userMsg = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const frame = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const EFFORT_MESSAGE = (effort: string) => ({ role: "system", content: [], output_config: { effort } });

interface Built { parsed: OcxParsedRequest; body: Record<string, any>; headers: Record<string, string>; adapter: ReturnType<typeof createAnthropicAdapter> }

async function build(input: unknown[], effort: string, opts: { provider?: OcxProviderConfig; newHistory?: boolean; parsed?: OcxParsedRequest; thread?: string } = {}): Promise<Built> {
  const adapter = withTestTranslatorBudget(createAnthropicAdapter(opts.provider ?? KEY_PROVIDER, "short"));
  const parsed = opts.parsed ?? parseRequest({
    model: MODEL, instructions: "You are a coding agent.", input, stream: true,
    reasoning: { effort }, prompt_cache_key: opts.thread ?? "thread-1",
  });
  if (!opts.parsed) parsed._codexNewHistory = opts.newHistory ?? input.length === 1;
  const request = await adapter.buildRequest(parsed, { headers: new Headers(), providerName: "anthropic-key", translatorBudget: createTestTranslatorBudget() });
  return { parsed, body: JSON.parse(request.body), headers: request.headers as Record<string, string>, adapter };
}

/** A synthetic Anthropic stream through the adapter that built the turn and the real bridge. */
async function respond(built: Built, text: string): Promise<{ items: Record<string, unknown>[]; response: Record<string, unknown> }> {
  const sse = [
    frame("message_start", { message: { id: "msg_up", usage: { input_tokens: 3, cache_read_input_tokens: 0 } } }),
    frame("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
    frame("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "plan" } }),
    frame("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "SigAbc1234567890==" } }),
    frame("content_block_stop", { index: 0 }),
    frame("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
    frame("content_block_delta", { index: 1, delta: { type: "text_delta", text } }),
    frame("content_block_stop", { index: 1 }),
    frame("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    frame("message_stop", {}),
  ].join("");
  let completed: Record<string, unknown> | undefined;
  const events = built.adapter.parseStream(new Response(sse, { headers: { "content-type": "text/event-stream" } }), createTestTranslatorBudget()) as AsyncIterable<AdapterEvent>;
  const stream = bridgeToResponsesSSE(events, MODEL, undefined, undefined, undefined, undefined, undefined, {
    translatorBudget: createTestTranslatorBudget(),
    onCompletedResponse: response => { completed = response; },
  });
  const reader = stream.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  if (!completed) throw new Error("bridge never completed");
  return { items: completed.output as Record<string, unknown>[], response: completed };
}

// The completed response as the bridge reports it, with the turn's cache counters.
function withCache(response: Record<string, unknown>, cache: { read: number; write: number }): Record<string, unknown> {
  return { ...response, usage: { input_tokens: 3 + cache.read + cache.write, output_tokens: 5, input_tokens_details: { cached_tokens: cache.read, cache_write_tokens: cache.write } } };
}
function finish(built: Built, response: Record<string, unknown>, cache: { read: number; write: number }): void {
  settleAnthropicPerMessageEffort(built.parsed, withCache(response, cache), "anthropic");
}

// Content only: the moving cache_control breakpoint and string-vs-block text are not part of the
// cached prefix, as the live captures on #6895 show.
function contentOf(messages: Array<Record<string, any>>) {
  return messages.map(m => ({
    ...m,
    content: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content)
      .map(({ cache_control: _cc, ...block }: Record<string, unknown>) => block),
  }));
}

const offProvider = (provider: OcxProviderConfig): OcxProviderConfig => ({ ...provider, perMessageEffort: false });
async function todayBody(input: unknown[], effort: string, provider = KEY_PROVIDER): Promise<string> {
  return JSON.stringify((await build(input, effort, { provider: offProvider(provider) })).body);
}
const betaOf = (headers: Record<string, string>) => (headers["anthropic-beta"] ?? "").split(",").map(s => s.trim());

beforeEach(() => resetPerMessageEffortStoreForTests());

describe("off by default", () => {
  test("without the option the body and headers are exactly today's, and nothing is stored", async () => {
    const { perMessageEffort: _flag, ...plain } = KEY_PROVIDER;
    const input = [userMsg("fix the bug")];
    const a = await build(input, "high", { provider: plain });
    const b = await build(input, "high", { provider: offProvider(KEY_PROVIDER) });
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    expect(betaOf(a.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
    expect(a.parsed._perMessageEffort).toBeUndefined();
    const store = perMessageEffortStoreForTests();
    expect(store.entries.size + store.pending.size).toBe(0);
  });
});

describe("a conversation that changes effort keeps its prefix", () => {
  test("top-level effort stays at the first turn's value and each change is an effort-only system message", async () => {
    const store = perMessageEffortStoreForTests();
    const input1 = [userMsg("fix the bug")];
    const t1 = await build(input1, "high");
    // Turn 1 is today's body; only the beta header is added.
    expect(JSON.stringify(t1.body)).toBe(await todayBody(input1, "high"));
    expect(betaOf(t1.headers)).toContain(PER_MESSAGE_EFFORT_BETA);
    const r1 = await respond(t1, "first");
    finish(t1, r1.response, { read: 0, write: 1000 });
    expect(store.entries.size).toBe(1);

    const input2 = [...input1, ...r1.items, userMsg("now the tests")];
    const t2 = await build(input2, "low");
    const today2 = JSON.parse(await todayBody(input2, "low"));
    expect(today2.output_config).toEqual({ effort: "low" });
    expect(t2.body.output_config).toEqual({ effort: "high" });
    expect(t2.body.max_tokens).toBe(today2.max_tokens);
    const at = today2.messages.length - 1;
    expect(t2.body.messages).toEqual([...today2.messages.slice(0, at), EFFORT_MESSAGE("low"), ...today2.messages.slice(at)]);
    expect(betaOf(t2.headers)).toContain(PER_MESSAGE_EFFORT_BETA);
    const r2 = await respond(t2, "second");
    finish(t2, r2.response, { read: 1000, write: 200 });
    expect(store.entries.size).toBe(1);

    // Same effort again: no new change point, the old one is re-sent where it was, and the whole
    // previous request is a prefix of this one.
    const input3 = [...input2, ...r2.items, userMsg("and the docs")];
    const t3 = await build(input3, "low");
    expect(t3.body.output_config).toEqual({ effort: "high" });
    expect(contentOf(t3.body.messages.slice(0, t2.body.messages.length))).toEqual(contentOf(t2.body.messages));
    expect(t3.body.messages.filter((m: Record<string, unknown>) => m.role === "system")).toEqual([EFFORT_MESSAGE("low")]);
    const r3 = await respond(t3, "third");
    finish(t3, r3.response, { read: 1200, write: 150 });

    // Back to high: a second change point, both re-sent in order.
    const input4 = [...input3, ...r3.items, userMsg("ship it")];
    const t4 = await build(input4, "high");
    expect(t4.body.output_config).toEqual({ effort: "high" });
    expect(contentOf(t4.body.messages.slice(0, t3.body.messages.length))).toEqual(contentOf(t3.body.messages));
    expect(t4.body.messages.filter((m: Record<string, unknown>) => m.role === "system")).toEqual([EFFORT_MESSAGE("low"), EFFORT_MESSAGE("high")]);
    expect(t4.body.messages.at(-2)).toEqual(EFFORT_MESSAGE("high"));
  });
});

describe("off paths send today's request", () => {
  async function committedFirstTurn(provider = KEY_PROVIDER) {
    const input1 = [userMsg("fix the bug")];
    const t1 = await build(input1, "high", { provider });
    const r1 = await respond(t1, "first");
    finish(t1, r1.response, { read: 0, write: 1000 });
    return [...input1, ...r1.items];
  }

  test("a first turn without Codex's New receipt is off", async () => {
    const input = [userMsg("fix the bug")];
    const t1 = await build(input, "high", { newHistory: false });
    expect(JSON.stringify(t1.body)).toBe(await todayBody(input, "high"));
    expect(betaOf(t1.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
    expect(perMessageEffortStoreForTests().pending.size).toBe(0);
  });

  test("a cache read below the committed prefix does not commit, so the next turn is off", async () => {
    const input1 = [userMsg("fix the bug")];
    const t1 = await build(input1, "high");
    const r1 = await respond(t1, "first");
    finish(t1, r1.response, { read: 0, write: 1000 });
    const input2 = [...input1, ...r1.items, userMsg("next")];
    const t2 = await build(input2, "low");
    const r2 = await respond(t2, "second");
    finish(t2, r2.response, { read: 10, write: 1190 });
    const input3 = [...input2, ...r2.items, userMsg("again")];
    const t3 = await build(input3, "low");
    expect(JSON.stringify(t3.body)).toBe(await todayBody(input3, "low"));
    expect(betaOf(t3.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
  });

  test("a second build of the same turn abandons the decision and is sent as today", async () => {
    const transcript = await committedFirstTurn();
    const input2 = [...transcript, userMsg("next")];
    const first = await build(input2, "low");
    expect(first.body.output_config).toEqual({ effort: "high" });
    const rebuilt = await build(input2, "low", { parsed: first.parsed });
    expect(JSON.stringify(rebuilt.body)).toBe(await todayBody(input2, "low"));
    expect(first.parsed._perMessageEffort).toMatchObject({ builds: 2 });
    expect(first.parsed._perMessageEffort?.token).toBeUndefined();
    const store = perMessageEffortStoreForTests();
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("a failover rebuild on a provider without the option still abandons the first decision", async () => {
    const transcript = await committedFirstTurn();
    const input2 = [...transcript, userMsg("next")];
    const first = await build(input2, "low");
    expect(first.parsed._perMessageEffort?.token).toBeDefined();
    await build(input2, "low", { parsed: first.parsed, provider: offProvider(KEY_PROVIDER) });
    expect(first.parsed._perMessageEffort).toMatchObject({ builds: 2 });
    const store = perMessageEffortStoreForTests();
    expect(store.entries.size + store.pending.size).toBe(0);
  });


  test("a sidecar loop's single iteration is decided once and settles through the shared turn", async () => {
    const transcript = await committedFirstTurn();
    const input2 = [...transcript, userMsg("next")];
    const parsed = parseRequest({ model: MODEL, instructions: "You are a coding agent.", input: input2, stream: true, reasoning: { effort: "low" }, prompt_cache_key: "thread-1" });
    shareAnthropicPerMessageEffortTurn(parsed);
    const iteration = await build(input2, "low", { parsed: { ...parsed } });
    expect(iteration.body.output_config).toEqual({ effort: "high" });
    const reply = await respond(iteration, "second");
    finish({ ...iteration, parsed }, reply.response, { read: 1000, write: 200 });
    expect(perMessageEffortStoreForTests().entries.size).toBe(1);
    expect(perMessageEffortStoreForTests().pending.size).toBe(0);
  });

  test("a second sidecar iteration abandons the decision and is sent as today", async () => {
    const transcript = await committedFirstTurn();
    const input2 = [...transcript, userMsg("next")];
    const parsed = parseRequest({ model: MODEL, instructions: "You are a coding agent.", input: input2, stream: true, reasoning: { effort: "low" }, prompt_cache_key: "thread-1" });
    shareAnthropicPerMessageEffortTurn(parsed);
    await build(input2, "low", { parsed: { ...parsed } });
    const second = await build(input2, "low", { parsed: { ...parsed } });
    expect(JSON.stringify(second.body)).toBe(await todayBody(input2, "low"));
    expect(parsed._perMessageEffort).toMatchObject({ builds: 2 });
    const store = perMessageEffortStoreForTests();
    expect(store.entries.size + store.pending.size).toBe(0);
  });

  test("a turn that declares Codex's web search tool is still served when no sidecar owns it", async () => {
    const input1 = [userMsg("fix the bug")];
    const adapter = withTestTranslatorBudget(createAnthropicAdapter(KEY_PROVIDER, "short"));
    const parsed = parseRequest({ model: MODEL, input: input1, stream: true, reasoning: { effort: "high" }, prompt_cache_key: "thread-ws", tools: [{ type: "web_search" }] });
    parsed._codexNewHistory = true;
    expect(parsed._webSearch).toBeDefined();
    const request = await adapter.buildRequest(parsed, { headers: new Headers(), providerName: "anthropic-key", translatorBudget: createTestTranslatorBudget() });
    expect(betaOf(request.headers as Record<string, string>)).toContain(PER_MESSAGE_EFFORT_BETA);
  });


  test("a stored change point at or past this turn's user message is never applied", async () => {
    const input1 = [userMsg("fix the bug")];
    const t1 = await build(input1, "high");
    const r1 = await respond(t1, "first");
    finish(t1, r1.response, { read: 0, write: 1000 });
    const input2 = [...input1, ...r1.items, userMsg("now the tests")];
    const t2 = await build(input2, "low");
    const r2 = await respond(t2, "second");
    finish(t2, r2.response, { read: 1000, write: 200 });
    // Defense in depth: corrupt the stored index so it names this turn's user message.
    const input3 = [...input2, ...r2.items, userMsg("and the docs")];
    const userIndex = JSON.parse(await todayBody(input3, "low")).messages.length - 1;
    for (const entry of perMessageEffortStoreForTests().entries.values()) entry.changePoints = entry.changePoints.map(point => ({ ...point, wireIndex: userIndex }));
    const t3 = await build(input3, "low");
    expect(JSON.stringify(t3.body)).toBe(await todayBody(input3, "low"));
    expect(betaOf(t3.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
  });


  test("an OAuth provider is outside the first slice", async () => {
    const oauth: OcxProviderConfig = { ...KEY_PROVIDER, authMode: "oauth", apiKey: "oauth-access" };
    const input = [userMsg("fix the bug")];
    const t1 = await build(input, "high", { provider: oauth });
    expect(JSON.stringify(t1.body)).toBe(await todayBody(input, "high", oauth));
    expect(betaOf(t1.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
  });

  test("an omitted output cap that follows effort makes the change ineligible", async () => {
    const derived: OcxProviderConfig = { ...KEY_PROVIDER, defaultMaxOutputTokens: undefined };
    const transcript = await committedFirstTurn(derived);
    const input2 = [...transcript, userMsg("next")];
    const t2 = await build(input2, "low", { provider: derived });
    expect(JSON.stringify(t2.body)).toBe(await todayBody(input2, "low", derived));
    expect(betaOf(t2.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
  });

  test("a turn that completes on another adapter, or does not complete, is not committed", async () => {
    for (const [status, adapterName] of [["completed", "openai-responses"], ["failed", "anthropic"], ["incomplete", "anthropic"]] as const) {
      resetPerMessageEffortStoreForTests();
      const input1 = [userMsg("fix the bug")];
      const t1 = await build(input1, "high");
      const r1 = await respond(t1, "first");
      settleAnthropicPerMessageEffort(t1.parsed, { ...withCache(r1.response, { read: 0, write: 1000 }), status }, adapterName);
      const store = perMessageEffortStoreForTests();
      expect(store.entries.size + store.pending.size).toBe(0);
    }
  });

  test("the documented model-unsupported 400 marks the model unsupported for later chats", async () => {
    const t1 = await build([userMsg("fix the bug")], "high");
    const refusal = new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config.effort requires a model that supports per-turn effort; this model does not" } }), { status: 400 });
    await rejectAnthropicPerMessageEffort(t1.parsed, refusal);
    expect(perMessageEffortStoreForTests().capability.size).toBe(1);
    const other = await build([userMsg("another chat")], "high", { thread: "thread-2" });
    expect(betaOf(other.headers)).not.toContain(PER_MESSAGE_EFFORT_BETA);
  });

  test("any other upstream error deletes the pending turn without a capability record", async () => {
    const t1 = await build([userMsg("fix the bug")], "high");
    await rejectAnthropicPerMessageEffort(t1.parsed, new Response("{}", { status: 529 }));
    const store = perMessageEffortStoreForTests();
    expect(store.pending.size + store.capability.size).toBe(0);
  });
});

describe("turn metadata and input mapping", () => {
  test("HTTP reads the request header; WebSocket reads only the frame's own client_metadata", () => {
    const upgrade = new Headers({ "x-codex-turn-metadata": NEW_META });
    expect(codexTurnStartsNewHistory({}, upgrade)).toBe(true);
    // Codex 0.167 sends the lowercase serde spelling.
    expect(codexTurnStartsNewHistory({}, new Headers({ "x-codex-turn-metadata": JSON.stringify({ history_initialization: "new", request_kind: "turn" }) }))).toBe(true);
    expect(codexTurnStartsNewHistory({}, new Headers({ "x-codex-turn-metadata": JSON.stringify({ history_initialization: "ColdResume" }) }))).toBe(false);
    expect(codexTurnStartsNewHistory({}, new Headers({ "x-codex-turn-metadata": "{not json" }))).toBe(false);
    expect(codexTurnStartsNewHistory({}, upgrade, "websocket")).toBe(false);
    expect(codexTurnStartsNewHistory({ client_metadata: { "x-codex-turn-metadata": NEW_META } }, new Headers(), "websocket")).toBe(true);
  });

  test("the new input is the trailing run of user, tool-result, developer and configuration items", () => {
    const call = { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" };
    const out = { type: "function_call_output", call_id: "c1", output: "ok" };
    const dev = { type: "message", role: "developer", content: [{ type: "input_text", text: "env" }] };
    const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
    expect(splitTurnInput([dev, userMsg("a")])).toEqual({ parent: [], suffix: [dev, userMsg("a")] });
    expect(splitTurnInput([userMsg("a"), call, out, userMsg("b")])).toEqual({ parent: [userMsg("a"), call], suffix: [out, userMsg("b")] });
    expect(splitTurnInput([userMsg("a"), assistant])).toEqual({ parent: [userMsg("a"), assistant], suffix: [] });
  });

  test("the effort message index is the wire message that starts with this turn's user text", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "continue" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "env" }, { type: "text", text: "continue" }] },
    ];
    // Merged behind other content: not placeable, and an earlier identical message is never used.
    expect(userMessageWireIndex(messages, [userMsg("continue")])).toBeUndefined();
    expect(userMessageWireIndex([...messages.slice(0, 2), { role: "user", content: [{ type: "text", text: "continue" }] }], [userMsg("continue")])).toBe(2);
    expect(userMessageWireIndex(messages, [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:" }] }])).toBeUndefined();
  });
});

