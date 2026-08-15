import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeForInspection, trackSseForRequestLog } from "../src/server/relay";
import {
  addFinalRequestLog,
  addRequestLog,
  beginRequestAttempt,
  httpStatusForRequestLogTerminal,
  type RequestLogContext,
} from "../src/server/request-log";
import {
  readUsageEntries,
  resetUsageReadCacheForTests,
  type PersistedUsageAttempt,
} from "../src/usage/log";

// Port of codex-router #139's streamAborted metering marker: an upstream stream
// that dies after its 200 head was committed must meter as a truncated turn
// (synthetic 502 + streamAborted), while a client cancellation keeps opencodex's
// own 499 client_cancel semantics and never carries the marker.

const encoder = new TextEncoder();

let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-stream-aborted-"));
  process.env.OPENCODEX_HOME = testDir;
  resetUsageReadCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function makeLogCtx(): { logCtx: RequestLogContext; attempt: PersistedUsageAttempt } {
  const attempt = beginRequestAttempt(1, "openai", "gpt-test", "openai-responses");
  const logCtx: RequestLogContext = {
    provider: "openai",
    model: "gpt-test",
    activeAttempt: attempt,
    activeAttemptStartedAt: Date.now(),
    attempts: [attempt],
  };
  return { logCtx, attempt };
}

/** Enqueues one event (a 200 head is committed), then the upstream read dies. */
function streamThatFailsMidStream(): ReadableStream<Uint8Array> {
  let reads = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      if (reads === 1) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hel"}\n\n'));
      } else {
        controller.error(new Error("socket reset"));
      }
    },
  });
}

/** A stream whose read never resolves on its own; only cancel or abort ends it. */
function pendingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {}, pull() { /* producer is test-controlled */ } });
}

describe("streamAborted marker (codex-router #139)", () => {
  test("mid-stream death after a 200 head meters as 502 + streamAborted", async () => {
    const { logCtx, attempt } = makeLogCtx();
    const terminalReported = Promise.withResolvers<void>();
    const terminals: Array<[string, number | undefined]> = [];
    let cancels = 0;
    consumeForInspection(
      streamThatFailsMidStream(),
      (status, httpStatusOverride) => {
        terminals.push([status, httpStatusOverride]);
        terminalReported.resolve();
      },
      undefined,
      () => {},
      logCtx,
      () => { cancels += 1; },
    );
    await terminalReported.promise;
    expect(terminals).toEqual([["failed", 502]]);
    expect(cancels).toBe(0);
    expect(attempt.streamAborted).toBe(true);

    // Finalize exactly like the native-passthrough terminal path in index.ts.
    addFinalRequestLog(
      "ocx-stream-aborted-e2e",
      Date.now(),
      logCtx,
      httpStatusForRequestLogTerminal("failed", logCtx),
      { terminalStatus: "failed", closeReason: "terminal" },
      addRequestLog,
    );
    const [row] = readUsageEntries();
    expect(row?.status).toBe(502);
    expect(row?.attempts?.[0]?.status).toBe(502);
    expect(row?.attempts?.[0]?.streamAborted).toBe(true);
  });

  test("client cancellation keeps 499 and never sets streamAborted", async () => {
    const { logCtx, attempt } = makeLogCtx();
    const ac = new AbortController();
    const cancelFired = Promise.withResolvers<void>();
    const doneFired = Promise.withResolvers<void>();
    const terminals: string[] = [];
    let cancels = 0;
    consumeForInspection(
      pendingStream(),
      status => { terminals.push(status); },
      ac.signal,
      () => doneFired.resolve(),
      logCtx,
      () => {
        cancels += 1;
        cancelFired.resolve();
      },
    );
    ac.abort();
    await Promise.all([cancelFired.promise, doneFired.promise]);
    expect(terminals).toEqual([]);
    expect(cancels).toBe(1);
    expect(attempt.streamAborted).toBeUndefined();

    addFinalRequestLog(
      "ocx-cancel-e2e",
      Date.now(),
      logCtx,
      499,
      { closeReason: "client_cancel" },
      addRequestLog,
    );
    const [row] = readUsageEntries();
    expect(row?.status).toBe(499);
    expect(row?.attempts?.[0]?.streamAborted).toBeUndefined();
  });

  test("translated SSE read failure marks the attempt streamAborted", async () => {
    const { logCtx, attempt } = makeLogCtx();
    const terminals: string[] = [];
    let cancels = 0;
    const relayed = trackSseForRequestLog(
      streamThatFailsMidStream(),
      status => { terminals.push(status); },
      () => { cancels += 1; },
      logCtx,
    );
    await expect(new Response(relayed).text()).rejects.toThrow("socket reset");
    expect(terminals).toEqual(["incomplete"]);
    expect(cancels).toBe(0);
    expect(attempt.streamAborted).toBe(true);
  });

  test("translated SSE client cancel never sets the truncation marker", async () => {
    const { logCtx, attempt } = makeLogCtx();
    const readStarted = Promise.withResolvers<void>();
    let upstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) { upstreamController = controller; },
      pull() { readStarted.resolve(); },
    });
    const cancelFired = Promise.withResolvers<void>();
    const terminals: string[] = [];
    let cancels = 0;
    const relayed = trackSseForRequestLog(
      upstream,
      status => { terminals.push(status); },
      () => {
        cancels += 1;
        cancelFired.resolve();
      },
      logCtx,
    );
    const reader = relayed.getReader();
    const pendingRead = reader.read();
    await readStarted.promise;
    upstreamController?.error(new Error("socket reset during client cancel"));
    await reader.cancel(new DOMException("client closed", "AbortError"));
    await cancelFired.promise;
    await pendingRead;
    expect(cancels).toBe(1);
    expect(terminals).toEqual([]);
    expect(attempt.streamAborted).toBeUndefined();

    addFinalRequestLog(
      "ocx-cancel-translated",
      Date.now(),
      logCtx,
      499,
      { closeReason: "client_cancel" },
      addRequestLog,
    );
    const [row] = readUsageEntries();
    expect(row?.status).toBe(499);
    expect(row?.attempts?.[0]?.streamAborted).toBeUndefined();
  });
});
