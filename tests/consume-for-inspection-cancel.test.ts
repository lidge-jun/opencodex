import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumeForInspection,
  consumeForResponseLogMetadata,
  getInspectionCounters,
  resetInspectionCountersForTest,
  type SseInspector,
} from "../src/server/relay";
import type { RequestLogContext } from "../src/server/request-log";

// Regression for issue #44: native-passthrough turns are inspected on a teed background stream.
// Codex disconnects the instant it finishes reading, so the inspection stream is frequently
// aborted. The cancel path must finalize (onCancel) and release the turn (onDone) instead of
// silently dropping the /api/logs entry.

function pendingStream(): ReadableStream<Uint8Array> {
  // A stream whose read never resolves on its own — only reader.cancel() (via abort) ends it.
  return new ReadableStream<Uint8Array>({ start() {}, pull() { /* never enqueue/close */ } });
}

function closingStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

const tick = () => new Promise(r => setTimeout(r, 5));
const encoder = new TextEncoder();

function controlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
  cancelReasons: unknown[];
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancelReasons: unknown[] = [];
  return {
    stream: new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() { /* producer is test-controlled */ },
      cancel(reason) { cancelReasons.push(reason); },
    }),
    push(chunk) { controller.enqueue(chunk); },
    close() { controller.close(); },
    cancelReasons,
  };
}

function completedFrame(id: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({
    type: "response.completed",
    response: { id, status: "completed", output: [] },
  })}\n\n`);
}

function failedFrame(message: string): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({
    type: "response.failed",
    response: { status: "failed", error: { message } },
  })}\n\n`);
}

function inspectionSpy(): { inspector: SseInspector; finishes: () => number; disposes: () => number } {
  let finishCount = 0;
  let disposeCount = 0;
  return {
    inspector: {
      feed() {},
      finish() { finishCount += 1; },
      dispose() { disposeCount += 1; },
      reported: () => false,
      terminalSeen: () => false,
    },
    finishes: () => finishCount,
    disposes: () => disposeCount,
  };
}

beforeEach(() => resetInspectionCountersForTest());

describe("consumeForInspection cancel finalization (#44)", () => {
  test("already-aborted signal → onCancel + onDone fire, onTerminal does not", () => {
    const ac = new AbortController();
    ac.abort();
    let terminal = 0, cancel = 0, done = 0;
    consumeForInspection(pendingStream(), () => terminal++, ac.signal, () => done++, undefined, () => cancel++);
    expect(cancel).toBe(1);
    expect(done).toBe(1);
    expect(terminal).toBe(0);
  });

  test("mid-drain abort → onCancel + onDone fire, onTerminal suppressed", async () => {
    const ac = new AbortController();
    let terminal = 0, cancel = 0, done = 0;
    consumeForInspection(pendingStream(), () => terminal++, ac.signal, () => done++, undefined, () => cancel++);
    ac.abort();
    await tick();
    expect(cancel).toBe(1);
    expect(done).toBe(1);
    expect(terminal).toBe(0);
  });

  test("clean close without a terminal payload → onTerminal(incomplete), not a cancel", async () => {
    let terminalStatus: string | null = null;
    let cancel = 0, done = 0;
    consumeForInspection(closingStream(), s => { terminalStatus = s; }, undefined, () => done++, undefined, () => cancel++);
    await tick();
    expect(terminalStatus).toBe("incomplete");
    expect(cancel).toBe(0);
    expect(done).toBe(1);
  });

});

