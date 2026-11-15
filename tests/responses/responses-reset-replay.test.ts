import { afterEach, describe, expect, jest, test } from "bun:test";
import {
  ambiguousResendAllowanceFor,
  createPhysicalReplayGuard,
  selfContainedChatBody,
  selfContainedResponsesBody,
  UnsafePhysicalReplacement,
} from "../../src/server/responses/reset-replay";
import { authorizeResendForRecovery } from "../../src/lib/request-resend-gate";
import type { AdapterRequest } from "../../src/adapters/base";
import { deferProtocolSafeResetRecovery, selectProtocolSafeResetResponse, type ResetSelectionOwner } from "../../src/server/responses/combo-stream-preflight";

const prelude = 'event: response.created\ndata: {"type":"response.created","response":{"id":"first","output":[]}}\n\n';
const completed = 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"second","output":[]}}\n\n';
const responseLog = { model: "test", provider: "test" };

describe("early reset selection", () => {
  const originalHeaders = { "content-type": "text/event-stream", "x-request-id": "id-one", "x-codex-turn-state": "turn-one" };
  const replacementHeaders = { "content-type": "text/event-stream", "x-request-id": "id-two", "x-codex-turn-state": "turn-two" };
  const decoder = new TextDecoder();
  const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  let fakeTimers = false;
  const useFakeTimers = () => { fakeTimers = true; jest.useFakeTimers(); };
  afterEach(() => {
    if (fakeTimers) jest.clearAllTimers();
    fakeTimers = false;
    jest.useRealTimers();
  });

  /** A prelude, then a connection reset once `gate` opens. */
  function gatedOriginal(gate: Promise<void>, state: { waiting?: () => void; cancels: number; hangCancel?: boolean }) {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prelude)); return; }
        state.waiting?.();
        await gate;
        controller.error(Object.assign(new Error("fixture reset"), { code: "ECONNRESET" }));
      },
      cancel() { state.cancels++; return state.hangCancel ? new Promise<void>(() => {}) : undefined; },
    }, { highWaterMark: 0 }), { headers: originalHeaders });
  }
  /** A prelude, then a clean close once `gate` opens: the prelude-only EOF this PR recovers. */
  function cleanEofOriginal(gate: Promise<void>, state: { waiting?: () => void }) {
    let sent = false;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prelude)); return; }
        state.waiting?.();
        await gate;
        controller.close();
      },
    }, { highWaterMark: 0 }), { headers: originalHeaders });
  }
  function trackedReplacement(state: { cancelled: boolean }, headers: Record<string, string> = replacementHeaders, status = 200) {
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode(completed)); controller.close(); },
      cancel() { state.cancelled = true; },
    }, { highWaterMark: 0 }), { status, headers });
  }
  async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ text: string; error?: unknown }> {
    let text = "";
    for (;;) {
      try {
        const next = await reader.read();
        if (next.done) return { text };
        text += decoder.decode(next.value);
      } catch (error) { return { text, error }; }
    }
  }

  test("publishes a replacement selected before the deadline with its own status and headers", async () => {
    const original = { cancels: 0 };
    const replacement = { cancelled: false };
    const commits: [Response, ResetSelectionOwner][] = [];
    let recoveries = 0;
    const published = await selectProtocolSafeResetResponse(gatedOriginal(Promise.resolve(), original), responseLog,
      async (_error, stage, _signal, accepts) => {
        recoveries++;
        expect(stage).toBe("protocol-prelude");
        const candidate = trackedReplacement(replacement, replacementHeaders, 201);
        expect(accepts(candidate)).toBe(true);
        return candidate;
      }, { heartbeatIntervalMs: 60_000, onCommit: (response, owner) => commits.push([response, owner]) });
    expect(recoveries).toBe(1);
    expect(published.status).toBe(201);
    expect([...published.headers]).toEqual([...new Headers(replacementHeaders)]);
    expect(commits).toEqual([[published, "replacement"]]);
    expect(await published.text()).toBe(completed);
    expect(replacement.cancelled).toBe(false);
  });

  test("a deadline commits the original head; a later read-error replacement is still published", async () => {
    useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const original = { cancels: 0, waiting: waiting.resolve };
    const replacement = { cancelled: false };
    const commits: ResetSelectionOwner[] = [];
    let acceptedAfterCommit: boolean | undefined;
    const selected = selectProtocolSafeResetResponse(gatedOriginal(gate.promise, original), responseLog,
      async (_error, _stage, _signal, accepts) => {
        const candidate = trackedReplacement(replacement);
        acceptedAfterCommit = accepts(candidate);
        return candidate;
      }, { heartbeatIntervalMs: 15_000, onCommit: (_response, owner) => commits.push(owner) });
    await waiting.promise;
    await flush();
    expect(commits).toEqual([]);
    jest.advanceTimersByTime(15_000);
    const published = await selected;
    expect(commits).toEqual(["original"]);
    expect([...published.headers]).toEqual([...new Headers(originalHeaders)]);
    const reader = published.body!.getReader();
    // The client already waited one heartbeat interval for this head.
    expect(decoder.decode((await reader.read()).value)).toBe(": keepalive\n\n");
    gate.resolve();
    const rest = await readAll(reader);
    // A read error after the head is committed keeps the reset lane's permissive replacement:
    // the transport died, so the fresh attempt stands in for it whatever its headers say.
    expect(acceptedAfterCommit).toBe(true);
    expect(replacement.cancelled).toBe(false);
    expect(rest.text).toBe(completed);
    expect(rest.error).toBeUndefined();
  });

  test("a matching replacement still continues behind a committed head", async () => {
    useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const replacement = { cancelled: false };
    const selected = selectProtocolSafeResetResponse(gatedOriginal(gate.promise, { cancels: 0, waiting: waiting.resolve }), responseLog,
      async () => trackedReplacement(replacement, originalHeaders), { keepalive: "none" });
    await waiting.promise;
    jest.advanceTimersByTime(15_000);
    const published = await selected;
    const reader = published.body!.getReader();
    const read = readAll(reader);
    gate.resolve();
    // No timer-generated comment for a caller that owns its own keepalive policy.
    expect((await read).text).toBe(completed);
    expect(replacement.cancelled).toBe(false);
  });

  test("the stall budget narrows the pre-head wait", async () => {
    useFakeTimers();
    const waiting = Promise.withResolvers<void>();
    const commits: ResetSelectionOwner[] = [];
    const selected = selectProtocolSafeResetResponse(gatedOriginal(new Promise<void>(() => {}), { cancels: 0, waiting: waiting.resolve }),
      responseLog, async () => null, { maxSelectionMs: 2_000, keepalive: "none", onCommit: (_r, owner) => commits.push(owner) });
    await waiting.promise;
    jest.advanceTimersByTime(1_999);
    await flush();
    expect(commits).toEqual([]);
    jest.advanceTimersByTime(1);
    const published = await selected;
    expect(commits).toEqual(["original"]);
    await published.body?.cancel();
  });

  test("abort ends the pre-head wait at once although upstream cancellation never settles", async () => {
    const waiting = Promise.withResolvers<void>();
    const original = { cancels: 0, waiting: waiting.resolve, hangCancel: true };
    const abort = new AbortController();
    let recoveries = 0;
    const selected = selectProtocolSafeResetResponse(gatedOriginal(new Promise<void>(() => {}), original), responseLog,
      async () => { recoveries++; return null; }, { signal: abort.signal, heartbeatIntervalMs: 60_000 });
    await waiting.promise;
    const reason = new Error("client left");
    abort.abort(reason);
    const published = await selected;
    await expect(published.body!.getReader().read()).rejects.toBe(reason);
    expect(original.cancels).toBe(1);
    expect(recoveries).toBe(0);
  });

  test("abort during an in-flight replacement cancels it when it finally arrives", async () => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const replacement = { cancelled: false };
    const abort = new AbortController();
    let recoverySignal: AbortSignal | undefined;
    const selected = selectProtocolSafeResetResponse(gatedOriginal(Promise.resolve(), { cancels: 0 }), responseLog,
      async (_error, _stage, signal) => { recoverySignal = signal; started.resolve(); return pending.promise; },
      { signal: abort.signal, heartbeatIntervalMs: 60_000 });
    await started.promise;
    abort.abort(new Error("client left"));
    const published = await selected;
    expect(recoverySignal?.aborted).toBe(true);
    await expect(published.body!.getReader().read()).rejects.toThrow("client left");
    pending.resolve(trackedReplacement(replacement));
    await flush();
    expect(replacement.cancelled).toBe(true);
  });

  test("a replacement in flight when the deadline fires is published after the committed head", async () => {
    useFakeTimers();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const replacement = { cancelled: false };
    const commits: ResetSelectionOwner[] = [];
    let accepts!: (candidate: Response) => boolean;
    const selected = selectProtocolSafeResetResponse(gatedOriginal(Promise.resolve(), { cancels: 0 }), responseLog,
      async (_error, _stage, _signal, accept) => { accepts = accept; started.resolve(); return pending.promise; },
      { keepalive: "none", onCommit: (_r, owner) => commits.push(owner) });
    await started.promise;
    const candidate = trackedReplacement(replacement);
    expect(accepts(candidate)).toBe(true);
    jest.advanceTimersByTime(15_000);
    const published = await selected;
    expect(commits).toEqual(["original"]);
    expect(accepts(candidate)).toBe(true);
    const read = readAll(published.body!.getReader());
    pending.resolve(candidate);
    const rest = await read;
    expect(replacement.cancelled).toBe(false);
    expect(rest.text).toBe(completed);
    expect(commits).toEqual(["original"]);
  });

  test("an inspection window commits a quiet original head, then still serves a read-error replacement", async () => {
    useFakeTimers();
    const gate = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const replacement = { cancelled: false };
    const order: string[] = [];
    let acceptedAfterCommit: boolean | undefined;
    const selected = selectProtocolSafeResetResponse(gatedOriginal(gate.promise, { cancels: 0, waiting: waiting.resolve }), responseLog,
      async (_error, _stage, _signal, accepts) => {
        const candidate = trackedReplacement(replacement);
        acceptedAfterCommit = accepts(candidate);
        return candidate;
      }, { heartbeatIntervalMs: 15_000, inspectionWindowMs: 250, onCommit: (_r, owner) => order.push("commit:" + owner) });
    await waiting.promise;
    jest.advanceTimersByTime(249);
    await flush();
    expect(order).toEqual([]);
    jest.advanceTimersByTime(1);
    const published = await selected;
    order.push("returned");
    // The owner is bound before the caller can publish the head.
    expect(order).toEqual(["commit:original", "returned"]);
    expect([...published.headers]).toEqual([...new Headers(originalHeaders)]);
    const reader = published.body!.getReader();
    // An HTTP server may write the head only with body bytes, so the first read is a comment.
    expect(decoder.decode((await reader.read()).value)).toBe(": keepalive\n\n");
    let second: string | undefined;
    const secondRead = reader.read().then(next => { second = decoder.decode(next.value); });
    jest.advanceTimersByTime(14_999);
    await flush();
    expect(second).toBeUndefined();
    jest.advanceTimersByTime(1);
    await secondRead;
    expect(second).toBe(": keepalive\n\n");
    gate.resolve();
    const rest = await readAll(reader);
    expect(acceptedAfterCommit).toBe(true);
    expect(replacement.cancelled).toBe(false);
    expect(rest.text).toBe(completed);
    expect(order).toEqual(["commit:original", "returned"]);
  });

  test("a failure inside the inspection window may publish its replacement after the window", async () => {
    useFakeTimers();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<Response>();
    const replacement = { cancelled: false };
    const commits: ResetSelectionOwner[] = [];
    const selected = selectProtocolSafeResetResponse(gatedOriginal(Promise.resolve(), { cancels: 0 }), responseLog,
      async () => { started.resolve(); return pending.promise; },
      { heartbeatIntervalMs: 15_000, inspectionWindowMs: 250, onCommit: (_r, owner) => commits.push(owner) });
    await started.promise;
    // The original is already dead; only the replacement's own head is outstanding.
    jest.advanceTimersByTime(14_999);
    await flush();
    expect(commits).toEqual([]);
    pending.resolve(trackedReplacement(replacement, replacementHeaders, 201));
    const published = await selected;
    expect(commits).toEqual(["replacement"]);
    expect(published.status).toBe(201);
    expect([...published.headers]).toEqual([...new Headers(replacementHeaders)]);
    expect(await published.text()).toBe(completed);
    jest.advanceTimersByTime(15_000);
    expect(commits).toEqual(["replacement"]);
  });

  test("an original that commits output inside the inspection window is published once", async () => {
    useFakeTimers();
    const output = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n';
    const commits: ResetSelectionOwner[] = [];
    let recoveries = 0;
    const selected = selectProtocolSafeResetResponse(new Response(prelude + output, { headers: originalHeaders }), responseLog,
      async () => { recoveries++; return null; },
      { heartbeatIntervalMs: 15_000, inspectionWindowMs: 250, onCommit: (_r, owner) => commits.push(owner) });
    const published = await selected;
    jest.advanceTimersByTime(15_000);
    expect(commits).toEqual(["original"]);
    expect(recoveries).toBe(0);
    expect(await published.text()).toBe(prelude + output);
  });
});

