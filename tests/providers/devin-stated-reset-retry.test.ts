/**
 * Devin stated-reset replay: a 429 trailer that names its own recovery delay
 * ("Your limit will reset in 35 seconds") is waited out and the identical
 * request replayed — but only while the stream produced zero events, and only
 * within the replay/wait bounds.
 */
import { describe, expect, test } from "bun:test";
import { CloudChatError, type CloudChatEvent, type CloudChatRequest } from "../../src/adapters/devin/cloud-direct";
import { streamChatEventsWithResetRetry } from "../../src/adapters/devin/cloud-direct/stated-reset-retry";

const REQ = { apiKey: "k", apiServerUrl: "https://example.invalid", modelUid: "swe-2", messages: [] } as unknown as CloudChatRequest;

function exhausting(message: string): () => AsyncGenerator<CloudChatEvent> {
  return () => (async function* (): AsyncGenerator<CloudChatEvent> {
    throw new CloudChatError(message, "resource_exhausted", "t", 429);
  })();
}

async function* events(...items: CloudChatEvent[]): AsyncGenerator<CloudChatEvent> {
  for (const item of items) yield item;
}

async function drain(source: AsyncGenerator<CloudChatEvent>): Promise<CloudChatEvent[]> {
  const out: CloudChatEvent[] = [];
  for await (const event of source) out.push(event);
  return out;
}

describe("streamChatEventsWithResetRetry", () => {
  test("waits the stated delay and replays a zero-event 429", async () => {
    const waits: number[] = [];
    let calls = 0;
    const stream = () => {
      calls += 1;
      return calls === 1
        ? exhausting("Reached free model rate limit. Your limit will reset in 35 seconds.")()
        : events({ kind: "text", text: "ok" } as CloudChatEvent, { kind: "finish", reason: "stop" } as CloudChatEvent);
    };
    const out = await drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async (ms) => { waits.push(ms); },
    }));
    expect(calls).toBe(2);
    expect(waits).toEqual([35_000]);
    expect(out.map(e => e.kind)).toEqual(["text", "finish"]);
  });

  test("does not replay once any event was yielded", async () => {
    const stream = () => (async function* (): AsyncGenerator<CloudChatEvent> {
      yield { kind: "text", text: "partial" } as CloudChatEvent;
      throw new CloudChatError("Your limit will reset in 35 seconds", "resource_exhausted", "t", 429);
    })();
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => { throw new Error("sleep must not run"); },
    }))).rejects.toThrow("35 seconds");
  });

  test("does not replay a 429 that states no parseable delay", async () => {
    let calls = 0;
    const stream = () => {
      calls += 1;
      return exhausting("Reached free model rate limit. Upgrade to Max for higher limits.")();
    };
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => {},
    }))).rejects.toThrow("Upgrade to Max");
    expect(calls).toBe(1);
  });

  test("does not replay a non-429 CloudChatError", async () => {
    let calls = 0;
    const stream = () => {
      calls += 1;
      return (async function* (): AsyncGenerator<CloudChatEvent> {
        throw new CloudChatError("unauthenticated", "unauthenticated", "t", 401);
      })();
    };
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => {},
    }))).rejects.toThrow("unauthenticated");
    expect(calls).toBe(1);
  });

  test("stops replaying at the replay cap", async () => {
    const waits: number[] = [];
    let calls = 0;
    const stream = () => {
      calls += 1;
      return exhausting("Your limit will reset in 10 seconds")();
    };
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async (ms) => { waits.push(ms); },
      maxReplays: 2,
    }))).rejects.toThrow("reset in 10 seconds");
    expect(calls).toBe(3);
    expect(waits).toEqual([10_000, 10_000]);
  });

  test("a stated window beyond the wait ceiling surfaces instead of holding", async () => {
    let calls = 0;
    const stream = () => {
      calls += 1;
      return exhausting("Your limit will reset in 13 minutes")();
    };
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => {},
      maxWaitMs: 300_000,
    }))).rejects.toThrow("13 minutes");
    expect(calls).toBe(1);
  });

  test("a 21-minute stated window replays under the default ceiling", async () => {
    // Observed upstream windows reach ~21 minutes; the default ceiling is 30.
    const waits: number[] = [];
    let calls = 0;
    const stream = () => {
      calls += 1;
      return calls === 1
        ? exhausting("Your limit will reset in 21 minutes")()
        : events({ kind: "finish", reason: "stop" } as CloudChatEvent);
    };
    const out = await drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async (ms) => { waits.push(ms); },
    }));
    expect(calls).toBe(2);
    expect(waits).toEqual([1_260_000]);
    expect(out.map(e => e.kind)).toEqual(["finish"]);
  });

  test("the wait ceiling honors the env override", async () => {
    const prev = process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS;
    process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS = "5000";
    try {
      let calls = 0;
      const stream = () => {
        calls += 1;
        return exhausting("Your limit will reset in 35 seconds")();
      };
      await expect(drain(streamChatEventsWithResetRetry(REQ, {
        stream,
        sleep: async () => {},
      }))).rejects.toThrow("35 seconds");
      expect(calls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS;
      else process.env.OPENCODEX_DEVIN_STATED_RESET_WAIT_MS = prev;
    }
  });

  test("an abort during the wait propagates instead of replaying", async () => {
    let calls = 0;
    const stream = () => {
      calls += 1;
      return exhausting("Your limit will reset in 35 seconds")();
    };
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => { throw new DOMException("The operation was aborted", "AbortError"); },
    }))).rejects.toThrow("aborted");
    expect(calls).toBe(1);
  });

  test("a non-CloudChatError passes straight through", async () => {
    const stream = () => (async function* (): AsyncGenerator<CloudChatEvent> {
      throw new Error("socket reset");
    })();
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => {},
    }))).rejects.toThrow("socket reset");
  });
});
