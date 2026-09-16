import { describe, expect, test } from "bun:test";
import { teeWithBoundedInspection } from "../../src/server/inspection-tee";
import { createBoundedResponseLogBody } from "../../src/server/response-log-body";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  createSseInspector,
  relaySseWithFailedTail,
  type InspectionConsumerOptions,
} from "../../src/server/relay";
import type { RequestLogContext } from "../../src/server/request-log";

const encoder = new TextEncoder();
const frame = (payload: unknown) => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const terminal = (id = "fixture-response") => ({
  type: "response.completed",
  response: {
    id, status: "completed", output: [],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("inspection did not settle")), 2_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function controlledSource() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelReasons: unknown[] = [];
  return {
    body: new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel(reason) { cancelReasons.push(reason); },
    }, { highWaterMark: 0 }),
    push(bytes: Uint8Array) { controller.enqueue(bytes); },
    close() { controller.close(); },
    error(reason: unknown) { controller.error(reason); },
    cancelReasons,
  };
}

function observe(body: ReadableStream<Uint8Array>, extra: Partial<InspectionConsumerOptions> = {}) {
  const clientGone = new AbortController();
  const hardAbort = new AbortController();
  const upstream = new AbortController();
  const [client, inspection] = teeWithBoundedInspection(body, {
    clientGoneSignal: clientGone.signal,
    maxReadAheadBytes: 64,
  });
  const logCtx: RequestLogContext = { model: "fixture-model", provider: "fixture-provider" };
  const outcomes: Array<{ status: string; httpStatus?: number }> = [];
  const completed: Array<{ id?: unknown; output?: unknown; status?: unknown }> = [];
  let cancels = 0;
  let dones = 0;
  let firstOutputs = 0;
  let feedResolve!: () => void;
  const fed = new Promise<void>(resolve => { feedResolve = resolve; });
  const done = new Promise<void>(resolve => {
    consumeForInspection(
      inspection,
      (status, httpStatus) => outcomes.push({ status, httpStatus }),
      hardAbort.signal,
      () => { dones += 1; resolve(); },
      logCtx,
      () => { cancels += 1; },
      response => completed.push(response),
      () => { firstOutputs += 1; },
      {
        clientGoneSignal: clientGone.signal,
        drainBounds: { ms: 1_000, bytes: 4_096 },
        upstream,
        inspectorFactory: handlers => {
          const inspector = createSseInspector(handlers);
          return {
            ...inspector,
            feed(chunk) { inspector.feed(chunk); feedResolve(); },
          };
        },
        ...extra,
      },
    );
  });
  return {
    client: relaySseWithFailedTail(client, upstream, reason => clientGone.abort(reason)),
    hardAbort, upstream, fed, done, logCtx, outcomes, completed,
    counts: () => ({ cancels, dones, firstOutputs }),
  };
}

