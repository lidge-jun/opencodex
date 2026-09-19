import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { OcxConfig } from "../../src/types";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { NativeSteeringChannel, MAX_NATIVE_STEERS, validateSteeringFrame } from "../../src/server/responses/native-steering";
import { NativeSteeringReplay, MAX_NATIVE_STEERING_REPLAY_BYTES } from "../../src/server/responses/native-steering-replay";
import { type WsData } from "../../src/server/ws-bridge";
import { getRequestLogEntries, clearRequestLogsForTests } from "../../src/server/request-log";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { MAX_ACTIVE_TURNS, tryAdmitTurn } from "../../src/server/lifecycle";
import { configSchema } from "../../src/config/schema/config-schema";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

// The websocket handler dispatches through the real request path, so it reaches the shared spend
// journal and needs the writer lease startServer would have taken. Without it the turn is refused
// and the symptom is this file's own waitFor timing out, which names nothing.
let releaseSpendHome: (() => void) | undefined;
// Every synthetic client this file opens, so teardown can close them before the lease is given
// back rather than leaving a handler mid-turn against a journal nobody owns.
const clients: Array<ServerWebSocket<WsData>> = [];

type Frame = Record<string, any>;
const realSocket = globalThis.WebSocket;
const realFetch = globalThis.fetch;
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedProxy: Record<string, string | undefined>;
let fallbackCalls = 0;
let nextId = 0;

class Socket extends EventTarget {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  frames: Frame[] = [];
  readonly root = `native-${++nextId}`;
  constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
    super(); Socket.all.push(this);
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(text: string) {
    const frame = JSON.parse(text);
    this.frames.push(frame);
    if (this.frames.length === 1) queueMicrotask(() => this.emit({ type: "response.created", response: { id: this.root, status: "in_progress", output: [] } }));
  }
  emit(frame: Frame) {
    const lane = this.frames[0]?.stream_id;
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ ...(lane !== undefined ? { stream_id: lane } : {}), ...frame }) }));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const config = (): OcxConfig => ({ port: 0, defaultProvider: "openai", websockets: true, codexNativeSteering: true,
  providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", codexAccountMode: "direct" } },
} as OcxConfig);
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 1000; i++) { if (condition()) return; await Bun.sleep(1); }
  throw new Error("fixture condition timed out");
};
function downstream(fields: Frame = {}, settings = config(), credential = "test") {
  releaseSpendHome ??= acquireOwnedSpendHome();
  const handler = createWebsocketHandler({ config: settings, deps: {} } as ServeOptionsContext);
  const sent: Frame[] = [];
  const ws = { readyState: 1, data: { headers: new Headers({ authorization: `Bearer ${credential}`, "thread-id": `fixture-${credential}`, session_id: `fixture-${credential}` }) } as WsData,
    send: (text: string) => { sent.push(JSON.parse(text)); return 1; }, close() { handler.close(ws); },
  } as unknown as ServerWebSocket<WsData>;
  const send = (frame: Frame) => handler.message(ws, JSON.stringify(frame));
  clients.push(ws);
  send({ type: "response.create", model: "gpt-5.5", input: "initial", ...fields });
  return { ws, sent, send, handler };
}
async function begin(fields: Frame = {}, credential = "test") {
  const client = downstream(fields, config(), credential);
  await waitFor(() => client.sent.some(frame => frame.type === "response.created"));
  const socket = Socket.all.find(s => s.options.headers.authorization === `Bearer ${credential}`)!;
  expect(socket).toBeDefined();
  return { ...client, socket, id: socket.root };
}
function accept(socket: Socket, id: string, steerId = "s1") {
  socket.emit({ type: "response.steer.accepted", steer: { id: steerId, previous_response_id: id } });
}
function complete(socket: Socket, id: string, extra: Frame = {}) {
  socket.emit({ type: "response.completed", response: { id, status: "completed", output: [], ...extra } });
}
beforeEach(() => {
  nextId = 0; fallbackCalls = 0;
  savedProxy = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  for (const key of proxyKeys) delete process.env[key];
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  globalThis.fetch = (async () => { fallbackCalls++; throw new Error("unexpected network/fallback in native steering fixture"); }) as typeof fetch;
  clearRequestLogsForTests();
});
afterEach(async () => {
  // handler.close only STARTS the pump cancellation. Waiting for the socket to drop its stream
  // cancel and its native control is what proves the turn finished accounting; releasing the
  // lease before that leaves a reader settling against a journal nobody owns.
  //
  // The rest runs even when that wait gives up, and the failure still propagates. A wait that
  // expired is NOT evidence the turn settled: it means this fixture could not prove it, and the
  // case should say so while still handing back the lease and the globals it replaced.
  let failure: unknown;
  const note = (error: unknown): void => { failure ??= error; };
  try {
    // Every client gets its close and its wait even after an earlier one gave up. Stopping at
    // the first failure left the rest open for the next case to inherit.
    for (const client of clients.splice(0)) {
      // Separate guards: close() runs the production handler, so a throw there would otherwise
      // skip this client's completion wait as well as its own failure.
      try { client.close(); } catch (error) { note(error); }
      try {
        await waitFor(() => client.data.cancel === undefined && client.data.nativeControl === undefined);
      } catch (error) { note(error); }
    }
    for (const socket of Socket.all) {
      try { socket.close(); } catch (error) { note(error); }
    }
    Socket.all = [];
    try { runOptionalShutdownHooks(); } catch (error) { note(error); }
    // The release itself can throw, and it used to take the global restore down with it.
    try { releaseSpendHome?.(); } catch (error) { note(error); } finally { releaseSpendHome = undefined; }
  } finally {
    globalThis.WebSocket = realSocket;
    globalThis.fetch = realFetch;
    for (const key of proxyKeys) { delete process.env[key]; if (savedProxy[key] !== undefined) process.env[key] = savedProxy[key]; }
  }
  if (failure !== undefined) throw failure;
});

