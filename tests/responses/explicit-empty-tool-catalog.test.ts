import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ProviderAdapter } from "../../src/adapters/base";
import * as adapterResolver from "../../src/server/adapter-resolve";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { resetProviderRequestPacingForTest } from "../../src/providers/request-pacing";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { closeRequestHistoryIndex } from "../../src/routing/history/indexer";
import type { AdapterEvent, OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";

type Wire = "chat" | "messages";
type Rec = Record<string, unknown>;
type Catalog = "empty" | "omitted" | "partial";
type Lane = { name: string; inbound: Wire; upstream?: Wire; native?: boolean; combo?: boolean; direct?: boolean };

// Both the current branch and its base can run these endpoint regressions. In particular,
// the expected public error code is not imported from a newly introduced guard helper.
const REFUSAL_CODE = "undeclared_tool_call";
const NATIVE_MARKER = "native-response-extension-preserved";
const MODEL = "fixture/model";
const lanes: Lane[] = [
  { name: "native Chat", inbound: "chat", upstream: "chat", native: true },
  { name: "native Messages", inbound: "messages", upstream: "messages", native: true },
  { name: "native Chat combo", inbound: "chat", upstream: "chat", native: true, combo: true },
  { name: "adapter Messages to Chat", inbound: "chat", upstream: "messages" },
  { name: "adapter Chat to Messages", inbound: "messages", upstream: "chat" },
  { name: "direct encoder Messages to Chat", inbound: "chat", upstream: "messages", direct: true },
  { name: "direct encoder Chat to Messages", inbound: "messages", upstream: "chat", direct: true },
  { name: "runTurn to Chat", inbound: "chat" },
  { name: "runTurn to Messages", inbound: "messages" },
  { name: "runTurn to Chat with directEncoders enabled", inbound: "chat", direct: true },
  { name: "runTurn to Messages with directEncoders enabled", inbound: "messages", direct: true },
];

let home: ReturnType<typeof createTempHome>;
let releaseHome: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
let adapterSpy: ReturnType<typeof spyOn<typeof adapterResolver, "resolveAdapter">> | undefined;

beforeEach(() => {
  home = createTempHome("ocx-empty-tool-catalog-");
  releaseHome = acquireOwnedSpendHome();
  clearKeyCooldowns();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearResponseStateForTests();
});

afterEach(async () => {
  releaseHome?.();
  releaseHome = undefined;
  adapterSpy?.mockRestore();
  adapterSpy = undefined;
  await upstream?.stop(true);
  upstream = undefined;
  closeRequestHistoryIndex();
  await flushResponseState();
  clearResponseStateForTests();
  clearKeyCooldowns();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  resetProviderRequestPacingForTest();
  home.remove();
});

function sse(data: Rec, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function frames(text: string): Rec[] {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    return data && data !== "[DONE]" ? [JSON.parse(data) as Rec] : [];
  });
}

