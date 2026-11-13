import { carryPacedStream, isPacedStream, PACED_READ_AHEAD_BYTES } from "../lib/paced-stream";

/** Read-ahead allowance, not a lifetime limit on SSE inspection or delivery. */
export const MAX_INSPECTION_READ_AHEAD_BYTES = 32 * 1024 * 1024;

/**
 * Relay a body in slices of at most `maxChunkBytes`, reading the source only when the last slice was taken.
 *
 * Every relay stage with a queue of one chunk then holds one slice instead of one source chunk, and the slices are
 * views of the chunk the source handed over, never copies. Bytes, order and errors pass through unchanged; a cancel
 * reaches the source.
 */
export function sliceChunks(source: ReadableStream<Uint8Array>, maxChunkBytes: number): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) throw new RangeError("Slice size must be a positive safe integer");
  const reader = source.getReader();
  let pending: Uint8Array | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (pending === undefined) {
          const next = await reader.read();
          if (next.done) { controller.close(); return; }
          if (next.value.byteLength > 0) pending = next.value;
        }
        const slice = pending.subarray(0, maxChunkBytes);
        pending = pending.byteLength > maxChunkBytes ? pending.subarray(maxChunkBytes) : undefined;
        controller.enqueue(slice);
      } catch (error) {
        pending = undefined;
        controller.error(error);
      }
    },
    cancel(reason) {
      pending = undefined;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}

export interface InspectionTeeOptions {
  /** Release pacing so the inspection owner's existing bounded drain can run. */
  clientGoneSignal?: AbortSignal;
  /** Internal test seam; callers must not take this value from upstream data. */
  maxReadAheadBytes?: number;
}

/**
 * Keep native tee cancellation semantics while pacing the inspection branch.
 *
 * Inspection may lead raw client consumption by the allowance plus one source
 * chunk (and native tee prefetch). It never stops merely because the whole turn
 * crossed that size: terminal, usage and continuation observers retain ownership.
 * Count raw client bytes BEFORE rewrites, which may shrink, drop or expand them.
 * Push sources still need their own producer-side bound; this is not an RSS cap.
 */
export function teeWithBoundedInspection(
  source: ReadableStream<Uint8Array>,
  options: InspectionTeeOptions = {},
): [ReadableStream<Uint8Array>, ReadableStream<Uint8Array>] {
  // A paced source (#8601) lets inspection lead its client by one chunk instead of the allowance.
  const limit = options.maxReadAheadBytes ?? (isPacedStream(source) ? PACED_READ_AHEAD_BYTES : MAX_INSPECTION_READ_AHEAD_BYTES);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Inspection read-ahead limit must be a positive safe integer");
  }
  const [client, inspection] = source.tee();
  let leadBytes = 0;
  let pacingReleased = false;
  let credit: Promise<void> | undefined;
  let wake: (() => void) | undefined;

  const wakeReader = () => {
    const resolve = wake;
    wake = undefined;
    credit = undefined;
    resolve?.();
  };
  const releasePacing = () => {
    pacingReleased = true;
    wakeReader();
  };
  const signal = options.clientGoneSignal;
  if (signal?.aborted) releasePacing();
  else signal?.addEventListener("abort", releasePacing, { once: true });

  const wrap = (
    body: ReadableStream<Uint8Array>,
    isClient: boolean,
  ): ReadableStream<Uint8Array> => {
    const reader = body.getReader();
    let ended = false;
    // An upstream error must wake an inspector waiting for credit, not remain
    // hidden until the client happens to issue another read. One observer per
    // reader, not a permanent Promise.race reaction attached on every chunk.
    void reader.closed.catch(releasePacing);
    const releaseLock = () => {
      try { reader.releaseLock(); } catch { /* a pending read owns the lock */ }
    };
    const finish = () => {
      ended = true;
      releasePacing();
      if (!isClient) signal?.removeEventListener("abort", releasePacing);
    };
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) return;
        if (!isClient && !pacingReleased && leadBytes >= limit) {
          credit ??= new Promise<void>(resolve => { wake = resolve; });
          await credit;
          if (ended) return;
        }
        try {
          const result = await reader.read();
          if (ended) return;
          if (result.done) {
            finish();
            releaseLock();
            controller.close();
            return;
          }
          if (isClient) {
            leadBytes -= result.value.byteLength;
            if (leadBytes < limit) wakeReader();
          } else {
            leadBytes += result.value.byteLength;
          }
          controller.enqueue(result.value);
        } catch (error) {
          if (ended) return;
          finish();
          releaseLock();
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        // Awaiting one tee branch's cancellation waits for the sibling. The
        // owner must be free to finish cleanup and cancel/read that sibling.
        void reader.cancel(reason).catch(() => undefined);
        releaseLock();
      },
    }, { highWaterMark: 0 });
  };
  return [carryPacedStream(source, wrap(client, true)), wrap(inspection, false)];
}
