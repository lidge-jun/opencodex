import { afterEach, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { startServer } from "../../src/server";
import {
  MAX_DECOMPRESSED_BODY_BYTES,
  MAX_CONFIGURABLE_INBOUND_BODY_BYTES,
  readJsonRequestBody,
  DecompressedBodyTooLargeError,
  UnsupportedContentEncodingError,
} from "../../src/server/request-decompress";
import {
  withRaisedInboundBodyAdmission,
  InboundBodyCapacityError,
  CONFIGURABLE_JSON_BODY_ROUTES,
  UNGATED_LOOPBACK_ROUTES,
} from "../../src/server/inbound-body-admission";
import { configureInboundBodyBudget, createInboundBodyBudget, inboundBodyBudget } from "../../src/server/inbound-body-budget";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { saturateInboundBodyBudget } from "../helpers/inbound-body-budget";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { repoPath } from "../helpers/repo-root";

let testBudget: ReturnType<typeof createInboundBodyBudget>;
/** Use the per-test budget with immediate refusal instead of the shared FIFO queue. */
function fixtureAdmission(...args: Parameters<typeof withRaisedInboundBodyAdmission>) {
  return withRaisedInboundBodyAdmission(args[0], args[1], args[2], args[3], args[4], {
    budget: testBudget, maxWaitMs: 0,
  });
}

// BEGIN raised-body admission regressions: these cases use Web streams and tiny payloads.
const RAISED_BODY_LIMIT = MAX_CONFIGURABLE_INBOUND_BODY_BYTES;
// Read the gate's own set rather than a second copy: a route added to admission
// without protocol coverage, or covered here but never admitted, must not pass.
const raisedBodyPaths = [...CONFIGURABLE_JSON_BODY_ROUTES];
/** Synchronize upload and producer milestones without timer-based ordering. */
function bodyDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
/** Build a POST fixture that supports streaming uploads and caller overrides. */
function admissionRequest(path = "/v1/responses", body: BodyInit = "{}", init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST", body, ...init, duplex: "half",
  } as RequestInit);
}
/** Admit a fixture handler using the request's own pathname and supplied limit. */
function admittedBodyWork(work: () => Promise<Response>, req = admissionRequest(), limit = RAISED_BODY_LIMIT) {
  return fixtureAdmission(req, new URL(req.url).pathname, limit, work);
}
/** Probe admission and consume the response so the probe cannot retain a lease. */
async function assertBodyCapacity(status: number) {
  const response = await admittedBodyWork(async () => new Response(null, { status: 204 }));
  assert.equal(response.status, status);
  await response.text();
}