test("configuration is explicit opt-in and malformed values fail closed", () => {
  const value = config();
  expect(configSchema.parse(value).codexNativeSteering).toBe(true);
  expect(configSchema.parse({ ...value, codexNativeSteering: "true" }).codexNativeSteering).toBe(false);
  delete value.codexNativeSteering;
  expect(configSchema.parse(value).codexNativeSteering).not.toBe(true);
});

test("real handler -> auth/dispatch -> native exchange -> downstream preserves automatic successor and aggregate usage", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "do not edit" });
  expect(socket.frames[1]).toEqual({ type: "response.steer", previous_response_id: id, input: "do not edit" });
  accept(socket, id);
  socket.emit({ type: "response.incomplete", response: { id, status: "incomplete", output: [], incomplete_details: { reason: "steered" }, usage: { input_tokens: 10, output_tokens: 2 } } });
  socket.emit({ type: "response.created", response: { id: "successor", previous_response_id: id, output: [] } });
  complete(socket, "successor", { usage: { input_tokens: 20, output_tokens: 3 } });
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.map(frame => frame.type)).toEqual(["response.created", "response.steer.accepted", "response.incomplete", "response.created", "response.completed"]);
  expect(sent.at(-1)?.response.id).toBe("successor");
  expect(Socket.all).toHaveLength(1);
  expect(socket.frames).toHaveLength(2); // no synthetic create for an automatic successor
  expect(socket.readyState).toBe(3);
  expect(fallbackCalls).toBe(0);
  const log = getRequestLogEntries().at(-1)!;
  expect(log.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 });
  expect(log.terminalStatus).toBe("completed");
  expect(log.upstreamError).toBeUndefined();
});

test("normal completion before acceptance still retains the socket and successor", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "new constraint" });
  complete(socket, id);
  accept(socket, id);
  socket.emit({ type: "response.created", response: { id: "r2", previous_response_id: id } });
  complete(socket, "r2");
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.filter(frame => frame.type === "response.completed").map(frame => frame.response.id)).toEqual([id, "r2"]);
});