describe("deferred response metadata", () => {
  // A `Response` built from a string closes cleanly, so every case in this block is the
  // prelude-only EOF path: the strict identity subset applies behind a committed head.
  const baseHeaders = { "content-type": "text/event-stream", "x-request-id": "id-one", "x-codex-turn-state": "turn-one", "x-ratelimit-remaining-requests": "7", "openai-model": "model-one" };
  test.each([
    ["status", { status: 201, headers: baseHeaders }],
    ["status text", { statusText: "Different", headers: baseHeaders }],
    ["content type", { headers: { ...baseHeaders, "content-type": "application/json" } }],
    ["turn state", { headers: { ...baseHeaders, "x-codex-turn-state": "turn-two" } }],
    ["model", { headers: { ...baseHeaders, "openai-model": "model-two" } }],
  ])("refuses a clean-EOF replacement with a different %s and cancels its body", async (_name, replacementInit) => {
    let cancelled = false;
    const original = new Response(prelude, { headers: baseHeaders });
    const replacement = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode(completed)); controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), replacementInit);
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => replacement, { keepalive: "none" });
    expect(await result.text()).toBe(prelude);
    expect(result.status).toBe(200);
    expect([...result.headers]).toEqual([...original.headers]);
    expect(cancelled).toBe(true);
  });

  test.each([
    ["quota", { headers: { ...baseHeaders, "x-ratelimit-remaining-requests": "6" } }],
    ["request id", { headers: { ...baseHeaders, "x-request-id": "id-two" } }],
    ["date", { headers: { ...baseHeaders, "date": "Tue, 10 Nov 2026 00:00:00 GMT" } }],
    ["missing volatile header", { headers: { "content-type": "text/event-stream", "x-codex-turn-state": "turn-one", "openai-model": "model-one" } }],
    ["extra provider header", { headers: { ...baseHeaders, "x-new-provider-field": "value" } }],
    ["set-cookie", { headers: { ...baseHeaders, "set-cookie": "fixture=value" } }],
    ["content-type parameter", { headers: { ...baseHeaders, "content-type": "text/event-stream; charset=utf-8" } }],
  ])("accepts a clean-EOF replacement whose only difference is %s", async (_name, replacementInit) => {
    const original = new Response(prelude, { headers: baseHeaders });
    const result = deferProtocolSafeResetRecovery(original, responseLog,
      async () => new Response(completed, replacementInit), { keepalive: "none" });
    expect(await result.text()).toBe(completed);
    // The head the client already holds never changes, even when the body behind it does.
    expect([...result.headers]).toEqual([...original.headers]);
  });

  test("accepts equal metadata and leaves ordinary calls unchanged", async () => {
    const original = new Response(prelude, { headers: baseHeaders });
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => new Response(completed, { headers: baseHeaders }), { keepalive: "none" });
    expect(await result.text()).toBe(completed);
    expect([...result.headers]).toEqual([...original.headers]);
    let recovered = false;
    const ordinary = new Response(completed, { headers: baseHeaders });
    const unchanged = deferProtocolSafeResetRecovery(ordinary, responseLog, async () => { recovered = true; return null; }, { keepalive: "none" });
    expect(await unchanged.text()).toBe(completed);
    expect([...unchanged.headers]).toEqual([...ordinary.headers]);
    expect(recovered).toBe(false);
  });

  test("accepts a changed repeated header", async () => {
    const first = new Headers(baseHeaders);
    first.append("set-cookie", "a=1");
    first.append("set-cookie", "b=2");
    const second = new Headers(baseHeaders);
    second.append("set-cookie", "a=1");
    second.append("set-cookie", "b=3");
    const result = deferProtocolSafeResetRecovery(new Response(prelude, { headers: first }), responseLog,
      async () => new Response(completed, { headers: second }), { keepalive: "none" });
    expect(await result.text()).toBe(completed);
  });

  test("publishes a read-error replacement whose metadata differs from the committed head", async () => {
    // Dev's reset path: the transport died after the head was committed, so a fresh attempt's
    // body stands in for it whatever its headers say. This is the behaviour the PR must keep.
    const failure = new Error("original reset");
    let sent = false;
    const original = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prelude)); }
      else controller.error(failure);
    } }), { headers: baseHeaders });
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => new Response(completed, {
      headers: { ...baseHeaders, "x-request-id": "id-two", "x-codex-turn-state": "turn-two", "openai-model": "model-two" },
    }), { keepalive: "none" });
    const reader = result.body!.getReader();
    // The replacement body stands in for the original's buffered prelude as well: the client
    // already holds the head, and the replacement stream carries its own complete turn.
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(completed);
    expect((await reader.read()).done).toBe(true);
  });

  test("retains the original read error when no replacement is offered", async () => {
    const failure = new Error("original reset");
    let sent = false;
    const original = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prelude)); }
      else controller.error(failure);
    } }), { headers: baseHeaders });
    const result = deferProtocolSafeResetRecovery(original, responseLog, async () => null, { keepalive: "none" });
    const reader = result.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(prelude);
    await expect(reader.read()).rejects.toBe(failure);
  });

  test("cancels a replacement arriving after the client disconnects", async () => {
    let announce!: () => void;
    let resolveReplacement!: (response: Response) => void;
    let cancelled = false;
    let aborted = false;
    const started = new Promise<void>(resolve => { announce = resolve; });
    const pending = new Promise<Response>(resolve => { resolveReplacement = resolve; });
    const result = deferProtocolSafeResetRecovery(new Response(prelude, { headers: baseHeaders }), responseLog,
      async (_error, _stage, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        announce();
        return pending;
      }, { keepalive: "none" });
    const reader = result.body!.getReader();
    const read = reader.read();
    await started;
    await reader.cancel("client disconnected");
    expect(aborted).toBe(true);
    const cancelledBody = new Promise<void>(resolve => {
      resolveReplacement(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; resolve(); } },
        { highWaterMark: 0 }), { headers: baseHeaders }));
    });
    await cancelledBody;
    expect(cancelled).toBe(true);
    await read;
  });
});

