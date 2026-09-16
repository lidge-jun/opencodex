/** Read-ahead allowance, not a lifetime limit on SSE inspection or delivery. */
export const MAX_INSPECTION_READ_AHEAD_BYTES = 32 * 1024 * 1024;

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
  const limit = options.maxReadAheadBytes ?? MAX_INSPECTION_READ_AHEAD_BYTES;
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
  return [wrap(client, true), wrap(inspection, false)];
}