test("pending results use one same-account/lane create and never replay accepted user text", async () => {
  const { ws, socket, send, sent, id } = await begin({ stream_id: "lane" });
  send({ type: "response.steer", previous_response_id: id, input: "keep files" });
  send({ type: "response.steer", previous_response_id: id, input: "only report" });
  accept(socket, id); accept(socket, id, "s2");
  complete(socket, id);
  const stub = { type: "function_call_output", call_id: "call-1" };
  for (const steerId of ["s1", "s2"]) socket.emit({ type: "response.steer.pending", steer: { id: steerId, previous_response_id: id }, reason: "waiting_for_required_input", required_input: [stub] });
  await waitFor(() => sent.some(frame => frame.type === "response.steer.pending"));
  const continuation = { type: "response.create", previous_response_id: id, stream_id: "lane", model: "gpt-5.5", input: [{ ...stub, output: "saved result" }] };
  send(continuation); send(continuation);
  await waitFor(() => socket.frames.length === 4);
  expect(socket.frames).toHaveLength(4); // initial, two steers, exactly one continuation
  expect(socket.frames[3].previous_response_id).toBe(id);
  expect(socket.frames[3].stream_id).toBe("lane");
  expect(socket.frames[3].input).toEqual(continuation.input);
  expect(sent.at(-1)?.error.code).toBe("duplicate_continuation");
  socket.emit({ type: "response.created", response: { id: "r2", previous_response_id: id } });
  complete(socket, "r2");
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.response.id).toBe("r2");
  expect(Socket.all).toHaveLength(1);
});

test("subsequent ordinary turns retain committed steering through the scoped replay cache", async () => {
  const { ws, socket, send, id, sent } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "committed instruction" });
  accept(socket, id); complete(socket, id);
  socket.emit({ type: "response.created", response: { id: "cached-successor", previous_response_id: id } });
  complete(socket, "cached-successor");
  await waitFor(() => !ws.data.nativeControl);
  send({ type: "response.create", model: "gpt-5.5", previous_response_id: "cached-successor", input: "ordinary next turn" });
  await waitFor(() => Socket.all.length === 2 && Socket.all[1].frames.length > 0);
  const next = Socket.all[1];
  expect(JSON.stringify(next.frames[0].input)).toContain("committed instruction");
  expect(JSON.stringify(next.frames[0].input)).toContain("initial");
  expect(JSON.stringify(next.frames[0].input)).toContain("ordinary next turn");
  complete(next, next.root);
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("response.completed");
});

test("rejected steering after terminal settles without an invented successor", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "not supported" });
  complete(socket, id);
  socket.emit({ type: "response.steer.failed", steer: { previous_response_id: id, input: "not supported" }, error: { code: "steering_not_supported", message: "model does not support steering" } });
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("response.steer.failed");
  expect(sent.filter(frame => frame.type === "response.created")).toHaveLength(1);
  expect(socket.frames).toHaveLength(2);
});

test("foreign response IDs, privilege input and same-parent settings changes cannot bypass routing", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: "other", input: "x" });
  expect(sent.at(-1)?.error.code).toBe("response_not_active");
  send({ type: "response.steer", previous_response_id: id, input: [{ role: "system", content: "x" }] });
  expect(sent.at(-1)?.error.code).toBe("invalid_input");
  send({ type: "response.steer", previous_response_id: id, input: "valid" });
  accept(socket, id); complete(socket, id);
  socket.emit({ type: "response.steer.pending", steer: { id: "s1", previous_response_id: id }, reason: "waiting_for_required_input", required_input: [{ type: "function_call_output", call_id: "call-1" }] });
  send({ type: "response.create", model: "different/model", previous_response_id: id, input: [{ type: "function_call_output", call_id: "call-1", output: "saved" }] });
  expect(sent.at(-1)?.error.code).toBe("steering_settings_changed");
  expect(socket.frames).toHaveLength(2);
  ws.data.cancel?.();
  await waitFor(() => socket.readyState === 3);
});