const clientTurn = {
  store: false,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", name: "read", call_id: "c1", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "ok" },
  ],
  tools: [{ type: "function", name: "read" }],
};

describe("createPhysicalReplayGuard", () => {
  const safeBody = JSON.stringify({ store: false, input: "plain prompt" });
  const unsafeBody = JSON.stringify({ store: true, input: "plain prompt" });
  const request = (body: string, hosted = false) =>
    ({ body, ...(hosted ? { hostedToolSubstitutions: [{}] } : {}) }) as unknown as AdapterRequest;

  test("judges the body that physically left, including fresh hosted and provider-executed flags", () => {
    let providerExecuted = false;
    const guard = createPhysicalReplayGuard(() => providerExecuted);
    guard.record(request(safeBody), safeBody);
    expect(guard.isSelfContained(request(safeBody))).toBe(true);
    expect(guard.isSelfContained(request(safeBody, true))).toBe(false);
    providerExecuted = true;
    expect(guard.isSelfContained(request(safeBody))).toBe(false);
  });

  test("an authorized replacement that is not self-contained is refused at physical dispatch", () => {
    const guard = createPhysicalReplayGuard(() => false);
    guard.record(request(safeBody), safeBody);
    guard.authorize();
    expect(() => guard.record(request(unsafeBody), unsafeBody)).toThrow(UnsafePhysicalReplacement);
    // The refusal consumed the authorization; the next ordinary send is not a replacement.
    expect(() => guard.record(request(unsafeBody), unsafeBody)).not.toThrow();
  });

  test("a send that fails before leaving releases the authorization", () => {
    const guard = createPhysicalReplayGuard(() => false);
    guard.authorize();
    expect(() => guard.record(request(safeBody), safeBody, () => { throw new Error("send budget exhausted"); }))
      .toThrow("send budget exhausted");
    expect(() => guard.record(request(unsafeBody), unsafeBody)).not.toThrow();
  });

  test("a send that fails before leaving keeps judging against the body that did leave", () => {
    const guard = createPhysicalReplayGuard(() => false);
    guard.record(request(safeBody), safeBody);
    guard.authorize();
    // `next` throws after the judgment: the replacement never physically left, so the previous
    // physical attempt is still the one a later rebuild has to match.
    expect(() => guard.record(request(safeBody), safeBody, () => { throw new Error("authorize refused"); }))
      .toThrow("authorize refused");
    expect(guard.isSelfContained(request(safeBody))).toBe(true);
    expect(guard.isSelfContained(request(unsafeBody))).toBe(false);
  });

  test("an authorized replacement carrying hosted substitutions is refused", () => {
    const guard = createPhysicalReplayGuard(() => false);
    guard.record(request(safeBody), safeBody);
    guard.authorize();
    expect(() => guard.record(request(safeBody, true), safeBody)).toThrow(UnsafePhysicalReplacement);
    // The refusal spends the authorization: a later ordinary send is not a replacement.
    expect(() => guard.record(request(safeBody, true), safeBody)).not.toThrow();
  });

  test("an authorized replacement whose send executes provider-side calls is refused", () => {
    let providerExecuted = false;
    const guard = createPhysicalReplayGuard(() => providerExecuted);
    guard.record(request(safeBody), safeBody);
    providerExecuted = true;
    guard.authorize();
    expect(() => guard.record(request(safeBody), safeBody)).toThrow(UnsafePhysicalReplacement);
    expect(() => guard.record(request(safeBody), safeBody)).not.toThrow();
  });

  test("a body that is not the string the attempt sent is judged on its own", () => {
    const guard = createPhysicalReplayGuard(() => false);
    guard.record(request(safeBody), safeBody);
    expect(guard.isSelfContained(request(unsafeBody))).toBe(false);
    // A non-string body (a stream, FormData) cannot be inspected, so it is never replaceable.
    expect(guard.isSelfContained({ body: new Blob([safeBody]) } as unknown as AdapterRequest)).toBe(false);
  });
});

