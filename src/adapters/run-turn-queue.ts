import type { AdapterEvent } from "../types";

type QueueReader = (result: IteratorResult<AdapterEvent>) => void;

export interface AdapterEventQueue {
  push(event: AdapterEvent): void;
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
    buffered.push(next.value);
    if (next.value.type === "heartbeat") continue;
    if (next.value.type === "error") {
      await iterator.return?.();
      return { stream: replay(buffered, iterator), error: next.value, empty: false };
    }
    return { stream: replay(buffered, iterator), empty: false };
  }
}

export function createAdapterEventQueue(): AdapterEventQueue {
  const queued: AdapterEvent[] = [];
  const readers: QueueReader[] = [];
  let closed = false;

  const push = (event: AdapterEvent): void => {
    if (closed) return;
    const reader = readers.shift();
    if (reader) {
      reader({ done: false, value: event });
      return;
    }
    queued.push(event);
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