describe("bounded inspection tee with real Responses consumers", () => {
  test("a turn larger than 32 MiB retains its late terminal, usage and reconstructed output", async () => {
    const delta = frame({ type: "response.output_text.delta", delta: "x".repeat(8_192) });
    const item = { type: "message", id: "fixture-message", role: "assistant", content: [] };
    let chunks = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const index = chunks++;
        if (index < 4_100) controller.enqueue(delta);
        else if (index === 4_100) {
          controller.enqueue(frame({ type: "response.output_item.done", output_index: 0, item }));
        } else if (index === 4_101) {
          controller.enqueue(frame(terminal()));
        }
        // Deliberately keep the connection open; the protocol terminal owns cleanup.
      },
    }, { highWaterMark: 0 });
    const state = observe(source);
    const reader = state.client.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
      }
      await bounded(state.done);
      expect(bytes).toBeGreaterThan(32 * 1024 * 1024);
      expect(state.outcomes).toEqual([{ status: "completed", httpStatus: undefined }]);
      expect(state.completed).toHaveLength(1);
      expect(state.completed[0]?.output).toEqual([item]);
      expect(state.logCtx.usage?.inputTokens).toBe(3);
      expect(state.logCtx.usage?.outputTokens).toBe(2);
      expect(state.counts()).toEqual({ cancels: 0, dones: 1, firstOutputs: 1 });
    } finally {
      await reader.cancel();
      state.hardAbort.abort();
    }
  }, 15_000);

  test("disconnect releases pacing and a late terminal wins inside the bounded drain", async () => {
    const source = controlledSource();
    const state = observe(source.body);
    source.push(frame({ type: "response.output_text.delta", delta: "x".repeat(128) }));
    await bounded(state.fed);
    await bounded(state.client.cancel("fixture client gone"));
    source.push(frame(terminal("late")));
    await bounded(state.done);
    expect(state.outcomes.map(value => value.status)).toEqual(["completed"]);
    expect(state.completed[0]?.id).toBe("late");
    expect(state.counts().cancels).toBe(0);
    expect(state.counts().dones).toBe(1);
    expect(state.upstream.signal.aborted).toBe(true);
  });

  test("a silent post-disconnect source still stops at the inspection time bound", async () => {
    const source = controlledSource();
    const state = observe(source.body, { drainBounds: { ms: 10, bytes: 4_096 } });
    await state.client.cancel("fixture disconnect");
    await bounded(state.done);
    expect(state.outcomes).toEqual([]);
    expect(state.counts()).toEqual({ cancels: 1, dones: 1, firstOutputs: 0 });
    expect(state.upstream.signal.aborted).toBe(true);
    expect(source.cancelReasons).toHaveLength(1);
  });

  test("the post-disconnect byte bound cannot parse a terminal beyond its prefix", async () => {
    const source = controlledSource();
    const state = observe(source.body, { drainBounds: { ms: 1_000, bytes: 8 } });
    await state.client.cancel("fixture disconnect");
    source.push(frame(terminal("beyond-bound")));
    await bounded(state.done);
    expect(state.outcomes).toEqual([]);
    expect(state.completed).toEqual([]);
    expect(state.counts().cancels).toBe(1);
    expect(state.counts().dones).toBe(1);
  });

  test("hard abort must not flush an unterminated completed candidate as success", async () => {
    const source = controlledSource();
    const state = observe(source.body);
    source.push(encoder.encode(`data: ${JSON.stringify(terminal("aborted"))}`));
    await bounded(state.fed);
    state.hardAbort.abort("fixture shutdown");
    await bounded(state.done);
    expect(state.outcomes).toEqual([]);
    expect(state.completed).toEqual([]);
    expect(state.counts().cancels).toBe(1);
    expect(state.counts().dones).toBe(1);
    await state.client.cancel("cleanup");
  });

  test("source error wakes a credit-blocked inspector and preserves synthetic 502 provenance", async () => {
    const source = controlledSource();
    const state = observe(source.body);
    source.push(frame({ type: "response.output_text.delta", delta: "x".repeat(128) }));
    await bounded(state.fed);
    source.error(new Error("fixture source reset"));
    await bounded(state.done);
    expect(state.outcomes).toEqual([{ status: "failed", httpStatus: 502 }]);
    expect(state.logCtx.transportPhase).toBe("mid_stream");
    expect(state.logCtx.terminalSource).toBe("synthetic");
    expect(state.counts().dones).toBe(1);
    await state.client.cancel("cleanup").catch(() => undefined);
  });

  test("an actual read error still flushes a real terminal lacking a final delimiter", async () => {
    const source = controlledSource();
    const state = observe(source.body);
    source.push(encoder.encode(`data: ${JSON.stringify(terminal("tail"))}`));
    await bounded(state.fed);
    source.error(new Error("fixture reset after terminal"));
    await bounded(state.done);
    expect(state.outcomes.map(value => value.status)).toEqual(["completed"]);
    expect(state.completed[0]?.id).toBe("tail");
    expect(state.counts().cancels).toBe(0);
    await state.client.cancel("cleanup").catch(() => undefined);
  });

  test("the metadata-only consumer also retains late usage and releases exactly once", async () => {
    const clientGone = new AbortController();
    const upstream = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame({ type: "response.output_text.delta", delta: "x".repeat(128) }));
        controller.enqueue(frame(terminal("metadata")));
      },
    });
    const [client, inspection] = teeWithBoundedInspection(source, {
      maxReadAheadBytes: 16, clientGoneSignal: clientGone.signal,
    });
    const logCtx: RequestLogContext = { model: "fixture-model", provider: "fixture-provider" };
    const completed: unknown[] = [];
    let dones = 0;
    const done = new Promise<void>(resolve => {
      consumeForResponseLogMetadata(inspection, logCtx, undefined,
        () => { dones += 1; resolve(); }, response => completed.push(response), undefined,
        { clientGoneSignal: clientGone.signal, upstream, drainBounds: { ms: 1_000, bytes: 4_096 } });
    });
    const delivery = relaySseWithFailedTail(client, upstream, reason => clientGone.abort(reason));
    expect(await new Response(delivery).text()).toContain("response.completed");
    await bounded(done);
    expect(logCtx.usage?.inputTokens).toBe(3);
    expect(logCtx.usage?.outputTokens).toBe(2);
    expect(completed).toHaveLength(1);
    expect(dones).toBe(1);
  });
});

