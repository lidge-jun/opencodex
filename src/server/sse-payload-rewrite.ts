import type { TranslatorBudget } from "../lib/translator-budget";

/**
 * Shared client-facing SSE payload rewrite shell.
 *
 * Multiple opt-in transforms (image-gen namespace restore, item-id repair, …) compose into one
 * parse/stringify pass so a tee'd stream is not re-framed twice per event.
 */

export type SsePayloadRewrite = (payload: string) => string | null;

/** Split one complete SSE event block while retaining its original blank-line delimiter. */
export function nextSseBlock(buffer: string): { block: string; delimiter: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    delimiter: match[0],
    rest: buffer.slice(match.index + match[0].length),
  };
}

/** Join all data lines from one SSE event according to the event-stream field rules. */
export function sseDataPayload(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return data.length > 0 ? data.join("\n") : null;
}

/** Replace an SSE event's data field while preserving non-data fields and newline style. */
export function replaceSseDataPayload(block: string, payload: string): string {
  const newline = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const rewritten: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      rewritten.push(line);
      continue;
    }
    if (!replaced) {
      rewritten.push(`data: ${payload}`);
      replaced = true;
    }
  }
  return replaced ? rewritten.join(newline) : block;
}

/** Apply rewrites left-to-right; empty list is identity. */
export function composeSsePayloadRewrites(...rewrites: SsePayloadRewrite[]): SsePayloadRewrite {
  if (rewrites.length === 0) return (payload) => payload;
  if (rewrites.length === 1) return rewrites[0]!;
  return (payload) => {
    let next: string | null = payload;
    for (const rewrite of rewrites) {
      if (next === null) return null;
      next = rewrite(next);
    }
    return next;
  };
}

/**
 * Relay an SSE body through a single JS pull wrapper, rewriting each event's data payload in place.
 * Non-data fields and framing are preserved; invalid JSON payloads are left to the rewrite callback.
 */
export interface RelaySseRewriteOptions {
  /** Optional trailer emitted once after the upstream body ends (e.g. `data: [DONE]\n\n`). */
  trailer?: string | (() => string | undefined);
}

export function relaySseWithPayloadRewrite(
  body: ReadableStream<Uint8Array>,
  rewrite: SsePayloadRewrite,
  translatorBudget: TranslatorBudget,
  options?: RelaySseRewriteOptions,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let bufferBytes = 0;

  const appendBuffer = (fragment: string): void => {
    if (!fragment) return;
    const nextBytes = bufferBytes + encoder.encode(fragment).byteLength;
    const reservation = translatorBudget.reserveTransient(nextBytes, { kind: "live_transient" });
    try {
      buffer += fragment;
      reservation.commitRetained();
      translatorBudget.releaseRetained(bufferBytes, { kind: "live_transient" });
      bufferBytes = nextBytes;
    } catch (error) {
      reservation.release();
      throw error;
    }
  };

  const replaceBuffer = (next: string): void => {
    const nextBytes = encoder.encode(next).byteLength;
    const reservation = translatorBudget.reserveTransient(nextBytes, { kind: "live_transient" });
    reservation.commitRetained();
    buffer = next;
    translatorBudget.releaseRetained(bufferBytes, { kind: "live_transient" });
    bufferBytes = nextBytes;
  };

  const enqueueText = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): void => {
    const bytes = encoder.encode(text).byteLength;
    const reservation = translatorBudget.reserveTransient(bytes, { kind: "live_transient" });
    try {
      const encoded = encoder.encode(text);
      reservation.commitRetained();
      controller.enqueue(encoded);
      translatorBudget.releaseRetained(bytes, { kind: "live_transient" });
    } catch (error) {
      reservation.release();
      throw error;
    }
  };

  const releaseBuffer = (): void => {
    translatorBudget.releaseRetained(bufferBytes, { kind: "live_transient" });
    buffer = "";
    bufferBytes = 0;
  };

  const emitProcessedBlocks = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    flushFinal = false,
  ): number => {
    let enqueued = 0;
    let next: { block: string; delimiter: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      replaceBuffer(next.rest);
      const payload = sseDataPayload(next.block);
      if (payload) {
        const rewrittenPayload = rewrite(payload);
        if (rewrittenPayload === null) continue;
        const block = rewrittenPayload !== payload
          ? replaceSseDataPayload(next.block, rewrittenPayload)
          : next.block;
        enqueueText(controller, block + next.delimiter);
        enqueued += 1;
      } else {
        enqueueText(controller, next.block + next.delimiter);
        enqueued += 1;
      }
    }
    if (flushFinal && buffer.length > 0) {
      const payload = sseDataPayload(buffer);
      if (payload) {
        const rewrittenPayload = rewrite(payload);
        if (rewrittenPayload !== null) {
          const block = rewrittenPayload !== payload
            ? replaceSseDataPayload(buffer, rewrittenPayload)
            : buffer;
          enqueueText(controller, block);
          enqueued += 1;
        }
      } else {
        enqueueText(controller, buffer);
        enqueued += 1;
      }
      releaseBuffer();
    }
    return enqueued;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Keep reading while rewrites drop events so the consumer is never left waiting
        // on a stream that still has upstream data but produced zero client-facing bytes.
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            appendBuffer(decoder.decode());
            emitProcessedBlocks(controller, true);
            const trailer = typeof options?.trailer === "function" ? options.trailer() : options?.trailer;
            if (trailer) enqueueText(controller, trailer);
            releaseBuffer();
            controller.close();
            return;
          }
          appendBuffer(decoder.decode(value, { stream: true }));
          const enqueued = emitProcessedBlocks(controller);
          if (enqueued > 0) return;
        }
      } catch (error) {
        releaseBuffer();
        try { await reader.cancel(error); } catch { /* already closed */ }
        controller.error(error);
      }
    },
    cancel(reason) {
      releaseBuffer();
      reader.cancel(reason).catch(() => {});
    },
  });
}