describe("raised inbound body admission lifetime", () => {
  beforeEach(() => { testBudget = createInboundBodyBudget(RAISED_BODY_LIMIT); });
  afterEach(() => assert.deepEqual(testBudget.snapshot(), {
    reservedBytes: 0, activeLeases: 0, queuedRequests: 0,
  }));
  test("keeps the parsed graph admitted while downstream work is pending", async () => {
    const parsed = bodyDeferred();
    const complete = bodyDeferred();
    const req = admissionRequest("/v1/responses", '{"input":"retained fixture"}');
    const first = admittedBodyWork(async () => {
      const raw = await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT) as { input: string };
      parsed.resolve();
      await complete.promise;
      return Response.json({ input: raw.input });
    }, req);
    try {
      await parsed.promise;
      assert.deepEqual(testBudget.snapshot(), {
        reservedBytes: Buffer.byteLength('{"input":"retained fixture"}'), activeLeases: 1, queuedRequests: 0,
      });
      await assertBodyCapacity(503);
      complete.resolve();
      const response = await first;
      await assertBodyCapacity(503); // Returning headers is not the end of the body lifetime.
      assert.deepEqual(await response.json(), { input: "retained fixture" });
      await assertBodyCapacity(204);
    } finally {
      complete.resolve();
      await (await first).body?.cancel().catch(() => undefined);
    }
  });

  test("reserves before the first upload finishes", async () => {
    const started = bodyDeferred();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const req = admissionRequest("/v1/responses", new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { started.resolve(); },
    }, { highWaterMark: 0 }));
    const first = admittedBodyWork(async () => {
      await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT);
      return new Response(null, { status: 204 });
    }, req);
    try {
      await started.promise;
      await assertBodyCapacity(503);
    } finally {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
      await first;
    }
    await assertBodyCapacity(204);
  });

  for (const path of raisedBodyPaths) {
    test(`returns retryable overload before the ${path} handler can wrap it`, async () => {
      const holder = await admittedBodyWork(async () => new Response("held"));
      let dispatched = false;
      try {
        const req = admissionRequest(path, "private-fixture-body");
        const response = await admittedBodyWork(async () => {
          dispatched = true;
          return Response.json({ error: "would wrap parser failures as 400" }, { status: 400 });
        }, req);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("retry-after"), "1");
        const payload = await response.json() as { type?: string; error: { type: string; code: string } };
        assert.equal(payload.error.code, "server_busy");
        const anthropic = path.startsWith("/v1/messages");
        assert.equal(payload.error.type, anthropic ? "overloaded_error" : "server_error");
        assert.equal(payload.type, anthropic ? "error" : undefined);
        assert.equal(JSON.stringify(payload).includes("private-fixture-body"), false);
        assert.equal(dispatched, false);
      } finally { await holder.text(); }
      await assertBodyCapacity(204);
    });
  }

  for (const limit of [undefined, 0, MAX_DECOMPRESSED_BODY_BYTES, 1024 * 1024, NaN, Infinity]) {
    test(`preserves ordinary concurrency for limit ${String(limit)}`, async () => {
      const holder = await admittedBodyWork(async () => new Response("held"));
      const original = new Response("unchanged");
      try {
        const response = await fixtureAdmission(admissionRequest(), "/v1/responses", limit, async () => original);
        assert.equal(response, original);
        await response.text();
      } finally { await holder.text(); }
    });
  }

  test("does not charge management, audio, context, or GET routes", async () => {
    const holder = await admittedBodyWork(async () => new Response("held"));
    try {
      for (const path of ["/api/config", "/v1/audio/transcriptions", "/v1/live", "/v1/context/history", "/v1/unknown"]) {
        const original = new Response(null, { status: 204 });
        assert.equal(await admittedBodyWork(async () => original, admissionRequest(path)), original);
      }
      const get = new Request("http://localhost/v1/responses");
      assert.equal((await admittedBodyWork(async () => new Response(null, { status: 204 }), get)).status, 204);
    } finally { await holder.text(); }
  });

  // The dispatcher is the source of truth for what the loopback listener accepts.
  // A new `/v1` route must be admitted or explicitly exempted; leaving it out of
  // both sets is how a raised `maxInboundBodyBytes` route would skip the
  // process-wide reservation while every admission test still passed.
  test("every loopback /v1 route is classified for inbound body admission", async () => {
    const source = await Bun.file(repoPath("src", "server", "index.ts")).text();
    const start = source.indexOf("function loopbackRouteAllowed");
    assert.notEqual(start, -1);
    const end = source.indexOf("\n  }", start);
    assert.notEqual(end, -1);
    const routes = [...source.slice(start, end).matchAll(/path === "(\/v1\/[^"]+)"/g)].map(match => match[1]);
    assert.ok(routes.length >= 8, `expected the dispatcher to list /v1 routes, saw ${routes.length}`);
    for (const route of routes) {
      assert.ok(
        CONFIGURABLE_JSON_BODY_ROUTES.has(route) || UNGATED_LOOPBACK_ROUTES.has(route),
        `${route} is neither admitted nor explicitly exempt in inbound-body-admission.ts`,
      );
    }
    for (const route of CONFIGURABLE_JSON_BODY_ROUTES) {
      assert.ok(routes.includes(route), `${route} is admitted but the dispatcher no longer serves it`);
    }
  });

  test("keeps an aborted request charged until its pending work actually returns", async () => {
    const abort = new AbortController();
    const started = bodyDeferred();
    const complete = bodyDeferred();
    const req = admissionRequest("/v1/responses", "{}", { signal: abort.signal });
    const first = admittedBodyWork(async () => {
      await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT);
      started.resolve();
      await complete.promise;
      return new Response(null, { status: 499 });
    }, req);
    try {
      await started.promise;
      abort.abort(new Error("fixture cancellation"));
      await assertBodyCapacity(503);
    } finally { complete.resolve(); await first; }
    await assertBodyCapacity(204);
  });

  for (const rejects of [false, true]) {
    test(`request abort cancels an unconsumed response and waits for settlement (rejects=${rejects})`, async () => {
      const abort = new AbortController();
      const finishCancel = bodyDeferred();
      const reason = new Error("fixture request abort");
      let cancelledWith: unknown;
      let cancellations = 0;
      let pulls = 0;
      const response = await admittedBodyWork(async () => new Response(new ReadableStream<Uint8Array>({
        pull() { pulls++; },
        async cancel(value) {
          cancellations++;
          cancelledWith = value;
          await finishCancel.promise;
          if (rejects) throw new Error("fixture producer cancellation failure");
        },
      }, { highWaterMark: 0 })), admissionRequest("/v1/responses", "{}", { signal: abort.signal }));
      try {
        await assertBodyCapacity(503);
        abort.abort(reason);
        await assertBodyCapacity(503);
        assert.equal(cancellations, 1);
        assert.equal(cancelledWith, reason);
        assert.equal(pulls, 0);
        assert.equal(response.bodyUsed, false);
        finishCancel.resolve();
        await Bun.sleep(0); // Let cancellation and the admission finalizer settle.
        await assertBodyCapacity(204);
      } finally {
        finishCancel.resolve();
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }

  test("request abort during work cancels its eventual body before releasing capacity", async () => {
    const abort = new AbortController();
    const started = bodyDeferred();
    const complete = bodyDeferred();
    const finishCancel = bodyDeferred();
    let cancellations = 0;
    const first = admittedBodyWork(async () => {
      started.resolve();
      await complete.promise;
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancellations++; return finishCancel.promise; },
      }, { highWaterMark: 0 }));
    }, admissionRequest("/v1/responses", "{}", { signal: abort.signal }));
    try {
      await started.promise;
      abort.abort();
      await assertBodyCapacity(503);
      assert.equal(cancellations, 0);
      complete.resolve();
      await first;
      await assertBodyCapacity(503);
      assert.equal(cancellations, 1);
      finishCancel.resolve();
      await Bun.sleep(0);
      await assertBodyCapacity(204);
    } finally {
      complete.resolve();
      finishCancel.resolve();
      await (await first).body?.cancel().catch(() => undefined);
    }
  });

  for (const abortFirst of [false, true]) {
    test(`request abort and explicit cancel release exactly once (abortFirst=${abortFirst})`, async () => {
      const abort = new AbortController();
      const finishCancel = bodyDeferred();
      const reason = new Error("fixture request abort race");
      let cancellations = 0;
      let cancelledWith: unknown;
      const response = await admittedBodyWork(async () => new Response(new ReadableStream<Uint8Array>({
        cancel(value) {
          cancellations++;
          cancelledWith = value;
          return finishCancel.promise;
        },
      }, { highWaterMark: 0 })), admissionRequest("/v1/responses", "{}", { signal: abort.signal }));
      let next: Response | undefined;
      try {
        if (abortFirst) abort.abort(reason);
        const cancelled = response.body!.cancel("fixture explicit cancel").catch(error => error);
        if (!abortFirst) abort.abort(reason);
        await assertBodyCapacity(503);
        assert.equal(cancellations, 1);
        assert.equal(cancelledWith, abortFirst ? reason : "fixture explicit cancel");
        finishCancel.resolve();
        await cancelled;
        await Bun.sleep(0);
        await assertBodyCapacity(204);
        next = await admittedBodyWork(async () => new Response("next reservation"));
        assert.equal(next.status, 200);
        await assertBodyCapacity(503); // A double release would admit this peer.
        assert.equal(cancellations, 1);
      } finally {
        finishCancel.resolve();
        await response.body?.cancel().catch(() => undefined);
        await next?.body?.cancel();
      }
      await assertBodyCapacity(204);
    });
  }

  test("preserves pre-aborted requests' existing error path", async () => {
    const holder = await admittedBodyWork(async () => new Response("held"));
    const abort = new AbortController();
    abort.abort();
    try {
      const response = await admittedBodyWork(async () => new Response(null, { status: 499 }),
        admissionRequest("/v1/responses", "{}", { signal: abort.signal }));
      assert.equal(response.status, 499);
    } finally { await holder.text(); }
  });

  test("does not double reserve internal body clones or translated reads", async () => {
    const req = admissionRequest();
    const clone = req.clone();
    const response = await admittedBodyWork(async () => {
      assert.deepEqual(await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT), {});
      assert.deepEqual(await readJsonRequestBody(clone, undefined, RAISED_BODY_LIMIT), {});
      return new Response(null, { status: 204 });
    }, req);
    assert.equal(response.status, 204);
    await assertBodyCapacity(204);
  });

  test("retains the original oversized-declaration refusal before capacity", async () => {
    const holder = await admittedBodyWork(async () => new Response("held"));
    const req = admissionRequest("/v1/responses", "{}", { headers: { "content-length": String(RAISED_BODY_LIMIT + 1) } });
    try {
      await assert.rejects(admittedBodyWork(async () => {
        await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT);
        return new Response(null, { status: 204 });
      }, req), DecompressedBodyTooLargeError);
      await assertBodyCapacity(503); // Rejecting an oversized peer cannot release the first lease.
    } finally { await holder.text(); }
  });

  for (const declared of ["", "invalid", "-1", "Infinity", "0", "1"]) {
    test(`an untrusted content-length ${JSON.stringify(declared)} cannot evade capacity`, async () => {
      const holder = await admittedBodyWork(async () => new Response("held"));
      try {
        const req = admissionRequest("/v1/responses", "{}", { headers: { "content-length": declared } });
        const response = await admittedBodyWork(async () => new Response(null, { status: 204 }), req);
        assert.equal(response.status, 503);
        await response.text();
      } finally { await holder.text(); }
    });
  }

  for (const failure of ["json", "gzip", "encoding", "downstream"]) {
    test(`releases on ${failure} failure without changing the error`, async () => {
      const req = admissionRequest("/v1/responses", failure === "json" ? "{" : "{}", {
        headers: failure === "gzip" ? { "content-encoding": "gzip" }
          : failure === "encoding" ? { "content-encoding": "not-a-codec" } : {},
      });
      const downstream = new Error("fixture downstream failure");
      await assert.rejects(admittedBodyWork(async () => {
        await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT);
        throw downstream;
      }, req), (error: unknown) => failure === "json" ? error instanceof SyntaxError
        : failure === "encoding" ? error instanceof UnsupportedContentEncodingError
          : failure === "downstream" ? error === downstream : error instanceof Error);
      await assertBodyCapacity(204);
    });
  }

  test("reserves the full compressed upload allowance before retaining its measured wire size", async () => {
    const wire = gzipSync(Buffer.from("{}"));
    const req = admissionRequest("/v1/responses", wire, { headers: { "content-encoding": "gzip" } });
    const holder = await admittedBodyWork(async () => {
      assert.equal(testBudget.snapshot().reservedBytes, RAISED_BODY_LIMIT);
      assert.deepEqual(await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT), {});
      return new Response("held");
    }, req);
    try {
      assert.equal(testBudget.snapshot().reservedBytes, wire.byteLength);
      await assertBodyCapacity(503);
    } finally { await holder.text(); }
    await assertBodyCapacity(204);
  });

  test("does not wait for cancellation of a refused tee", async () => {
    const holder = await admittedBodyWork(async () => new Response("held"));
    const cancelled = bodyDeferred();
    const unblockCancel = bodyDeferred();
    let reason: unknown;
    const req = admissionRequest("/v1/responses", new ReadableStream<Uint8Array>({
      cancel(value) { reason = value; cancelled.resolve(); return unblockCancel.promise; },
    }, { highWaterMark: 0 }));
    try {
      const response = await admittedBodyWork(async () => new Response(null, { status: 204 }), req);
      await cancelled.promise;
      assert.equal(response.status, 503);
      assert.ok(reason instanceof InboundBodyCapacityError);
      await response.text();
    } finally { unblockCancel.resolve(); await holder.text(); }
  });

  test("retains a stream through EOF and preserves headers, bytes and backpressure", async () => {
    let pulls = 0;
    const chunk = new Uint8Array([1, 2, 3]);
    const response = await admittedBodyWork(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; if (pulls === 1) controller.enqueue(chunk); else controller.close(); },
    }, { highWaterMark: 0 }), { status: 201, statusText: "Fixture", headers: { "x-fixture": "preserved" } }));
    assert.equal(pulls, 0);
    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Fixture");
    assert.equal(response.headers.get("x-fixture"), "preserved");
    const reader = response.body!.getReader();
    try {
      assert.equal((await reader.read()).value, chunk); // no body-sized copy
      assert.equal(pulls, 1);
      await assertBodyCapacity(503);
      assert.equal((await reader.read()).done, true);
      await assertBodyCapacity(204);
    } finally { await reader.cancel(); reader.releaseLock(); }
  });

  test("releases a failed response stream and preserves its original error", async () => {
    const error = new Error("fixture stream error");
    const response = await admittedBodyWork(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(error); },
    }, { highWaterMark: 0 })));
    await assert.rejects(response.text(), (actual: unknown) => actual === error);
    await assertBodyCapacity(204);
  });

  for (const rejects of [false, true]) {
    test(`pending-read EOF never releases before cancellation settles (rejects=${rejects})`, async () => {
      const reading = bodyDeferred();
      const finishCancel = bodyDeferred();
      const cancellation = new Error("fixture cancel error");
      let cancelledWith: unknown;
      const response = await admittedBodyWork(async () => new Response(new ReadableStream<Uint8Array>({
        pull() { reading.resolve(); },
        async cancel(reason) {
          cancelledWith = reason;
          await finishCancel.promise;
          if (rejects) throw cancellation;
        },
      }, { highWaterMark: 0 })));
      const reader = response.body!.getReader();
      const pendingRead = reader.read();
      await reading.promise;
      const cancelResult = reader.cancel("fixture stop").then(() => undefined, error => error);
      try {
        assert.equal((await pendingRead).done, true);
        await Promise.resolve();
        await assertBodyCapacity(503);
        assert.equal(cancelledWith, "fixture stop");
      } finally { finishCancel.resolve(); }
      assert.equal(await cancelResult, rejects ? cancellation : undefined);
      reader.releaseLock();
      await assertBodyCapacity(204);
    });
  }

  test("runs the caller's refusal decoration once without dispatching work", async () => {
    const holder = await admittedBodyWork(async () => new Response("held"));
    let decorated = 0;
    try {
      const response = await fixtureAdmission(admissionRequest(), "/v1/responses", RAISED_BODY_LIMIT,
        async () => { throw new Error("must not dispatch"); }, refused => {
          decorated++;
          refused.headers.set("x-fixture-log", "once");
          return refused;
        });
      assert.equal(decorated, 1);
      assert.equal(response.headers.get("x-fixture-log"), "once");
      await response.text();
    } finally { await holder.text(); }
  });

  for (const declared of [null, "", "invalid", "-1", "Infinity", "NaN", "0", "1", "2", "1.5"]) {
    test(`content-length ${JSON.stringify(declared)} cannot reduce the upfront allowance`, async () => {
      const holder = await testBudget.acquire(1, new AbortController().signal, 0);
      assert.ok(holder);
      let dispatched = false;
      const req = admissionRequest("/v1/responses", "{}", {
        headers: declared === null ? {} : { "content-length": declared },
      });
      try {
        const response = await admittedBodyWork(async () => {
          dispatched = true;
          return new Response(null, { status: 204 });
        }, req);
        assert.equal(response.status, 503);
        await response.text();
        assert.equal(dispatched, false);
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: 1, activeLeases: 1, queuedRequests: 0 });
      } finally { holder.release(); }
    });
  }

  for (const grant of ["immediate", "queued"] as const) {
    test(`${grant} grant followed by abort before the caller resumes never dispatches`, async () => {
      const holder = grant === "queued" ? await testBudget.acquire(RAISED_BODY_LIMIT, new AbortController().signal) : null;
      const abort = new AbortController();
      const reason = new Error("fixture disconnect after grant");
      let dispatched = false;
      let cancelledWith: unknown;
      let cancellations = 0;
      let pulls = 0;
      const req = admissionRequest("/v1/responses", new ReadableStream<Uint8Array>({
        pull() { pulls++; },
        cancel(value) { cancellations++; cancelledWith = value; },
      }, { highWaterMark: 0 }), { signal: abort.signal });
      const pending = withRaisedInboundBodyAdmission(req, "/v1/responses", RAISED_BODY_LIMIT, async () => {
        dispatched = true;
        return new Response(null, { status: 204 });
      }, undefined, { budget: testBudget, maxWaitMs: 1000 });
      const outcome = pending.catch(error => error);
      try {
        if (grant === "queued") {
          assert.equal(testBudget.snapshot().queuedRequests, 1);
          holder!.release();
        }
        // Do not yield: acquire has granted a lease but admission's await has not resumed.
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: RAISED_BODY_LIMIT, activeLeases: 1, queuedRequests: 0 });
        abort.abort(reason);
        assert.equal(await outcome, reason);
        assert.equal(dispatched, false);
        assert.equal(pulls, 0);
        assert.equal(cancellations, 1);
        assert.equal(cancelledWith, reason);
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
        await assertBodyCapacity(204);
      } finally {
        abort.abort(reason);
        holder?.release();
        const result = await outcome;
        if (result instanceof Response) await result.body?.cancel();
      }
    });
  }

  for (const end of ["abort", "timeout"] as const) {
    test(`a queued HTTP upload ${end} cancels its unread body without releasing the holder`, async () => {
      const holder = await admittedBodyWork(async () => new Response("held"));
      const abort = new AbortController();
      const reason = new Error("fixture waiting upload left");
      let cancelledWith: unknown;
      let cancellations = 0;
      let dispatched = false;
      let pulls = 0;
      const req = admissionRequest("/v1/responses", new ReadableStream<Uint8Array>({
        pull() { pulls++; },
        cancel(value) { cancellations++; cancelledWith = value; },
      }, { highWaterMark: 0 }), { signal: abort.signal });
      const outcome = withRaisedInboundBodyAdmission(req, "/v1/responses", RAISED_BODY_LIMIT, async () => {
        dispatched = true;
        return new Response(null, { status: 204 });
      }, undefined, { budget: testBudget, maxWaitMs: end === "timeout" ? 20 : 1000 }).catch(error => error);
      try {
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: RAISED_BODY_LIMIT, activeLeases: 1, queuedRequests: 1 });
        if (end === "abort") abort.abort(reason);
        const result = await outcome;
        if (end === "abort") assert.equal(result, reason);
        else {
          assert.ok(result instanceof Response);
          assert.equal(result.status, 503);
          assert.equal(result.headers.get("retry-after"), "1");
          await result.text();
        }
        assert.equal(dispatched, false);
        assert.equal(pulls, 0);
        assert.equal(cancellations, 1);
        if (end === "abort") assert.equal(cancelledWith, reason);
        else assert.ok(cancelledWith instanceof InboundBodyCapacityError);
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: RAISED_BODY_LIMIT, activeLeases: 1, queuedRequests: 0 });
      } finally {
        abort.abort(reason);
        await outcome;
        await holder.text();
      }
      await assertBodyCapacity(204);
    });
  }

  for (const normalized of [false, true]) {
    test(`retains measured JSON bytes with translator normalization ${normalized}`, async () => {
      const text = "1e20";
      const req = admissionRequest("/v1/responses", text);
      const translator = normalized ? createTranslatorBudget() : undefined;
      let response: Response | undefined;
      try {
        response = await admittedBodyWork(async () => {
          assert.equal(testBudget.snapshot().reservedBytes, RAISED_BODY_LIMIT);
          assert.equal(await readJsonRequestBody(req, translator, RAISED_BODY_LIMIT), 1e20);
          return new Response("held");
        }, req);
        const expected = normalized ? Buffer.byteLength(JSON.stringify(1e20)) : Buffer.byteLength(text);
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: expected, activeLeases: 1, queuedRequests: 0 });
        await response.text();
      } finally {
        await response?.body?.cancel().catch(() => undefined);
        translator?.dispose();
      }
    });
  }

  for (const end of ["eof", "error", "cancel"] as const) {
    test(`retains decoded compressed bytes until response ${end} settles exactly once`, async () => {
      const text = JSON.stringify({ input: "x".repeat(10_000) });
      const wire = gzipSync(Buffer.from(text));
      assert.ok(wire.byteLength < Buffer.byteLength(text));
      const abort = new AbortController();
      const req = admissionRequest("/v1/responses", wire, {
        headers: { "content-encoding": "gzip" }, signal: abort.signal,
      });
      const finishCancel = bodyDeferred();
      const cancelStarted = bodyDeferred();
      const error = new Error("fixture stream failure");
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let cancellations = 0;
      const response = await admittedBodyWork(async () => {
        assert.equal(testBudget.snapshot().reservedBytes, RAISED_BODY_LIMIT);
        assert.deepEqual(await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT), JSON.parse(text));
        return new Response(new ReadableStream<Uint8Array>({
          start(value) { controller = value; },
          cancel() { cancellations++; cancelStarted.resolve(); return finishCancel.promise; },
        }, { highWaterMark: 0 }));
      }, req);
      let next: Response | undefined;
      try {
        const retained = { reservedBytes: Buffer.byteLength(text), activeLeases: 1, queuedRequests: 0 };
        assert.deepEqual(testBudget.snapshot(), retained);
        if (end === "eof") {
          controller.close();
          assert.equal(await response.text(), "");
        } else if (end === "error") {
          controller.error(error);
          await assert.rejects(response.text(), (actual: unknown) => actual === error);
        } else {
          const cancellation = response.body!.cancel("fixture stop");
          await cancelStarted.promise;
          assert.deepEqual(testBudget.snapshot(), retained);
          finishCancel.resolve();
          await cancellation;
        }
        assert.deepEqual(testBudget.snapshot(), { reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
        next = await admittedBodyWork(async () => new Response("next reservation"));
        abort.abort(error);
        await Promise.resolve();
        await assertBodyCapacity(503); // A late finalizer cannot release the next owner.
        assert.equal(cancellations, end === "cancel" ? 1 : 0);
      } finally {
        finishCancel.resolve();
        await response.body?.cancel().catch(() => undefined);
        await next?.body?.cancel();
      }
      await assertBodyCapacity(204);
    });
  }
});
// END raised-body admission regressions.

