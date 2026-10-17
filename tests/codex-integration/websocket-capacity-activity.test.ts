import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { CodexWebSocketActivity } from "../../src/codex/websocket-activity";
import {
  MAX_TRACKED_CODEX_WEBSOCKETS, codexWebSocketAdmissionMetrics,
  registerCodexWebSocket, tryReserveCodexWebSocket, unregisterCodexWebSocket,
} from "../../src/codex/websocket-registry";
import type { AdmissionReservation } from "../../src/lib/admission";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { MAX_ACTIVE_TURNS, tryAdmitTurn } from "../../src/server/lifecycle";
import type { NativeResponseControl } from "../../src/server/responses/native-response-control";
import { sendResponseToWebSocket, type WsData } from "../../src/server/ws-bridge";

type Frame = Record<string, unknown>;
const leases: AdmissionReservation<ServerWebSocket<WsData>>[] = [];
const sockets: ServerWebSocket<WsData>[] = [];
const handler = createWebsocketHandler({ config: {}, deps: {} } as ServeOptionsContext);

afterEach(() => {
  for (const ws of sockets.splice(0)) unregisterCodexWebSocket(ws);
  for (const lease of leases.splice(0)) lease.release();
});

function reserve() {
  const lease = tryReserveCodexWebSocket();
  if (lease) leases.push(lease);
  return lease;
}

function admittedSocket(mode: "normal" | "delayed" | "throw" = "normal") {
  const lease = reserve();
  expect(lease).not.toBeNull();
  const sent: Frame[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  let state = 1;
  let buffered = 0;
  const ws = {
    data: { admissionLease: lease! } as WsData,
    get readyState() { return state; },
    getBufferedAmount: () => buffered,
    send(text: string) { sent.push(JSON.parse(text)); return 1; },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      if (mode === "throw") throw new Error("fixture close failure");
      if (mode === "normal") finishClose();
    },
  } as unknown as ServerWebSocket<WsData>;
  function finishClose() {
    state = 3;
    handler.close(ws, 1000, "fixture close");
  }
  lease!.bind(ws);
  registerCodexWebSocket(ws);
  sockets.push(ws);
  return { ws, sent, closed, finishClose, activity: ws.data.responsesActivity!,
    setBuffered(bytes: number) { buffered = bytes; } };
}

function output(activity: CodexWebSocketActivity, item: Frame) {
  activity.observePayload(JSON.stringify({ type: "response.output_item.done", item }));
}

const argumentCompletions = [
  ["function_call", "response.function_call_arguments.done", "function_call_output"],
  ["custom_tool_call", "response.custom_tool_call_input.done", "custom_tool_call_output"],
] as const;