describe("bounded post-disconnect inspection drain", () => {
  test("consumeForInspection stops at the injected byte bound, cancels the reader, and aborts upstream", async () => {
    const source = controlledStream();
    const clientGone = new AbortController();
    const upstream = new AbortController();
    let terminals = 0;
    let cancels = 0;
    let dones = 0;
    const done = new Promise<void>(resolve => {
      consumeForInspection(
        source.stream,
        () => { terminals += 1; },
        undefined,
        () => { dones += 1; resolve(); },
        undefined,
        () => { cancels += 1; },
        undefined,
        undefined,
        {
          clientGoneSignal: clientGone.signal,
          drainBounds: { ms: 1_000, bytes: 8 },
          upstream,
        },
      );
    });

    const reason = new DOMException("client closed", "AbortError");
    clientGone.abort(reason);
    source.push(encoder.encode("x".repeat(32)));
    await done;

    expect(terminals).toBe(0);
    expect(cancels).toBe(1);
    expect(dones).toBe(1);
    expect(upstream.signal.aborted).toBe(true);
    expect(source.cancelReasons).toEqual([reason]);
    expect(getInspectionCounters().postCancelDrainStops).toBe(1);
  });

  test("consumeForResponseLogMetadata stops a silent source at the injected time bound", async () => {
    const source = controlledStream();
    const clientGone = new AbortController();
    const upstream = new AbortController();
    let dones = 0;
    const done = new Promise<void>(resolve => {
      consumeForResponseLogMetadata(
        source.stream,
        {} as RequestLogContext,
        undefined,
        () => { dones += 1; resolve(); },
        undefined,
        undefined,
        {
          clientGoneSignal: clientGone.signal,
          drainBounds: { ms: 5, bytes: 1_024 },
          upstream,
        },
      );
    });

    const reason = new DOMException("client closed", "AbortError");
    clientGone.abort(reason);
    await done;

    expect(dones).toBe(1);
    expect(upstream.signal.aborted).toBe(true);
    expect(source.cancelReasons).toEqual([reason]);
    expect(getInspectionCounters().postCancelDrainStops).toBe(1);
  });

  test("a completed terminal inside the drain window wins over cancellation", async () => {
    const source = controlledStream();
    const clientGone = new AbortController();
    const upstream = new AbortController();
    const terminals: string[] = [];
    const completed: unknown[] = [];
    let cancels = 0;
    const done = new Promise<void>(resolve => {
      consumeForInspection(
        source.stream,
        status => terminals.push(status),
        undefined,
        resolve,
        undefined,
        () => { cancels += 1; },
        response => completed.push(response),
        undefined,
        {
          clientGoneSignal: clientGone.signal,
          drainBounds: { ms: 100, bytes: 4_096 },
          upstream,
        },
      );
    });

    clientGone.abort("gone");
    source.push(completedFrame("late-terminal"));
    await done;

    expect(terminals).toEqual(["completed"]);
    expect(completed).toHaveLength(1);
    expect(cancels).toBe(0);
    expect(upstream.signal.aborted).toBe(true);
    expect(source.cancelReasons).toEqual(["gone"]);
    expect(getInspectionCounters().postCancelDrainStops).toBe(0);
  });

  test("metadata consumer captures a failed terminal inside the drain window before aborting", async () => {
    const source = controlledStream();
    const clientGone = new AbortController();
    const upstream = new AbortController();
    const logCtx = {} as RequestLogContext;
    const done = new Promise<void>(resolve => {
      consumeForResponseLogMetadata(
        source.stream,
        logCtx,
        undefined,
        resolve,
        undefined,
        undefined,
        {
          clientGoneSignal: clientGone.signal,
          drainBounds: { ms: 100, bytes: 4_096 },
          upstream,
        },
      );
    });

    clientGone.abort("gone");
    source.push(failedFrame("late upstream failure"));
    await done;

    expect(logCtx.upstreamError).toBe("late upstream failure");
    expect(upstream.signal.aborted).toBe(true);
    expect(source.cancelReasons).toEqual(["gone"]);
    expect(getInspectionCounters().postCancelDrainStops).toBe(0);
  });

  test("client-gone EOF finalizes cancellation but does not increment the bound-stop counter", async () => {
    const source = controlledStream();
    const clientGone = new AbortController();
    const upstream = new AbortController();
    let cancels = 0;
    const done = new Promise<void>(resolve => {
      consumeForInspection(
        source.stream,
        () => {},
        undefined,
        resolve,
        undefined,
        () => { cancels += 1; },
        undefined,
        undefined,
        {
          clientGoneSignal: clientGone.signal,
          drainBounds: { ms: 100, bytes: 4_096 },
          upstream,
        },
      );
    });

    clientGone.abort("gone");
    source.close();
    await done;

    expect(cancels).toBe(1);
    expect(getInspectionCounters().postCancelDrainStops).toBe(0);
  });
});

describe("inspection consumer teardown", () => {
  test("both public consumers dispose their inspector in finally", async () => {
    const terminalSpy = inspectionSpy();
    const metadataSpy = inspectionSpy();
    const terminalDone = new Promise<void>(resolve => {
      consumeForInspection(
        closingStream(),
        () => {},
        undefined,
        resolve,
        undefined,
        undefined,
        undefined,
        undefined,
        { inspectorFactory: () => terminalSpy.inspector },
      );
    });
    const metadataDone = new Promise<void>(resolve => {
      consumeForResponseLogMetadata(
        closingStream(),
        {} as RequestLogContext,
        undefined,
        resolve,
        undefined,
        undefined,
        { inspectorFactory: () => metadataSpy.inspector },
      );
    });

    await Promise.all([terminalDone, metadataDone]);
    expect(terminalSpy.finishes()).toBe(1);
    expect(terminalSpy.disposes()).toBe(1);
    expect(metadataSpy.finishes()).toBe(1);
    expect(metadataSpy.disposes()).toBe(1);
  });
});
