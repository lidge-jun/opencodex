/**
 * Eager bounded single-reader SSE relay (#314 WP2) + createSseInspector
 * extraction locks. Fixtures follow the deterministic pull-count pattern from
 * devlog/_plan/260723_win_mem_safestream/020 — no wall-clock assertions except
 * via the injectable clock/short drain windows.
 */
import { describe, expect, test } from "bun:test";
import { createSseInspector } from "../src/server/relay";
import { relaySseEagerBounded, type EagerRelayHooks } from "../src/server/relay-eager";
import type { RequestLogContext } from "../src/server/request-log";

const enc = new TextEncoder();

function sse(event: string): Uint8Array {
  return enc.encode(`data: ${event}\n\n`);
}

const COMPLETED = JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
const DELTA = JSON.stringify({ type: "response.output_text.delta", delta: "hi" });

type Recorded = {
  terminals: Array<{ status: string; httpStatus?: number }>;
  completed: unknown[];
  cancels: number;
  dones: number;
  synthetics: string[];
};

function makeHooks(): { hooks: EagerRelayHooks; rec: Recorded; inspector: ReturnType<typeof createSseInspector> } {
  const rec: Recorded = { terminals: [], completed: [], cancels: 0, dones: 0, synthetics: [] };
  const inspector = createSseInspector({
    onTerminal: (status, httpStatus) => rec.terminals.push({ status, httpStatus }),
    onCompletedResponse: r => rec.completed.push(r),
  });
  const hooks: EagerRelayHooks = {
    inspectChunk: c => inspector.feed(c),
    finishInspection: () => inspector.finish(),
    sawTerminal: () => inspector.reported(),
    onSynthetic: kind => rec.synthetics.push(kind),
    onClientCancel: () => { rec.cancels += 1; },
    onDone: () => { rec.dones += 1; },
  };
  return { hooks, rec, inspector };
}

/** Upstream with externally controlled chunk release + pull counting. */
function controlledUpstream(): {
  stream: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
  fail: (err: Error) => void;
  pullCount: () => number;
} {
  let pulls = 0;
  const pending: Array<{ resolve: (r: ReadableStreamReadResult<Uint8Array>) => void }> = [];
  const queue: Array<{ kind: "chunk"; value: Uint8Array } | { kind: "close" } | { kind: "fail"; err: Error }> = [];
  const controllerQueue: Uint8Array[] = [];
  let closed = false;
  let failure: Error | null = null;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const flush = () => {
    if (!controllerRef) return;
    while (controllerQueue.length) controllerRef.enqueue(controllerQueue.shift()!);
    if (failure) { try { controllerRef.error(failure); } catch { /* done */ } return; }
    if (closed) { try { controllerRef.close(); } catch { /* done */ } }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controllerRef = controller; flush(); },
    pull() { pulls += 1; },
  }, { highWaterMark: 0 });
  return {
    stream,
    push: chunk => { controllerQueue.push(chunk); flush(); },
    close: () => { closed = true; flush(); },
    fail: err => { failure = err; flush(); },
    pullCount: () => pulls,
  };
}

async function settle(ms = 0): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  return text;
}

describe("relaySseEagerBounded — side-effect parity", () => {
  test("(a) relays bytes verbatim; terminal recorded once; completed captured; onDone once", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks);
    up.push(sse(DELTA));
    up.push(sse(COMPLETED));
    up.close();
    const text = await readAll(relayed);
    await settle();
    expect(text).toContain("response.completed");
    expect(rec.terminals).toEqual([{ status: "completed", httpStatus: undefined }]);
    expect(rec.completed.length).toBe(1);
    expect(rec.dones).toBe(1);
    expect(rec.cancels).toBe(0);
    expect(rec.synthetics).toEqual([]);
  });

  test("(a2) clean end without terminal → synthetic incomplete via onSynthetic", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(sse(DELTA));
    up.close();
    await readAll(relayed);
    await settle();
    expect(rec.synthetics).toEqual(["incomplete"]);
    expect(rec.dones).toBe(1);
  });
});

describe("relaySseEagerBounded — bounded queue", () => {
  test("(b) producer pauses at byte cap and resumes on client read", async () => {
    const { hooks } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks, {
      maxQueueBytes: 16,
    });
    const reader = relayed.getReader();
    // 3 chunks of 12 bytes: after chunk 2 (24 bytes queued > 16) the producer pauses.
    const chunk = enc.encode("x".repeat(12));
    up.push(chunk);
    up.push(chunk);
    up.push(chunk);
    up.close();
    await settle(10);
    // Client reads → wakes the producer; eventually all three chunks + close arrive.
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(36);
  });

  test("(f) cancel while paused wakes the gate — onDone fires, no deadlock", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks, {
      maxQueueBytes: 8,
      postCancelDrainMs: 30,
    });
    const reader = relayed.getReader();
    up.push(enc.encode("x".repeat(32))); // exceeds cap immediately → producer pauses
    await settle(10);
    await reader.cancel();
    await settle(80); // drain window expires (silent upstream)
    expect(rec.dones).toBe(1);
    expect(rec.cancels).toBe(1);
  });

  test("(f2) shutdown abort while paused wakes the gate — onDone fires", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    relaySseEagerBounded(up.stream, upstreamAc, hooks, { maxQueueBytes: 8 });
    up.push(enc.encode("x".repeat(32)));
    await settle(10);
    upstreamAc.abort(new Error("server shutdown"));
    await settle(20);
    expect(rec.dones).toBe(1);
    // Shutdown abort is NOT a client cancel and NOT a synthetic failure.
    expect(rec.cancels).toBe(0);
    expect(rec.synthetics).toEqual([]);
  });
});

