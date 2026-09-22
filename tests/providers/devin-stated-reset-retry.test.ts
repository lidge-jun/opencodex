/**
 * Devin stated-reset replay: a 429 trailer that names its own recovery delay
 * ("Your limit will reset in 35 seconds") is waited out and the identical
 * request replayed — but only while the stream produced zero events, and only
 * within the replay/wait bounds.
 */
import { describe, expect, test } from "bun:test";
import { CloudChatError, type CloudChatEvent, type CloudChatRequest } from "../../src/adapters/devin/cloud-direct";
import { clearCachedCatalog } from "../../src/adapters/devin/cloud-direct/catalog";
import { streamChatEventsWithResetRetry } from "../../src/adapters/devin/cloud-direct/stated-reset-retry";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";

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

function eosEnvelope(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload));
  const envelope = Buffer.alloc(5 + body.length);
  envelope[0] = 0x02;
  envelope.writeUInt32BE(body.length, 1);
  body.copy(envelope, 5);
  return envelope;
}

describe("streamChatEventsWithResetRetry", () => {
  test("admits and reports every inference POST through one shared budget", async () => {
    let spendReservations = 0;
    let spendRefunds = 0;
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 3, baseSendAllowance: 3, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, "devin-reset-accounting", {
      charge: () => { spendReservations += 1; return true; },
      refund: () => { spendRefunds += 1; },
    });
    const sends: number[] = [];
    const usedDuringWait: number[] = [];
    const observed: Array<{ ordinal: number; recovery?: string }> = [];
    let attempts = 0;
    const stream = (req: CloudChatRequest) => (async function* (): AsyncGenerator<CloudChatEvent> {
      attempts += 1;
      await req.executor!("https://example.invalid/GetChatMessage");
      if (attempts < 3) throw new CloudChatError("reset in 1 second", "resource_exhausted", "t", 429);
      yield { kind: "finish", reason: "stop" } as CloudChatEvent;
    })();

    await drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => { usedDuringWait.push(budget.used); },
      execution: {
        executor: (async () => { sends.push(sends.length + 1); return new Response(); }) as typeof fetch,
        sendBudget: budget,
        onPhysicalSend: send => { observed.push(send); },
      },
    }));

    expect(sends).toEqual([1, 2, 3]);
    expect(budget.used).toBe(3);
    expect(usedDuringWait).toEqual([1, 2]);
    expect(spendReservations).toBe(3);
    expect(spendRefunds).toBe(0);
    expect(observed).toEqual([
      { ordinal: 1 },
      { ordinal: 2, recovery: "rate-limit-429" },
      { ordinal: 3, recovery: "rate-limit-429" },
    ]);
  });

  test("a refused replay performs no inference I/O and preserves the provider 429", async () => {
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, "devin-reset-refusal");
    const refusal = new CloudChatError("Your limit will reset in 1 second", "resource_exhausted", "trace", 429);
    const withheld: string[] = [];
    let inferenceSends = 0;
    const stream = (req: CloudChatRequest) => (async function* (): AsyncGenerator<CloudChatEvent> {
      await req.executor!("https://example.invalid/GetChatMessage");
      throw refusal;
    })();

    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => {},
      execution: {
        executor: (async () => { inferenceSends += 1; return new Response(); }) as typeof fetch,
        sendBudget: budget,
        onRecoveryWithheld: event => { withheld.push(event.reason); },
      },
    }))).rejects.toBe(refusal);

    expect(inferenceSends).toBe(1);
    expect(budget.used).toBe(1);
    expect(withheld).toEqual(["retry-send-budget"]);
  });

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

  test("a zero wait allowance surfaces a stated reset without sleeping", async () => {
    let calls = 0;
    const stream = () => {
      calls += 1;
      return exhausting("Your limit will reset in 21 minutes")();
    };
    await expect(drain(streamChatEventsWithResetRetry(REQ, {
      stream,
      sleep: async () => { throw new Error("sleep must not run"); },
      maxWaitMs: 0,
    }))).rejects.toThrow("21 minutes");
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

  test("the stated delay survives the real content-free trailer error", async () => {
    // The thrown trailer error no longer carries upstream text, so a fabricated
    // CloudChatError cannot prove the contract: this drives the real stream
    // through a Connect EOS trailer and expects the typed retryAfterSeconds the
    // parser preserved to schedule the replay.
    const credential = "devin-session-token$header.payload.signature";
    const chatEnvelopes = [
      eosEnvelope({
        error: {
          code: "resource_exhausted",
          message: `Your limit will reset in 35 seconds. ${credential}`,
        },
      }),
      eosEnvelope({}),
    ];
    let chatCalls = 0;
    const originalFetch = globalThis.fetch;
    clearCachedCatalog();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Everything except the chat POST fails: the catalog pre-flight mints a
      // user_jwt first, so gating on GetChatMessage keeps auxiliary RPCs from
      // consuming a chat envelope.
      if (!url.includes("GetChatMessage")) {
        return new Response("catalog unavailable", { status: 503 });
      }
      const envelope = chatEnvelopes[Math.min(chatCalls, chatEnvelopes.length - 1)];
      chatCalls += 1;
      return new Response(envelope, { status: 200 });
    }) as typeof fetch;
    const waits: number[] = [];
    try {
      const out = await drain(streamChatEventsWithResetRetry(
        { apiKey: "k", modelUid: "swe-2", messages: [] } as unknown as CloudChatRequest,
        { sleep: async (ms) => { waits.push(ms); } },
      ));
      expect(chatCalls).toBe(2);
      expect(waits).toEqual([35_000]);
      expect(out).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      clearCachedCatalog();
    }
  });

  test("a stated window beyond the ceiling still reports the wait outward", async () => {
    // When the stated delay exceeds the local cap the original trailer error
    // propagates. Its message must carry the seconds in our own words so the
    // client can tell how long to wait — without the raw trailer text, which
    // can reflect the request credential.
    const credential = "devin-session-token$header.payload.signature";
    const chatEnvelopes = [
      eosEnvelope({
        error: {
          code: "resource_exhausted",
          message: `Your limit will reset in 35 seconds. ${credential}`,
        },
      }),
    ];
    let chatCalls = 0;
    const originalFetch = globalThis.fetch;
    clearCachedCatalog();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("GetChatMessage")) {
        return new Response("catalog unavailable", { status: 503 });
      }
      const envelope = chatEnvelopes[Math.min(chatCalls, chatEnvelopes.length - 1)];
      chatCalls += 1;
      return new Response(envelope, { status: 200 });
    }) as typeof fetch;
    try {
      let caught: unknown;
      try {
        await drain(streamChatEventsWithResetRetry(
          { apiKey: "k", modelUid: "swe-2", messages: [] } as unknown as CloudChatRequest,
          { sleep: async () => {}, maxWaitMs: 10_000 },
        ));
      } catch (error) {
        caught = error;
      }
      expect(chatCalls).toBe(1);
      expect(caught).toBeInstanceOf(CloudChatError);
      const message = (caught as Error).message;
      expect(message).toContain("retry after ~35s");
      expect(message).not.toContain(credential);
      expect(message).not.toContain("Your limit will reset");
    } finally {
      globalThis.fetch = originalFetch;
      clearCachedCatalog();
    }
  });
});
