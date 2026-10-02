import type { TranslatorBudget } from "../lib/translator-budget";
import { Buffer } from "node:buffer";

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
  let disposed = false;
  const composed: SseBlockRewrite = (block: string) => {
    let blocks: readonly string[] = [block];
    for (const rewrite of active) {
      const next: string[] = [];
      for (const current of blocks) {
        if (disposed) return [];
        next.push(...rewrite(current));
      }
      blocks = next;
    }
    return blocks;
  };
  // Child disposal is part of the contract: one idempotent disposer for the
  // whole chain, so relay teardown never leaks a nested collector.
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
  // The negative lookahead prevents backtracking from splitting one CRLF into two endings.
  const match = buffer.match(/(?:\r\n|\r(?!\n)|\n){2}/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    delimiter: match[0],
    rest: buffer.slice(match.index + match[0].length),
  };
}

/**
 * Incremental form of nextSseBlock for bounded relays. The scan cursor visits only new text and
 * consuming a block subtracts its byte length instead of recounting the remaining suffix.
 * Old/new buffer overlap still requires admission before either append or consumption commits.
 * Call compact before yielding to stop retaining an already-consumed prefix across pulls.
 */
export function createSseBlockBuffer(
  budget: TranslatorBudget,
  assertAppendSize?: (bytes: number) => void,
): {
  append(fragment: string): void;
  next(): { block: string; delimiter: string } | null;
  tail(): string;
  isEmpty(): boolean;
  compact(): void;
  clear(): void;
} {
  const scope = { kind: "live_transient" as const };
  let buffer = "";
  let offset = 0;
  let scanOffset = 0;
  let bufferBytes = 0;
  const delimiterPattern = /(?:\r\n|\r(?!\n)|\n){2}/g;

  const compact = (): void => {
    if (offset === 0) return;
    buffer = buffer.slice(offset);
    scanOffset -= offset;
    offset = 0;
  };

  return {
    append(fragment) {
      if (!fragment) return;
      let fragmentBytes = Buffer.byteLength(fragment, "utf8");
      // Decoder output never splits a surrogate pair, but keep the helper exact for string callers.
      const last = buffer.charCodeAt(buffer.length - 1);
      const first = fragment.charCodeAt(0);
      if (offset < buffer.length && last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) {
        fragmentBytes -= 2;
      }
      const nextBytes = bufferBytes + fragmentBytes;
      assertAppendSize?.(nextBytes);
      const reservation = budget.reserveTransient(nextBytes, scope);
      try {
        compact();
        buffer += fragment;
        reservation.commitRetained();
        budget.releaseRetained(bufferBytes, scope);
        bufferBytes = nextBytes;
      } catch (error) {
        reservation.release();
        throw error;
      }
    },
    next() {
      delimiterPattern.lastIndex = scanOffset;
      const match = delimiterPattern.exec(buffer);
      if (!match) {
        // A delimiter is at most four code units. Revisit only its possible split prefix.
        scanOffset = Math.max(offset, buffer.length - 3);
        return null;
      }
      const start = match.index;
      const end = start + match[0].length;
      const block = buffer.slice(offset, start);
      const delimiter = buffer.slice(start, end);
      const nextBytes = bufferBytes - Buffer.byteLength(block, "utf8") - delimiter.length;
      const reservation = budget.reserveTransient(nextBytes, scope);
      reservation.commitRetained();
      budget.releaseRetained(bufferBytes, scope);
      bufferBytes = nextBytes;
      offset = end;
      scanOffset = end;
      if (offset === buffer.length) {
        buffer = "";
        offset = 0;
        scanOffset = 0;
      }
      return { block, delimiter };
    },
    tail: () => buffer.slice(offset),
    isEmpty: () => offset === buffer.length,
    compact,
    clear() {
      budget.releaseRetained(bufferBytes, scope);
      buffer = "";
      offset = 0;
      scanOffset = 0;
      bufferBytes = 0;
    },
  };
}

/** Join all data lines from one SSE event according to the event-stream field rules. */
export function sseDataPayload(block: string): string | null {
  let result = "";
  let found = false;
  let lineStart = 0;
  const len = block.length;

  while (lineStart < len) {
    let lineEnd = lineStart;
    while (lineEnd < len && block.charCodeAt(lineEnd) !== 13 && block.charCodeAt(lineEnd) !== 10) lineEnd += 1;
    let nextStart = lineEnd;
    if (nextStart < len) {
      nextStart += block.charCodeAt(lineEnd) === 13 && block.charCodeAt(lineEnd + 1) === 10 ? 2 : 1;
    }

    const lineLen = lineEnd - lineStart;
    if (lineLen === 4 && block.startsWith("data", lineStart)) {
      if (found) {
        result += "\n";
      } else {
        found = true;
      }
    } else if (lineLen >= 5 && block.startsWith("data:", lineStart)) {
      let valueStart = lineStart + 5;
      if (valueStart < lineEnd && block.charCodeAt(valueStart) === 32) {
        valueStart += 1;
      }
      const value = block.slice(valueStart, lineEnd);
      if (found) {
        result += "\n" + value;
      } else {
        result = value;
        found = true;
      }
    }

    lineStart = nextStart;
  }

  return found ? result : null;
}

