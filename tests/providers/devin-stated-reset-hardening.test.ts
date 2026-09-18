import { describe, expect, test } from "bun:test";
import { CloudChatError, type CloudChatEvent, type CloudChatRequest } from "../../src/adapters/devin/cloud-direct";
import {
  streamChatEventsWithResetRetry,
  statedResetMaxWaitMsForTests,
} from "../../src/adapters/devin/cloud-direct/stated-reset-retry";

const request = {
  apiKey: "test-only", apiServerUrl: "https://example.invalid", modelUid: "swe-2", messages: [],
} as unknown as CloudChatRequest;

const cap = (message: string) => new CloudChatError(message, "resource_exhausted", "test", 429);
async function drain(events: AsyncIterable<CloudChatEvent>): Promise<void> {
  for await (const _event of events) { /* Consume the real wrapper without a live RPC. */ }
}

describe("Devin cumulative stated-reset allowance", () => {
  test("two one-hour refusals cannot turn a one-hour allowance into two hours", async () => {
    let calls = 0;
    const waits: number[] = [];
    const failure = cap("Your limit will reset in 1 hour");
    const stream = async function* (req: CloudChatRequest): AsyncGenerator<CloudChatEvent> {
      expect(req).toBe(request);
      calls += 1;
      throw failure;
    };
    await expect(drain(streamChatEventsWithResetRetry(request, {
      stream, maxWaitMs: 3_600_000, sleep: async ms => { waits.push(ms); },
    }))).rejects.toBe(failure);
    expect(calls).toBe(2);
    expect(waits).toEqual([3_600_000]);
  });

  test("twenty plus ten minutes fits the default cumulative allowance", async () => {
    let calls = 0;
    const waits: number[] = [];
    const stream = async function* (): AsyncGenerator<CloudChatEvent> {
      calls += 1;
      if (calls === 1) throw cap("reset in 20 minutes");
      if (calls === 2) throw cap("reset in 10 minutes");
      yield { kind: "text", text: "ok" };
    };
    await drain(streamChatEventsWithResetRetry(request, {
      stream, maxWaitMs: 1_800_000, sleep: async ms => { waits.push(ms); },
    }));
    expect(calls).toBe(3);
    expect(waits).toEqual([1_200_000, 600_000]);
  });

  test("a compound duration is never shortened to fit the allowance", async () => {
    let calls = 0;
    const waits: number[] = [];
    const stream = async function* (): AsyncGenerator<CloudChatEvent> {
      calls += 1;
      throw cap("reset in 5 minutes 30 seconds");
    };
    await expect(drain(streamChatEventsWithResetRetry(request, {
      stream, maxWaitMs: 300_000, sleep: async ms => { waits.push(ms); },
    }))).rejects.toThrow("5 minutes 30 seconds");
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  test("a pre-aborted request does not enter the stream", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(drain(streamChatEventsWithResetRetry({ ...request, signal: controller.signal }, {
      stream: async function* (): AsyncGenerator<CloudChatEvent> { calls += 1; },
    }))).rejects.toHaveProperty("name", "AbortError");
    expect(calls).toBe(0);
  });

  test("cancellation at the sleep-completion boundary prevents replay", async () => {
    const controller = new AbortController();
    let calls = 0;
    const stream = async function* (): AsyncGenerator<CloudChatEvent> {
      calls += 1;
      throw cap("reset in 1 second");
    };
    await expect(drain(streamChatEventsWithResetRetry({ ...request, signal: controller.signal }, {
      stream, sleep: async () => { controller.abort(); },
    }))).rejects.toHaveProperty("name", "AbortError");
    expect(calls).toBe(1);
  });

  test.each([
    { kind: "text", text: "partial" },
    { kind: "usage", promptTokens: 1 },
    { kind: "tool_call_start", id: "t1", name: "write_file" },
    { kind: "reasoning_signature", signature: "sig" },
  ] as CloudChatEvent[])("never retries after an event: %j", async event => {
    let calls = 0;
    const stream = async function* (): AsyncGenerator<CloudChatEvent> {
      calls += 1;
      yield event;
      throw cap("reset in 1 second");
    };
    await expect(drain(streamChatEventsWithResetRetry(request, { stream }))).rejects.toThrow("reset in 1 second");
    expect(calls).toBe(1);
  });

  test("explicit zero disables waiting; overlarge overrides stay bounded", () => {
    const name = "OPENCODEX_DEVIN_STATED_RESET_WAIT_MS";
    const previous = process.env[name];
    try {
      process.env[name] = "0";
      expect(statedResetMaxWaitMsForTests()).toBe(0);
      process.env[name] = "999999999";
      expect(statedResetMaxWaitMsForTests()).toBe(3_600_000);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});
