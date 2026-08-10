import type { TranslatorBudget } from "../lib/translator-budget";

/**
 * Shared client-facing SSE payload rewrite shell.
 *
 * Multiple opt-in transforms (image-gen namespace restore, item-id repair, …) compose into one
 * parse/stringify pass so a tee'd stream is not re-framed twice per event.
 */

export type SsePayloadRewrite = (payload: string) => string;

/**
 * Block-level SSE rewrite: maps one complete SSE event block (without its
 * blank-line delimiter) to zero or more replacement blocks. This is the
 * contract lifecycle repair needs: injecting missing canonical events
 * (#893) is impossible in the one-payload-in/one-payload-out model.
 *
 * `dispose` releases any retained state (budget-charged collectors) when the
 * relay tears down — terminal, EOF, cancel, or error. Relays call it exactly
 * once per teardown path.
 */
export type SseBlockRewrite = ((block: string) => readonly string[]) & {
  dispose?: () => void;
};

/** Adapt a payload rewrite to the block contract (replace only on change). */
export function payloadRewriteAsBlockRewrite(rewrite: SsePayloadRewrite): SseBlockRewrite {
  return (block) => {
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    const rewritten = rewrite(payload);
    return rewritten !== payload ? [replaceSseDataPayload(block, rewritten)] : [block];
  };
}

/** Chain block rewrites: every block stage N emits feeds stage N+1. */
export function composeSseBlockRewrites(...rewrites: SseBlockRewrite[]): SseBlockRewrite {
  const active = rewrites.filter(Boolean);
  if (active.length === 0) return Object.assign((block: string) => [block], {});
  const composed: SseBlockRewrite = (block: string) => {
    let blocks: readonly string[] = [block];
    for (const rewrite of active) {
      const next: string[] = [];
      for (const current of blocks) next.push(...rewrite(current));
      blocks = next;
    }
    return blocks;
  };
  // Child disposal is part of the contract: one idempotent disposer for the
  // whole chain, so relay teardown never leaks a nested collector.
  let disposed = false;
  composed.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const rewrite of active) {
      try { rewrite.dispose?.(); } catch { /* teardown must not throw */ }
    }
  };
  return composed;
}

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
    let next = payload;
    for (const rewrite of rewrites) next = rewrite(next);
    return next;
  };
}

/**
 * Relay an SSE body through a single JS pull wrapper, rewriting each event's data payload in place.
 * Non-data fields and framing are preserved; invalid JSON payloads are left to the rewrite callback.
 */
export function relaySseWithPayloadRewrite(
  body: ReadableStream<Uint8Array>,
  rewrite: SsePayloadRewrite,
  translatorBudget: TranslatorBudget,
): ReadableStream<Uint8Array> {
  return relaySseWithBlockRewrite(body, payloadRewriteAsBlockRewrite(rewrite), translatorBudget);
}

/**
 * Relay an SSE body through a single JS pull wrapper, applying a block-level
 * rewrite that may emit zero or more blocks per upstream event (lifecycle
 * event injection, #893). The original stream's delimiter style is preserved
 * for every emitted block.
 */
export function relaySseWithBlockRewrite(
  body: ReadableStream<Uint8Array>,
  rewrite: SseBlockRewrite,
  translatorBudget: TranslatorBudget,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let bufferBytes = 0;
  // Relays have several independent teardown paths; disposal is exactly once.
  let disposed = false;
  let cancelled = false;
  const disposeRewrite = (): void => {
    if (disposed) return;
    disposed = true;
    try { rewrite.dispose?.(); } catch { /* teardown must not throw */ }
  };

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
    let emitted = 0;
    let next: { block: string; delimiter: string; rest: string } | null;
    while ((next = nextSseBlock(buffer))) {
      replaceBuffer(next.rest);
      for (const outBlock of rewrite(next.block)) {
        enqueueText(controller, outBlock + next.delimiter);
        emitted += 1;
      }
    }
    if (flushFinal && buffer.length > 0) {
      const tailBlocks = rewrite(buffer);
      // A trailing fragment has no delimiter of its own; multiple emitted
      // blocks must still be framed as separate events (#893 review).
      const tailDelimiter = buffer.includes("\r\n") ? "\r\n\r\n" : "\n\n";
      for (let i = 0; i < tailBlocks.length; i++) {
        enqueueText(controller, tailBlocks[i]! + (i < tailBlocks.length - 1 ? tailDelimiter : ""));
        emitted += 1;
      }
      releaseBuffer();
    }
    return emitted;
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // A network chunk is not an SSE-event boundary. Bun may not issue a
        // second pull after a fulfilled pull enqueues nothing, so keep reading
        // until at least one complete rewritten block is available or EOF is
        // reached. This also handles block rewrites that intentionally drop an
        // event without parking the client stream.
        for (;;) {
          const { done, value } = await reader.read();
          // A cancel raced this pending read: never feed the rewriter again
          // after its disposal (#893 review).
          if (cancelled) return;
          if (done) {
            appendBuffer(decoder.decode());
            emitProcessedBlocks(controller, true);
            releaseBuffer();
            disposeRewrite();
            controller.close();
            return;
          }
          appendBuffer(decoder.decode(value, { stream: true }));
          if (emitProcessedBlocks(controller) > 0) return;
        }
      } catch (error) {
        releaseBuffer();
        disposeRewrite();
        try { await reader.cancel(error); } catch { /* already closed */ }
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      releaseBuffer();
      disposeRewrite();
      reader.cancel(reason).catch(() => {});
    },
  });
}