describe("inspection pacing boundary", () => {
  test("invalid allowances are rejected before locking the source", () => {
    for (const limit of [0, -1, NaN, Infinity, 1.5]) {
      const source = controlledSource();
      expect(() => teeWithBoundedInspection(source.body, { maxReadAheadBytes: limit })).toThrow(RangeError);
      expect(source.body.locked).toBe(false);
    }
  });

  test("a slow client bounds inspection progress until raw client bytes are consumed", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("12345678"));
        controller.enqueue(encoder.encode("abcdefgh"));
        controller.close();
      },
    });
    const [client, inspection] = teeWithBoundedInspection(source, { maxReadAheadBytes: 8 });
    const reader = inspection.getReader();
    expect((await reader.read()).value).toEqual(encoder.encode("12345678"));
    let settled = false;
    const next = reader.read().then(result => { settled = true; return result; });
    await Bun.sleep(5);
    expect(settled).toBe(false);
    const clientReader = client.getReader();
    await clientReader.read();
    expect((await bounded(next)).value).toEqual(encoder.encode("abcdefgh"));
    await reader.cancel("inspection done");
    await clientReader.cancel("client done");
  });

  test("cancelling only inspection settles promptly and leaves all client bytes intact", async () => {
    const payload = encoder.encode("unmodified client response");
    const source = new Response(payload).body!;
    const [client, inspection] = teeWithBoundedInspection(source, { maxReadAheadBytes: 8 });
    await bounded(inspection.cancel("inspection detached"));
    expect(new Uint8Array(await new Response(client).arrayBuffer())).toEqual(payload);
  });

  test("already-aborted client signal releases pacing for the bounded drain owner", async () => {
    const signal = AbortSignal.abort("already gone");
    const source = new Response("abcdefghijklmnop").body!;
    const [client, inspection] = teeWithBoundedInspection(source, { maxReadAheadBytes: 1, clientGoneSignal: signal });
    expect(await bounded(new Response(inspection).text())).toBe("abcdefghijklmnop");
    await client.cancel();
  });
});