describe("selfContainedResponsesBody", () => {
  test("accepts a turn whose second send can only repeat the inference", () => {
    expect(selfContainedResponsesBody(clientTurn)).toBe(true);
    expect(selfContainedResponsesBody({ store: false, input: "plain prompt" })).toBe(true);
    expect(selfContainedResponsesBody({
      store: false,
      input: [{ role: "user", content: "hi" }],
    })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { store: undefined },
      { background: true },
      { previous_response_id: "resp_1" },
      { conversation: "conv_1" },
      { stream_id: undefined },
      { input: undefined },
      { input: { not: "a list" } },
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, ...override })).toBe(false);
    }
    expect(selfContainedResponsesBody(null)).toBe(false);
    expect(selfContainedResponsesBody([clientTurn])).toBe(false);
  });

  test("refuses a catalog carrying anything the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", name: "read" }, { type: "mcp", server_label: "s" }],
      [{ type: "tool_search", execution: "server" }],
      [{ type: "namespace", name: "ns", tools: [{ type: "code_interpreter" }] }],
      [{ type: "namespace" }],
      "not a list",
    ]) {
      expect(selfContainedResponsesBody({ ...clientTurn, tools })).toBe(false);
    }
    expect(selfContainedResponsesBody({
      ...clientTurn,
      tools: [{ type: "namespace", name: "ns", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("a hosted tool cannot ride in through a deferred declaration", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "additional_tools", tools: [{ type: "web_search" }] }],
    })).toBe(false);
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [...clientTurn.input, { type: "tool_search_output", tools: [{ type: "function", name: "read" }] }],
    })).toBe(true);
  });

  test("an input item type this proxy does not recognise is refused", () => {
    expect(selfContainedResponsesBody({
      ...clientTurn,
      input: [{ type: "image_generation_call", id: "ig1" }],
    })).toBe(false);
  });
});