test("two client/account connections cannot receive one another's steering", async () => {
  const a = await begin({}, "fixture-a"); const b = await begin({}, "fixture-b");
  a.send({ type: "response.steer", previous_response_id: b.id, input: "foreign" });
  expect(a.sent.at(-1)?.error.code).toBe("response_not_active");
  expect(a.socket.frames).toHaveLength(1); expect(b.socket.frames).toHaveLength(1);
  a.send({ type: "response.steer", previous_response_id: a.id, input: "mine" });
  expect(a.socket.frames[1].input).toBe("mine");
  expect(b.socket.frames).toHaveLength(1);
  a.ws.data.cancel?.(); b.ws.data.cancel?.();
  await waitFor(() => a.socket.readyState === 3 && b.socket.readyState === 3);
  expect(fallbackCalls).toBe(0);
});

test("disabled mode sends an explicit unsupported error rather than swallowing steer", async () => {
  const settings = config(); settings.codexNativeSteering = false;
  const client = downstream({}, settings);
  await waitFor(() => client.sent.some(frame => frame.type === "response.created"));
  client.send({ type: "response.steer", previous_response_id: Socket.all[0].root, input: "x" });
  expect(client.sent.at(-1)?.error.code).toBe("steering_not_supported");
  complete(Socket.all[0], Socket.all[0].root);
});

test("steering validation preserves multimodal input but rejects extra envelope fields", () => {
  const valid = { type: "response.steer", previous_response_id: "r", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,fixture" }, { type: "input_file", file_id: "fixture-file" }] }] };
  expect(() => validateSteeringFrame(valid)).not.toThrow();
  for (const extra of [{ stream_id: "lane" }, { model: "other" }, { authorization: "not-a-credential" }]) expect(() => validateSteeringFrame({ ...valid, ...extra })).toThrow();
  expect(() => validateSteeringFrame({ ...valid, input: [] })).toThrow();
});

test("pending submissions have a hard count bound and disconnect releases them", () => {
  const channel = new NativeSteeringChannel({ model: "fixture" });
  const detach = channel.attach(() => {}, () => {});
  channel.observe({ type: "response.created", response: { id: "r" } });
  for (let i = 0; i < MAX_NATIVE_STEERS; i++) channel.steer({ type: "response.steer", previous_response_id: "r", input: "x" });
  expect(() => channel.steer({ type: "response.steer", previous_response_id: "r", input: "x" })).toThrow("limit");
  detach(); expect(channel.hasOutstanding).toBe(false);
});

test("foreign lane or successor parent is a non-replayable protocol failure", () => {
  const channel = new NativeSteeringChannel({ stream_id: "one" });
  const detach = channel.attach(() => {}, () => {});
  expect(() => channel.observe({ type: "response.created", stream_id: "two", response: { id: "r" } })).toThrow("lane mismatch");
  detach();
});

test("replay budget refuses overflow instead of silently losing context", () => {
  expect(() => new NativeSteeringReplay("x".repeat(MAX_NATIVE_STEERING_REPLAY_BYTES), () => {})).toThrow("budget");
});

test("HTTP upgrade fallback keeps ordinary streaming and rejects steering explicitly", async () => {
  globalThis.WebSocket = class { constructor() { throw new Error("fixture unavailable upgrade"); } } as unknown as typeof WebSocket;
  let finish!: () => void;
  globalThis.fetch = (async () => {
    fallbackCalls++;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      const event = (value: Frame) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      event({ type: "response.created", response: { id: "http-response", status: "in_progress", output: [] } });
      finish = () => { event({ type: "response.completed", response: { id: "http-response", status: "completed", output: [] } }); controller.close(); };
    } });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const { ws, send, sent } = downstream();
  await waitFor(() => sent.some(frame => frame.type === "response.created"));
  send({ type: "response.steer", previous_response_id: "http-response", input: "not delivered" });
  expect(sent.at(-1)?.error.code).toBe("steering_not_supported");
  finish();
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("response.completed");
  expect(fallbackCalls).toBe(1);
  expect(Socket.all).toHaveLength(0);
});