/** Shared line rules for field-mutating repairs; identity paths keep the original block. */
export function sseLineEnding(block: string): "\r\n" | "\r" | "\n" {
  return block.match(/\r\n|\r|\n/)?.[0] as "\r\n" | "\r" | "\n" ?? "\n";
}

export function splitSseBlock(block: string): { newline: string; lines: string[] } {
  return { newline: sseLineEnding(block), lines: block.split(/\r\n|\r|\n/) };
}

/** Replace an SSE event's data field while preserving non-data fields and newline style. */
export function replaceSseDataPayload(block: string, payload: string): string {
  if (sseDataPayload(block) === payload) return block;
  const { newline, lines } = splitSseBlock(block);
  const rewritten: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (line !== "data" && !line.startsWith("data:")) {
      rewritten.push(line);
      continue;
    }
    if (!replaced) {
      rewritten.push(...payload.split(/\r\n|\r|\n/).map(line => `data: ${line}`));
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
  const buffer = createSseBlockBuffer(translatorBudget);
  // Relays have several independent teardown paths; disposal is exactly once.
  let disposed = false;
  let cancelled = false;
  let pendingLineFeed = false;
  let pendingLineFeedVisible = false;
  const disposeRewrite = (): void => {
    if (disposed) return;
    disposed = true;
    try { rewrite.dispose?.(); } catch { /* teardown must not throw */ }
  };

  const enqueueText = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): void => {
    const bytes = Buffer.byteLength(text, "utf8");
    const reservation = translatorBudget.reserveTransient(bytes, { kind: "live_transient" });
    try {
      const encoded = encoder.encode(text);
      controller.enqueue(encoded);
      reservation.commitRetained();
      translatorBudget.releaseRetained(bytes, { kind: "live_transient" });
    } catch (error) {
      reservation.release();
      throw error;
    }
  };

  const emitProcessedBlocks = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    flushFinal = false,
  ): number => {
    let emitted = 0;
    let next: { block: string; delimiter: string } | null;
    while (!cancelled && (next = buffer.next())) {
      const { block, delimiter } = next;
      // A CR followed by buffered text is already settled; only an end-of-buffer CR
      // can still receive the LF that extends its delimiter in the next fragment.
      pendingLineFeed = delimiter.endsWith("\r") && buffer.isEmpty();
      const outBlocks = rewrite(block);
      pendingLineFeedVisible = outBlocks.length > 0;
      if (cancelled) return emitted;
      for (let index = 0; index < outBlocks.length; index++) {
        // Synthetic earlier blocks need a settled delimiter; only the final one can
        // inherit an upstream LF in a later chunk. Completing CR as CRLF is equivalent.
        const settled = index < outBlocks.length - 1 && delimiter.endsWith("\r") ? delimiter + "\n" : delimiter;
        enqueueText(controller, outBlocks[index]! + settled);
        emitted += 1;
      }
    }
    buffer.compact();
    const tail = flushFinal ? buffer.tail() : "";
    if (tail.length > 0) {
      const tailBlocks = rewrite(tail);
      if (cancelled) return emitted;
      // A trailing fragment has no delimiter of its own; multiple emitted
      // blocks must still be framed as separate events (#893 review).
      const tailDelimiter = tail.includes("\r\n") ? "\r\n\r\n" : "\n\n";
      for (let i = 0; i < tailBlocks.length; i++) {
        enqueueText(controller, tailBlocks[i]! + (i < tailBlocks.length - 1 ? tailDelimiter : ""));
        emitted += 1;
      }
      buffer.clear();
    }
    return emitted;
  };

  const appendFragment = (controller: ReadableStreamDefaultController<Uint8Array>, fragment: string): number => {
    let continuation = false;
    if (pendingLineFeed && fragment.length > 0) {
      continuation = fragment.startsWith("\n");
      pendingLineFeed = false;
      if (continuation) fragment = fragment.slice(1);
    }
    // Consume a late LF before scanning, so it cannot pair with a new LF to create
    // a phantom empty callback. Any following line ending stays in the input buffer.
    buffer.append(fragment);
    if (continuation && pendingLineFeedVisible) {
      enqueueText(controller, "\n");
      return 1;
    }
    return 0;
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
            appendFragment(controller, decoder.decode());
            emitProcessedBlocks(controller, true);
            if (cancelled) return;
            buffer.clear();
            disposeRewrite();
            controller.close();
            return;
          }
          const continuation = appendFragment(controller, decoder.decode(value, { stream: true }));
          const emitted = continuation + emitProcessedBlocks(controller);
          if (cancelled || emitted > 0) return;
        }
      } catch (error) {
        buffer.clear();
        disposeRewrite();
        // Cancelling one tee branch waits for its sibling. Surface the failure
        // now so downstream can abort upstream and release the inspection branch.
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      buffer.clear();
      disposeRewrite();
      reader.cancel(reason).catch(() => {});
    },
  });
}
