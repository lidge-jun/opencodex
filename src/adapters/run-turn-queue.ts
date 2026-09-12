import type { AdapterEvent } from "../types";

type QueueReader = (result: IteratorResult<AdapterEvent>) => void;

export const PREFLIGHT_HEARTBEAT_RETAIN_LIMIT = 16;

/**
 * Coalescing threshold for adjacent text/thinking deltas buffered with no
 * waiting reader (UTF-16 code units). This is a merge-size ceiling, not a
 * byte-memory cap: a single oversized incoming event stays one item.
 */
export const COALESCE_MAX_CHUNK_LENGTH = 64 * 1024;

export interface AdapterEventQueue {
  /**
   * Returns true when the event was merged into the buffered tail instead of
   * becoming its own retained item. A caller that charges a memory budget for
   * what the queue holds needs that distinction: a merged delta costs only its
   * appended payload, while a new item costs a whole serialized event.
   */
  push(event: AdapterEvent): boolean;
  close(): void;
  stream(): AsyncIterable<AdapterEvent>;
  collect(): Promise<AdapterEvent[]>;
}

export interface AdapterEventPreflight {
  stream: AsyncIterable<AdapterEvent>;
  error?: Extract<AdapterEvent, { type: "error" }>;
  empty: boolean;
}

async function* replay(
  buffered: readonly AdapterEvent[],
  iterator: AsyncIterator<AdapterEvent>,
): AsyncGenerator<AdapterEvent> {
  try {
    for (const event of buffered) yield event;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

export async function preflightAdapterEvents(
  source: AsyncIterable<AdapterEvent>,
): Promise<AdapterEventPreflight> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: AdapterEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { stream: replay(buffered, iterator), empty: true };
    if (next.value.type === "heartbeat") {
      buffered.push(next.value);
      if (buffered.length > PREFLIGHT_HEARTBEAT_RETAIN_LIMIT) buffered.shift();
      continue;
    }
    buffered.push(next.value);
    if (next.value.type === "error") {
      await iterator.return?.();
      return { stream: replay(buffered, iterator), error: next.value, empty: false };
    }
    return { stream: replay(buffered, iterator), empty: false };
  }
}

export function createAdapterEventQueue(opts?: {
  maxBacklog?: number;
  onBacklogExceeded?: () => void;
}): AdapterEventQueue {
  const queued: AdapterEvent[] = [];
  const readers: QueueReader[] = [];
  const maxBacklog = opts?.maxBacklog ?? 1_024;
  let closed = false;

  // Merge an incoming delta into the buffered tail when no reader is waiting.
  // The backlog cap counts events, not tokens, so a detached or briefly
  // stalled consumer (e.g. a Codex app mid-reconnect whose disconnect Bun has
  // not yet delivered) used to hit the cap within seconds of token-granular
  // streaming and abort a healthy turn. Adjacent same-phase text deltas,
  // adjacent thinking deltas, and consecutive heartbeats carry no ordering
  // information between themselves, so merging them preserves every consumer
  // contract while making the cap approximate buffered items again.
  // Pushed objects may be retained by adapters, so the tail is REPLACED with
  // a fresh object — never mutated (alias safety).
  const coalesceIntoTail = (event: AdapterEvent): boolean => {
    const tail = queued[queued.length - 1];
    if (!tail) return false;
    if (event.type === "heartbeat") return tail.type === "heartbeat";
    if (event.type === "text_delta" && tail.type === "text_delta" && tail.phase === event.phase) {
      if (tail.text.length + event.text.length > COALESCE_MAX_CHUNK_LENGTH) return false;
      queued[queued.length - 1] = { type: "text_delta", text: tail.text + event.text, phase: tail.phase };
      return true;
    }
    if (event.type === "thinking_delta" && tail.type === "thinking_delta") {
      if (tail.thinking.length + event.thinking.length > COALESCE_MAX_CHUNK_LENGTH) return false;
      queued[queued.length - 1] = { type: "thinking_delta", thinking: tail.thinking + event.thinking };
      return true;
    }
    return false;
  };

  const push = (event: AdapterEvent): boolean => {
    if (closed) return false;
    const reader = readers.shift();
    if (reader) {
      reader({ done: false, value: event });
      return false;
    }
    if (coalesceIntoTail(event)) return true;
    if (queued.length >= maxBacklog) {
      opts?.onBacklogExceeded?.();
      queued.push({ type: "error", message: "consumer stalled: adapter event backlog exceeded — turn aborted" });
      close();
      return false;
    }
    queued.push(event);
    return false;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    while (readers.length > 0) {
      readers.shift()?.({ done: true, value: undefined as never });
    }
  };

  async function* stream(): AsyncIterable<AdapterEvent> {
    while (true) {
      const next = queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (closed) return;
      const result = await new Promise<IteratorResult<AdapterEvent>>(resolve => {
        readers.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }

  const collect = async (): Promise<AdapterEvent[]> => {
    const events: AdapterEvent[] = [];
    for await (const event of stream()) events.push(event);
    return events;
  };

  return { push, close, stream, collect };
}
