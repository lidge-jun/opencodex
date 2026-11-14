import { describe, expect, spyOn, test } from "bun:test";
import type { AdapterRequest } from "../../../src/adapters/base";
import { fetchGoogleWithRetry } from "../../../src/adapters/google-http";
import { createAdapterPhysicalSend } from "../../../src/adapters/physical-send";
import { createRequestExecutionBudget } from "../../../src/lib/request-execution-budget";
import { SendBudgetExhaustedError } from "../../../src/lib/upstream-retry";
import {
  providerRequestPacingStatus, resetProviderRequestPacingForTest,
  setProviderRequestPacingRuntimeForTest, waitForProviderRequestSlot,
} from "../../../src/providers/request-pacing";
import { providerFetch } from "../../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../../src/types";

const request = (): AdapterRequest => ({
  url: "https://retry-fixture.invalid/inference", method: "POST",
  headers: { authorization: "Bearer fixture-account-A" }, body: "fixture-body",
});

const repairable = (): AdapterRequest => ({
  ...request(), body: JSON.stringify({ model: "fixture-argon", project: "fixture-project-A", request: {
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    tools: [{ functionDeclarations: [{ name: "fixture", parameters: {
      type: "object", properties: { ids: { type: "array", items: { type: "string" } } },
    } }] }],
  } }),
});
const schemaError = JSON.stringify({ error: { code: 400, status: "INVALID_ARGUMENT",
  message: "tools.0.custom.input_schema: JSON schema is invalid" } });

