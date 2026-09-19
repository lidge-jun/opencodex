import { afterEach, describe, expect, test } from "bun:test";
import type { AdapterRequest } from "../../src/adapters/base";
import { fetchKiroWithRetry, resetKiroThrottleStateForTests } from "../../src/adapters/kiro-retry";
import { runCursorTurnWithRetry } from "../../src/adapters/cursor/transport-retry";
import type { CursorRunRequest, CursorServerMessage } from "../../src/adapters/cursor/types";
import type { CursorTransport } from "../../src/adapters/cursor/transport";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { CloudChatError, type CloudChatEvent, type CloudChatRequest } from "../../src/adapters/devin/cloud-direct";
import { streamChatEventsWithResetRetry } from "../../src/adapters/devin/cloud-direct/stated-reset-retry";

/**
 * Adapters that retry INSIDE one adapter call are the layer a per-request cap cannot see from
 * outside. Kiro nests a reset ladder under an endpoint fallback under a throttle loop, and
 * Cursor re-sends the whole turn, so one adapter entry is not one upstream send.
 *
 * Two properties are pinned here, and the first matters as much as the second: the budget field
 * is OPTIONAL and absent means unlimited. Every adapter unit test builds a transport context
 * without one, so a mandatory budget would have turned all of them into budget tests.
 */
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetKiroThrottleStateForTests();
});

/** Exactly `sends` physical sends allowed, with no reserve and no alternate target. */
function budgetOf(sends: number) {
  const policy: RequestExecutionBudgetPolicy = {
    maxTotalModelSends: sends,
    baseSendAllowance: sends,
    finalRecoveryAllowance: 0,
    maxAlternateTargetSends: 0,
    maxTargetTransitions: 0,
  };
  return createRequestExecutionBudget(policy, "lr-adapter-inner-test");
}

const kiroRequest: AdapterRequest = {
  url: "https://runtime.us-east-1.kiro.dev/",
  method: "POST",
  headers: { authorization: "Bearer tok", accept: "application/vnd.amazon.eventstream" },
  body: "{}",
};

function alwaysResets(): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls += 1;
    throw Object.assign(new Error("network failure: ECONNRESET"), { code: "ECONNRESET" });
  }) as typeof fetch;
  return state;
}

describe("Kiro inner retries and the request send budget", () => {
  test("a context without a budget keeps the adapter's own reset ladder", async () => {
    const upstream = alwaysResets();
    const observed: Array<{ ordinal: number; recovery?: string }> = [];

    await expect(fetchKiroWithRetry(kiroRequest, {
      timeoutMs: 5_000,
      onPhysicalSend: send => { observed.push(send); },
    })).rejects.toMatchObject({ code: "ECONNRESET" });

    // Unlimited by default: the ladder runs to its own end and the failure the caller sees is
    // the transport error, not a budget refusal.
    expect(upstream.calls).toBe(3);
    // Each inner send is observable now. Without this the whole ladder reported as one send and
    // no count could be pinned for it at all.
    expect(observed.map(send => send.ordinal)).toEqual([1, 2, 3]);
    expect(observed.map(send => send.recovery)).toEqual([undefined, "connection-reset", "connection-reset"]);
  });

  test("a context with a budget stops the ladder at the allowance", async () => {
    const upstream = alwaysResets();

    await expect(fetchKiroWithRetry(kiroRequest, {
      timeoutMs: 5_000,
      sendBudget: budgetOf(2),
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);

    // Two physical sends, then a refusal BEFORE the third leaves this process.
    expect(upstream.calls).toBe(2);
  });

  test("the budget counts every inner send, not one per adapter call", async () => {
    alwaysResets();
    const budget = budgetOf(3);

    await expect(fetchKiroWithRetry(kiroRequest, { timeoutMs: 5_000, sendBudget: budget }))
      .rejects.toMatchObject({ code: "ECONNRESET" });

    // Three, not one. Counting the adapter entry is how a nested ladder stayed invisible to a
    // four-send request cap while reaching upstream up to eighteen times.
    expect(budget.used).toBe(3);
  });
});

const cursorRequest = {} as CursorRunRequest;

function failingCursorTransport(): CursorTransport {
  return {
    async *run() {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    },
    writeClient() {},
    close() {},
    requestCommitted: () => false,
  };
}

describe("Cursor inner retries and the request send budget", () => {
  test("a turn without execution options keeps the adapter's own attempt count", async () => {
    let calls = 0;

    await expect(runCursorTurnWithRetry(
      () => { calls += 1; return failingCursorTransport(); },
      { provider: { adapter: "cursor" } } as never,
      cursorRequest,
      undefined,
      (_message: CursorServerMessage) => {},
    )).rejects.toMatchObject({ code: "ECONNRESET" });

    // Three attempts, the adapter's own shape, with no budget in sight.
    expect(calls).toBe(3);
  });

  test("a turn with a budget refuses the attempt it cannot pay for", async () => {
    let calls = 0;
    const observed: Array<{ ordinal: number; recovery?: string }> = [];
    const budget = budgetOf(2);

    await expect(runCursorTurnWithRetry(
      () => { calls += 1; return failingCursorTransport(); },
      { provider: { adapter: "cursor" } } as never,
      cursorRequest,
      undefined,
      (_message: CursorServerMessage) => {},
      { sendBudget: budget, onPhysicalSend: send => { observed.push(send); } },
    )).rejects.toBeInstanceOf(SendBudgetExhaustedError);

    // The third attempt never builds a transport: the refusal happens before the connection.
    expect(calls).toBe(2);
    expect(budget.used).toBe(2);
    expect(observed.map(send => send.ordinal)).toEqual([1, 2]);
    expect(observed.map(send => send.recovery)).toEqual([undefined, "connection-reset"]);
  });
});

describe("Devin inner retries and the request send budget", () => {
  test("an exhausted initial send escapes as the local budget error", async () => {
    const request = {
      apiKey: "test", apiServerUrl: "https://example.invalid", modelUid: "swe-2", messages: [],
    } as unknown as CloudChatRequest;
    const stream = (req: CloudChatRequest) => (async function* (): AsyncGenerator<CloudChatEvent> {
      await req.executor!("https://example.invalid/GetChatMessage");
      throw new CloudChatError("must not replace the budget refusal", undefined, undefined, 429);
    })();

    await expect((async () => {
      for await (const _event of streamChatEventsWithResetRetry(request, {
        stream,
        execution: { sendBudget: budgetOf(0) },
      })) { /* drain */ }
    })()).rejects.toBeInstanceOf(SendBudgetExhaustedError);
  });
});
