/**
 * Eager bounded single-reader SSE relay (#314 WP2) + createSseInspector
 * extraction locks. Fixtures follow the deterministic pull-count pattern from
 * devlog/_plan/260723_win_mem_safestream/020 — no wall-clock assertions except
 * via the injectable clock/short drain windows.
 */
import { describe, expect, test } from "bun:test";
import {
  adapterEofIncompleteFrame,
  createSseInspector,
  doneFrame,
  MAX_TAIL_ERROR_MESSAGE_CHARS,
} from "../src/server/relay";
import { relaySseEagerBounded, type EagerRelayHooks } from "../src/server/relay-eager";
import { createTranslatorBudget } from "../src/lib/translator-budget";
import type { RequestLogContext } from "../src/server/request-log";
import { MAX_CLIENT_SSE_FRAME_BYTES } from "../src/server/sse-frame-buffer";

import { watchdogMs } from "./helpers/ci-watchdog";
const enc = new TextEncoder();

function sse(event: string): Uint8Array {
  return enc.encode(`data: ${event}\n\n`);
}

const COMPLETED = JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
const DELTA = JSON.stringify({ type: "response.output_text.delta", delta: "hi" });
const FAILED_EVENT_MARKER = "event: response.failed\ndata: ";

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function failedPayload(text: string): {
  type: string;
  response: {
    status: string;
    error: { code: string; message: string };
    incomplete_details?: unknown;
  };
} {
  const payload = text.split(FAILED_EVENT_MARKER)[1]?.split("\n")[0];
  if (!payload) throw new Error("missing response.failed payload");
  return JSON.parse(payload);
}

type Recorded = {
  terminals: Array<{ status: string; httpStatus?: number }>;
  completed: unknown[];
  cancels: number;
  dones: number;
  disposes: number;
  synthetics: string[];
};