describe("Google retry ownership and repair counterexamples", () => {
  test("abort just after retry classification cleans up the still-owned response", () => withClock(async clock => {
    const first = unread(503);
    let sends = 0;
    const reason = new Error("fixture classification abort");
    // Abort synchronously during backoff calculation, before pendingResponse is set.
    // The next loop's top-level abort bypasses retry preparation entirely.
    const random = spyOn(Math, "random").mockImplementation(() => { clock.controller.abort(reason); return 0; });
    try {
      await expect(fetchGoogleWithRetry("Antigravity", request(), {
        executor: paced(fakeFetch(async () => { sends++; return first.response; })),
        abortSignal: clock.controller.signal,
      })).rejects.toBe(reason);
      expect(sends).toBe(1); expect(first.counts.cancels).toBe(1);
      expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
      expect(clock.timers.size).toBe(0);
    } finally { random.mockRestore(); }
  }));

  test("abort while the retry queues behind another owner refunds and never dispatches", () => withClock(async clock => {
    const first = unread(503);
    const budget = budgetOf(3);
    let sends = 0;
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", request(), {
      executor: paced(fakeFetch(async () => { sends++; return first.response; })),
      sendBudget: budget, abortSignal: clock.controller.signal,
    }));
    await clock.advance(100);
    const other = await waitForProviderRequestSlot(providerName, configured, "fixture-argon");
    try {
      await clock.advance(200);
      expect(status()).toMatchObject({ inFlight: 1, queued: 1 });
      const reason = new Error("fixture queue abort");
      clock.controller.abort(reason);
      await expect(completion).rejects.toBe(reason);
      expect(status()).toMatchObject({ inFlight: 1, queued: 0 });
      expect(budget.used).toBe(1); expect(first.counts.cancels).toBe(1);
    } finally { other.release(); }
    await clock.advance(1000);
    expect(sends).toBe(1); expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(clock.timers.size).toBe(0);
  }));

  test("a real repair-budget denial returns the untouched original 400", () => withClock(async clock => {
    const first = new Response(schemaError, { status: 400, headers: { "Retry-After": "7" } });
    const budget = budgetOf(1);
    let sends = 0;
    const withheld: string[] = [];
    const original = repairable();
    const originalBody = original.body;
    const response = await fetchGoogleWithRetry("Antigravity", original, {
      executor: fakeFetch(async () => { sends++; return first; }), sendBudget: budget,
      returnRawErrors: true, abortSignal: clock.controller.signal,
      onRecoveryWithheld: event => withheld.push(event.reason),
    });
    expect(response).toBe(first); expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.text()).toBe(schemaError);
    expect(sends).toBe(1); expect(budget.used).toBe(1);
    expect(withheld).toEqual(["retry-send-budget"]);
    expect(original.body).toBe(originalBody); expect(clock.timers.size).toBe(0);
  }));

  test("repair then transient retry retain the repaired body and selected account", () => withClock(async clock => {
    const original = repairable();
    const calls: Array<{ url: string; auth: string | null; body: string; at: number }> = [];
    const budget = budgetOf(3);
    const executor = paced(fakeFetch(async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body), at: clock.now() });
      if (calls.length === 1) return new Response(schemaError, { status: 400 });
      if (calls.length === 2) return unread(503).response;
      return new Response("ok");
    }));
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", original, {
      executor, sendBudget: budget, abortSignal: clock.controller.signal,
    }).then(res => res.text()));
    await clock.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).not.toBe(calls[0]!.body);
    const repaired = JSON.parse(calls[1]!.body);
    expect(repaired.request.tools[0].functionDeclarations[0].parameters).toEqual({ type: "object", properties: {} });
    expect(repaired.model).toBe("fixture-argon"); expect(repaired.project).toBe("fixture-project-A");
    await clock.advance(199); expect(calls).toHaveLength(2);
    await clock.advance(200); expect(await completion).toBe("ok");
    expect(calls).toHaveLength(3); expect(budget.used).toBe(3);
    expect(calls[2]!.body).toBe(calls[1]!.body);
    expect(calls.every(call => call.url === original.url && call.auth === "Bearer fixture-account-A")).toBe(true);
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 }); expect(clock.timers.size).toBe(0);
  }));

  test("an already-rebuilt request refreshes headers and URL without undoing its repair", () => withClock(async clock => {
    const original = repairable();
    const calls: Array<{ url: string; auth: string | null; body: string }> = [];
    const executor = paced(fakeFetch(async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      if (calls.length === 1) return new Response(schemaError, { status: 400 });
      if (calls.length === 2) {
        original.url = "https://retry-fixture.invalid/refreshed";
        original.headers = { authorization: "Bearer fixture-A-new" };
        return unread(503).response;
      }
      return new Response("ok");
    }));
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", original, {
      executor, abortSignal: clock.controller.signal,
    }).then(res => res.text()));
    await clock.advance(200);
    expect(await completion).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ url: "https://retry-fixture.invalid/refreshed",
      auth: "Bearer fixture-A-new", body: calls[1]!.body });
    expect(calls[1]!.body).not.toBe(calls[0]!.body);
    expect(clock.timers.size).toBe(0);
  }));

  test("late physical budget refusal cannot return the response already cancelled for replay", () => withClock(async clock => {
    const first = unread(503);
    let physicalStarts = 0, sends = 0;
    const budget = createRequestExecutionBudget(undefined, undefined, {
      charge: () => true, refund() {}, beforePhysicalSend: () => ++physicalStarts === 1,
    });
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", request(), {
      executor: paced(fakeFetch(async () => { sends++; return first.response; })),
      sendBudget: budget, returnRawErrors: true, abortSignal: clock.controller.signal,
    }));
    await clock.advance(200);
    await expect(completion).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(sends).toBe(1); expect(first.counts.cancels).toBe(1);
    expect(budget.used).toBe(1); expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(clock.timers.size).toBe(0);
  }));

  test("beforePacing failure refunds its booking before acquiring a slot", () => withClock(async clock => {
    const budget = budgetOf(1);
    let sends = 0;
    const send = createAdapterPhysicalSend({ sendBudget: budget }, paced(fakeFetch(async () => { sends++; return new Response("unexpected"); })));
    const reason = new Error("fixture preparation refusal");
    await expect(send({ url: request().url, beforePacing: () => { throw reason; },
      dispatch: physical => physical(request().url) })).rejects.toBe(reason);
    expect(budget.used).toBe(0); expect(sends).toBe(0);
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 }); expect(clock.timers.size).toBe(0);
  }));
});
const budgetOf = (limit: number) => createRequestExecutionBudget({
  maxTotalModelSends: limit, baseSendAllowance: limit, finalRecoveryAllowance: 0,
  maxAlternateTargetSends: 0, maxTargetTransitions: 0,
});
const configured: OcxProviderConfig = {
  adapter: "google", authMode: "oauth", googleMode: "cloud-code-assist",
  baseUrl: "https://retry-fixture.invalid",
  requestPacing: { enabled: true, maxConcurrentRequests: 1, minIntervalMs: 0 },
};
const providerName = "retry-before-pacing-redteam";
const status = () => providerRequestPacingStatus(providerName, configured);
const paced = (execute: typeof fetch) => providerFetch({ ...configured, fetch: execute }, undefined,
  { providerName, modelId: "fixture-argon" });
