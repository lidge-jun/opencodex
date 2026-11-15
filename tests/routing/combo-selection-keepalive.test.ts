import { describe, expect, test } from "bun:test";
import {
  COMBO_SELECTION_KEEPALIVE_INTERVAL_MS,
  COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS,
  comboSelectionKeepaliveApplies,
  comboSelectionKeepaliveLadderOptions,
  selectComboWithKeepalive,
  type ComboSelectionKeepaliveClock,
  type ComboSelectionKeepaliveHooks,
} from "../../src/server/responses/combo-selection-keepalive";
import { comboUnavailableResponse } from "../../src/server/responses/core-errors";
import type { RequestLogContext } from "../../src/server/request-log";

/** Manual clock: nothing fires until the test advances it, so no case depends on wall time. */
function manualClock(): ComboSelectionKeepaliveClock & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    setTimeout(callback, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(handle) { timers.delete(handle as number); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function sse(...frames: string[]): Response {
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

const completed = "event: response.completed\ndata: " + JSON.stringify({
  type: "response.completed",
  response: { id: "resp_ok", status: "completed", output: [] },
}) + "\n\n";

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return text;
    text += decoder.decode(next.value, { stream: true });
  }
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const next = await reader.read();
  return next.done ? "<done>" : new TextDecoder().decode(next.value);
}

function start(clock: ReturnType<typeof manualClock>, logCtx: RequestLogContext = { model: "", provider: "" }) {
  const selection = deferred<Response>();
  let hooks: ComboSelectionKeepaliveHooks | undefined;
  const response = selectComboWithKeepalive(value => { hooks = value; return selection.promise; }, {
    model: "combo/free",
    logCtx,
    clock,
  });
  return { selection, response, hooks: () => hooks!, logCtx };
}

describe("combo selection keepalive", () => {
  test("a selection under the threshold returns the selected response itself", async () => {
    const clock = manualClock();
    const run = start(clock);
    const failure = comboUnavailableResponse("No combo target is available");
    run.selection.resolve(failure);
    expect(await run.response).toBe(failure);
    expect(failure.status).toBe(503);
    expect(clock.pending()).toBe(0);
    expect(run.hooks().headCommitted()).toBe(false);
  });

  test("a rejected selection under the threshold rejects unchanged", async () => {
    const clock = manualClock();
    const run = start(clock);
    const error = new Error("child dispatch failed");
    run.selection.reject(error);
    expect(run.response).rejects.toBe(error);
    await flush();
    expect(clock.pending()).toBe(0);
  });

  test("a slow selection commits a 200 SSE head with keepalives, then streams the selected child", async () => {
    const clock = manualClock();
    const run = start(clock);
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS - 1);
    await flush();
    expect(run.hooks().headCommitted()).toBe(false);
    clock.advance(1);
    const response = await run.response;
    expect(run.hooks().headCommitted()).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    const second = readChunk(reader);
    await flush();
    clock.advance(COMBO_SELECTION_KEEPALIVE_INTERVAL_MS);
    expect(await second).toBe(": keepalive\n\n");
    run.selection.resolve(sse(completed));
    expect(await readAll(reader)).toBe(completed);
    expect(clock.pending()).toBe(0);
  });

  test("an all-targets failure after the head carries the same error code in response.failed", async () => {
    const clock = manualClock();
    const run = start(clock);
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS);
    const response = await run.response;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    run.selection.resolve(comboUnavailableResponse("No combo target is available"));
    const rest = await readAll(reader);
    expect(rest.startsWith("event: response.failed\ndata: ")).toBe(true);
    const payload = JSON.parse(rest.slice("event: response.failed\ndata: ".length).trim()) as {
      type: string;
      response: { status: string; model: string; output: unknown[]; error: Record<string, unknown> };
    };
    expect(payload.type).toBe("response.failed");
    expect(payload.response).toMatchObject({ status: "failed", model: "combo/free", output: [] });
    expect(payload.response.error).toMatchObject({ code: "combo_unavailable", type: "server_error" });
    expect(String(payload.response.error.message)).toContain("No combo target is available");
    expect(run.logCtx.terminalHttpStatus).toBe(503);
    expect(clock.pending()).toBe(0);
  });

  test("a selection that throws after the head ends the stream with a server_error failure", async () => {
    const clock = manualClock();
    const run = start(clock);
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS);
    const reader = (await run.response).body!.getReader();
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    run.selection.reject(new Error("child dispatch failed"));
    const rest = await readAll(reader);
    expect(rest).toContain("event: response.failed");
    expect(rest).toContain('"code":"server_error"');
    expect(rest).not.toContain("child dispatch failed");
    expect(run.logCtx.terminalHttpStatus).toBe(502);
  });

  test("cancelling the committed stream aborts selection and releases a late child body", async () => {
    const clock = manualClock();
    const run = start(clock);
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS);
    const reader = (await run.response).body!.getReader();
    expect(await readChunk(reader)).toBe(": keepalive\n\n");
    await reader.cancel("client left");
    expect(run.hooks().signal.aborted).toBe(true);
    expect(clock.pending()).toBe(0);
    let cancelled = false;
    run.selection.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { "content-type": "text/event-stream" },
    }));
    await flush();
    await flush();
    expect(cancelled).toBe(true);
  });

  test("an already aborted request never commits a keepalive head", async () => {
    const clock = manualClock();
    const abort = new AbortController();
    abort.abort("gone");
    const selection = deferred<Response>();
    const pending = selectComboWithKeepalive(() => selection.promise, {
      model: "combo/free", logCtx: { model: "", provider: "" }, clock, signal: abort.signal,
    });
    clock.advance(COMBO_SELECTION_KEEPALIVE_THRESHOLD_MS * 3);
    const cancelled = new Response(null, { status: 499 });
    selection.resolve(cancelled);
    expect(await pending).toBe(cancelled);
  });

  test("only top-level HTTP Responses streaming turns opt in", () => {
    const on = { comboSelectionKeepalive: {} };
    expect(comboSelectionKeepaliveApplies({ stream: true }, on)).toBe(true);
    expect(comboSelectionKeepaliveApplies({ stream: false }, on)).toBe(false);
    expect(comboSelectionKeepaliveApplies({ stream: true }, {})).toBe(false);
    expect(comboSelectionKeepaliveApplies({ stream: true }, { ...on, inboundTransport: "websocket" })).toBe(false);
    expect(comboSelectionKeepaliveApplies({ stream: true }, { ...on, inboundWire: "chat" })).toBe(false);
    expect(comboSelectionKeepaliveApplies({ stream: true }, { ...on, internalDecisionCall: true })).toBe(false);
  });

  test("ladder options drop the ingress native log callbacks once the head is committed", () => {
    const seen: string[] = [];
    let committed = false;
    const signal = new AbortController().signal;
    const options = comboSelectionKeepaliveLadderOptions({
      comboSelectionKeepalive: {},
      onNativePassthroughTerminal: status => seen.push(status),
      onNativePassthroughCancel: () => seen.push("cancel"),
    }, { signal, headCommitted: () => committed });
    expect(options.comboSelectionKeepalive).toBeUndefined();
    expect(options.abortSignal).toBe(signal);
    options.onNativePassthroughTerminal!("completed");
    committed = true;
    options.onNativePassthroughTerminal!("failed");
    options.onNativePassthroughCancel!();
    expect(seen).toEqual(["completed"]);
  });
});
