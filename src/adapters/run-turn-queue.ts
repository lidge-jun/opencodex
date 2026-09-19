import type { AdapterEvent } from "../types";

type QueueReader = (result: IteratorResult<AdapterEvent>) => void;

export const PREFLIGHT_HEARTBEAT_RETAIN_LIMIT = 16;

/**
 * Coalescing threshold for adjacent text/thinking deltas buffered with no
 * waiting reader (UTF-16 code units). The aggregate backlog budget below is
 * enforced separately, including for a single oversized incoming event.
 */
export const COALESCE_MAX_CHUNK_LENGTH = 64 * 1024;
/** Maximum retained string payload across one queue, measured as UTF-16 code units. */
export const DEFAULT_MAX_BACKLOG_CODE_UNITS = 1024 * 1024;

function retainedStringCodeUnits(value: unknown, seen = new Set<object>()): number {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  let total = 0;
  for (const nested of Object.values(value)) total += retainedStringCodeUnits(nested, seen);
  return total;
}

function retainedEventStringCodeUnits(event: AdapterEvent): number {
  let total = 0;
  for (const [key, value] of Object.entries(event)) {
    if (key !== "type") total += retainedStringCodeUnits(value);
  }
  return total;
}

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
  replayUnsafe: boolean;
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
  let replayUnsafe = false;
  while (true) {
    const next = await iterator.next();
    if (next.done) return { stream: replay(buffered, iterator), empty: true, replayUnsafe };
    if (next.value.type === "heartbeat") {
      replayUnsafe ||= next.value.replayUnsafe === true;
      buffered.push(next.value);
      if (buffered.length > PREFLIGHT_HEARTBEAT_RETAIN_LIMIT) buffered.shift();
      continue;
    }
    buffered.push(next.value);
    if (next.value.type === "error") {
      await iterator.return?.();
      return { stream: replay(buffered, iterator), error: next.value, empty: false, replayUnsafe };
    }
    return { stream: replay(buffered, iterator), empty: false, replayUnsafe };
  }
}

export function createAdapterEventQueue(opts?: {
  maxBacklog?: number;
  maxBacklogCodeUnits?: number;
  onBacklogExceeded?: () => void;
}): AdapterEventQueue {
  const queued: AdapterEvent[] = [];
  const readers: QueueReader[] = [];
  const maxBacklog = opts?.maxBacklog ?? 1_024;
  const maxBacklogCodeUnits = opts?.maxBacklogCodeUnits ?? DEFAULT_MAX_BACKLOG_CODE_UNITS;
  if (!Number.isSafeInteger(maxBacklogCodeUnits) || maxBacklogCodeUnits <= 0) {
    throw new RangeError("maxBacklogCodeUnits must be a positive safe integer");
  }
  let backlogCodeUnits = 0;
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
  // Returns the replacement tail without mutating the queue, or null when the
  // event must be queued as its own item.
  const planTailMerge = (tail: AdapterEvent, event: AdapterEvent): AdapterEvent | null => {
    if (event.type === "heartbeat") {
      if (tail.type !== "heartbeat") return null;
      // Heartbeats carry no ordering between themselves, but the replay-unsafe
      // marker is not ordering — it is a latch. Dropping the incoming event
      // would discard the only record that Cursor already performed a local
      // side effect, and preflight would then permit an OAuth replay of it.
      if (event.replayUnsafe === true && tail.replayUnsafe !== true) {
        return { type: "heartbeat", replayUnsafe: true };
      }
      return tail;
    }
    if (event.type === "text_delta" && tail.type === "text_delta" && tail.phase === event.phase) {
      if (tail.text.length + event.text.length > COALESCE_MAX_CHUNK_LENGTH) return null;
      return { type: "text_delta", text: tail.text + event.text, phase: tail.phase };
    }
    if (event.type === "thinking_delta" && tail.type === "thinking_delta") {
      if (tail.thinking.length + event.thinking.length > COALESCE_MAX_CHUNK_LENGTH) return null;
      return { type: "thinking_delta", thinking: tail.thinking + event.thinking };
    }
    return null;
  };

  const push = (event: AdapterEvent): boolean => {
    if (closed) return false;
    const reader = readers.shift();
    if (reader) {
      reader({ done: false, value: event });
      return false;
    }
    const tail = queued[queued.length - 1];
    const mergedTail = tail ? planTailMerge(tail, event) : null;
    // Charge what the retained backlog actually gains. A merge keeps the
    // tail's own fields — e.g. one phase for same-phase text deltas — so the
    // incoming event's duplicated strings are never retained; only the delta
    // between the replacement tail and the current tail is charged.
    const eventCodeUnits = mergedTail && tail
      ? retainedEventStringCodeUnits(mergedTail) - retainedEventStringCodeUnits(tail)
      : retainedEventStringCodeUnits(event);
    if (eventCodeUnits > maxBacklogCodeUnits - backlogCodeUnits) {
      opts?.onBacklogExceeded?.();
      queued.push({ type: "error", message: "consumer stalled: adapter event backlog exceeded — turn aborted" });
      close();
      return false;
    }
    backlogCodeUnits += eventCodeUnits;
    if (mergedTail) {
      queued[queued.length - 1] = mergedTail;
      return true;
    }
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
        backlogCodeUnits -= retainedEventStringCodeUnits(next);
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