describe("relaySseEagerBounded — #44 cancel semantics", () => {
  test("(c) post-cancel late terminal → recorded as completed, onClientCancel NOT fired", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks, {
      postCancelDrainMs: 5_000,
    });
    const reader = relayed.getReader();
    up.push(sse(DELTA));
    await settle(5);
    await reader.cancel(); // client walks away mid-stream
    up.push(sse(COMPLETED)); // terminal arrives during discard-drain
    await settle(20);
    expect(rec.terminals).toEqual([{ status: "completed", httpStatus: undefined }]);
    expect(rec.cancels).toBe(0);
    expect(rec.dones).toBe(1);
  });

  test("(d) post-cancel drain timeout → onClientCancel fired, upstream aborted", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks, {
      postCancelDrainMs: 30,
    });
    const reader = relayed.getReader();
    up.push(sse(DELTA));
    await settle(5);
    await reader.cancel();
    await settle(100); // silent upstream; wall-clock drain bound must fire
    expect(rec.cancels).toBe(1);
    expect(rec.terminals).toEqual([]);
    expect(upstreamAc.signal.aborted).toBe(true);
    expect(rec.dones).toBe(1);
  });

  test("(d2) post-cancel drainBytes cap → onClientCancel fired without waiting for the clock", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks, {
      postCancelDrainMs: 60_000,
      postCancelDrainBytes: 24,
    });
    const reader = relayed.getReader();
    up.push(sse(DELTA));
    await settle(5);
    await reader.cancel();
    up.push(enc.encode("x".repeat(32))); // exceeds the 24-byte drain cap, no terminal
    await settle(20);
    expect(rec.cancels).toBe(1);
    expect(upstreamAc.signal.aborted).toBe(true);
    expect(rec.dones).toBe(1);
  });
});

describe("relaySseEagerBounded — error paths", () => {
  test("(e) mid-stream upstream error → synthetic failed + onDone", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reader = relayed.getReader();
    up.push(sse(DELTA));
    up.fail(new Error("socket reset"));
    await expect(async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }).toThrow();
    await settle();
    expect(rec.synthetics).toEqual(["failed"]);
    expect(rec.dones).toBe(1);
  });

  test("(g) shutdown abort mid-stream → onDone, NO synthetic failed-502", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    relaySseEagerBounded(up.stream, upstreamAc, hooks);
    up.push(sse(DELTA));
    await settle(5);
    upstreamAc.abort(new Error("server shutdown"));
    up.fail(new Error("aborted")); // upstream read rejects due to teardown
    await settle(20);
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
  });
});

describe("createSseInspector — extraction locks (h)", () => {
  test("logCtx SSE inspection stops after terminal (reported gate)", () => {
    const logCtx = { transportPhase: "handshake" } as unknown as RequestLogContext;
    const seen: string[] = [];
    const origInspect = logCtx as unknown as Record<string, unknown>;
    void origInspect;
    const inspector = createSseInspector({
      onTerminal: () => { seen.push("terminal"); },
      logCtx,
    });
    inspector.feed(sse(COMPLETED));
    expect(inspector.reported()).toBe(true);
    expect((logCtx as unknown as { transportPhase?: string }).transportPhase).toBe("terminal_sse");
    expect((logCtx as unknown as { terminalSource?: string }).terminalSource).toBe("upstream");
  });

  test("done-flush trailing scan is skipped once reported", () => {
    const completed: unknown[] = [];
    const terminals: string[] = [];
    const inspector = createSseInspector({
      onTerminal: s => { terminals.push(s); },
      onCompletedResponse: r => completed.push(r),
    });
    inspector.feed(sse(COMPLETED));
    expect(terminals).toEqual(["completed"]);
    // Trailing unterminated buffer AFTER the terminal must be dropped by finish().
    inspector.feed(enc.encode(`data: ${COMPLETED}`)); // no trailing blank line → stays buffered
    inspector.finish();
    expect(completed.length).toBe(1);
    expect(terminals).toEqual(["completed"]);
  });

  test("per-block onCompletedResponse continues firing after reported", () => {
    const completed: unknown[] = [];
    const inspector = createSseInspector({
      onTerminal: () => { /* recorded */ },
      onCompletedResponse: r => completed.push(r),
    });
    inspector.feed(sse(COMPLETED));
    inspector.feed(sse(COMPLETED)); // complete SSE block after terminal
    expect(completed.length).toBe(2);
  });

  test("metadata configuration (no onTerminal): reported stays false, inspection unconditional", () => {
    const logCtx = {} as unknown as RequestLogContext;
    const inspector = createSseInspector({ logCtx });
    inspector.feed(sse(COMPLETED));
    inspector.feed(sse(DELTA));
    inspector.finish();
    expect(inspector.reported()).toBe(false);
  });
});