const fakeFetch = (run: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) =>
  Object.assign(run, { preconnect() {} }) as typeof fetch;

function unread(statusCode: number, headers: HeadersInit = {}, cancellation?: () => void | Promise<void>) {
  const counts = { cancels: 0, pulls: 0 };
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      counts.pulls++;
      controller.enqueue(new TextEncoder().encode("upstream-original"));
      controller.close();
    },
    cancel() { counts.cancels++; return cancellation?.(); },
  }, { highWaterMark: 0 }), { status: statusCode, headers });
  return { response, counts };
}

// Only time and inference I/O are synthetic. Admission, refunds, body ownership,
// cancellation and pacing are the actual candidate implementations.
async function withClock(run: (clock: {
  now: () => number; advance: (target: number) => Promise<void>; flush: () => Promise<void>;
  controller: AbortController; watch: <T>(promise: Promise<T>) => Promise<T>; timers: Map<number, unknown>;
}) => Promise<void>) {
  let now = 0, nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const schedule = (callback: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
    return id;
  };
  const controller = new AbortController();
  const tasks: Promise<unknown>[] = [];
  const spies = [
    spyOn(globalThis, "setTimeout").mockImplementation(schedule as typeof setTimeout),
    spyOn(globalThis, "clearTimeout").mockImplementation(id => { timers.delete(Number(id)); }),
    spyOn(Date, "now").mockImplementation(() => now),
    spyOn(performance, "now").mockImplementation(() => now),
    spyOn(Math, "random").mockReturnValue(0),
  ];
  setProviderRequestPacingRuntimeForTest({ now: () => now, setTimer: schedule,
    clearTimer: id => { timers.delete(Number(id)); }, enqueueMicrotask: queueMicrotask, random: () => 0 });
  try {
    await run({ now: () => now, flush, controller, timers,
      watch<T>(promise: Promise<T>) { tasks.push(promise); void promise.catch(() => {}); return promise; },
      advance: async target => {
        await flush();
        for (;;) {
          const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
            .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
          if (!due) break;
          const [id, timer] = due;
          timers.delete(id); now = timer.at; timer.callback(); await flush();
        }
        now = target; await flush();
      },
    });
  } finally {
    controller.abort();
    await flush();
    await Promise.allSettled(tasks);
    resetProviderRequestPacingForTest(); timers.clear();
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}

describe("Google retry admission redteam", () => {
  test("real budget denial after a transient 429 preserves the original after clone inspection", () => withClock(async clock => {
    const payload = JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "rate limit, try again" } });
    const first = new Response(payload, { status: 429, headers: { "Retry-After": "3" } });
    const budget = budgetOf(1);
    let sends = 0;
    const withheld: string[] = [];
    const response = await fetchGoogleWithRetry("Antigravity", request(), {
      executor: fakeFetch(async () => { sends++; return first; }), sendBudget: budget,
      returnRawErrors: true, abortSignal: clock.controller.signal,
      onRecoveryWithheld: event => withheld.push(event.reason),
    });
    expect(response).toBe(first); expect(response.bodyUsed).toBe(false);
    expect(response.headers.get("retry-after")).toBe("3"); expect(await response.text()).toBe(payload);
    expect(sends).toBe(1); expect(budget.used).toBe(1);
    expect(withheld).toEqual(["retry-send-budget"]); expect(clock.timers.size).toBe(0);
  }));

  test.each([true, false])("real budget denial transfers the original 503 body (raw=%s)", raw => withClock(async clock => {
    const first = unread(503, { "Retry-After": "3", "x-upstream-proof": "original" });
    const budget = budgetOf(1);
    let sends = 0;
    const withheld: string[] = [];
    const executor = paced(fakeFetch(async () => { sends++; return first.response; }));
    const response = await fetchGoogleWithRetry("Antigravity", request(), {
      executor, sendBudget: budget, abortSignal: clock.controller.signal, returnRawErrors: raw,
      onRecoveryWithheld: event => withheld.push(event.reason),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("x-upstream-proof")).toBe("original");
    expect(sends).toBe(1); expect(budget.used).toBe(1);
    expect(withheld).toEqual(["retry-send-budget"]);
    expect(first.counts.cancels).toBe(0);
    if (raw) {
      expect(response.bodyUsed).toBe(false);
      expect(first.counts.pulls).toBe(0);
      expect(status()).toMatchObject({ inFlight: 1, queued: 0 });
      expect(await response.text()).toBe("upstream-original");
    } else expect(await response.text()).toContain("upstream-original");
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(clock.timers.size).toBe(0);
  }));

  test("an exhausted initial budget does not acquire pacing or dispatch", () => withClock(async clock => {
    let sends = 0;
    const budget = budgetOf(0);
    const executor = paced(fakeFetch(async () => { sends++; return new Response("unexpected"); }));
    await expect(fetchGoogleWithRetry("Antigravity", request(), {
      executor, sendBudget: budget, abortSignal: clock.controller.signal,
    })).rejects.toBeInstanceOf(SendBudgetExhaustedError);
    expect(sends).toBe(0); expect(budget.used).toBe(0);
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(clock.timers.size).toBe(0);
  }));

  test.each(["reject", "never"] as const)("retry releases its own lease even when source cancellation is %s", kind => withClock(async clock => {
    const first = unread(503, {}, () => kind === "reject"
      ? Promise.reject(new Error("fixture cancellation rejection")) : new Promise<void>(() => {}));
    const sends: number[] = [];
    const executor = paced(fakeFetch(async () => {
      sends.push(clock.now()); return sends.length === 1 ? first.response : new Response("ok");
    }));
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", request(), {
      executor, abortSignal: clock.controller.signal,
    }).then(res => res.text()));
    await clock.flush();
    expect(first.counts).toEqual({ cancels: 1, pulls: 0 });
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    await clock.advance(199); expect(sends).toEqual([0]);
    await clock.advance(200); expect(sends).toEqual([0, 200]);
    expect(await completion).toBe("ok");
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(clock.timers.size).toBe(0);
  }));

  test("abort during backoff refunds only the unsent reservation", () => withClock(async clock => {
    const first = unread(503);
    const budget = budgetOf(3);
    let sends = 0;
    const executor = paced(fakeFetch(async () => { sends++; return first.response; }));
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", request(), {
      executor, sendBudget: budget, abortSignal: clock.controller.signal,
    }));
    await clock.flush();
    expect(budget.used).toBe(2); // Initial send plus the open retry reservation.
    expect(first.counts.cancels).toBe(1);
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    const reason = new Error("fixture backoff abort");
    clock.controller.abort(reason);
    await expect(completion).rejects.toBe(reason);
    expect(sends).toBe(1); expect(budget.used).toBe(1);
    expect(first.counts.cancels).toBe(1); expect(clock.timers.size).toBe(0);
  }));

  test.each(["3", "Thu, 01 Jan 1970 00:00:03 GMT"])("Retry-After floor survives early lease release: %s", retryAfter => withClock(async clock => {
    const first = unread(503, { "Retry-After": retryAfter });
    const calls: Array<{ at: number; url: string; auth: string | null; body: string }> = [];
    const original = request();
    const executor = paced(fakeFetch(async (input, init) => {
      calls.push({ at: clock.now(), url: String(input), auth: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
      return calls.length === 1 ? first.response : new Response("ok");
    }));
    const completion = clock.watch(fetchGoogleWithRetry("Antigravity", original, {
      executor, abortSignal: clock.controller.signal,
    }).then(res => res.text()));
    await clock.flush();
    expect(first.counts.cancels).toBe(1);
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    await clock.advance(2999); expect(calls).toHaveLength(1);
    await clock.advance(3000); expect(await completion).toBe("ok");
    expect(calls.map(call => call.at)).toEqual([0, 3000]);
    expect(calls.every(call => call.url === original.url && call.auth === "Bearer fixture-account-A" && call.body === "fixture-body")).toBe(true);
    expect(clock.timers.size).toBe(0);
  }));

  test("Retry-After above the wait ceiling returns a readable original, not a retry", () => withClock(async clock => {
    const first = unread(503, { "Retry-After": "61" });
    let sends = 0;
    const budget = budgetOf(3);
    const response = await fetchGoogleWithRetry("Antigravity", request(), {
      executor: paced(fakeFetch(async () => { sends++; return first.response; })),
      sendBudget: budget, abortSignal: clock.controller.signal, returnRawErrors: true,
    });
    expect(response.headers.get("retry-after")).toBe("61");
    expect(first.counts.cancels).toBe(0); expect(sends).toBe(1); expect(budget.used).toBe(1);
    expect(await response.text()).toBe("upstream-original");
    expect(status()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(clock.timers.size).toBe(0);
  }));
});