test("the explicitly raised public singleton admits eight tiny parsed bodies with live responses", async () => {
  const empty = { reservedBytes: 0, activeLeases: 0, queuedRequests: 0 };
  assert.deepEqual(inboundBodyBudget.snapshot(), empty);
  configureInboundBodyBudget(4 * RAISED_BODY_LIMIT);
  const responses: Response[] = [];
  let measuredBytes = 0;
  let cancellations = 0;
  try {
    for (let n = 0; n < 8; n++) {
      const text = JSON.stringify({ request: n });
      const req = admissionRequest("/v1/responses", text);
      const response = await withRaisedInboundBodyAdmission(req, "/v1/responses", RAISED_BODY_LIMIT, async () => {
        assert.deepEqual(await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT), { request: n });
        return new Response(new ReadableStream<Uint8Array>({
          cancel() { cancellations++; },
        }, { highWaterMark: 0 }));
      }, undefined, { maxWaitMs: 0 }); // Use the public singleton; fail promptly if full allowances stay retained.
      responses.push(response);
      assert.equal(response.status, 200);
      assert.equal(response.bodyUsed, false);
      measuredBytes += Buffer.byteLength(text);
      assert.deepEqual(inboundBodyBudget.snapshot(), {
        reservedBytes: measuredBytes, activeLeases: n + 1, queuedRequests: 0,
      });
    }
    assert.equal(responses.length, 8);
  } finally {
    await Promise.all(responses.map(response => response.body?.cancel().catch(() => undefined)));
    configureInboundBodyBudget();
  }
  assert.equal(cancellations, 8);
  assert.deepEqual(inboundBodyBudget.snapshot(), empty);
});