describe("Responses final tool arguments", () => {
  test.each(argumentCompletions)("%s stays protected after EOF until the real handler accepts its result", async (type, done, result) => {
    const client = admittedSocket();
    const finish = client.activity.beginTurn([]);
    const argumentField = type === "function_call" ? "arguments" : "input";
    const frames = [
      { type: "response.output_item.added", item: { type, id: "item", call_id: "call", name: "fixture_tool", [argumentField]: "" } },
      { type: done, item_id: "item", [argumentField]: "{}" },
    ];
    await sendResponseToWebSocket(client.ws, new Response(
      frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ), () => true, { onSsePayload: payload => client.activity.observePayload(payload) });
    finish();
    expect(client.sent.map(frame => frame.type)).toEqual(["response.output_item.added", done, "error"]);
    expect(client.sent.at(-1)).toMatchObject({ error: { message: "Upstream stream ended before response terminal event" } });
    expect(client.ws.data.cancel).toBeUndefined();
    const others = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS - 1 }, () => admittedSocket());
    const finishOthers = others.map(other => other.activity.beginTurn([]));
    try {
      expect(reserve()).toBeNull();
      expect(client.closed).toEqual([]);
      let accepted = false;
      client.ws.data.nativeControl = { inject: () => { accepted = true; } } as unknown as NativeResponseControl;
      handler.message(client.ws, JSON.stringify({ type: "response.inject", input: [{ type: result, call_id: "call", output: "done" }] }));
      expect(accepted).toBe(true);
      client.ws.data.nativeControl = undefined;
      expect(reserve()).not.toBeNull();
      expect(client.closed).toEqual([{ code: 1001, reason: "Idle Responses connection reclaimed" }]);
    } finally {
      client.ws.data.nativeControl = undefined;
      for (const end of finishOthers) end();
    }
  });

  test.each(argumentCompletions)("unfinished %s arguments do not invent pending client work", (type) => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn([]);
    activity.observePayload(JSON.stringify({ type: "response.output_item.added", item: { type, id: "item", call_id: "call" } }));
    finish();
    expect(activity.idle).toBe(true);
  });

  test.each(argumentCompletions)("%s completion echoes stay settled and reused identities belong to the next turn", (type, done, resultType) => {
    const activity = new CodexWebSocketActivity();
    const call = { type, id: "reused-item", call_id: "reused-call" };
    const result = { type: resultType, call_id: call.call_id, output: "done" };
    const added = JSON.stringify({ type: "response.output_item.added", item: call });
    const completed = JSON.stringify({ type: done, item_id: call.id });
    for (const created of [true, false]) {
      const finish = activity.beginTurn([result]);
      if (created) activity.observePayload(JSON.stringify({ type: "response.created", response: { id: "response" } }));
      activity.observePayload(added);
      activity.observePayload(added); // A repeated identity is not a new call.
      activity.observePayload(completed);
      finish();
      expect(activity.idle).toBe(false);
      activity.acceptResults([result]);
      activity.observePayload(completed);
      output(activity, call);
      activity.observePayload(JSON.stringify({ type: "response.completed", response: { output: [call] } }));
      expect(activity.idle).toBe(true);
    }
  });

  test("native response.created resets argument identities without suppressing a reused call", () => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn([]);
    for (const id of ["first", "second"]) {
      activity.observePayload(JSON.stringify({ type: "response.created", response: { id } }));
      activity.observePayload(JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "item", call_id: id } }));
      activity.observePayload(JSON.stringify({ type: "response.function_call_arguments.done", item_id: "item" }));
      if (id === "first") activity.acceptResults([{ type: "function_call_output", call_id: id }]);
    }
    finish();
    expect(activity.idle).toBe(false);
    activity.acceptResults([{ type: "function_call_output", call_id: "second" }]);
    expect(activity.idle).toBe(true);
  });

  test("hosted custom input completion stays idle only with this response's provider authorization", () => {
    const activity = new CodexWebSocketActivity();
    const hosted = new Set([{ itemType: "custom_tool_call", callIdPrefix: "xs_call-" }]);
    const added = JSON.stringify({ type: "response.output_item.added", item: { type: "custom_tool_call", id: "item", call_id: "xs_call-1" } });
    const done = JSON.stringify({ type: "response.custom_tool_call_input.done", item_id: "item" });
    const first = activity.beginTurn([]);
    activity.observePayload(added, hosted);
    activity.observePayload(done, hosted);
    first();
    expect(activity.idle).toBe(true);
    const second = activity.beginTurn([]);
    activity.observePayload(added);
    activity.observePayload(done);
    second();
    expect(activity.idle).toBe(false);
    activity.acceptResults([{ type: "custom_tool_call_output", call_id: "xs_call-1" }]);
    expect(activity.idle).toBe(true);
  });

  test("unknown, oversized and mismatched final argument identities remain protected", () => {
    for (const item of [
      undefined,
      { type: "function_call", id: "", call_id: "call" },
      { type: "function_call", id: "item", call_id: "" },
      { type: "function_call", id: "item", call_id: "x".repeat(1025) },
      { type: "function_call", id: "x".repeat(1025), call_id: "call" },
      { type: "custom_tool_call", id: "item", call_id: "call" },
    ]) {
      const activity = new CodexWebSocketActivity();
      const finish = activity.beginTurn([]);
      activity.observePayload(JSON.stringify({ type: "response.output_item.added", item }));
      activity.observePayload(JSON.stringify({ type: "response.function_call_arguments.done", item_id: item?.id ?? "unknown" }));
      finish();
      activity.acceptResults([{ type: "function_call_output", call_id: "call" }]);
      expect(activity.idle).toBe(false);
    }
  });

  test("conflicting or over-budget argument identities conservatively protect the socket", () => {
    for (const conflict of [true, false]) {
      const activity = new CodexWebSocketActivity();
      const finish = activity.beginTurn([]);
      for (let index = 0; index < (conflict ? 2 : 1025); index += 1) {
        activity.observePayload(JSON.stringify({ type: "response.output_item.added", item: {
          type: "function_call", id: conflict ? "conflict" : `item-${index}`, call_id: `call-${index}`,
        } }));
      }
      finish();
      expect(activity.idle).toBe(false);
    }
  });

  test.each(argumentCompletions)("invalid %s redefinitions cannot reuse a prior result identity", (type, done, resultType) => {
    for (const returnedFirst of [false, true]) {
      for (const call_id of [undefined, "", "x".repeat(1025)]) {
        const activity = new CodexWebSocketActivity();
        const finish = activity.beginTurn([]);
        const emit = (frame: Frame) => activity.observePayload(JSON.stringify(frame));
        const result = { type: resultType, call_id: "prior", output: "done" };
        emit({ type: "response.output_item.added", item: { type, id: "item", call_id: "prior" } });
        emit({ type: done, item_id: "item" });
        if (returnedFirst) activity.acceptResults([result]);
        emit({ type: "response.output_item.added", item: { type, id: "item", call_id } });
        emit({ type: done, item_id: "item" });
        finish();
        expect(activity.idle).toBe(false);
        if (!returnedFirst) activity.acceptResults([result]);
        expect(activity.idle).toBe(false);
      }
    }
  });
});