test("post-send disconnect never replays accepted steering through HTTP or another socket", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "delivery unknown" });
  accept(socket, id);
  socket.close();
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.type).toBe("error");
  expect(fallbackCalls).toBe(0);
  expect(Socket.all).toHaveLength(1);
  expect(socket.frames).toHaveLength(2);
});

test("downstream disconnect closes the dedicated upstream while steering is pending", async () => {
  const { ws, socket, handler, send, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "only report" });
  accept(socket, id); complete(socket, id);
  socket.emit({ type: "response.steer.pending", steer: { id: "s1", previous_response_id: id }, reason: "waiting_for_required_input", required_input: [{ type: "function_call_output", call_id: "saved-call" }] });
  handler.close(ws);
  await waitFor(() => socket.readyState === 3 && !ws.data.nativeControl);
  expect(fallbackCalls).toBe(0);
  expect(socket.frames).toHaveLength(2);
});

test("idle deadline is bounded and reports uncertainty without inventing a continuation", async () => {
  const channel = new NativeSteeringChannel({ type: "response.create", model: "fixture" }, 1);
  const sent: Frame[] = [];
  let failure: Error | undefined;
  const detach = channel.attach(frame => sent.push(frame), error => { failure = error; });
  channel.observe({ type: "response.created", response: { id: "idle" } });
  await waitFor(() => failure !== undefined);
  expect(failure?.message).toContain("timed out");
  expect(sent).toHaveLength(0);
  detach();
});

test("saved tool results may arrive before pending and retain extra user input without replaying accepted steering", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "accepted constraint" });
  accept(socket, id);
  complete(socket, id, { output: [{ type: "function_call", call_id: "early-call", name: "lookup", arguments: "{}" }] });
  const input = [
    { type: "function_call_output", call_id: "early-call", output: "saved result" },
    { role: "user", content: "Show the revised plan first." },
  ];
  send({ type: "response.create", previous_response_id: id, model: "gpt-5.5", input });
  await waitFor(() => socket.frames.length === 3);
  expect(socket.frames[2].input).toEqual(input);
  expect(sent.some(frame => frame.type === "error")).toBe(false);
  socket.emit({ type: "response.created", response: { id: "early-successor", previous_response_id: id } });
  complete(socket, "early-successor");
  await waitFor(() => !ws.data.nativeControl);
  expect(Socket.all).toHaveLength(1);
  expect(fallbackCalls).toBe(0);
});

test("pending stub name is optional on a function output but a different supplied name is rejected", () => {
  const channel = new NativeSteeringChannel({ model: "fixture" });
  const sent: Frame[] = [];
  const detach = channel.attach(frame => sent.push(frame), () => {});
  channel.observe({ type: "response.created", response: { id: "r" } });
  channel.steer({ type: "response.steer", previous_response_id: "r", input: "constraint" });
  channel.observe({ type: "response.steer.accepted", steer: { id: "s", previous_response_id: "r" } });
  channel.observe({ type: "response.completed", response: { id: "r", output: [] } });
  channel.observe({ type: "response.steer.pending", steer: { id: "s", previous_response_id: "r" }, reason: "waiting_for_required_input",
    required_input: [{ type: "function_call_output", call_id: "c", name: "lookup" }] });
  const continuation = { type: "response.create", previous_response_id: "r", input: [{ type: "function_call_output", call_id: "c", output: "saved" }] };
  expect(() => channel.continue({ ...continuation, input: [{ ...continuation.input[0], name: "other" }] })).toThrow();
  expect(channel.continue(continuation)).toBe(true);
  expect(sent).toHaveLength(2);
  detach();
});

