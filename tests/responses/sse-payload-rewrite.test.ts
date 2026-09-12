/**
 * Single-pass composition of client-facing SSE payload rewrites (#588 follow-up).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createImageGenCallRestoreRewrite } from "../../src/server/responses-image-gen-repair";
import { createResponsesItemIdPayloadRewrite } from "../../src/server/responses-item-id-repair";
import {
  composeSsePayloadRewrites,
  composeSseBlockRewrites,
  createSseBlockBuffer,
  nextSseBlock,
  replaceSseDataPayload,
  relaySseWithBlockRewrite,
  relaySseWithPayloadRewrite,
  sseDataPayload,
} from "../../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { relaySseWithFailedTail } from "../../src/server/relay";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

function streamFromTexts(texts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const text = texts[index++];
      if (text === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(text));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("SSE payload rewrite composition", () => {
  test.each(["\n", "\r\n"])("reads and replaces colonless data fields with %j lines", newline => {
    const block = ["event: update", "data", 'data: {"text":"hello"}', "data", "database: unchanged"].join(newline);
    expect(sseDataPayload(block)).toBe('\n{"text":"hello"}\n');
    expect(replaceSseDataPayload(block, '{"text":"changed"}')).toBe(
      ["event: update", 'data: {"text":"changed"}', "database: unchanged"].join(newline),
    );
    expect(sseDataPayload("data")).toBe("");
    expect(sseDataPayload("database")).toBeNull();
  });

  test("encodes only delivered blocks and counts coalesced input in linear space", async () => {
    const text = Array.from({ length: 256 }, (_, index) => `data: ${index} 中文😀${"x".repeat(128)}\n\n`).join("");
    const upstream = streamFromText(text);
    const budget = createTestTranslatorBudget();
    const originalEncode = TextEncoder.prototype.encode;
    const originalByteLength = Buffer.byteLength;
    let encodedBytes = 0;
    let countedCodeUnits = 0;
    const encode = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, input) {
      const encoded = originalEncode.call(this, input);
      encodedBytes += encoded.byteLength;
      return encoded;
    });
    const byteLength = spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (typeof value === "string") countedCodeUnits += value.length;
      return originalByteLength(value, encoding);
    });
    try {
      expect(await readAll(relaySseWithBlockRewrite(upstream, block => [block], budget))).toBe(text);
      expect(encodedBytes).toBe(originalByteLength(text, "utf8"));
      expect(countedCodeUnits).toBeLessThanOrEqual(text.length * 3);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      encode.mockRestore();
      byteLength.mockRestore();
    }
  });

  test("does not rescan an unterminated prefix after each transport fragment", async () => {
    const fragments = Array.from({ length: 256 }, () => "x".repeat(128));
    fragments[0] = "data: " + fragments[0];
    fragments.push("\r\n\r\n");
    const originalMatch = String.prototype.match;
    const originalIndexOf = String.prototype.indexOf;
    let scannedCodeUnits = 0;
    const match = spyOn(String.prototype, "match").mockImplementation(function (this: string, regexp) {
      if (regexp instanceof RegExp && regexp.source === "\\r?\\n\\r?\\n") scannedCodeUnits += this.length;
      return originalMatch.call(this, regexp);
    });
    const indexOf = spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search, position) {
      const found = originalIndexOf.call(this, search, position);
      if (search === "\n") scannedCodeUnits += (found < 0 ? this.length : found + 1) - (position ?? 0);
      return found;
    });
    try {
      const text = fragments.join("");
      expect(await readAll(relaySseWithBlockRewrite(streamFromTexts(fragments), block => [block], createTestTranslatorBudget()))).toBe(text);
      expect(scannedCodeUnits).toBeLessThanOrEqual(text.length * 2);
    } finally {
      match.mockRestore();
      indexOf.mockRestore();
    }
  });

  test("rejects an oversized replacement before encoding or delivering it", async () => {
    const upstream = streamFromText("data: small\n\n");
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const encode = spyOn(TextEncoder.prototype, "encode");
    let disposeCalls = 0;
    const rewrite = Object.assign(() => [`data: ${"界".repeat(32)}`], {
      dispose() { disposeCalls += 1; },
    });
    try {
      await expect(readAll(relaySseWithBlockRewrite(upstream, rewrite, budget))).rejects.toMatchObject({ code: "translation_buffer_limit" });
      expect(encode).not.toHaveBeenCalled();
      expect(disposeCalls).toBe(1);
      expect(budget.snapshot()).toMatchObject({ currentBytes: 0, overflows: 1 });
    } finally {
      encode.mockRestore();
    }
  });

  test.each(["\n\n", "\r\n\r\n", "\r\n\n", "\n\r\n"])(
    "preserves delimiter %j through byte-split Unicode, drops, injection, and EOF",
    async delimiter => {
      const first = "event: keep\r\ndata: 中文😀";
      const tail = "event: tail\r\ndata: é";
      const text = `${first}${delimiter}data: drop${delimiter}data: inject${delimiter}${tail}`;
      const bytes = new TextEncoder().encode(text);
      let index = 0;
      let disposeCalls = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === bytes.length) controller.close();
          else controller.enqueue(bytes.subarray(index, ++index));
        },
      });
      const rewrite = Object.assign((block: string) => {
        if (block === "data: drop") return [];
        if (block === "data: inject") return ["data: one", "data: two"];
        if (block === tail) return [tail, "data: end"];
        return [block];
      }, { dispose() { disposeCalls += 1; } });
      const budget = createTestTranslatorBudget();
      expect(await readAll(relaySseWithBlockRewrite(source, rewrite, budget))).toBe(
        `${first}${delimiter}data: one${delimiter}data: two${delimiter}${tail}\r\n\r\ndata: end`,
      );
      expect(budget.snapshot().currentBytes).toBe(0);
      expect(disposeCalls).toBe(1);
    },
  );

  test("offset framing preserves exact suffix and overlap accounting through compaction", () => {
    const budget = createTestTranslatorBudget();
    const buffer = createSseBlockBuffer(budget);
    let reference = "";
    let peak = 0;
    for (const fragment of ["data: 中文😀\r\n\r\ndata: é\n\npartial", "界\r", "\n", "\r", "\nlast\n\n", "\ud800", "\udc00\n\n"]) {
      const previousBytes = Buffer.byteLength(reference, "utf8");
      reference += fragment;
      peak = Math.max(peak, previousBytes + Buffer.byteLength(reference, "utf8"));
      buffer.append(fragment);
      for (;;) {
        const expected = nextSseBlock(reference);
        const beforeBytes = Buffer.byteLength(reference, "utf8");
        const actual = buffer.next();
        if (!expected) {
          expect(actual).toBeNull();
          break;
        }
        expect(actual).toEqual({ block: expected.block, delimiter: expected.delimiter });
        reference = expected.rest;
        peak = Math.max(peak, beforeBytes + Buffer.byteLength(reference, "utf8"));
        // Native Chat yields after one event; HTTP rewriting drains the whole batch.
        buffer.compact();
        expect(buffer.tail()).toBe(reference);
        expect(budget.snapshot().currentBytes).toBe(Buffer.byteLength(reference, "utf8"));
      }
      expect(buffer.tail()).toBe(reference);
      expect(budget.snapshot()).toMatchObject({
        currentBytes: Buffer.byteLength(reference, "utf8"),
        highWaterBytes: peak,
        overflows: 0,
      });
    }
    buffer.clear();
    buffer.clear();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each(["append", "consume"] as const)("keeps old/new %s overlap admission atomic", operation => {
    const initial = operation === "append" ? "data: partial" : "data: first\n\ndata: second\n\n";
    const budget = createTestTranslatorBudget({ maxTurnBytes: Buffer.byteLength(initial) + 1 });
    const buffer = createSseBlockBuffer(budget);
    buffer.append(initial);
    expect(() => operation === "append" ? buffer.append("x") : buffer.next()).toThrow("buffer exceeded");
    expect(buffer.tail()).toBe(initial);
    expect(budget.snapshot()).toMatchObject({ currentBytes: Buffer.byteLength(initial), overflows: 1 });
    buffer.clear();
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("cancel during a pending read releases partial input and disposes once", async () => {
    const waiting = Promise.withResolvers<void>();
    const bytes = new TextEncoder().encode("data: partial 中文");
    let sent = false;
    let cancelCalls = 0;
    let disposeCalls = 0;
    let rewriteCalls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
        } else waiting.resolve();
      },
      cancel() { cancelCalls += 1; },
    });
    const rewrite = Object.assign((block: string) => {
      rewriteCalls += 1;
      return [block];
    }, { dispose() { disposeCalls += 1; } });
    const budget = createTestTranslatorBudget();
    const reader = relaySseWithBlockRewrite(source, rewrite, budget).getReader();
    const pending = reader.read();
    await waiting.promise;
    await reader.cancel("client left");
    expect(await pending).toMatchObject({ done: true });
    expect(rewriteCalls).toBe(0);
    expect(cancelCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test.each([false, true])("cancel inside rewrite stops queued blocks and EOF rewrites (tail: %s)", async tail => {
    const text = tail ? "data: unfinished" : "data: first\n\ndata: second\n\n";
    let disposeCalls = 0;
    let rewriteCalls = 0;
    let cancellation: Promise<void> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    const rewrite = Object.assign((block: string) => {
      rewriteCalls += 1;
      cancellation = reader.cancel("cancel during rewrite");
      return [block, "data: injected"];
    }, { dispose() { disposeCalls += 1; } });
    const budget = createTestTranslatorBudget();
    const encode = spyOn(TextEncoder.prototype, "encode");
    const upstream = streamFromText(text);
    encode.mockClear();
    try {
      reader = relaySseWithBlockRewrite(upstream, rewrite, budget).getReader();
      expect(await reader.read()).toMatchObject({ done: true });
      await cancellation;
      expect(encode).not.toHaveBeenCalled();
      expect(rewriteCalls).toBe(1);
      expect(disposeCalls).toBe(1);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      encode.mockRestore();
    }
  });

  test("releases the output reservation when enqueue fails after allocation", async () => {
    const upstream = streamFromText("data: first\n\n");
    const budget = createTestTranslatorBudget();
    const originalEncode = TextEncoder.prototype.encode;
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    let cancellation: Promise<void> | undefined;
    const encode = spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, text) {
      const encoded = originalEncode.call(this, text);
      // Close the downstream immediately before enqueue to exercise reservation cleanup.
      cancellation = reader.cancel("closed before enqueue");
      return encoded;
    });
    try {
      reader = relaySseWithBlockRewrite(upstream, block => [block], budget).getReader();
      expect(await reader.read()).toMatchObject({ done: true });
      await cancellation;
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      encode.mockRestore();
    }
  });

  test("cancellation in one composed stage never invokes a disposed later stage", async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    let cancellation: Promise<void> | undefined;
    let laterCalls = 0;
    let disposeCalls = 0;
    const rewrite = composeSseBlockRewrites(
      block => {
        cancellation = reader.cancel("cancel during first stage");
        return [block];
      },
      Object.assign((block: string) => {
        laterCalls += 1;
        return [block];
      }, { dispose() { disposeCalls += 1; } }),
    );
    const budget = createTestTranslatorBudget();
    reader = relaySseWithBlockRewrite(streamFromText("data: event\n\n"), rewrite, budget).getReader();
    expect(await reader.read()).toMatchObject({ done: true });
    await cancellation;
    expect(laterCalls).toBe(0);
    expect(disposeCalls).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("applies image-gen restore and item-id repair in one relay pass", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_0","role":"assistant"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"image_gen__imagegen","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_0","role":"assistant"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"image_gen__imagegen","arguments":"{}"}]}}\n\n',
    ].join("");

    let imageGenCalls = 0;
    let itemIdCalls = 0;
    const imageGen = createImageGenCallRestoreRewrite(
      new Map([["image_gen__imagegen", { namespace: "image_gen", name: "imagegen" }]]),
    )!;
    const itemId = createResponsesItemIdPayloadRewrite({
      message: ["msg_0"],
      repairMissingTerminalIds: true,
    });

    const composed = composeSsePayloadRewrites(
      (payload) => {
        imageGenCalls += 1;
        return imageGen(payload);
      },
      (payload) => {
        itemIdCalls += 1;
        return itemId(payload);
      },
    );

    const budget = createTestTranslatorBudget();
    const out = await readAll(relaySseWithPayloadRewrite(streamFromText(upstream), composed, budget));
    budget.dispose();
    expect(imageGenCalls).toBe(3);
    expect(itemIdCalls).toBe(3);
    expect(imageGenCalls).toBe(itemIdCalls);

    const events = out
      .trim()
      .split(/\r?\n\r?\n/)
      .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
      .filter((payload): payload is string => !!payload)
      .map(payload => JSON.parse(payload) as Record<string, unknown>);

    const messageAdded = events[0].item as Record<string, unknown>;
    expect(messageAdded.id).toMatch(/^msg_ocx_[0-9a-f]+_0$/);

    const functionAdded = events[1].item as Record<string, unknown>;
    expect(functionAdded).toMatchObject({
      name: "imagegen",
      namespace: "image_gen",
      call_id: "call_1",
    });

    const completed = events[2].response as { output: Record<string, unknown>[] };
    expect(completed.output[0].id).toBe(messageAdded.id);
    expect(completed.output[1]).toMatchObject({
      name: "imagegen",
      namespace: "image_gen",
    });
  });

  test("compose with no rewrites is identity", () => {
    expect(composeSsePayloadRewrites()('{"a":1}')).toBe('{"a":1}');
  });

  test("keeps pulling after a partial or intentionally dropped block", async () => {
    const budget = createTestTranslatorBudget();
    const upstream = streamFromTexts([
      'event: drop\ndata: {"type":"drop"',
      '}\n\nevent: keep\ndata: {"type":"keep","delta":"ok"}\n\n',
    ]);
    const rewritten = relaySseWithBlockRewrite(
      upstream,
      (block) => block.includes('"type":"drop"') ? [] : [block],
      budget,
    );

    expect(await readAll(rewritten)).toBe(
      'event: keep\ndata: {"type":"keep","delta":"ok"}\n\n',
    );
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("unterminated rewrite accumulation closes through a typed failed tail", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const upstream = new AbortController();
    const rewritten = relaySseWithPayloadRewrite(
      streamFromText(`data: ${"x".repeat(80)}`),
      payload => payload,
      budget,
    );

    const out = await readAll(relaySseWithFailedTail(rewritten, upstream));
    expect(out).toContain('"code":"translation_buffer_limit"');
    expect(out).toEndWith("data: [DONE]\n\n");
    expect(upstream.signal.aborted).toBe(true);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test.each(["resolve", "reject"] as const)(
    "surfaces a rewrite failure before tee cancellation can %s",
    async cancellationOutcome => {
      const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
      const upstream = new AbortController();
      const cancellation = Promise.withResolvers<void>();
      const cancellationError = new Error("upstream cancellation failed");
      let cancelCalls = 0;
      let disposeCalls = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: partial"));
          controller.enqueue(new TextEncoder().encode("x".repeat(80)));
          // Keep the source open after exhausting the rewrite budget.
        },
        cancel() {
          cancelCalls += 1;
          return cancellation.promise;
        },
      });
      const [native, inspection] = source.tee();
      const inspectionReader = inspection.getReader();
      await inspectionReader.read();
      await inspectionReader.read();
      let inspectionSettled = false;
      const pendingInspection = inspectionReader.read().then(() => { inspectionSettled = true; });
      const rewrite = Object.assign((block: string) => [block], {
        dispose() { disposeCalls += 1; },
      });
      const rewritten = relaySseWithBlockRewrite(native, rewrite, budget);
      const client = relaySseWithFailedTail(rewritten, upstream);
      const completion = readAll(client);
      let deadline: ReturnType<typeof setTimeout> | undefined;

      try {
        const out = await Promise.race([
          completion,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("rewrite failure waited for the inspection tee")), 1_000);
          }),
        ]);
        expect(out.match(/event: response.failed/g)).toHaveLength(1);
        expect(out).toContain('"code":"translation_buffer_limit"');
        expect(out).toEndWith("data: [DONE]\n\n");
        expect(upstream.signal.aborted).toBe(true);
        expect(inspectionSettled).toBe(false);
        expect(cancelCalls).toBe(0);
        expect(disposeCalls).toBe(1);
        expect(budget.snapshot().currentBytes).toBe(0);
        expect(budget.snapshot().overflows).toBe(1);

        // Releasing inspection settles both tee cancellation promises. A late
        // rejection must be handled by the rewriter as well as this reader.
        const siblingCancellation = inspectionReader.cancel("inspection cleanup");
        expect(cancelCalls).toBe(1);
        if (cancellationOutcome === "reject") {
          cancellation.reject(cancellationError);
          await expect(siblingCancellation).rejects.toBe(cancellationError);
        } else {
          cancellation.resolve();
          await siblingCancellation;
        }
        await pendingInspection;
        await Bun.sleep(0); // Let the runner observe any unhandled cancellation rejection.
        expect(disposeCalls).toBe(1);
      } finally {
        clearTimeout(deadline);
        const cleanup = inspectionReader.cancel().catch(() => {});
        cancellation.resolve();
        await cleanup;
        await pendingInspection;
        await completion.catch(() => {});
        inspectionReader.releaseLock();
        budget.dispose();
      }
    },
  );
});