describe("Responses socket activity", () => {
  test("overlapping superseded turns each keep their own idempotent busy reference", () => {
    const activity = new CodexWebSocketActivity();
    const first = activity.beginTurn([]);
    const second = activity.beginTurn([]);
    second();
    second();
    expect(activity.idle).toBe(false);
    first();
    expect(activity.idle).toBe(true);
    const third = activity.beginTurn([]);
    first();
    expect(activity.idle).toBe(false);
    third();
    expect(activity.idle).toBe(true);
  });

  test.each([
    ["function_call", "function_call_output"],
    ["custom_tool_call", "custom_tool_call_output"],
    ["local_shell_call", "function_call_output"],
    ["shell_call", "shell_call_output"],
    ["computer_call", "computer_call_output"],
    ["apply_patch_call", "apply_patch_call_output"],
    ["tool_search_call", "tool_search_output"],
  ])("protects client %s work until its %s arrives", (callType, resultType) => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn([]);
    output(activity, { type: callType, call_id: "client-call", execution: "client" });
    activity.observePayload(JSON.stringify({ type: "response.completed", response: { output: [] } }));
    finish();
    expect(activity.idle).toBe(false);
    const continueTurn = activity.beginTurn([{ type: resultType, call_id: "client-call", output: "done" }]);
    expect(activity.idle).toBe(false);
    continueTurn();
    expect(activity.idle).toBe(true);
  });

  test("terminal-only tool calls and partial result batches retain all outstanding work", () => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn([]);
    output(activity, { type: "function_call", call_id: "first" });
    activity.observePayload(JSON.stringify({ type: "response.completed", response: { output: [
      { type: "function_call", call_id: "first" },
      { type: "custom_tool_call", call_id: "second" },
      { type: "mcp_approval_request", id: "approval" },
    ] } }));
    finish();
    activity.beginTurn([{ type: "function_call_output", call_id: "first", output: "done" }])();
    expect(activity.idle).toBe(false);
    activity.beginTurn([{ type: "function_call_output", call_id: "second", output: "wrong type" },
      { type: "mcp_approval_response", approval_request_id: "unrelated", approve: true }])();
    expect(activity.idle).toBe(false);
    activity.beginTurn([{ type: "custom_tool_call_output", call_id: "second", output: "done" }])();
    expect(activity.idle).toBe(false);
    activity.beginTurn([{ type: "mcp_approval_response", approval_request_id: "approval", approve: false }])();
    expect(activity.idle).toBe(true);
  });

  test("hosted tools and malformed observations do not invent client work", () => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn([]);
    for (const type of ["web_search_call", "file_search_call", "code_interpreter_call", "mcp_call", "tool_search_call", "message"]) {
      output(activity, { type, id: "hosted-item" });
    }
    output(activity, { type: "tool_search_call", execution: "server", call_id: "hosted-search" });
    for (const payload of ["bad JSON", "null", "[]", JSON.stringify({ type: "response.completed", response: null })]) {
      activity.observePayload(payload);
    }
    finish();
    expect(activity.idle).toBe(true);
  });

  test("returned native results ignore terminal echoes but cannot mask a later call reusing its ID", () => {
    const activity = new CodexWebSocketActivity();
    const call = { type: "function_call", call_id: "reused" };
    const result = { type: "function_call_output", call_id: "reused", output: "done" };
    const finish = activity.beginTurn([]);
    activity.observePayload(JSON.stringify({ type: "response.created", response: { id: "first" } }));
    output(activity, call);
    activity.acceptResults([result]);
    activity.observePayload(JSON.stringify({ type: "response.completed", response: { output: [call] } }));
    finish();
    expect(activity.idle).toBe(true);
    const finishNext = activity.beginTurn([result]); // Full replay repeats a historical result.
    activity.observePayload(JSON.stringify({ type: "response.created", response: { id: "second" } }));
    output(activity, call);
    finishNext();
    expect(activity.idle).toBe(false);
    activity.acceptResults([result]);
    expect(activity.idle).toBe(true);
  });

  test("hosted shell output clears its call without waiting for a client result", () => {
    const activity = new CodexWebSocketActivity();
    const finish = activity.beginTurn([]);
    const call = { type: "shell_call", call_id: "hosted-shell", action: { commands: ["pwd"] } };
    const result = { type: "shell_call_output", call_id: "hosted-shell", output: [] };
    output(activity, call);
    output(activity, result);
    activity.observePayload(JSON.stringify({ type: "response.completed", response: { output: [call, result] } }));
    finish();
    expect(activity.idle).toBe(true);
  });

  test.each(["response.inject", "response.create"])("real handler accounts for accepted native results on %s", type => {
    const client = admittedSocket();
    const finish = client.activity.beginTurn([]);
    const call = { type: "function_call", call_id: "native-call" };
    output(client.activity, call);
    let accepted = 0;
    const accept = () => { accepted += 1; return true; };
    client.ws.data.nativeControl = { relayActive: true, inject: accept, continue: accept } as unknown as NativeResponseControl;
    handler.message(client.ws, JSON.stringify({ type, input: [
      { type: "function_call_output", call_id: "native-call", output: "done" },
    ] }));
    expect(accepted).toBe(1);
    expect(client.activity.idle).toBe(false);
    client.activity.observePayload(JSON.stringify({ type: "response.completed", response: { output: [call] } }));
    finish();
    expect(client.activity.idle).toBe(true);
    expect(client.sent).toHaveLength(0);
  });

  test.each(["response.inject", "response.create"])("rejected native results on %s cannot release a client tool wait", type => {
    const client = admittedSocket();
    output(client.activity, { type: "function_call", call_id: "native-call" });
    const reject = () => { throw new Error("fixture rejected result"); };
    client.ws.data.nativeControl = { relayActive: true, inject: reject, continue: reject } as unknown as NativeResponseControl;
    handler.message(client.ws, JSON.stringify({ type, input: [
      { type: "function_call_output", call_id: "native-call", output: "done" },
    ] }));
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({ type: "error", status: 400 });
    expect(client.activity.idle).toBe(false);
  });

  test("unknown and oversized client result identities remain conservatively protected", () => {
    for (const callId of [undefined, "", "x".repeat(1025)]) {
      const activity = new CodexWebSocketActivity();
      output(activity, { type: "function_call", call_id: callId });
      activity.beginTurn([{ type: "function_call_output", call_id: callId, output: "done" }])();
      expect(activity.idle).toBe(false);
    }
    const activity = new CodexWebSocketActivity();
    const results = Array.from({ length: 1025 }, (_, index) => {
      const call_id = `bounded-${index}`;
      output(activity, { type: "function_call", call_id });
      return { type: "function_call_output", call_id, output: "done" };
    });
    activity.beginTurn(results)();
    expect(activity.idle).toBe(false);
  });

  test("real handler warmup and turn-capacity refusal do not consume pending client results", () => {
    const client = admittedSocket();
    output(client.activity, { type: "function_call", call_id: "pending" });
    const input = [{ type: "function_call_output", call_id: "pending", output: "done" }];
    handler.message(client.ws, JSON.stringify({ type: "response.create", generate: false, input }));
    expect(client.sent.map(frame => frame.type)).toEqual(["response.created", "response.completed"]);
    expect(client.activity.idle).toBe(false);
    const turns = Array.from({ length: MAX_ACTIVE_TURNS }, () => tryAdmitTurn());
    try {
      expect(turns.every(Boolean)).toBe(true);
      handler.message(client.ws, JSON.stringify({ type: "response.create", model: "fixture", input }));
      expect(client.sent.at(-1)).toMatchObject({ type: "error", status: 503 });
      expect(client.activity.idle).toBe(false);
    } finally {
      for (const turn of turns) turn?.release();
    }
  });
});

