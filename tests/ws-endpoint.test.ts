import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  buildWarmupCompletionFrames,
  pumpResponsesSseToWebSocket,
  safeResponseHeaders,
  selectForwardHeaders,
  readBoundedPrefix,
  sendResponsesJsonAsEvents,
  sendResponseToWebSocket,
  type WsData,
} from "../src/ws-bridge";
import type { ServerWebSocket } from "bun";

function mockWs(sendResult = 1): { ws: ServerWebSocket<WsData>; sent: string[] } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    data: {} as WsData,
    send: (m: string) => { sent.push(m); return sendResult; },
  } as unknown as ServerWebSocket<WsData>;
  return { ws, sent };
}

function sseStream(frames: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe("WS endpoint re-framer (120/132)", () => {
  test("server config declares explicit websocket idle timeout policy", () => {
    const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(source).toContain("const WEBSOCKET_IDLE_TIMEOUT_SECONDS = 0;");
    expect(source).toContain("websocket: {");
    expect(source).toContain("idleTimeout: WEBSOCKET_IDLE_TIMEOUT_SECONDS,");
  });

  test("generate=false warmup completes locally without upstream and forces full next request", () => {
    const frames = buildWarmupCompletionFrames({ model: "gpt-5.5", generate: false }).map(f => JSON.parse(f));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      type: "response.created",
      sequence_number: 0,
      response: { object: "response", status: "in_progress", model: "gpt-5.5" },
    });
    expect(frames[1]).toMatchObject({
      type: "response.completed",
      sequence_number: 1,
      response: { object: "response", status: "completed", model: "gpt-5.5" },
    });
    expect(frames[1].response.id).toBe(frames[0].response.id);
    expect(frames[1].response.id).toBe("");
  });

  test("re-frames SSE data payloads as WS Text and stops at the first terminal", async () => {
    let cancelled = false;
    const { ws, sent } = mockWs();
    await pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\ndata: {"type":"response.created","sequence_number":0}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"stale"}\n\n',
    ], () => { cancelled = true; }));
    expect(sent.map(f => JSON.parse(f).type)).toEqual([
      "response.created",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(cancelled).toBe(true);
  });

  test("reports failed terminal status exactly once while pumping SSE to WebSocket", async () => {
    const { ws } = mockWs();
    const terminals: string[] = [];
    await pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    ]), { onTerminal: status => terminals.push(status) });
    expect(terminals).toEqual(["failed"]);
  });

  test("reports incomplete when SSE ends before a terminal event", async () => {
    const { ws } = mockWs();
    const terminals: string[] = [];
    await pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    ]), { onTerminal: status => terminals.push(status) });
    expect(terminals).toEqual(["incomplete"]);
  });

  test("does not report terminal status when WebSocket pump is cancelled", async () => {
    const { ws } = mockWs();
    const terminals: string[] = [];
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() { /* stays open until cancelled */ },
      cancel() { cancelled = true; },
    });
    const pump = pumpResponsesSseToWebSocket(ws, stream, { onTerminal: status => terminals.push(status) });
    ws.data.cancel!();
    await pump;
    expect(cancelled).toBe(true);
    expect(terminals).toEqual([]);
  });

  test("supports CRLF, multiline data, split chunks, and unterminated final events", async () => {
    const { ws, sent } = mockWs();
    await pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\r\ndata: {"type":"response.created",\r\ndata: "sequence_number":0}\r\n\r\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}',
    ]));
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]).type).toBe("response.created");
    expect(JSON.parse(sent[1]).type).toBe("response.completed");
  });

  test("emits standalone transport error when EOF arrives before a terminal event", async () => {
    const { ws, sent } = mockWs();
    await pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    ]));
    expect(JSON.parse(sent.at(-1)!).type).toBe("error");
    expect(JSON.parse(sent.at(-1)!).status).toBe(502);
  });

  test("dropped websocket sends fail instead of silently passing", async () => {
    const { ws } = mockWs(0);
    await expect(pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
    ]))).rejects.toThrow("websocket send dropped");
  });

  test("backpressured websocket sends are accepted", async () => {
    const { ws, sent } = mockWs(-1);
    await pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
    ]));
    expect(JSON.parse(sent[0]).type).toBe("response.completed");
  });

  test("wires a cancel hook that aborts the stream on client disconnect", async () => {
    const { ws } = mockWs();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() { /* never enqueues or closes until cancelled */ },
      cancel() { cancelled = true; },
    });
    const pump = pumpResponsesSseToWebSocket(ws, stream);
    expect(typeof ws.data.cancel).toBe("function");
    ws.data.cancel!();
    await pump;
    expect(cancelled).toBe(true);
  });

  test("does not emit stale frames after a replacement turn invalidates the pump", async () => {
    const { ws, sent } = mockWs();
    let current = true;
    const terminals: string[] = [];
    const pump = pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    ]), { isCurrent: () => current, onTerminal: status => terminals.push(status) });
    current = false;
    ws.data.cancel?.();
    await pump;
    expect(sent).toEqual([]);
    expect(terminals).toEqual([]);
  });

  test("stale pump cleanup does not erase the replacement turn cancel hook", async () => {
    const { ws } = mockWs();
    let current = false;
    const stalePump = pumpResponsesSseToWebSocket(ws, sseStream([
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    ]), { isCurrent: () => current });
    const replacementCancel = () => {};
    ws.data.cancel = replacementCancel;
    await stalePump;
    expect(ws.data.cancel).toBe(replacementCancel);
  });

  test("invalid upstream SSE JSON emits one standalone protocol error and cancels", async () => {
    const { ws, sent } = mockWs();
    let cancelled = false;
    await pumpResponsesSseToWebSocket(ws, sseStream([
      "event: response.created\ndata: {not-json}\n\n",
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    ], () => { cancelled = true; }));
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toMatchObject({
      type: "error",
      status: 502,
      error: { code: "websocket_protocol_error" },
    });
    expect(cancelled).toBe(true);
  });

  test("converts successful Responses JSON into output_item.done plus response.completed frames", () => {
    const { ws, sent } = mockWs();
    sendResponsesJsonAsEvents(ws, {
      id: "resp_json",
      object: "response",
      status: "completed",
      output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] }],
    });
    expect(sent.map(f => JSON.parse(f).type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(JSON.parse(sent[2]).response.id).toBe("resp_json");
  });

  test("JSON response with status 'incomplete' emits response.incomplete event type", () => {
    const { ws, sent } = mockWs();
    sendResponsesJsonAsEvents(ws, {
      id: "resp_inc",
      object: "response",
      status: "incomplete",
      output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] }],
      incomplete_details: { reason: "upstream_stall_timeout" },
    });
    const types = sent.map(f => JSON.parse(f).type);
    expect(types).toContain("response.incomplete");
    expect(types).not.toContain("response.completed");
    expect(JSON.parse(sent[sent.length - 1]).response.status).toBe("incomplete");
  });

  test("JSON response with status 'failed' emits response.failed event type", () => {
    const { ws, sent } = mockWs();
    const terminals: string[] = [];
    sendResponsesJsonAsEvents(ws, {
      id: "resp_fail",
      object: "response",
      status: "failed",
      output: [],
      error: { code: "server_error", message: "upstream died" },
    }, status => terminals.push(status));
    const types = sent.map(f => JSON.parse(f).type);
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");
    expect(types).not.toContain("response.incomplete");
    expect(terminals).toEqual(["failed"]);
  });

  test("stores only allowlisted inbound headers and emits only safe response headers", () => {
    const inbound = new Headers({
      authorization: "Bearer secret",
      cookie: "session=secret",
      "openai-beta": "responses=experimental",
      "x-codex-turn-state": "turn",
    });
    const selected = selectForwardHeaders(inbound);
    expect(selected.get("authorization")).toBe("Bearer secret");
    expect(selected.get("openai-beta")).toBe("responses=experimental");
    expect(selected.get("x-codex-turn-state")).toBe("turn");
    expect(selected.get("cookie")).toBeNull();

    const outbound = safeResponseHeaders(new Headers({
      "retry-after": "2",
      "set-cookie": "secret=1",
      "x-ratelimit-remaining": "4",
      "x-codex-turn-state": "state",
      "x-codex-primary-used-percent": "100.0",
      "x-codex-primary-window-minutes": "15",
      "x-codex-secondary-primary-reset-at": "1781928000",
      "x-codex-secondary-limit-name": "Secondary",
    }));
    expect(outbound).toEqual({
      "retry-after": "2",
      "x-codex-turn-state": "state",
      "x-codex-primary-used-percent": "100.0",
      "x-codex-primary-window-minutes": "15",
      "x-codex-secondary-primary-reset-at": "1781928000",
      "x-codex-secondary-limit-name": "Secondary",
      "x-ratelimit-remaining": "4",
    });
  });

  test("bounded sniffing replays the full body without dropping bytes", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("abcdef"));
        controller.close();
      },
    });
    const { prefix, stream } = await readBoundedPrefix(body, 3);
    expect(new TextDecoder().decode(prefix)).toBe("abc");
    expect(await new Response(stream).text()).toBe("abcdef");
  });

  test("classifies labelled SSE responses", async () => {
    const { ws, sent } = mockWs();
    await sendResponseToWebSocket(ws, new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"sse"}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ), () => true);
    expect(JSON.parse(sent[0]).type).toBe("response.completed");
  });

  test("cancels a stale successful response body before pumping", async () => {
    const { ws, sent } = mockWs();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.completed","response":{"id":"stale"}}\n\n',
        ));
      },
      cancel() { cancelled = true; },
    });
    await sendResponseToWebSocket(ws, new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }), () => false);
    expect(sent).toEqual([]);
    expect(cancelled).toBe(true);
  });

  test("sniffs mislabelled SSE responses", async () => {
    const { ws, sent } = mockWs();
    await sendResponseToWebSocket(ws, new Response(
      'data: {"type":"response.completed","response":{"id":"mislabelled"}}\n\n',
      { headers: { "content-type": "text/plain" } },
    ), () => true);
    expect(JSON.parse(sent[0]).response.id).toBe("mislabelled");
  });

  test("converts application/json 200 responses into event sequence", async () => {
    const { ws, sent } = mockWs();
    const terminals: string[] = [];
    await sendResponseToWebSocket(ws, Response.json({
      id: "json",
      object: "response",
      status: "completed",
      output: [{ type: "message", id: "msg", role: "assistant", status: "completed", content: [] }],
    }), () => true, { onTerminal: status => terminals.push(status) });
    expect(sent.map(f => JSON.parse(f).type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(terminals).toEqual(["completed"]);
  });

  test("unexpected successful HTML and empty 204 become standalone protocol errors", async () => {
    const html = mockWs();
    await sendResponseToWebSocket(html.ws, new Response("<html></html>", {
      headers: { "content-type": "text/html" },
    }), () => true);
    expect(JSON.parse(html.sent.at(-1)!).type).toBe("error");

    const empty = mockWs();
    await sendResponseToWebSocket(empty.ws, new Response(null, { status: 204 }), () => true);
    expect(JSON.parse(empty.sent.at(-1)!).type).toBe("error");
  });

  test("non-2xx responses use standalone error envelope with status and safe headers", async () => {
    const { ws, sent } = mockWs();
    await sendResponseToWebSocket(ws, Response.json({
      error: { type: "rate_limit_exceeded", message: "retry later" },
    }, {
      status: 429,
      headers: { "retry-after": "3", "set-cookie": "secret=1" },
    }), () => true);
    const error = JSON.parse(sent[0]);
    expect(error).toMatchObject({
      type: "error",
      status: 429,
      error: { type: "rate_limit_exceeded", message: "retry later" },
      headers: { "retry-after": "3" },
    });
    expect(error.headers["set-cookie"]).toBeUndefined();
  });
});
