import { expect, spyOn, test } from "bun:test";
import { tapAnthropicSseForLog, type PassthroughBodyGuard, type PassthroughFinalizeMeta } from "../../src/server/messages-shared";
import type { RequestLogContext } from "../../src/server/request-log";

const encoder = new TextEncoder();
const start = 'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}';
const delta = 'data: {"type":"message_delta","usage":{"output_tokens":5}}';
const stop = 'data: {"type":"message_stop"}';

function tap(bytes: Uint8Array, chunkSize: number, ending: "close" | "error" | "stall" = "close", guard?: PassthroughBodyGuard) {
  let offset = 0;
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        const end = Math.min(bytes.length, offset + chunkSize);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      } else if (ending === "close") controller.close();
      else if (ending === "error") controller.error(new Error("fixture reset"));
    },
    cancel() { cancelled = true; },
  });
  const log: RequestLogContext = { model: "fixture", provider: "fixture" };
  const calls: Array<{ status: number; meta: PassthroughFinalizeMeta }> = [];
  const stream = tapAnthropicSseForLog(source, log, (status, meta) => calls.push({ status, meta }), guard);
  return { stream, log, calls, cancelled: () => cancelled };
}

test("fragmented large Anthropic frames have a linear normalization budget", async () => {
  const content = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "x".repeat(256 * 1024) } })}`;
  const bytes = encoder.encode([start, content, delta, stop, ""].join("\n\n"));
  const original = String.prototype.replace;
  let normalizedChars = 0;
  const replace = spyOn(String.prototype, "replace");
  replace.mockImplementation(function (this: string, ...args: Parameters<typeof original>) {
    if (args[0] instanceof RegExp && args[0].source === "\\r\\n?") normalizedChars += this.length;
    return Reflect.apply(original, this, args);
  });
  try {
    const result = tap(bytes, 256);
    expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(bytes);
    expect(result.log.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.calls).toEqual([{ status: 200, meta: { closeReason: "terminal" } }]);
    // Count actual normalization input rather than asserting a machine-dependent time limit.
    expect(normalizedChars).toBeLessThanOrEqual(bytes.length * 2);
  } finally {
    replace.mockRestore();
  }
});

test("one-byte fragments are coalesced instead of retaining one slot per byte", async () => {
  const bytes = encoder.encode(`${start}\n\ndata: ${JSON.stringify({ padding: "x".repeat(128 * 1024) })}\n\n${stop}\n\n`);
  const original = Array.prototype.join;
  let maxParts = 0;
  let joinedChars = 0;
  const join = spyOn(Array.prototype, "join");
  join.mockImplementation(function (this: unknown[], separator?: string) {
    if (separator === "") {
      maxParts = Math.max(maxParts, this.length);
      for (const part of this) if (typeof part === "string") joinedChars += part.length;
    }
    return Reflect.apply(original, this, [separator]);
  });
  try {
    const result = tap(bytes, 1);
    const output = new Uint8Array(await new Response(result.stream).arrayBuffer());
    join.mockRestore();
    expect(output).toEqual(bytes);
    expect(maxParts).toBeLessThanOrEqual(8192);
    expect(joinedChars).toBeGreaterThanOrEqual(bytes.length);
    expect(joinedChars).toBeLessThanOrEqual(bytes.length * 4);
  } finally {
    join.mockRestore();
  }
});

for (const eol of ["\n", "\r\n", "\r", "\n\r", "\r\n\n"]) {
  test(`Anthropic inspection preserves fragmented ${JSON.stringify(eol)} framing and UTF-8`, async () => {
    const content = `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "한글 🌸" } })}`;
    const bytes = encoder.encode([start, content, delta, stop, ""].join("\n\n").replace(/\n/g, eol));
    const result = tap(bytes, 1, "stall", { stallMs: 30, maxBytes: 0 });
    expect(new Uint8Array(await new Response(result.stream).arrayBuffer())).toEqual(bytes);
    expect(result.log.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.log.generationStartedAt).toBeNumber();
    expect(result.calls).toEqual([{ status: 200, meta: { closeReason: "terminal" } }]);
    expect(result.cancelled()).toBe(true);
  });
}

for (const suffix of ["", "\n", "\r"]) {
  test(`a reset after an unterminated terminal ${JSON.stringify(suffix)} restores its delimiter`, async () => {
    const text = `${start}\n\n${delta}\n\n${stop}${suffix}`;
    const result = tap(encoder.encode(text), 1, "error");
    expect(await new Response(result.stream).text()).toBe(`${text}\n\n`);
    expect(result.log.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.calls).toEqual([{ status: 200, meta: { closeReason: "terminal" } }]);
  });
}

test("a reset before a terminal still emits the Anthropic error and records usage", async () => {
  const result = tap(encoder.encode(`${start}\n\n${delta}\n\n`), 3, "error");
  expect(await new Response(result.stream).text()).toContain('"type":"error"');
  expect(result.log.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
  expect(result.calls).toEqual([{ status: 502, meta: { terminalStatus: "failed", closeReason: "terminal" } }]);
});

test("a body cap after a held CR terminal preserves the completed turn", async () => {
  const text = `${start}\n\n${delta}\n\n${stop}\r`;
  const bytes = encoder.encode(`${text}${"x".repeat(64)}`);
  const result = tap(bytes, encoder.encode(text).length, "close", { stallMs: 0, maxBytes: encoder.encode(text).length });
  expect(await new Response(result.stream).text()).toBe(`${text}\n\n`);
  expect(result.calls).toEqual([{ status: 200, meta: { closeReason: "terminal" } }]);
});

test("client cancellation still settles once and cancels the source", async () => {
  const abort = new AbortController();
  const result = tap(encoder.encode(`${start}\n\n`), 3, "stall", { stallMs: 0, maxBytes: 0, reqSignal: abort.signal });
  const text = new Response(result.stream).text();
  abort.abort();
  await text;
  expect(result.calls).toEqual([{ status: 499, meta: { closeReason: "client_cancel" } }]);
  expect(result.cancelled()).toBe(true);
});
