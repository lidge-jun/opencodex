import type { AdapterEvent } from "../types";

type QueueReader = (result: IteratorResult<AdapterEvent>) => void;

export const PREFLIGHT_HEARTBEAT_RETAIN_LIMIT = 16;

/**
 * Coalescing threshold for adjacent text/thinking deltas buffered with no
 * waiting reader (UTF-16 code units). This is a merge-size ceiling; the two
 * retention budgets below are what bound memory.
 */
export const COALESCE_MAX_CHUNK_LENGTH = 64 * 1024;

/**
 * Retained-string budget for the WHOLE queue, in UTF-16 code units.
 *
 * This bounds what the queue is holding at one moment, not how much a turn
 * streams: every dequeue gives its charge back, so a long healthy stream with a
 * consumer attached never accumulates and is never capped by total length.
 *
 * 32 MiB is deliberately far above any single legitimate burst. A synchronous
 * producer can legally fill the queue before its consumer is scheduled — the
 * image loop does exactly that with over a million one-character deltas, which
 * coalesce into roughly 1.2 MB of retained text — so a budget near that size
 * aborts healthy turns rather than stalled ones. The previous effective bound
 * was the 1024-event cap times the 64 KiB merge ceiling, so 64 MiB; this halves
 * it while leaving that legitimate burst an order of magnitude of headroom.
 */
export const DEFAULT_MAX_BACKLOG_CODE_UNITS = 32 * 1024 * 1024;

/**
 * Retained-string budget for ONE queued event, in UTF-16 code units.
 *
 * Separate from the aggregate on purpose, because the two describe different
 * failures. Passing the aggregate means the consumer is not keeping up. Passing
 * this one means a single event is malformed or unbounded, which stays true
 * however empty the queue is, so it must be refused even with the whole
 * aggregate free. They also report different terminal messages, so an operator
 * reading the turn's error learns which happened.
 *
 * Like the aggregate, this governs what the queue RETAINS. An event handed
 * straight to a waiting consumer is never held here, so neither budget applies
 * to it: refusing it would abort a turn over memory this queue does not own,
 * and the consumer's own per-event bound governs that payload instead.
 */
export const DEFAULT_MAX_EVENT_CODE_UNITS = 8 * 1024 * 1024;

const BACKLOG_EXCEEDED_MESSAGE = "consumer stalled: adapter event backlog exceeded — turn aborted";
const EVENT_TOO_LARGE_MESSAGE = "adapter event exceeds the single-event retained-string budget — turn aborted";

/**
 * Bound on how far the retention measure walks into one event. AdapterEvent is
 * a plain-data union, but two of its members carry open provider-shaped bags
 * (`providerState`, `usage.rawUsage`) whose depth no type here controls. The
 * ceilings keep a single push O(1)-ish rather than O(whatever an adapter
 * attached), and under-counting a pathological object is the safe direction:
 * the event-count cap still bounds how many of them can be retained.
 */
const RETENTION_MAX_DEPTH = 8;
const RETENTION_MAX_NODES = 4096;

/**
 * Retained UTF-16 code units carried by one event's string payload.
 *
 * Measured by walking own enumerable properties rather than by naming each
 * variant's string fields: a hand-written per-variant table is exhaustive over
 * a union, so adding an event type on one branch while a consumer lands on
 * another produces a measure that silently stops counting the new payload.
 * The walk is the derived answer and needs no update when the union grows.
 *
 * `type` is skipped because it is the discriminant, identical for every event
 * of a kind and not payload anyone is buffering.
 */
export function retainedEventCodeUnits(event: AdapterEvent): number {
  // Defensive: this measures values an adapter produced. A malformed emission
  // has to become a terminal event, not a TypeError thrown out of push() with
  // the queue half-updated.
  if (!event || typeof event !== "object") return 0;
  let total = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      total += value.length;
      return;
    }
    if (!value || typeof value !== "object" || depth >= RETENTION_MAX_DEPTH || seen.has(value)) return;
    seen.add(value);
    for (const nested of Object.values(value)) {
      if (nodes++ >= RETENTION_MAX_NODES) return;
      visit(nested, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue;
    if (nodes++ >= RETENTION_MAX_NODES) break;
    visit(value, 1);
  }
  return total;
}