test("a steering failure cannot close an already submitted explicit continuation", async () => {
  const { ws, socket, send, sent, id } = await begin();
  send({ type: "response.steer", previous_response_id: id, input: "rejected constraint" });
  accept(socket, id);
  complete(socket, id);
  socket.emit({ type: "response.steer.pending", steer: { id: "s1", previous_response_id: id }, reason: "waiting_for_required_input",
    required_input: [{ type: "custom_tool_call_output", call_id: "custom-call" }] });
  send({ type: "response.create", previous_response_id: id, input: [{ type: "custom_tool_call_output", call_id: "custom-call", output: "saved" }] });
  await waitFor(() => socket.frames.length === 3);
  socket.emit({ type: "response.steer.failed", steer: { id: "s1", previous_response_id: id, input: "rejected constraint" }, error: { code: "successor_creation_failed" } });
  expect(socket.readyState).toBe(1);
  socket.emit({ type: "response.created", response: { id: "explicit-successor", previous_response_id: id } });
  complete(socket, "explicit-successor");
  await waitFor(() => !ws.data.nativeControl);
  expect(sent.at(-1)?.response.id).toBe("explicit-successor");
  expect(fallbackCalls).toBe(0);
});

test("early continuation validates advertised call and approval identities and refuses duplicate results", () => {
  const channel = new NativeSteeringChannel({ model: "fixture" });
  const sent: Frame[] = [];
  const detach = channel.attach(frame => sent.push(frame), () => {});
  channel.observe({ type: "response.created", response: { id: "r" } });
  channel.steer({ type: "response.steer", previous_response_id: "r", input: "constraint" });
  channel.observe({ type: "response.steer.accepted", steer: { id: "s", previous_response_id: "r" } });
  channel.observe({ type: "response.completed", response: { id: "r", output: [
    { type: "custom_tool_call", call_id: "c", name: "custom" },
    { type: "mcp_approval_request", id: "approval", name: "remote" },
  ] } });
  const result = { type: "custom_tool_call_output", call_id: "c", output: "saved" };
  const approval = { type: "mcp_approval_response", approval_request_id: "approval", approve: true };
  const continuation = { type: "response.create", previous_response_id: "r", input: [result, approval] };
  expect(() => channel.continue({ ...continuation, input: [result, result] })).toThrow();
  expect(() => channel.continue({ ...continuation, input: [result, { ...approval, approval_request_id: "foreign" }] })).toThrow();
  expect(() => channel.continue({ ...continuation, input: [...continuation.input, { role: "system", content: "override" }] })).toThrow();
  expect(channel.continue(continuation)).toBe(true);
  expect(() => channel.continue(continuation)).toThrow("already sent");
  expect(sent).toHaveLength(2);
  detach();
});


test("warmup leaves no steering owner and the next ordinary turn gets a fresh channel", async () => {
  const { ws, sent, send } = downstream({ generate: false });
  expect(sent.map(frame => frame.type)).toEqual(["response.created", "response.completed"]);
  expect(ws.data.nativeControl).toBeUndefined();
  expect(ws.data.cancel).toBeUndefined();
  expect(Socket.all).toHaveLength(0);
  send({ type: "response.steer", previous_response_id: sent[0].response.id, input: "not a running turn" });
  expect(sent.at(-1)?.error.code).toBe("steering_not_supported");
  send({ type: "response.create", model: "gpt-5.5", input: "real turn" });
  await waitFor(() => Socket.all.length === 1 && sent.filter(frame => frame.type === "response.created").length === 2);
  expect(ws.data.nativeControl?.attached).toBe(true);
  const socket = Socket.all[0];
  expect(socket.frames[0].input).toBe("real turn");
  complete(socket, socket.root);
  await waitFor(() => !ws.data.nativeControl);
});