function chatReply(stream: boolean, tool: boolean): Response {
  const common = { id: "chatcmpl-fixture", object: "chat.completion", model: "model", fixture_extra: NATIVE_MARKER };
  const call = { id: "call_write", type: "function", function: { name: "Write", arguments: '{"path":"fixture.txt"}' } };
  if (!stream) return Response.json({
    ...common,
    choices: [{ index: 0, message: { role: "assistant", content: tool ? null : "fixture text", ...(tool ? { tool_calls: [call] } : {}) },
      finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
  const chunk = (delta: Rec, finish_reason: string | null = null) => ({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] });
  return new Response([
    sse(chunk({ role: "assistant" })),
    sse(chunk(tool ? { tool_calls: [{ ...call, index: 0 }] } : { content: "fixture text" })),
    sse(chunk({}, tool ? "tool_calls" : "stop")),
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
}

function messagesReply(stream: boolean, tool: boolean): Response {
  const block = tool ? { type: "tool_use", id: "call_write", name: "Write", input: { path: "fixture.txt" } }
    : { type: "text", text: "fixture text" };
  const message = { id: "msg_fixture", type: "message", role: "assistant", model: "model", content: [block],
    stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3 }, fixture_extra: NATIVE_MARKER };
  if (!stream) return Response.json(message);
  const items: Rec[] = [
    { type: "message_start", message: { ...message, content: [], stop_reason: null } },
    { type: "content_block_start", index: 0, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' } : { type: "text_delta", text: "fixture text" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  return new Response(items.map(item => sse(item, String(item.type))).join(""), { headers: { "content-type": "text/event-stream" } });
}

function requestTools(wire: Wire, catalog: Catalog): Rec {
  if (catalog === "omitted") return {};
  if (catalog === "empty") return { tools: [] };
  return { tools: wire === "chat"
    ? [{ type: "function", function: { name: "Read", parameters: { type: "object", properties: {} } } }]
    : [{ name: "Read", input_schema: { type: "object", properties: {} } }] };
}

async function dispatch(lane: Lane, stream: boolean, catalog: Catalog, tool: boolean, options: {
  reply?: (body: Rec) => Response | Promise<Response>;
  video?: boolean;
  body?: Rec;
} = {}) {
  const seen: Rec[] = [];
  let runTurns = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    // A fixture must never reach an external media service; Write is a client tool, not
    // the configured hosted video operation. Any attempted fulfillment fails the send count.
    if (new URL(request.url).pathname.startsWith("/xai")) {
      seen.push({ unexpectedHostedVideoRequest: true });
      return Response.json({ error: { message: "unexpected hosted video fulfillment" } }, { status: 500 });
    }
    const body = await request.json() as Rec;
    seen.push(body);
    if (options.reply) return options.reply(body);
    return lane.upstream === "chat" ? chatReply(body.stream === true, tool) : messagesReply(body.stream === true, tool);
  } });
  const adapter = lane.upstream === "chat" ? "openai-chat" : lane.upstream === "messages" ? "anthropic" : "fixture-run-turn";
  if (!lane.upstream) {
    const originalResolve = adapterResolver.resolveAdapter;
    adapterSpy = spyOn(adapterResolver, "resolveAdapter").mockImplementation((provider, cache) => {
      if (provider.adapter !== "fixture-run-turn") return originalResolve(provider, cache);
      return {
        name: "fixture-run-turn",
        buildRequest() { throw new Error("runTurn fixture must not build an HTTP request"); },
        async *parseStream(): AsyncGenerator<AdapterEvent> { throw new Error("runTurn fixture must not parse an HTTP response"); },
        async runTurn(_parsed, _incoming, emit) {
          runTurns++;
          if (tool) {
            emit({ type: "tool_call_start", id: "call_write", name: "Write" });
            emit({ type: "tool_call_delta", arguments: '{"path":"fixture.txt"}' });
            emit({ type: "tool_call_end" });
          } else emit({ type: "text_delta", text: "fixture text" });
          emit({ type: "done", usage: { inputTokens: 2, outputTokens: 3 } });
        },
      } satisfies ProviderAdapter;
    });
  }
  const config: OcxConfig = {
    port: 0, defaultProvider: "fixture",
    providers: { fixture: { adapter, baseUrl: `http://127.0.0.1:${upstream.port}/v1`, allowPrivateNetwork: true,
      authMode: "key", apiKey: "fixture-key", models: ["model"], liveModels: false } },
    protocols: { rollout: { managedMessagesNative: lane.native && lane.inbound === "messages", nativeChatCombos: !!lane.combo, directEncoders: !!lane.direct } },
    ...(lane.combo ? { combos: { fixture: { strategy: "failover", targets: [{ provider: "fixture", model: "model" }] } } } : {}),
  };
  if (options.video) {
    config.images = { videoBridgeEnabled: true };
    config.providers.xai = { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/xai`,
      allowPrivateNetwork: true, authMode: "key", apiKey: "fixture-video-key", models: ["video"], liveModels: false };
  }
  const model = lane.combo ? "combo/fixture" : MODEL;
  const body = { model, stream, messages: [{ role: "user", content: "fixture request" }],
    ...(lane.inbound === "messages" ? { max_tokens: 64 } : {}), ...requestTools(lane.inbound, catalog), ...options.body };
  const request = new Request(`http://localhost/v1/${lane.inbound === "chat" ? "chat/completions" : "messages"}`, {
    method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body),
  });
  const context = { model: "", provider: "" };
  const response = lane.inbound === "chat" ? await handleChatCompletions(request, config, context)
    : await handleClaudeMessages(request, config, context);
  const text = await response.text();
  expect(lane.upstream ? seen.length : runTurns).toBe(1);
  if (options.video) expect(JSON.stringify(seen[0]?.tools)).toContain("video_gen");
  return { response, text, model, seen };
}

function assertRefusal(wire: Wire, stream: boolean, response: Response, text: string): void {
  expect(text).toContain(REFUSAL_CODE);
  expect(text).not.toContain('"name":"Write"');
  // A native upstream may return JSON to an SSE caller. A guard that has not committed
  // headers can correctly refuse with HTTP 502 JSON instead of starting an error stream.
  if (!stream || response.status !== 200) {
    expect(response.status).toBe(502);
    const body = JSON.parse(text);
    expect(body.error).toMatchObject({ code: REFUSAL_CODE });
    if (wire === "messages") expect(body.error.type).toBe("api_error");
    expect(body.choices).toBeUndefined();
    expect(body.content).toBeUndefined();
    return;
  }
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const events = frames(text);
  const errors = events.filter(item => typeof item.error === "object" && item.error !== null);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.error).toMatchObject({ code: REFUSAL_CODE });
  expect(text).not.toContain("[DONE]");
  if (wire === "messages") {
    expect(errors[0]).toMatchObject({ type: "error", error: { type: "api_error" } });
    expect(events.some(item => item.type === "message_stop")).toBe(false);
    expect(events.some(item => item.type === "message_delta" && (item.delta as Rec | undefined)?.stop_reason != null)).toBe(false);
    expect(events.some(item => (item.content_block as Rec | undefined)?.type === "tool_use")).toBe(false);
  } else {
    const choices = events.flatMap(item => Array.isArray(item.choices) ? item.choices as Rec[] : []);
    expect(choices.some(choice => choice.finish_reason != null)).toBe(false);
    expect(choices.some(choice => Array.isArray((choice.delta as Rec | undefined)?.tool_calls))).toBe(false);
  }
}

function assertSuccess(wire: Wire, stream: boolean, response: Response, text: string, tool: boolean): void {
  expect(response.status).toBe(200);
  expect(text).not.toContain(REFUSAL_CODE);
  expect(text).toContain(tool ? "Write" : "fixture text");
  if (stream) {
    const events = frames(text);
    expect(events.some(item => item.error !== undefined)).toBe(false);
    if (wire === "chat") expect(text).toContain("[DONE]");
    else expect(events.some(item => item.type === "message_stop")).toBe(true);
  } else {
    const body = JSON.parse(text);
    expect(body.error).toBeUndefined();
    if (wire === "chat") expect(body.choices[0].finish_reason).toBe(tool ? "tool_calls" : "stop");
    else expect(body.stop_reason).toBe(tool ? "tool_use" : "end_turn");
  }
}

describe("explicit empty tool catalogs across endpoint delivery lanes", () => {
  for (const lane of lanes) for (const stream of [false, true]) {
    const label = `${lane.name}, ${stream ? "SSE" : "JSON"}`;
    test(`${label}: tools:[] refuses an upstream Write without a successful tool or terminal`, async () => {
      const { response, text } = await dispatch(lane, stream, "empty", true);
      assertRefusal(lane.inbound, stream, response, text);
    });
    for (const catalog of ["omitted", "partial"] as const) {
      test(`${label}: ${catalog} catalog preserves deferred Write`, async () => {
        const { response, text } = await dispatch(lane, stream, catalog, true);
        assertSuccess(lane.inbound, stream, response, text, true);
      });
    }
    test(`${label}: tools:[] still permits a text-only completion`, async () => {
      const { response, text, model } = await dispatch(lane, stream, "empty", false);
      assertSuccess(lane.inbound, stream, response, text, false);
      // Refusing tools must not turn a native lane into a lossy translated response.
      if (lane.native) {
        expect(text).toContain(NATIVE_MARKER);
        // Native Chat JSON preserves the upstream model; its SSE and native Messages echo
        // the caller selector. Keep each existing wire contract while adding the refusal.
        expect(text).toContain(`"model":"${lane.inbound === "chat" && !stream ? "model" : model}"`);
      }
    });
  }
});

describe("legacy Chat functions alongside an explicit empty tools array", () => {
  const lane: Lane = { name: "native Chat", inbound: "chat", upstream: "chat", native: true };
  const body = { functions: [{ name: "Read", parameters: { type: "object", properties: {} } }] };
  for (const stream of [false, true]) {
    test(`legacy Read cannot authorize Write (${stream ? "SSE" : "JSON"})`, async () => {
      const { response, text } = await dispatch(lane, stream, "empty", true, { body });
      assertRefusal("chat", stream, response, text);
    });
    test(`legacy Read remains declared (${stream ? "SSE" : "JSON"})`, async () => {
      const { response, text } = await dispatch(lane, stream, "empty", true, { body, reply: async upstreamBody => {
        const answer = chatReply(upstreamBody.stream === true, true);
        return new Response((await answer.text()).replaceAll("Write", "Read"), { headers: answer.headers });
      } });
      expect(response.status).toBe(200);
      expect(text).not.toContain(REFUSAL_CODE);
      expect(text).toContain("Read");
      if (stream) expect(text).toContain("[DONE]");
      else expect(JSON.parse(text).choices[0].finish_reason).toBe("tool_calls");
    });
  }
  for (const splitName of [false, true]) test(`legacy Read accepts ${splitName ? "split-name" : "id-first"} SSE fragments`, async () => {
    const deltas = [
      { tool_calls: [{ index: 0, id: "call_read", type: "function", function: {} }] },
      { tool_calls: [{ index: 0, function: { name: splitName ? "Re" : "Read" } }] },
      ...(splitName ? [{ tool_calls: [{ index: 0, function: { name: "ad" } }] }] : []),
      { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
    ];
    const { response, text } = await dispatch(lane, true, "empty", true, { body, reply: () => new Response(
      deltas.map(delta => sse({ choices: [{ index: 0, delta, finish_reason: null }] })).join("")
        + sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    ) });
    expect(response.status).toBe(200);
    expect(text).not.toContain(REFUSAL_CODE);
    expect(text).toContain("[DONE]");
    const names = frames(text).flatMap(event => Array.isArray(event.choices) ? event.choices : [])
      .flatMap(choice => (choice as { delta?: { tool_calls?: Array<{ function?: { name?: string } }> } }).delta?.tool_calls ?? [])
      .map(call => call.function?.name ?? "").join("");
    expect(names).toBe("Read");
  });
});

describe("explicit empty catalogs on alternate native tool frames", () => {
  const chat: Lane = { name: "native Chat", inbound: "chat", upstream: "chat", native: true };
  const messages: Lane = { name: "native Messages", inbound: "messages", upstream: "messages", native: true };
  const chatVariants: Array<{ name: string; payload: Rec }> = [
    { name: "argument-only tool delta", payload: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null }] } },
    { name: "id-only tool delta", payload: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_orphan" }] }, finish_reason: null }] } },
    { name: "legacy function_call", payload: { choices: [{ index: 0, delta: { function_call: { name: "Write", arguments: "{}" } }, finish_reason: null }] } },
    { name: "secondary choice tool", payload: { choices: [{ index: 0, delta: { content: "safe prefix" }, finish_reason: null },
      { index: 1, delta: { tool_calls: [{ index: 0, id: "call_other", function: { name: "Write", arguments: "{}" } }] }, finish_reason: null }] } },
    { name: "message-shaped tool chunk", payload: { choices: [{ index: 0, message: { role: "assistant", tool_calls: [{ id: "call_message", function: { name: "Write", arguments: "{}" } }] }, finish_reason: null }] } },
  ];
  for (const stream of [false, true]) {
    for (const variant of chatVariants) test(`native Chat ${variant.name}, caller ${stream ? "SSE" : "JSON"}`, async () => {
      const { response, text } = await dispatch(chat, stream, "empty", true, { reply: () => new Response(
        sse(variant.payload) + sse({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      ) });
      assertRefusal("chat", stream, response, text);
    });
    test(`native Chat opposite upstream wire, caller ${stream ? "SSE" : "JSON"}`, async () => {
      const { response, text } = await dispatch(chat, stream, "empty", true, { reply: () => chatReply(!stream, true) });
      assertRefusal("chat", stream, response, text);
    });
    test(`native Messages opposite upstream wire, caller ${stream ? "SSE" : "JSON"}`, async () => {
      const { response, text } = await dispatch(messages, stream, "empty", true, { reply: () => messagesReply(!stream, true) });
      assertRefusal("messages", stream, response, text);
    });
    for (const variant of ["orphan arguments", "tool inside message_start"] as const) {
      test(`native Messages ${variant}, caller ${stream ? "SSE" : "JSON"}`, async () => {
        const start = { type: "message_start", message: { id: "msg_variant", type: "message", role: "assistant", model: "model",
          content: variant === "tool inside message_start" ? [{ type: "tool_use", id: "call_nested", name: "Write", input: {} }] : [],
          stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
        const argument = { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } };
        const done = { type: "message_stop" };
        const { response, text } = await dispatch(messages, stream, "empty", true, { reply: () => new Response(
          sse(start, start.type) + sse(argument, argument.type) + sse(done, done.type),
          { headers: { "content-type": "text/event-stream" } },
        ) });
        assertRefusal("messages", stream, response, text);
      });
    }
    test(`native Messages tool token split over data lines, caller ${stream ? "SSE" : "JSON"}`, async () => {
      // The native collector also accepts concatenated data lines, so the guard must use
      // the same interpretation instead of missing a tool token split inside a JSON string.
      const { response, text } = await dispatch(messages, stream, "empty", true, { reply: () => new Response(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_\n'
          + 'data: use","id":"call_split","name":"Write","input":{}}}\n\n'
          + sse({ type: "message_stop" }, "message_stop"),
        { headers: { "content-type": "text/event-stream" } },
      ) });
      assertRefusal("messages", stream, response, text);
    });
    test(`native Messages hosted server tool remains permitted, caller ${stream ? "SSE" : "JSON"}`, async () => {
      const { response, text } = await dispatch(messages, stream, "empty", false, { reply: () => {
        const serverTool = { type: "server_tool_use", id: "server_search", name: "web_search", input: {} };
        const start = { type: "message_start", message: { id: "msg_hosted", type: "message", role: "assistant", model: "model",
          content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } };
        const events: Rec[] = [start,
          { type: "content_block_start", index: 0, content_block: serverTool },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"fixture"}' } },
          { type: "content_block_stop", index: 0 },
          { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "fixture text" } },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ];
        return new Response(events.map(item => sse(item, String(item.type))).join(""), { headers: { "content-type": "text/event-stream" } });
      } });
      assertSuccess("messages", stream, response, text, false);
    });
  }
});

describe("explicit empty catalogs with a configured video sidecar", () => {
  for (const lane of lanes.filter(item => item.name.startsWith("adapter "))) for (const stream of [false, true]) {
    const label = `${lane.name}, ${stream ? "SSE" : "JSON"}`;
    test(`${label}: synthetic hosted tool does not authorize Write`, async () => {
      const { response, text } = await dispatch(lane, stream, "empty", true, { video: true });
      assertRefusal(lane.inbound, stream, response, text);
    });
    for (const catalog of ["omitted", "partial"] as const) test(`${label}: ${catalog} still defers Write with hosted video configured`, async () => {
      const { response, text } = await dispatch(lane, stream, catalog, true, { video: true });
      assertSuccess(lane.inbound, stream, response, text, true);
    });
    test(`${label}: empty catalog and hosted video still permit text`, async () => {
      const { response, text } = await dispatch(lane, stream, "empty", false, { video: true });
      assertSuccess(lane.inbound, stream, response, text, false);
    });
  }
});