describe("Responses WebSocket capacity reclamation", () => {
  test("below capacity leaves idle connections open; at capacity reclaims least recently used", () => {
    const clients = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS }, () => admittedSocket());
    expect(clients.every(client => client.closed.length === 0)).toBe(true);
    clients[0].activity.beginTurn([])();
    const before = codexWebSocketAdmissionMetrics();
    expect(reserve()).not.toBeNull();
    expect(clients[0].closed).toHaveLength(0);
    expect(clients[1].closed).toEqual([{ code: 1001, reason: "Idle Responses connection reclaimed" }]);
    expect(clients.slice(2).every(client => client.closed.length === 0)).toBe(true);
    expect(codexWebSocketAdmissionMetrics()).toMatchObject({ active: MAX_TRACKED_CODEX_WEBSOCKETS, peak: MAX_TRACKED_CODEX_WEBSOCKETS,
      admitted: before.admitted + 1, rejected: before.rejected });
  });

  test("skips active turns, client tools, buffered output and native control owners", () => {
    const clients = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS }, () => admittedSocket());
    const finish = clients[0].activity.beginTurn([]);
    output(clients[1].activity, { type: "function_call", call_id: "pending" });
    clients[2].setBuffered(1);
    clients[3].ws.data.nativeControl = { relayActive: true } as NativeResponseControl;
    expect(reserve()).not.toBeNull();
    expect(clients.slice(0, 4).every(client => client.closed.length === 0)).toBe(true);
    expect(clients[4].closed).toHaveLength(1);
    finish();
  });

  test("all busy or unbound reservations leave the cap intact and reject new admission", () => {
    const clients = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS - 1 }, () => admittedSocket());
    const finish = clients.map(client => client.activity.beginTurn([]));
    expect(reserve()).not.toBeNull(); // An upgrade reserved before its open callback.
    const before = codexWebSocketAdmissionMetrics();
    expect(reserve()).toBeNull();
    expect(clients.every(client => client.closed.length === 0)).toBe(true);
    expect(codexWebSocketAdmissionMetrics()).toMatchObject({ active: MAX_TRACKED_CODEX_WEBSOCKETS, rejected: before.rejected + 1 });
    for (const end of finish) end();
  });

  test.each(["delayed", "throw"] as const)("%s close cannot free admission before the close callback", mode => {
    const victim = admittedSocket(mode);
    const others = Array.from({ length: MAX_TRACKED_CODEX_WEBSOCKETS - 1 }, () => admittedSocket());
    const finish = others.map(client => client.activity.beginTurn([]));
    expect(reserve()).toBeNull();
    expect(victim.closed).toHaveLength(1);
    expect(victim.activity.closing).toBe(mode === "delayed");
    expect(codexWebSocketAdmissionMetrics().active).toBe(MAX_TRACKED_CODEX_WEBSOCKETS);
    handler.message(victim.ws, JSON.stringify({ type: "response.create", generate: false }));
    // A closer that throws while still OPEN must not silently disable the old client.
    expect(victim.sent).toHaveLength(mode === "delayed" ? 0 : 2);
    expect(victim.ws.data.turnId).toBe(mode === "delayed" ? undefined : 1);
    expect(reserve()).toBeNull();
    expect(victim.closed).toHaveLength(mode === "delayed" ? 1 : 2);
    expect(others.every(client => client.closed.length === 0)).toBe(true);
    victim.finishClose();
    victim.finishClose();
    expect(codexWebSocketAdmissionMetrics().active).toBe(MAX_TRACKED_CODEX_WEBSOCKETS - 1);
    expect(reserve()).not.toBeNull();
    expect(codexWebSocketAdmissionMetrics().active).toBe(MAX_TRACKED_CODEX_WEBSOCKETS);
    for (const end of finish) end();
  });
});