describe("selfContainedChatBody", () => {
  const chatTurn = {
    model: "mock/test-model",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "read" } }],
  };

  test("accepts a Chat turn whose second send can only repeat the inference", () => {
    expect(selfContainedChatBody(chatTurn)).toBe(true);
    expect(selfContainedChatBody({ model: "m", messages: [] })).toBe(true);
  });

  test("refuses anything that leaves state behind or continues someone else's turn", () => {
    for (const override of [
      { store: true },
      { previous_response_id: "resp_1" },
      { messages: undefined },
      { messages: "not a list" },
    ]) {
      expect(selfContainedChatBody({ ...chatTurn, ...override })).toBe(false);
    }
    expect(selfContainedChatBody(null)).toBe(false);
    expect(selfContainedChatBody([chatTurn])).toBe(false);
  });

  test("refuses hosted execution requested outside the tool catalog", () => {
    expect(selfContainedChatBody({ ...chatTurn, web_search_options: {} })).toBe(false);
    expect(selfContainedChatBody({ ...chatTurn, web_search_options: undefined })).toBe(true);
  });

  test("refuses a catalog carrying a tool the origin would execute", () => {
    for (const tools of [
      [{ type: "web_search" }],
      [{ type: "function", function: { name: "read" } }, { type: "code_interpreter" }],
      [{ function: { name: "read" } }],
      "not a list",
    ]) {
      expect(selfContainedChatBody({ ...chatTurn, tools })).toBe(false);
    }
  });
});