test("eight concurrent local HTTP JSON requests retain live fixture streams without an upstream", async () => {
  const budget = createInboundBodyBudget(4 * RAISED_BODY_LIMIT);
  const seen = new Set<number>();
  let cancellations = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      return withRaisedInboundBodyAdmission(req, new URL(req.url).pathname, RAISED_BODY_LIMIT, async () => {
        const parsed = await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT) as { request: number };
        seen.add(parsed.request);
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${parsed.request}\n\n`)); },
          cancel() { cancellations++; },
        }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
      }, undefined, { budget, maxWaitMs: 1000 });
    },
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let clients: Promise<void>[] = [];
  try {
    clients = controllers.map(async (controller, n) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: n }), signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response.body!.getReader();
      readers.push(reader);
      const decoder = new TextDecoder();
      let event = "";
      while (!event.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        event += decoder.decode(chunk.value, { stream: true });
      }
      assert.equal(event, `data: ${n}\n\n`);
    });
    await Promise.all(clients);
    assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(budget.snapshot(), {
      reservedBytes: Array.from({ length: 8 }, (_, request) => Buffer.byteLength(JSON.stringify({ request })))
        .reduce((total, bytes) => total + bytes, 0),
      activeLeases: 8, queuedRequests: 0,
    });
    assert.equal(cancellations, 0);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(clients);
    await Promise.all(readers.map(reader => reader.cancel().catch(() => undefined)));
    for (const reader of readers) reader.releaseLock();
    await server.stop(true);
    for (let i = 0; i < 100 && budget.snapshot().activeLeases; i++) await Bun.sleep(10);
  }
  assert.equal(cancellations, 8);
  assert.deepEqual(budget.snapshot(), { reservedBytes: 0, activeLeases: 0, queuedRequests: 0 });
});

describe("raised inbound body admission at the real HTTP boundary", () => {
  let fixtureHome: string;
  let previousHome: string | undefined;
  let codexHome: IsolatedCodexHome;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    fixtureHome = mkdtempSync(join(tmpdir(), "ocx-inbound-body-admission-"));
    process.env.OPENCODEX_HOME = fixtureHome;
    codexHome = installIsolatedCodexHome("ocx-inbound-body-admission-codex-");
  });
  afterEach(async () => {
    configureInboundBodyBudget();
    await drainAndRemoveFixtureRoots({
      roots: [{ path: fixtureHome }, { path: codexHome.path }],
      restoreEnvironment() {
        if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
        else process.env.OPENCODEX_HOME = previousHome;
        codexHome.restoreEnvironment();
      },
    });
  });

  for (const capacity of [undefined, 0, RAISED_BODY_LIMIT, 2 * RAISED_BODY_LIMIT, 4 * RAISED_BODY_LIMIT]) {
    test(`startup captures shared capacity ${String(capacity)} until the next restart`, async () => {
      saveConfig({ ...getDefaultConfig(), providers: {}, maxInboundBodyBytes: RAISED_BODY_LIMIT,
        maxConcurrentInboundBodyBytes: capacity });
      const server = startServer(0);
      try {
        const expected = capacity || RAISED_BODY_LIMIT;
        assert.equal(inboundBodyBudget.capacity(), expected);
        saveConfig({ ...getDefaultConfig(), providers: {}, maxInboundBodyBytes: RAISED_BODY_LIMIT,
          maxConcurrentInboundBodyBytes: capacity === 4 * RAISED_BODY_LIMIT ? RAISED_BODY_LIMIT : 4 * RAISED_BODY_LIMIT });
        assert.equal(inboundBodyBudget.capacity(), expected, "a disk edit must not replace live accounting");
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        assert.equal(response.status, 400);
        await response.text();
        assert.equal(inboundBodyBudget.capacity(), expected, "handling traffic must retain startup policy");
      } finally { await server.stop(true); }
    }, 30_000);
  }

  test("all configured JSON routes refuse before protocol parsing and recover after release", async () => {
    saveConfig({ ...getDefaultConfig(), providers: {}, maxInboundBodyBytes: RAISED_BODY_LIMIT });
    const server = startServer(0);
    let restoreCapacity: (() => Promise<void>) | undefined;
    try {
      restoreCapacity = await saturateInboundBodyBudget();
      for (const path of raisedBodyPaths) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        assert.equal(response.status, 503, path);
        assert.equal(response.headers.get("retry-after"), "1", path);
        const payload = await response.json() as { type?: string; error: { type: string; code: string } };
        assert.equal(payload.error.code, "server_busy", path);
        assert.equal(payload.error.type, path.startsWith("/v1/messages") ? "overloaded_error" : "server_error", path);
      }
      // Admission remains after the listener's origin policy, even while busy.
      const blocked = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", origin: "https://example.invalid" }, body: "{}",
      });
      assert.equal(blocked.status, 403);
      await blocked.text();
      await restoreCapacity();
      const recovered = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      // Invalid input reaches the original parser again; no provider is configured or contacted.
      assert.equal(recovered.status, 400);
      await recovered.text();
    } finally {
      await restoreCapacity?.();
      await server.stop(true);
    }
  }, 30_000);
});
