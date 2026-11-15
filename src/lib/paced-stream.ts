/**
 * Pacing that travels with a stream (#8601).
 *
 * A Remote Link turn while the link WebSocket feature is on reads its upstream body only as its client drains. Each
 * relay stage between the upstream and the client normally keeps one chunk queued ahead of its reader; a stage whose
 * source is paced queues none instead and marks its own output, so the whole chain pulls on demand. Streams that were
 * never marked keep their default queue: every other request is unchanged.
 */
const paced = new WeakSet<ReadableStream<Uint8Array>>();

/** How far a reader of a paced stream may get ahead of its own reader: one chunk, never a byte allowance. */
export const PACED_READ_AHEAD_BYTES = 1;

/** Mark a stream whose reads must follow its reader's demand. */
export function markPacedStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  paced.add(stream);
  return stream;
}

/** Whether a stream was marked paced, or carries the mark of a paced source. */
export function isPacedStream(stream: ReadableStream<Uint8Array> | null | undefined): boolean {
  return stream ? paced.has(stream) : false;
}

/** The queuing strategy for a stage reading `source`: none ahead when the source is paced, the default otherwise. */
export function pacedQueuingStrategy(source: ReadableStream<Uint8Array> | null | undefined): QueuingStrategy<Uint8Array> | undefined {
  return source && paced.has(source) ? { highWaterMark: 0 } : undefined;
}

/** Carry a paced source's mark to the stage's output. */
export function carryPacedStream<T extends ReadableStream<Uint8Array>>(source: ReadableStream<Uint8Array> | null | undefined, output: T): T {
  if (source && paced.has(source)) paced.add(output);
  return output;
}