describe("ambiguousResendAllowanceFor", () => {
  test("absent or disabled policy grants nothing", () => {
    const claim = () => true;
    expect(ambiguousResendAllowanceFor({}, () => true, claim)).toBeUndefined();
    expect(ambiguousResendAllowanceFor({ retryOnReset: { enabled: false } }, () => true, claim)).toBeUndefined();
  });

  test("a bare opt-in spends one replacement for the whole request", () => {
    const limits: number[] = [];
    let left = 1;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => true, limit => {
      limits.push(limit);
      return left-- > 0;
    })!;
    expect(grant.selfContained).toBe(true);
    expect(grant.claim()).toBe(true);
    expect(grant.claim()).toBe(false);
    // Both questions were asked at the same ceiling, against the one request-wide counter.
    expect(limits).toEqual([1, 1]);
  });

  test("the body judgment is lazy and reaches the gate as a refusal reason", () => {
    let judged = 0;
    const grant = ambiguousResendAllowanceFor({ retryOnReset: {} }, () => { judged += 1; return false; }, () => true)!;
    expect(judged).toBe(0);
    const decision = authorizeResendForRecovery("pre-header", "connection-reset", grant);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.refusal).toBe("ambiguous-request-not-replayable");
    expect(judged).toBe(1);
  });

  test("a provider that opted in still funds only what the operator asked for", () => {
    const seen: number[] = [];
    const grant = ambiguousResendAllowanceFor(
      { retryOnReset: { replacements: 2 } },
      () => true,
      limit => { seen.push(limit); return true; },
    )!;
    expect(grant.claim()).toBe(true);
    expect(seen).toEqual([2]);
  });
});