describe("non-stream inspection boundary", () => {
  test.each(["eof", "read_error", "cancel", "cancel_rejected"] as const)("releases its source reader after %s", async outcome => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const source = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { if (outcome === "cancel_rejected") return Promise.reject(new Error("fixture cancel rejection")); },
    }, { highWaterMark: 0 });
    const ended: string[] = [];
    const reader = createBoundedResponseLogBody(source, {
      json: false, inspect() {}, finalize: reason => ended.push(reason),
    }).getReader();
    const pending = reader.read();
    if (outcome === "eof") { controller.close(); await bounded(pending); }
    else if (outcome === "read_error") {
      const failure = new Error("fixture reader failure");
      controller.error(failure);
      await expect(pending).rejects.toBe(failure);
    } else { await bounded(reader.cancel("fixture cancellation")); await bounded(pending); }
    expect(source.locked).toBe(false);
    expect(ended).toEqual([outcome === "cancel_rejected" ? "cancel" : outcome]);
  });

  test("a bounded body can cancel one native tee branch without waiting for or truncating its sibling", async () => {
    const source = controlledSource();
    const [left, right] = source.body.tee();
    const ended: string[] = [];
    const reader = createBoundedResponseLogBody(left, {
      json: false, inspect() {}, finalize: reason => ended.push(reason),
    }).getReader();
    const sibling = right.getReader();
    const first = reader.read(), siblingFirst = sibling.read();
    source.push(encoder.encode("first"));
    await bounded(Promise.all([first, siblingFirst]));
    await bounded(reader.cancel("inspection finished"));
    expect(left.locked).toBe(false);
    expect(ended).toEqual(["cancel"]);
    expect(source.cancelReasons).toEqual([]);
    const next = sibling.read();
    source.push(encoder.encode("second"));
    expect((await bounded(next)).value).toEqual(encoder.encode("second"));
    source.close();
    expect((await bounded(sibling.read())).done).toBe(true);
    sibling.releaseLock();
  });

  test("diagnostic bytes do not alias mutable chunks delivered to the client", async () => {
    const source = controlledSource();
    const inspected: string[] = [];
    const reader = createBoundedResponseLogBody(source.body, {
      json: false, inspect: text => inspected.push(text), finalize() {},
    }).getReader();
    const original = encoder.encode("original");
    const pending = reader.read();
    source.push(original);
    await bounded(pending);
    original.fill(120);
    source.close();
    await bounded(reader.read());
    expect(inspected).toEqual(["original"]);
  });

  test("multibyte error inspection ends at the byte prefix while delivery remains whole", async () => {
    const payload = "한".repeat(10_000);
    const inspected: string[] = [];
    const body = createBoundedResponseLogBody(new Response(payload).body!, {
      json: false, inspect: text => inspected.push(text), finalize() {},
    });
    expect(await new Response(body).text()).toBe(payload);
    expect(inspected).toEqual([new TextDecoder().decode(encoder.encode(payload).subarray(0, 8_192))]);
  });

  test("cancel wins a racing source error without finalizing twice", async () => {
    const source = controlledSource();
    const ended: string[] = [];
    const reader = createBoundedResponseLogBody(source.body, {
      json: true, inspect() { throw new Error("partial JSON must not be inspected"); }, finalize: reason => ended.push(reason),
    }).getReader();
    const pending = reader.read();
    await Promise.resolve();
    source.error(new Error("fixture source failure"));
    await bounded(reader.cancel("fixture cancellation"));
    await bounded(pending);
    expect(ended).toEqual(["cancel"]);
    expect(source.body.locked).toBe(false);
  });

  test("JSON over its inspection allowance is delivered intact but never inspected", async () => {
    const inspected: string[] = [];
    const ended: string[] = [];
    const payload = '{"value":"too large"}';
    const body = createBoundedResponseLogBody(new Response(payload).body!, {
      json: true, maxInspectionBytes: 8,
      inspect: text => inspected.push(text), finalize: reason => ended.push(reason),
    });
    expect(await new Response(body).text()).toBe(payload);
    expect(inspected).toEqual([]);
    expect(ended).toEqual(["eof"]);
  });

  test("JSON exactly at its byte allowance is inspected once", async () => {
    const payload = '{"x":1}';
    const inspected: string[] = [];
    const body = createBoundedResponseLogBody(new Response(payload).body!, {
      json: true, maxInspectionBytes: encoder.encode(payload).byteLength,
      inspect: text => inspected.push(text), finalize() { return; },
    });
    expect(await new Response(body).text()).toBe(payload);
    expect(inspected).toEqual([payload]);
  });

  test("non-JSON retains an exact byte prefix across one-byte source chunks", async () => {
    let sent = 0;
    const inspected: string[] = [];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 10_000) controller.enqueue(new Uint8Array([120]));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const body = createBoundedResponseLogBody(source, {
      json: false, inspect: text => inspected.push(text), finalize() { return; },
    });
    expect((await new Response(body).text()).length).toBe(10_000);
    expect(inspected).toEqual(["x".repeat(8_192)]);
  });

  test("no downstream pull means no logging-driven upstream read", async () => {
    let reads = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; controller.enqueue(new Uint8Array([120])); },
    }, { highWaterMark: 0 });
    const body = createBoundedResponseLogBody(source, {
      json: false, inspect() { return; }, finalize() { return; },
    });
    await Bun.sleep(5);
    expect(reads).toBe(0);
    await body.cancel();
  });

  test("diagnostic callback exceptions cannot corrupt transport or duplicate finalization", async () => {
    let finals = 0;
    const payload = new Uint8Array([255, 0, 128]);
    const body = createBoundedResponseLogBody(new Response(payload).body!, {
      json: false,
      inspect() { throw new Error("fixture diagnostic exception"); },
      finalize() { finals += 1; throw new Error("fixture finalizer exception"); },
    });
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(payload);
    expect(finals).toBe(1);
  });

  test("cancellation wins a pending read and never inspects a valid-looking JSON prefix", async () => {
    const source = controlledSource();
    const inspected: string[] = [];
    const ended: string[] = [];
    const body = createBoundedResponseLogBody(source.body, {
      json: true, inspect: text => inspected.push(text), finalize: reason => ended.push(reason),
    });
    const reader = body.getReader();
    const first = reader.read();
    source.push(encoder.encode('{"model":"not-complete"}'));
    await first;
    const pending = reader.read();
    await bounded(reader.cancel("fixture cancel"));
    await bounded(pending);
    expect(inspected).toEqual([]);
    expect(ended).toEqual(["cancel"]);
    expect(source.cancelReasons).toEqual(["fixture cancel"]);
  });
});
