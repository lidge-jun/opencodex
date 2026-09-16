import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { MAX_DECOMPRESSED_BODY_BYTES, MAX_CONFIGURABLE_INBOUND_BODY_BYTES, readJsonRequestBody, DecompressedBodyTooLargeError, UnsupportedContentEncodingError } from "../../src/server/request-decompress";
import {
  withRaisedInboundBodyAdmission,
  InboundBodyCapacityError,
  CONFIGURABLE_JSON_BODY_ROUTES,
  UNGATED_LOOPBACK_ROUTES,
} from "../../src/server/inbound-body-admission";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(import.meta.dir, ".tmp-server-request-body-size-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-body-size-codex-");
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

describe("server maxRequestBodySize (Issue #1601)", () => {
  test("configures Bun.serve listener with MAX_DECOMPRESSED_BODY_BYTES (256 MiB)", () => {
    expect(MAX_DECOMPRESSED_BODY_BYTES).toBe(256 * 1024 * 1024);
  });

  test("server listener accepts requests without failing at the Bun 128 MiB default", async () => {
    const server = startServer(0);
    try {
      const port = server.port;
      // Send a POST with a body above Bun's 128 MiB default but below our 256 MiB limit.
      // Use a 129 MiB body to prove the raised maxRequestBodySize is effective.
      const bodySize = 129 * 1024 * 1024;
      const body = Buffer.alloc(bodySize, 0x20); // ASCII spaces
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      // The request should NOT get an empty 413 from Bun's default limit.
      // It will get a 4xx from our handler (bad JSON, missing auth, etc.) — that's fine,
      // the point is that Bun accepted the body instead of rejecting at 128 MiB.
      expect(res.status).not.toBe(413);
      // Drain the response so the connection closes cleanly.
      await res.text();
    } finally {
      void server.stop(true);
    }
  });
});

describe("configurable listener body size (Issue #3573)", () => {
  const BODY_BYTES = 2 * 1024 * 1024;

  // Bun refuses an oversized body BEFORE fetch() runs, so a listener pinned to the 256 MiB
  // default would silently cap the opt-in no matter what the handlers do with it. Proving the
  // listener moved is cheaper downward than upward: the same 2 MiB body is admitted under the
  // default and refused under a 1 MiB configured limit.
  async function postFixedBody(port: number): Promise<{ refused: boolean; status: number | null }> {
    // Bun answers 413 and stops reading while the client is still uploading, so the write side
    // can surface the refusal as a transport error instead of a response. Both shapes mean the
    // listener refused the body; neither can be produced by admitting it.
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Buffer.alloc(BODY_BYTES, 0x20),
    }).catch(() => null);
    if (!res) return { refused: true, status: null };
    const status = res.status;
    await res.text().catch(() => "");
    return { refused: status === 413, status };
  }

  test("a body under the configured limit still reaches the handler", async () => {
    saveConfig({ ...getDefaultConfig(), maxInboundBodyBytes: 8 * 1024 * 1024 });
    const server = startServer(0);
    try {
      const result = await postFixedBody(server.port);
      // Unparseable JSON, so the handler answers 4xx — the point is that it answered at all.
      expect(result.refused).toBe(false);
      expect(result.status).not.toBeNull();
    } finally {
      void server.stop(true);
    }
  });

  test("the listener refuses above maxInboundBodyBytes instead of the fixed default", async () => {
    // The old listener was pinned to MAX_DECOMPRESSED_BODY_BYTES, so this body reached the
    // handler regardless of config. It must now be refused before the handler runs.
    saveConfig({ ...getDefaultConfig(), maxInboundBodyBytes: 1024 * 1024 });
    expect(1024 * 1024).toBeLessThan(BODY_BYTES);
    const server = startServer(0);
    try {
      expect((await postFixedBody(server.port)).refused).toBe(true);
    } finally {
      void server.stop(true);
    }
  });
});

// BEGIN raised-body admission regressions: these cases use Web streams and tiny payloads.
const RAISED_BODY_LIMIT = MAX_CONFIGURABLE_INBOUND_BODY_BYTES;
// Read the gate's own set rather than a second copy: a route added to admission
// without protocol coverage, or covered here but never admitted, must not pass.
const raisedBodyPaths = [...CONFIGURABLE_JSON_BODY_ROUTES];
function bodyDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function admissionRequest(path = "/v1/responses", body: BodyInit = "{}", init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST", body, ...init, duplex: "half",
  } as RequestInit);
}
function admittedBodyWork(work: () => Promise<Response>, req = admissionRequest(), limit = RAISED_BODY_LIMIT) {
  return withRaisedInboundBodyAdmission(req, new URL(req.url).pathname, limit, work);
}
async function assertBodyCapacity(status: number) {
  const response = await admittedBodyWork(async () => new Response(null, { status: 204 }));
  assert.equal(response.status, status);
  await response.text();
}

describe("raised inbound body admission lifetime", () => {
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
        const response = await withRaisedInboundBodyAdmission(admissionRequest(), "/v1/responses", limit, async () => original);
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
    const source = await Bun.file(join(import.meta.dir, "../../src/server/index.ts")).text();
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

  test("counts compressed uploads by their allowance, not their small wire size", async () => {
    const req = admissionRequest("/v1/responses", gzipSync(Buffer.from("{}")), { headers: { "content-encoding": "gzip" } });
    const holder = await admittedBodyWork(async () => {
      assert.deepEqual(await readJsonRequestBody(req, undefined, RAISED_BODY_LIMIT), {});
      return new Response("held");
    }, req);
    try { await assertBodyCapacity(503); } finally { await holder.text(); }
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
      const response = await withRaisedInboundBodyAdmission(admissionRequest(), "/v1/responses", RAISED_BODY_LIMIT,
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
});
// END raised-body admission regressions.


describe("raised inbound body admission at the real HTTP boundary", () => {
  test("all configured JSON routes refuse before protocol parsing and recover after release", async () => {
    saveConfig({ ...getDefaultConfig(), providers: {}, maxInboundBodyBytes: RAISED_BODY_LIMIT });
    const server = startServer(0);
    let holder: Response | undefined;
    try {
      holder = await admittedBodyWork(async () => new Response("held"));
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
      await holder.text();
      holder = undefined;
      const recovered = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      // Invalid input reaches the original parser again; no provider is configured or contacted.
      assert.equal(recovered.status, 400);
      await recovered.text();
    } finally {
      await holder?.body?.cancel().catch(() => undefined);
      await server.stop(true);
    }
  }, 30_000);
});