function positiveBudget(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
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
  /**
   * Retained string payload the queue is currently holding, in UTF-16 code
   * units. Exposed so a caller — and a regression — can assert the counter
   * returns to zero on every terminal path instead of inferring it from an
   * abort that happened to fire.
   */
  retainedCodeUnits(): number;
}

export interface AdapterEventPreflight {
  stream: AsyncIterable<AdapterEvent>;
  error?: Extract<AdapterEvent, { type: "error" }>;
  empty: boolean;
  replayUnsafe: boolean;
  timedOut?: boolean;
}

async function* replay(
  buffered: readonly AdapterEvent[],
  iterator: AsyncIterator<AdapterEvent>,
  pendingNext?: Promise<IteratorResult<AdapterEvent>>,
): AsyncGenerator<AdapterEvent> {
  try {
    for (const event of buffered) yield event;
    if (pendingNext) {
      const next = await pendingNext;
      if (next.done) return;
      yield next.value;
    }
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
  classifyFirstEvent?: (event: AdapterEvent) => Extract<AdapterEvent, { type: "error" }> | undefined,
  options?: { maxWaitMs?: number },
): Promise<AdapterEventPreflight> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: AdapterEvent[] = [];
  let replayUnsafe = false;
  const maxWaitMs = options?.maxWaitMs;
  if (maxWaitMs !== undefined && maxWaitMs <= 0) {
    return { stream: replay(buffered, iterator), empty: false, replayUnsafe, timedOut: true };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutPromise: Promise<"timeout"> | undefined;
  if (maxWaitMs !== undefined) {
    timeoutPromise = new Promise(resolve => {
      timeout = setTimeout(() => resolve("timeout"), maxWaitMs);
    });
  }
  try {
    while (true) {
      const pendingNext = iterator.next();
      const raced = timeoutPromise ? await Promise.race([pendingNext, timeoutPromise]) : await pendingNext;
      if (raced === "timeout") {
        return {
          stream: replay(buffered, iterator, pendingNext),
          empty: false,
          replayUnsafe,
          timedOut: true,
        };
      }
      const next = raced;
      if (next.done) return { stream: replay(buffered, iterator), empty: true, replayUnsafe };
      if (next.value.type === "heartbeat") {
        replayUnsafe ||= next.value.replayUnsafe === true;
        // Preserve the latch in replay even after the original unsafe heartbeat is evicted.
        buffered.push(replayUnsafe ? { ...next.value, replayUnsafe: true } : next.value);
        if (buffered.length > PREFLIGHT_HEARTBEAT_RETAIN_LIMIT) buffered.shift();
        continue;
      }
      const classifiedError = replayUnsafe ? undefined : classifyFirstEvent?.(next.value);
      if (classifiedError) {
        buffered.push(classifiedError);
        await iterator.return?.();
        return { stream: replay(buffered, iterator), error: classifiedError, empty: false, replayUnsafe };
      }
      buffered.push(next.value);
      if (next.value.type === "error") {
        await iterator.return?.();
        return { stream: replay(buffered, iterator), error: next.value, empty: false, replayUnsafe };
      }
      return { stream: replay(buffered, iterator), empty: false, replayUnsafe };
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function createAdapterEventQueue(opts?: {
  maxBacklog?: number;
  maxBacklogCodeUnits?: number;
  maxEventCodeUnits?: number;
  onBacklogExceeded?: () => void;
}): AdapterEventQueue {
  const queued: AdapterEvent[] = [];
  /**
   * What each queued item was charged, in lockstep with `queued`. Releasing the
   * recorded charge rather than re-measuring is what makes the accounting exact
   * on every path: a merge, a terminal record admitted past the budget and a
   * plain event all give back precisely what they took, so the counter cannot
   * drift positive (a leak) or negative (a budget the next turn gets for free).
   */
  const charged: number[] = [];
  const readers: QueueReader[] = [];
  const maxBacklog = opts?.maxBacklog ?? 1_024;
  const maxBacklogCodeUnits = positiveBudget(opts?.maxBacklogCodeUnits, DEFAULT_MAX_BACKLOG_CODE_UNITS, "maxBacklogCodeUnits");
  const maxEventCodeUnits = positiveBudget(opts?.maxEventCodeUnits, DEFAULT_MAX_EVENT_CODE_UNITS, "maxEventCodeUnits");
  let retained = 0;
  let closed = false;

  // Merge an incoming delta into the buffered tail when no reader is waiting.
  // The event cap counts events, not tokens, so a detached or briefly stalled
  // consumer (e.g. a Codex app mid-reconnect whose disconnect Bun has not yet
  // delivered) used to hit it within seconds of token-granular streaming and
  // abort a healthy turn. Adjacent same-phase text deltas, adjacent thinking
  // deltas, and consecutive heartbeats carry no ordering information between
  // themselves, so merging them preserves every consumer contract while making
  // the cap approximate buffered items again.
  // Pushed objects may be retained by adapters, so the tail is REPLACED with
  // a fresh object — never mutated (alias safety). Returning the replacement
  // instead of installing it lets push price the merge before committing to it.
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

  /**
   * Record why the turn is ending and close. The terminal error is admitted
   * past both budgets — refusing to retain the explanation of a refusal would
   * leave the consumer with a silent truncation — but it is charged like any
   * other item so the counter stays exact through the final drain.
   */
  const abortWith = (message: string): false => {
    opts?.onBacklogExceeded?.();
    const terminal: AdapterEvent = { type: "error", message };
    const cost = retainedEventCodeUnits(terminal);
    queued.push(terminal);
    charged.push(cost);
    retained += cost;
    close();
    return false;
  };

  const push = (event: AdapterEvent): boolean => {
    if (closed) return false;
    const reader = readers.shift();
    if (reader) {
      // Handed straight to a waiting consumer, so the queue retains nothing and
      // charges nothing. Neither budget applies to an event it never holds.
      reader({ done: false, value: event });
      return false;
    }
    const tail = queued[queued.length - 1];
    const merged = tail ? planTailMerge(tail, event) : null;
    if (merged && tail) {
      const replacement = retainedEventCodeUnits(merged);
      if (replacement > maxEventCodeUnits) return abortWith(EVENT_TOO_LARGE_MESSAGE);
      // Charge only what the backlog actually gains. A merge keeps the tail's
      // own fields, so the incoming event's duplicated phase is never retained
      // twice and an unchanged tail costs nothing at all.
      const delta = replacement - charged[charged.length - 1]!;
      if (delta > maxBacklogCodeUnits - retained) return abortWith(BACKLOG_EXCEEDED_MESSAGE);
      queued[queued.length - 1] = merged;
      charged[charged.length - 1] = replacement;
      retained += delta;
      return true;
    }
    const cost = retainedEventCodeUnits(event);
    if (cost > maxEventCodeUnits) return abortWith(EVENT_TOO_LARGE_MESSAGE);
    // Both refusals are priced before anything is retained, so an event that is
    // turned away is never charged for.
    if (queued.length >= maxBacklog) return abortWith(BACKLOG_EXCEEDED_MESSAGE);
    if (cost > maxBacklogCodeUnits - retained) return abortWith(BACKLOG_EXCEEDED_MESSAGE);
    queued.push(event);
    charged.push(cost);
    retained += cost;
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
        retained -= charged.shift() ?? 0;
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

  return { push, close, stream, collect, retainedCodeUnits: () => retained };
}