test("admission refusal leaves no steering owner and a later admitted turn is independent", async () => {
  const leases: NonNullable<ReturnType<typeof tryAdmitTurn>>[] = [];
  try {
    for (let i = 0; i < MAX_ACTIVE_TURNS; i++) {
      const lease = tryAdmitTurn();
      if (lease) leases.push(lease);
    }
    expect(leases.length).toBeGreaterThan(0);
    const { ws, sent, send } = downstream();
    expect(sent.at(-1)?.error.code).toBe("server_busy");
    expect(ws.data.nativeControl).toBeUndefined();
    expect(ws.data.cancel).toBeUndefined();
    expect(Socket.all).toHaveLength(0);
    for (const lease of leases) lease.release();
    send({ type: "response.create", model: "gpt-5.5", input: "after admission" });
    await waitFor(() => sent.some(frame => frame.type === "response.created"));
    expect(Socket.all).toHaveLength(1);
    const socket = Socket.all[0];
    expect(socket.frames[0].input).toBe("after admission");
    expect(ws.data.nativeControl?.attached).toBe(true);
    complete(socket, socket.root);
    await waitFor(() => !ws.data.nativeControl);
  } finally {
    for (const lease of leases) lease.release();
  }
});

test("superseding an active turn with warmup clears its steering owner immediately", async () => {
  const { ws, socket, send } = await begin();
  expect(ws.data.nativeControl?.attached).toBe(true);
  send({ type: "response.create", model: "gpt-5.5", input: "warmup", generate: false });
  expect(ws.data.nativeControl).toBeUndefined();
  expect(ws.data.cancel).toBeUndefined();
  await waitFor(() => socket.readyState === 3);
});

test.each(["output", "steer", "continuation"] as const)("large %s arrays stay ordered below the replay byte limit", (source) => {
  // 750,000 small, valid messages exceed the runtime argument-count limit while
  // remaining within the unchanged 32 MiB history budget.
  const items = Array.from({ length: 750_000 }, (_, i) => ({
    role: source === "output" ? "assistant" : "user", content: String(i),
  }));
  expect(Buffer.byteLength(JSON.stringify(items))).toBeLessThan(MAX_NATIVE_STEERING_REPLAY_BYTES - 1024);
  let prefix: unknown[] = [];
  const replay = new NativeSteeringReplay("initial", (input, response) => {
    if (response.id === "large-successor") prefix = input.slice();
  });
  try {
    replay.observe({ type: "response.created", response: { id: "large-parent" } });
    replay.submitted({ type: "response.steer", previous_response_id: "large-parent",
      input: source === "steer" ? items : "committed steer" });
    replay.observe({ type: "response.steer.accepted", steer: { id: "large-steer", previous_response_id: "large-parent" } });
    const output = source === "output" ? items : [{ role: "assistant", content: "parent output" }];
    replay.observe({ type: "response.completed", response: { id: "large-parent", output } });
    replay.submitted({ type: "response.create", previous_response_id: "large-parent",
      input: source === "continuation" ? items : "explicit continuation" });
    replay.observe({ type: "response.created", response: { id: "large-successor", previous_response_id: "large-parent" } });
    replay.observe({ type: "response.completed", response: { id: "large-successor", output: [] } });
    expect(prefix).toHaveLength(items.length + 3);
    expect(prefix[0]).toEqual({ type: "message", role: "user", content: [{ type: "input_text", text: "initial" }] });
    const offset = source === "output" ? 1 : source === "steer" ? 2 : 3;
    expect(prefix.slice(offset, offset + items.length)).toEqual(items);
    if (source !== "output") expect(prefix[1]).toEqual(output[0]);
    if (source !== "steer") expect(prefix[source === "output" ? items.length + 1 : 2]).toEqual({
      type: "message", role: "user", content: [{ type: "input_text", text: "committed steer" }],
    });
    if (source !== "continuation") expect(prefix.at(-1)).toEqual({
      type: "message", role: "user", content: [{ type: "input_text", text: "explicit continuation" }],
    });
  } finally { replay.dispose(); }
});