function makeHooks(): { hooks: EagerRelayHooks; rec: Recorded; inspector: ReturnType<typeof createSseInspector> } {
  const rec: Recorded = { terminals: [], completed: [], cancels: 0, dones: 0, disposes: 0, synthetics: [] };
  const inspector = createSseInspector({
    onTerminal: (status, httpStatus) => rec.terminals.push({ status, httpStatus }),
    onCompletedResponse: r => rec.completed.push(r),
  });
  const hooks: EagerRelayHooks = {
    inspectChunk: c => inspector.feed(c),
    finishInspection: () => inspector.finish(),
    disposeInspection: () => { rec.disposes += 1; inspector.dispose(); },
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

describe("relaySseEagerBounded — inline payload rewrite (#864)", () => {
  test("neither relay races reads against a shared abort promise", async () => {
    // Retention shape, not behavior: racing every read against ONE never-settled
    // promise attaches a reaction per completed read and holds it until abort, so a
    // long stream retains O(chunk-count) callbacks. Both relays relay identically
    // either way, which is exactly why no behavioral assertion catches a regression
    // here — relay.ts already states the rule in prose at its own drain, and this
    // pins it for both files. The sanctioned shape is: cancel the reader on abort.
    const eager = await Bun.file(new URL("../src/server/relay-eager.ts", import.meta.url)).text();
    const relay = await Bun.file(new URL("../src/server/relay.ts", import.meta.url)).text();

    // Strip comments first: both files DESCRIBE the banned shape in prose, and the
    // rule is about the code, not the explanation of why the code avoids it.
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const [name, source] of [["relay-eager.ts", eager], ["relay.ts", relay]] as const) {
      const racesReads = /Promise\.race\(\s*\[\s*reader\.read\(\)/.test(stripComments(source));
      expect(`${name} races reads: ${racesReads}`).toBe(`${name} races reads: false`);
    }
    // And the eager producer must keep the reader-cancel wake-up that replaced it.
    expect(eager).toMatch(/reader\.cancel\(upstream\.signal\.reason\)/);
  });

  test("a terminal frame settling in the same tick as abort is still recorded", async () => {
    // Post-cancel drain: the terminal arrives, and the drain deadline aborts
    // upstream in the same tick. Honoring the signal before examining the settled
    // read discarded that frame, so the turn was accounted as a cancel instead of
    // the completion it actually reached.
    const up = controlledUpstream();
    const { hooks, rec } = makeHooks();
    const upstream = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstream, hooks);
    const reading = readAll(relayed);

    up.push(sse(DELTA));
    await settle();
    // Enqueue the terminal and abort without yielding in between.
    up.push(enc.encode(`event: response.completed\ndata: ${COMPLETED}\n\n`));
    upstream.abort(new Error("drain window expired"));
    up.close();
    await reading;

    expect(rec.terminals.map(t => t.status)).toContain("completed");
  });

  test("rewrites complete blocks across fragmented chunks and flushes the tail at EOF", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    hooks.rewritePayload = (payload: string) => payload.replaceAll("image_gen__gen", "RESTORED");
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reading = readAll(relayed);

    const aliased = `data: {"type":"response.output_item.done","item":{"name":"image_gen__gen"}}\n\n`;
    // Fragment mid-block: the rewrite must wait for the complete SSE block.
    up.push(enc.encode(aliased.slice(0, 30)));
    await settle();
    up.push(enc.encode(aliased.slice(30)));
    up.push(enc.encode(`event: response.completed\ndata: ${COMPLETED}\n\n`));
    up.push(enc.encode(`data: {"type":"trailing-partial"`));
    up.close();

    const text = await reading;
    expect(text).toContain("RESTORED");
    expect(text).not.toContain("image_gen__gen");
    expect(text).toContain("response.completed");
    // The protocol terminal ends the client stream; bytes produced after it
    // belong to the gateway's retained connection and must not hold Codex open.
    expect(text).not.toContain("trailing-partial");
    expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("identity rewrite preserves framing byte-for-byte", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    let rewriteCalls = 0;
    hooks.rewritePayload = (payload: string) => {
      rewriteCalls += 1;
      return payload;
    };
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reading = readAll(relayed);

    const first = sse(DELTA);
    const second = `event: response.completed\ndata: ${COMPLETED}\n\n`;
    up.push(first);
    up.push(enc.encode(second));
    up.close();

    const text = await reading;
    expect(text).toBe(
      new TextDecoder().decode(joinBytes([first, enc.encode(second)])) + "data: [DONE]\n\n",
    );
    // The rewrite actually ran — this is what makes the test red pre-fix.
    expect(rewriteCalls).toBeGreaterThan(0);
  });

  test("drops coalesced post-terminal frames and detects only a real DONE event", async () => {
    for (const realDone of [false, true]) {
      const up = controlledUpstream();
      const { hooks } = makeHooks();
      const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
      const reading = readAll(relayed);
      const completed = JSON.stringify({
        type: "response.completed",
        response: { status: "completed", note: "data: [DONE]" },
      });
      up.push(enc.encode(
        `event: response.completed\ndata: ${completed}\n\n`
        + (realDone ? "data: [DONE]\n\n" : "")
        + `data: {"type":"response.output_text.delta","delta":"must not leak"}\n\n`,
      ));
      up.close();

      const text = await reading;
      expect(text).not.toContain("must not leak");
      expect(countOccurrences(text, "\ndata: [DONE]\n\n")).toBe(1);
      expect(text.endsWith("data: [DONE]\n\n")).toBe(true);
    }
  });

  test("unchanged multi-data-line events keep their original framing", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    hooks.rewritePayload = (payload: string) => payload;
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reading = readAll(relayed);

    // Two data fields in one event plus CRLF framing: must pass through
    // byte-identical when the rewrite changes nothing.
    const multi = `event: response.output_text.delta\r\ndata: {"delta":"part1",\r\ndata: "more":true}\r\n\r\n`;
    up.push(enc.encode(multi));
    up.push(enc.encode(`event: response.completed\ndata: ${COMPLETED}\n\n`));
    up.close();

    const text = await reading;
    expect(text).toContain(`data: {"delta":"part1",\r\ndata: "more":true}`);
  });

  test("decoder-flushed bytes follow the buffered tail at EOF", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    hooks.rewritePayload = (payload: string) => payload;
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reading = readAll(relayed);

    // Close with an INCOMPLETE multibyte sequence: the decoder flush emits the
    // replacement char AFTER the buffered text, never before it.
    const euro = enc.encode("data: €");
    up.push(euro.subarray(0, euro.length - 1));
    up.close();

    const text = await reading;
    expect(text.startsWith("data: �")).toBe(true);
    expect(text).toContain('"reason":"adapter_eof"');
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
  });

  test("terminal framing keeps partial blocks out of the rewrite budget", async () => {
    const budget = createTranslatorBudget();
    const up = controlledUpstream();
    const ac = new AbortController();
    try {
      const { hooks, rec } = makeHooks();
      let resolveDone!: () => void;
      const done = new Promise<void>(resolve => { resolveDone = resolve; });
      const previousOnDone = hooks.onDone;
      hooks.onDone = () => {
        previousOnDone();
        resolveDone();
      };
      hooks.rewritePayload = (payload: string) => payload;
      relaySseEagerBounded(up.stream, ac, hooks, { rewriteBudget: budget });

      up.push(enc.encode(`data: {"type":"unterminated"`));
      // The shared terminal boundary now owns incomplete SSE framing, so the
      // downstream rewrite stage never retains an unterminated block.
      expect(budget.snapshot().currentBytes).toBe(0);
      ac.abort(new Error("test abort"));
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("relay cleanup timed out")), watchdogMs(2_000));
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(rec.dones).toBe(1);
    } finally {
      ac.abort(new Error("test cleanup"));
      budget.dispose();
    }
  });

  test("blocks without a data field pass through untouched before the terminal", async () => {
    const up = controlledUpstream();
    const { hooks } = makeHooks();
    let rewriteCalls = 0;
    hooks.rewritePayload = (payload: string) => {
      rewriteCalls += 1;
      return payload;
    };
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const reading = readAll(relayed);

    up.push(enc.encode(`: keepalive comment\n\n`));
    up.push(enc.encode(`event: response.completed\ndata: ${COMPLETED}\n\n`));
    up.close();

    const text = await reading;
    expect(text).toContain(": keepalive comment");
    // Only the data-bearing block invoked the rewrite.
    expect(rewriteCalls).toBe(1);
  });
});

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
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
    expect(rec.disposes).toBe(1);
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

  test("clean EOF emits one adapter_eof incomplete terminal and one DONE", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(sse(DELTA));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.incomplete/g)?.length).toBe(1);
    expect(text).toContain('"reason":"adapter_eof"');
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.synthetics).toEqual(["incomplete"]);
    expect(rec.terminals).toEqual([]);
  });

  test.each([
    [
      "completed",
      "response.completed",
      "response.completed",
      {
        type: "response.completed",
        sequence_number: 31,
        response: { id: "resp-unframed-completed", status: "completed", output: [] },
      },
      { status: "completed" },
    ],
    [
      "failed",
      "response.failed",
      "response.failed",
      {
        type: "response.failed",
        sequence_number: 32,
        response: { id: "resp-unframed-failed", status: "failed", output: [] },
      },
      { status: "failed" },
    ],
    [
      "incomplete",
      "response.incomplete",
      "response.incomplete",
      {
        type: "response.incomplete",
        sequence_number: 33,
        response: { id: "resp-unframed-incomplete", status: "incomplete", output: [] },
      },
      { status: "incomplete" },
    ],
    [
      "policy error",
      "error",
      "response.failed",
      {
        type: "error",
        sequence_number: 34,
        response: {
          id: "resp-unframed-policy",
          output: [{ type: "message", id: "item-unframed-policy" }],
          status: "failed",
        },
        error: {
          type: "invalid_request_error",
          code: "cyber_policy",
          message: "blocked by upstream policy",
        },
      },
      { status: "failed", httpStatus: 400 },
    ],
  ] as const)("unframed EOF %s is parsed once without an adapter_eof duplicate", async (
    _name,
    upstreamEvent,
    clientEvent,
    payload,
    expectedTerminal,
  ) => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: ${upstreamEvent}\ndata: ${JSON.stringify(payload)}`));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.(?:completed|failed|incomplete)/g)?.length).toBe(1);
    expect(text).toContain(`event: ${clientEvent}`);
    expect(text).not.toContain('"reason":"adapter_eof"');
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.terminals).toEqual([expectedTerminal]);
    expect(rec.synthetics).toEqual([]);
  });

  test("policy response.incomplete is rewritten to one failed terminal with 400 accounting", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: response.incomplete\ndata: ${JSON.stringify({
      type: "response.incomplete",
      sequence_number: 7,
      response: {
        id: "resp-policy",
        output: [{ type: "message", id: "item-1" }],
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
        error: {
          type: "invalid_request_error",
          code: "cyber_policy",
          message: "blocked by upstream policy",
        },
      },
    })}\n\n`));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).not.toContain("response.incomplete");
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain('"type":"invalid_request_error"');
    expect(text).toContain('"id":"resp-policy"');
    expect(text).toContain('"sequence_number":7');
    expect(text).toContain('"output":[{"type":"message","id":"item-1"}]');
    expect(failedPayload(text).response.incomplete_details).toBeUndefined();
    expect(text).not.toContain("content_filter");
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.terminals).toEqual([{ status: "failed", httpStatus: 400 }]);
    expect(rec.synthetics).toEqual([]);
  });

  test("policy leading error frame is rewritten and stops a clean EOF without a duplicate", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: error\ndata: ${JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        code: "cyber_policy",
        message: "policy blocked this request",
      },
    })}\n\n`));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).not.toContain("event: error");
    expect(text).not.toContain("response.incomplete");
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.terminals).toEqual([{ status: "failed", httpStatus: 400 }]);
    expect(rec.synthetics).toEqual([]);
  });

  test("structured policy response.failed stays failed, normalizes to cyber_policy, and preserves metadata", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const payload = JSON.stringify({
      type: "response.failed",
      sequence_number: 18,
      model: "gpt-policy",
      retryable: true,
      response: {
        id: "resp-structured-policy-eager",
        output: [{ type: "message", id: "item-structured-policy-eager" }],
        status: "failed",
        retryable: true,
        error: {
          type: "server_error",
          code: "cyber_policy",
          message: `blocked by upstream policy Authorization: ${["Bear", "er"].join("")} relayeagersecret123456`,
        },
      },
    });
    const framed = enc.encode(`event: response.failed\r\ndata: ${payload}\r\n\r\n`);
    up.push(framed.subarray(0, framed.byteLength - 1));
    up.push(framed.subarray(framed.byteLength - 1));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain('"type":"server_error"');
    expect(text).toContain('"code":"cyber_policy"');
    expect(text.match(/"retryable":false/g)?.length).toBe(2);
    expect(text).not.toContain('"retryable":true');
    expect(text).toContain("Authorization: Bearer [REDACTED]");
    expect(text).not.toContain("relayeagersecret123456");
    expect(text).toContain('"sequence_number":18');
    expect(text).toContain('"model":"gpt-policy"');
    expect(text).toContain('"id":"resp-structured-policy-eager"');
    expect(text).toContain('"output":[{"type":"message","id":"item-structured-policy-eager"}]');
    expect(rec.terminals).toEqual([{ status: "failed", httpStatus: 400 }]);
    expect(rec.synthetics).toEqual([]);
  });

  test("ordinary response.failed remains unchanged", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: response.failed\ndata: ${JSON.stringify({
      type: "response.failed",
      response: {
        id: "resp-ordinary-failed",
        status: "failed",
        error: { type: "server_error", code: "upstream_error", message: "provider failed" },
      },
    })}\n\n`));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain('"code":"upstream_error"');
    expect(text).not.toContain('"code":"cyber_policy"');
    expect(rec.terminals).toEqual([{ status: "failed" }]);
    expect(rec.synthetics).toEqual([]);
  });

  test("policy error survives same-chunk frame-count overflow without an upstream reset", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const policy = JSON.stringify({
      type: "error",
      sequence_number: 23,
      response: {
        id: "resp-policy-frame-count",
        output: [{ type: "message", id: "item-policy-frame-count" }],
        status: "failed",
      },
      error: {
        type: "invalid_request_error",
        code: "cyber_policy",
        message: "blocked by upstream policy",
      },
    });
    const frameLimit = Math.ceil(MAX_CLIENT_SSE_FRAME_BYTES / 1024);
    // The client framer derives its per-feed frame cap from the byte cap. The
    // policy terminal is first, followed by a full cap of empty blocks, which used to
    // turn the already-committed policy response into an upstream_reset 502.
    up.push(enc.encode(`event: error\ndata: ${policy}\n\n${"\n\n".repeat(frameLimit)}`));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).not.toContain("upstream_reset");
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain('"sequence_number":23');
    expect(text).toContain('"id":"resp-policy-frame-count"');
    expect(text).toContain('"output":[{"type":"message","id":"item-policy-frame-count"}]');
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.terminals).toEqual([{ status: "failed", httpStatus: 400 }]);
    expect(rec.synthetics).toEqual([]);
  });

  test("policy error also survives same-chunk oversized trailing bytes", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const policy = JSON.stringify({
      type: "error",
      sequence_number: 25,
      response: { id: "resp-policy-byte-overflow", output: [], status: "failed" },
      error: {
        type: "invalid_request_error",
        code: "cyber_policy",
        message: "blocked by upstream policy",
      },
    });
    const oversizedTail = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1).fill(120);
    up.push(joinBytes([
      enc.encode(`event: error\ndata: ${policy}\n\n`),
      oversizedTail,
    ]));
    up.close();

    const text = await readAll(relayed);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).not.toContain("upstream_reset");
    expect(text).toContain('"code":"cyber_policy"');
    expect(text).toContain('"id":"resp-policy-byte-overflow"');
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.terminals).toEqual([{ status: "failed", httpStatus: 400 }]);
  });

  test("oversized nonterminal before a same-chunk terminal emits one client fallback", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks);
    const oversizedNonterminal = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1).fill(120);
    up.push(joinBytes([oversizedNonterminal, enc.encode("\n\n"), sse(COMPLETED)]));

    const text = await readAll(relayed);
    await settle();
    expect(countOccurrences(text, "event: response.failed")).toBe(1);
    expect(countOccurrences(text, "event: response.completed")).toBe(0);
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(text).toContain('"code":"upstream_reset"');
    expect(rec.terminals).toEqual([{ status: "completed" }]);
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
    expect(upstreamAc.signal.aborted).toBe(true);
  });

  test("inspector-only terminal cannot suppress the oversized-frame client fallback", async () => {
    const inspector = createSseInspector({});
    const synthetics: string[] = [];
    let doneCount = 0;
    const hooks: EagerRelayHooks = {
      inspectChunk: chunk => inspector.feed(chunk),
      finishInspection: () => inspector.finish(),
      disposeInspection: () => inspector.dispose(),
      sawTerminal: () => inspector.terminalSeen(),
      onSynthetic: kind => synthetics.push(kind),
      onClientCancel() {},
      onDone: () => { doneCount += 1; },
    };
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks);
    const oversizedNonterminal = new Uint8Array(MAX_CLIENT_SSE_FRAME_BYTES + 1).fill(120);
    up.push(joinBytes([oversizedNonterminal, enc.encode("\n\n"), sse(COMPLETED)]));

    const text = await readAll(relayed);
    await settle();
    expect(inspector.terminalSeen()).toBe(true);
    expect(inspector.reported()).toBe(false);
    expect(countOccurrences(text, "event: response.failed")).toBe(1);
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(synthetics).toEqual([]);
    expect(doneCount).toBe(1);
    expect(upstreamAc.signal.aborted).toBe(true);
  });

  const unframedReadErrorCases = [
    {
      label: "completed",
      type: "response.completed",
      event: "response.completed",
      status: "completed",
      payload: {
        type: "response.completed",
        sequence_number: 61,
        response: { id: "resp-eager-read-error-completed", status: "completed", output: [] },
      },
    },
    {
      label: "failed",
      type: "response.failed",
      event: "response.failed",
      status: "failed",
      payload: {
        type: "response.failed",
        sequence_number: 62,
        response: { id: "resp-eager-read-error-failed", status: "failed", output: [] },
      },
    },
    {
      label: "incomplete",
      type: "response.incomplete",
      event: "response.incomplete",
      status: "incomplete",
      payload: {
        type: "response.incomplete",
        sequence_number: 63,
        response: { id: "resp-eager-read-error-incomplete", status: "incomplete", output: [] },
      },
    },
    {
      label: "policy error",
      type: "error",
      event: "response.failed",
      status: "failed",
      payload: {
        type: "error",
        sequence_number: 64,
        response: {
          id: "resp-eager-read-error-policy",
          output: [{ type: "message", id: "item-eager-read-error-policy" }],
          status: "failed",
        },
        error: {
          type: "invalid_request_error",
          code: "cyber_policy",
          message: "blocked by upstream policy",
        },
      },
      httpStatus: 400,
    },
  ] as const;

  test.each(unframedReadErrorCases)(
    "eager preserves an unframed $label terminal before a reader error",
    async (fixture) => {
      const { hooks, rec } = makeHooks();
      const up = controlledUpstream();
      const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
      up.push(enc.encode(`event: ${fixture.type}\ndata: ${JSON.stringify(fixture.payload)}`));
      up.fail(new Error("socket reset after unframed terminal"));

      const text = await readAll(relayed);
      expect(text.match(/event: response\.(?:completed|failed|incomplete)/g)?.length).toBe(1);
      expect(text).toContain(`event: ${fixture.event}`);
      expect(text).not.toContain("upstream_reset");
      expect(text).not.toContain('"reason":"adapter_eof"');
      expect(countOccurrences(text, "data: [DONE]")).toBe(1);
      expect(rec.terminals).toEqual([{ status: fixture.status, ...(fixture.httpStatus ? { httpStatus: fixture.httpStatus } : {}) }]);
      expect(rec.synthetics).toEqual([]);
      if (fixture.type === "error") {
        expect(text).toContain('"sequence_number":64');
        expect(text).toContain('"id":"resp-eager-read-error-policy"');
        expect(text).toContain('"output":[{"type":"message","id":"item-eager-read-error-policy"}]');
      }
    },
  );

  test("eager keeps an ordinary top-level error fail-closed on reader error", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "server_error", code: "upstream_error", message: "provider failed" },
    })}`));
    up.fail(new Error("socket reset after ordinary error"));

    const text = await readAll(relayed);
    expect(text).toContain("event: error");
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text).toContain('"code":"upstream_reset"');
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).not.toContain('"code":"cyber_policy"');
    expect(rec.terminals).toEqual([]);
    expect(rec.synthetics).toEqual(["failed"]);
  });

  test("eager read-error terminal flushes the active rewrite tail", async () => {
    const { hooks, rec } = makeHooks();
    hooks.rewritePayload = payload => payload.replace("rewrite-me", "rewritten");
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { id: "resp-read-error-rewrite", status: "completed", output: [{ type: "message", text: "rewrite-me" }] },
    })}`));
    up.fail(new Error("socket reset after rewritten terminal"));

    const text = await readAll(relayed);
    expect(text).toContain("rewritten");
    expect(text).not.toContain("rewrite-me");
    expect(text.match(/event: response\.completed/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).not.toContain("upstream_reset");
    expect(rec.terminals).toEqual([{ status: "completed" }]);
    expect(rec.synthetics).toEqual([]);
  });

  test("eager rewriteBlocks failure emits one safe failed envelope without a second outcome", async () => {
    const { hooks, rec } = makeHooks();
    hooks.rewriteBlocks = () => { throw new Error("rewrite callback failed"); };
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 71,
      response: {
        id: "resp-rewrite-failure-secret",
        status: "completed",
        output: [{ type: "message", text: "raw-secret-content" }],
      },
    })}`));
    up.fail(new Error("socket reset after rewrite failure"));

    const text = await readAll(relayed);
    expect(text.length).toBeGreaterThan(0);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain('"code":"upstream_reset"');
    expect(text).not.toContain("resp-rewrite-failure-secret");
    expect(text).not.toContain("raw-secret-content");
    expect(text).not.toContain('"sequence_number":71');
    expect(rec.terminals).toEqual([{ status: "completed" }]);
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
  });

  test("terminal rewrite fallback aborts and cancels a still-open upstream", async () => {
    let sourceCancels = 0;
    let terminalSent = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (terminalSent) return;
        terminalSent = true;
        controller.enqueue(sse(COMPLETED));
      },
      cancel() { sourceCancels += 1; },
    }, { highWaterMark: 0 });
    const { hooks, rec } = makeHooks();
    hooks.rewriteBlocks = () => { throw new Error("terminal rewrite failed"); };
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(source, upstreamAc, hooks);

    const text = await readAll(relayed);
    await settle();
    expect(countOccurrences(text, "event: response.failed")).toBe(1);
    expect(countOccurrences(text, "data: [DONE]")).toBe(1);
    expect(rec.terminals).toEqual([{ status: "completed" }]);
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
    expect(upstreamAc.signal.aborted).toBe(true);
    expect(sourceCancels).toBe(1);
  });

  test("eager rewrite-budget exhaustion emits one bounded failed envelope and releases the budget", async () => {
    const budget = createTranslatorBudget({ maxTurnBytes: 1 });
    const upstreamAc = new AbortController();
    try {
      const { hooks, rec } = makeHooks();
      hooks.rewritePayload = payload => payload;
      const up = controlledUpstream();
      const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks, { rewriteBudget: budget });
      up.push(enc.encode(`event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        sequence_number: 72,
        response: {
          id: "resp-budget-failure-secret",
          status: "completed",
          output: [{ type: "message", text: "raw-budget-secret" }],
        },
      })}`));
      up.fail(new Error("socket reset after budget failure"));

      const text = await readAll(relayed);
      expect(text.length).toBeGreaterThan(0);
      expect(text.match(/event: response\.failed/g)?.length).toBe(1);
      expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
      expect(text).toContain('"code":"translation_buffer_limit"');
      expect(text).not.toContain("resp-budget-failure-secret");
      expect(text).not.toContain("raw-budget-secret");
      expect(text).not.toContain('"sequence_number":72');
      expect(rec.terminals).toEqual([{ status: "completed" }]);
      expect(rec.synthetics).toEqual([]);
      expect(rec.dones).toBe(1);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      upstreamAc.abort(new Error("test cleanup"));
      budget.dispose();
    }
  });

  test("eager clean EOF rewrite failure emits one safe failed envelope", async () => {
    const { hooks, rec } = makeHooks();
    hooks.rewriteBlocks = () => { throw new Error("clean EOF rewrite callback failed"); };
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode(`event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      sequence_number: 73,
      response: {
        id: "resp-clean-eof-rewrite-secret",
        status: "completed",
        output: [{ type: "message", text: "clean-eof-raw-secret" }],
      },
    })}`));
    up.close();

    const text = await readAll(relayed);
    expect(text.length).toBeGreaterThan(0);
    expect(text.match(/event: response\.failed/g)?.length).toBe(1);
    expect(text.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(text).toContain('"code":"upstream_reset"');
    expect(text).not.toContain("resp-clean-eof-rewrite-secret");
    expect(text).not.toContain("clean-eof-raw-secret");
    expect(text).not.toContain('"sequence_number":73');
    expect(rec.terminals).toEqual([{ status: "completed" }]);
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
  });

  test("eager relay backfills missing completed output before passthrough persistence (#334)", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    const frames = [
      sse(JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
      })),
      sse(JSON.stringify({
        type: "response.output_item.done",
        output_index: 1,
        item: { type: "function_call", call_id: "call_eager", name: "lookup", arguments: "{}" },
      })),
      sse(JSON.stringify({
        type: "response.completed",
        response: { id: "resp_334_eager", status: "completed" },
      })),
    ];
    for (const frame of frames) up.push(frame);
    up.close();

    const clientBytes = await readAllBytes(relayed);
    await settle();
    expect(clientBytes).toEqual(joinBytes([...frames, enc.encode("data: [DONE]\n\n")]));
    const wireText = new TextDecoder().decode(clientBytes);
    expect(wireText).not.toContain('"output":');
    expect(rec.completed).toHaveLength(1);
    expect((rec.completed[0] as { output: Array<{ type: string }> }).output.map(item => item.type))
      .toEqual(["message", "function_call"]);
    expect(rec.dones).toBe(1);
  });

  test("malformed SSE payload is skipped before a valid completed response (#334) — eager relay subcase", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(enc.encode("data: {not-json}\n\n"));
    up.push(sse(JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "survived" }] },
    })));
    up.push(sse(JSON.stringify({
      type: "response.completed",
      response: { id: "resp_334_eager_malformed", status: "completed", output: [] },
    })));
    up.close();

    await readAll(relayed);
    await settle();
    expect(rec.completed).toHaveLength(1);
    expect((rec.completed[0] as { output: Array<{ type: string }> }).output.map(item => item.type))
      .toEqual(["message"]);
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
    // The unterminated client block is made dispatchable with one blank-line
    // delimiter, then clean EOF adds exactly one adapter_eof terminal and DONE.
    expect(total).toBe(
      3 * chunk.byteLength
        + enc.encode("\n\n").byteLength
        + adapterEofIncompleteFrame(enc).byteLength
        + doneFrame(enc).byteLength,
    );
  });

  test("(b2) pause resolver rechecks an abort that wins before installation", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const realUpstream = new AbortController();
    let abortOnNextSignalCheck = false;
    let predicateAbortTriggered = false;
    const signal = new Proxy(realUpstream.signal, {
      get(target, property) {
        if (property === "aborted" && abortOnNextSignalCheck) {
          abortOnNextSignalCheck = false;
          predicateAbortTriggered = true;
          realUpstream.abort(new Error("deterministic pause interleave"));
          // Return the pre-abort value for this predicate evaluation. The abort
          // event has already fired, so the resolver installed by paused() must
          // observe the new value on its post-install check.
          return false;
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const upstream = {
      signal,
      abort: (reason?: unknown) => realUpstream.abort(reason),
    } as unknown as AbortController;

    let resolveDone!: () => void;
    const done = new Promise<void>(resolve => { resolveDone = resolve; });
    const previousOnDone = hooks.onDone;
    hooks.onDone = () => {
      previousOnDone();
      resolveDone();
    };
    hooks.rewritePayload = payload => {
      // This callback runs after the chunk is read and before the bounded-queue
      // predicate. The proxy then aborts exactly while that predicate is being
      // evaluated, before paused() installs its resolver.
      abortOnNextSignalCheck = true;
      return payload;
    };

    const relayed = relaySseEagerBounded(up.stream, upstream, hooks, { maxQueueBytes: 1 });
    const reader = relayed.getReader();
    up.push(sse(DELTA));

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("pause resolver did not observe the deterministic abort")),
            watchdogMs(2_000),
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await reader.cancel().catch(() => {});
      realUpstream.abort(new Error("test cleanup"));
    }

    expect(predicateAbortTriggered).toBe(true);
    expect(rec.dones).toBe(1);
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

  test("post-cancel terminal ends metadata-only drain without waiting for timeout", async () => {
    const inspector = createSseInspector({});
    const up = controlledUpstream();
    const rec = { cancels: 0, dones: 0, synthetics: [] as string[] };
    let resolveDone!: () => void;
    const relayDone = new Promise<void>(resolve => { resolveDone = resolve; });
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), {
      inspectChunk: chunk => inspector.feed(chunk),
      finishInspection: () => inspector.finish(),
      disposeInspection: () => inspector.dispose(),
      // Mirrors the no-onTerminal wiring in responses/core.ts.
      sawTerminal: () => inspector.terminalSeen(),
      onSynthetic: kind => { rec.synthetics.push(kind); },
      onClientCancel: () => { rec.cancels += 1; },
      onDone: () => { rec.dones += 1; resolveDone(); },
    }, { postCancelDrainMs: 5_000 });
    const reader = relayed.getReader();
    up.push(sse(DELTA));
    await settle(5);
    await reader.cancel();

    // Keep upstream open after delivering the terminal. The protocol terminal,
    // not EOF or the five-second drain timer, must finish the relay lifecycle.
    up.push(sse(COMPLETED));
    await Promise.race([
      relayDone,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("metadata-only terminal drain waited for timeout")),
        200,
      )),
    ]);

    expect(inspector.reported()).toBe(false);
    expect(inspector.terminalSeen()).toBe(true);
    expect(rec.cancels).toBe(0);
    expect(rec.synthetics).toEqual([]);
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
  test("(e/090-1) mid-stream upstream error → clean failed tail + onSynthetic/onDone once", async () => {
    const { hooks, rec } = makeHooks();
    const inspectChunk = hooks.inspectChunk;
    let inspectedChunks = 0;
    hooks.inspectChunk = chunk => {
      inspectedChunks += 1;
      inspectChunk(chunk);
    };
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks);
    up.push(sse(DELTA));
    up.fail(new Error("socket reset"));
    const out = await readAll(relayed);
    await settle();

    expect(out.startsWith(new TextDecoder().decode(sse(DELTA)))).toBe(true);
    expect(out).toContain(`\n\n${FAILED_EVENT_MARKER}`);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(failedPayload(out).response.error.message).toContain("socket reset");
    // The synthetic tail is client-only; only the upstream DELTA reached inspection.
    expect(inspectedChunks).toBe(1);
    expect(rec.synthetics).toEqual(["failed"]);
    expect(rec.dones).toBe(1);
    expect(upstreamAc.signal.aborted).toBe(true);
  });

  test("(090-2) upstream failure after a protocol terminal emits no duplicate terminal", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(sse(COMPLETED));
    up.fail(new Error("late socket reset"));

    const out = await readAll(relayed);
    await settle();
    expect(countOccurrences(out, "response.completed")).toBe(1);
    expect(countOccurrences(out, "event: response.failed")).toBe(0);
    expect(rec.terminals).toEqual([{ status: "completed", httpStatus: undefined }]);
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
  });

  test("(090-3) upstream failure after client cancel emits no tail and preserves cancel accounting", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const reader = relaySseEagerBounded(up.stream, upstreamAc, hooks, {
      postCancelDrainMs: 5_000,
    }).getReader();
    up.push(sse(DELTA));
    await reader.read();
    const cancel = reader.cancel();
    up.fail(new Error("reset after cancel"));

    await cancel;
    await settle();
    expect(rec.synthetics).toEqual([]);
    expect(rec.cancels).toBe(1);
    expect(rec.dones).toBe(1);
    expect(upstreamAc.signal.aborted).toBe(true);
  });

  test("(g/090-4) shutdown abort mid-stream → onDone, NO synthetic failed-502 or tail", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks);
    const reader = relayed.getReader();
    up.push(sse(DELTA));
    const first = await reader.read();
    expect(first.done).toBe(false);
    upstreamAc.abort(new Error("server shutdown"));
    up.fail(new Error("aborted")); // upstream read rejects due to teardown
    expect((await reader.read()).done).toBe(true);
    await settle();
    expect(rec.synthetics).toEqual([]);
    expect(rec.dones).toBe(1);
  });

  test("(090-5) long error messages are capped and the failed frame remains valid JSON", async () => {
    const { hooks } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.fail(new Error(`reset-${"x".repeat(4_096)}-uncapped-suffix`));

    const parsed = failedPayload(await readAll(relayed));
    expect(parsed.response.error.message.length).toBe(MAX_TAIL_ERROR_MESSAGE_CHARS);
    expect(parsed.response.error.message).not.toContain("uncapped-suffix");
  });

  test("(090-6) failure before any client bytes yields a standalone failed tail", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.fail(new Error("pre-byte reset"));

    const out = await readAll(relayed);
    expect(out.startsWith(`\n\n${FAILED_EVENT_MARKER}`)).toBe(true);
    expect(failedPayload(out).response.status).toBe("failed");
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(rec.synthetics).toEqual(["failed"]);
  });

  test("(090-7) concurrent client cancel wins over an in-flight failing read with one accounting outcome", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const reader = relaySseEagerBounded(up.stream, upstreamAc, hooks, {
      postCancelDrainMs: 5_000,
    }).getReader();
    const pendingRead = reader.read();
    const cancel = reader.cancel();
    up.fail(new Error("cancel/reset race"));

    await Promise.allSettled([pendingRead, cancel]);
    await settle();
    expect(rec.synthetics.length + rec.cancels).toBe(1);
    expect(rec.synthetics).toEqual([]);
    expect(rec.cancels).toBe(1);
    expect(rec.dones).toBe(1);
  });

  test("(090-8) one reset emits exactly one terminal, one DONE, one synthetic, and completes lifecycle", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const relayed = relaySseEagerBounded(up.stream, new AbortController(), hooks);
    up.push(sse(DELTA));
    up.fail(new Error("single reset"));

    const out = await readAll(relayed);
    await settle();
    expect(countOccurrences(out, "event: response.failed")).toBe(1);
    expect(countOccurrences(out, "data: [DONE]")).toBe(1);
    expect(rec.synthetics).toEqual(["failed"]);
    expect(rec.dones).toBe(1);
  });

  test("(090-9) synthetic-failed teardown aborts upstream and cancels its active reader", async () => {
    let sourceCancels = 0;
    const src = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(sse(DELTA)); },
      cancel() { sourceCancels += 1; },
    }, { highWaterMark: 0 });
    const { hooks, rec } = makeHooks();
    hooks.inspectChunk = () => { throw new Error("producer inspection failure"); };
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(src, upstreamAc, hooks);

    const out = await readAll(relayed);
    await settle();
    expect(out).toContain(FAILED_EVENT_MARKER);
    expect(upstreamAc.signal.aborted).toBe(true);
    expect(sourceCancels).toBe(1);
    expect(rec.synthetics).toEqual(["failed"]);
  });

  test("(090-11) re-entrant cancel from the error serializer suppresses the tail (exactly-one accounting)", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks, {
      postCancelDrainMs: 5_000,
    });
    const reader = relayed.getReader();
    const pendingRead = reader.read();
    let cancelPromise: Promise<void> | null = null;
    const evil = new Error("re-entrant");
    Object.defineProperty(evil, "message", {
      get() {
        // User-defined accessor runs inside buildFailedTailPayload — it must
        // not be able to sneak past the eligibility guard.
        cancelPromise ??= reader.cancel();
        return "re-entrant cancel";
      },
    });
    up.fail(evil);

    await Promise.allSettled([pendingRead, cancelPromise ?? Promise.resolve()]);
    await settle();
    // Exactly one accounting outcome: the cancel wins, no synthetic tail.
    expect(rec.synthetics).toEqual([]);
    expect(rec.cancels).toBe(1);
    expect(rec.dones).toBe(1);
  });

  test("(090-12) re-entrant upstream abort from the error serializer suppresses the tail", async () => {
    const { hooks, rec } = makeHooks();
    const up = controlledUpstream();
    const upstreamAc = new AbortController();
    const relayed = relaySseEagerBounded(up.stream, upstreamAc, hooks);
    const evil = new Error("re-entrant");
    Object.defineProperty(evil, "message", {
      get() {
        upstreamAc.abort(new Error("shutdown during serialization"));
        return "re-entrant abort";
      },
    });
    up.fail(evil);

    const out = await readAll(relayed).catch(() => "");
    await settle();
    expect(out).not.toContain(FAILED_EVENT_MARKER);
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
