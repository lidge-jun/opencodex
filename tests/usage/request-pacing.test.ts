import { afterEach, describe, expect, test } from "bun:test";
import {
  REQUEST_PACING_BODY_INACTIVITY_MS,
  REQUEST_PACING_CONCURRENCY_RETRY_AFTER_SECONDS,
  REQUEST_PACING_UNCONSUMED_BODY_MS,
  releaseProviderRequestSlot,
  trackProviderRequestSlotBody,
  providerRequestPacingStatus,
  reconcileProviderRequestPacing,
  RequestPacingQueueOverloadError,
  requestPacingIntervalMs,
  resetProviderRequestPacingForTest,
  setProviderRequestPacingLimitsForTest,
  setProviderRequestPacingRuntimeForTest,
  waitForProviderRequestSlot,
  withProviderRequestSlot,
  type RequestPacingRuntime,
} from "../../src/providers/request-pacing";
import { createAdapterPhysicalSend } from "../../src/adapters/physical-send";
import {
  isNonReplayableResponse,
  isReplayRefusalResponse,
  retainReplayRefusal,
} from "../../src/lib/upstream-retry";
import { __resetEgressWebsocketDowngradeNotices, providerFetch } from "../../src/server/responses/fetch-helpers";
import { fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import { CODEX_RESPONSES_HTTP_URL } from "../../src/server/responses/codex-ws-request";
import { requestPacingOverloadResponse } from "../../src/server/responses/pacing-overload";
import { requestPacingConfigError } from "../../src/config/schema/leaf-validators";
import type { OcxProviderConfig } from "../../src/types";

afterEach(() => resetProviderRequestPacingForTest());

function provider(requestPacing: OcxProviderConfig["requestPacing"]): OcxProviderConfig {
  return { adapter: "openai-chat", baseUrl: "https://example.test/v1", requestPacing };
}

function fakePacingClock(): {
  runtime: RequestPacingRuntime;
  now: () => number;
  pendingTimerCount: () => number;
  advanceBy: (delayMs: number) => void;
} {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    runtime: {
      now: () => now,
      setTimer: (callback, delayMs) => {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimer: handle => { timers.delete(handle as number); },
      enqueueMicrotask: callback => callback(),
    },
    now: () => now,
    pendingTimerCount: () => timers.size,
    advanceBy: (delayMs) => {
      const target = now + delayMs;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = target;
    },
  };
}

describe("requestPacingIntervalMs", () => {
  test("uses the slower of provider RPM, provider delay, and model override", () => {
    const configured = provider({
      enabled: true,
      requestsPerMinute: 120,
      minIntervalMs: 700,
      models: {
        slow: { requestsPerMinute: 30 },
        attemptedFast: { requestsPerMinute: 600 },
      },
    });
    expect(requestPacingIntervalMs(configured, "ordinary")).toBe(700);
    expect(requestPacingIntervalMs(configured, "slow")).toBe(2_000);
    expect(requestPacingIntervalMs(configured, "attemptedFast")).toBe(700);
  });

  test("supports model-only pacing while unrelated models remain unpaced", () => {
    const configured = provider({ enabled: true, models: { slow: { minIntervalMs: 900 } } });
    expect(requestPacingIntervalMs(configured, "slow")).toBe(900);
    expect(requestPacingIntervalMs(configured, "other")).toBe(0);
  });
});

describe("provider request pacing queue", () => {
  test("spaces concurrent starts in one provider FIFO and exposes queue state", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const started: Array<{ url: string; at: number }> = [];
    const fetchImpl = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      started.push({ url: String(input), at: clock.now() });
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, requestsPerMinute: 600 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    const first = send("https://example.test/v1/first");
    const second = send("https://example.test/v1/second");
    const third = send("https://example.test/v1/third");
    await first;
    expect(started).toEqual([{ url: "https://example.test/v1/first", at: 0 }]);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    clock.advanceBy(100);
    await second;
    expect(started).toEqual([
      { url: "https://example.test/v1/first", at: 0 },
      { url: "https://example.test/v1/second", at: 100 },
    ]);
    clock.advanceBy(100);
    await third;
    expect(started).toEqual([
      { url: "https://example.test/v1/first", at: 0 },
      { url: "https://example.test/v1/second", at: 100 },
      { url: "https://example.test/v1/third", at: 200 },
    ]);
    const status = providerRequestPacingStatus("demo", configured);
    expect(status.queued).toBe(0);
    expect(status.lastModelId).toBe("model-a");
  });

  test("a runTurn fetch consumes its pre-acquired slot once, then paces internal requests", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const starts: number[] = [];
    const fetchImpl = Object.assign(async () => {
      starts.push(clock.now());
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, minIntervalMs: 100 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };

    await waitForProviderRequestSlot("cursor", configured, "model-a");
    const send = providerFetch(configured, undefined, {
      providerName: "cursor",
      modelId: "model-a",
      pacingSlotAcquired: true,
    });
    await send("https://example.test/run-sse");
    const append = send("https://example.test/bidi-append");

    expect(starts).toHaveLength(1);
    expect(providerRequestPacingStatus("cursor", configured).queued).toBe(1);
    clock.advanceBy(100);
    await append;
    expect(starts).toEqual([0, 100]);
  });

  test("aborted queued requests leave immediately and never consume a start", async () => {
    const configured = provider({ enabled: true, minIntervalMs: 1_000 });
    await waitForProviderRequestSlot("demo", configured, "first");
    const controller = new AbortController();
    const queued = waitForProviderRequestSlot("demo", configured, "cancelled", controller.signal);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    controller.abort();
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(0);
    await expect(queued).rejects.toHaveProperty("name", "AbortError");
  });

  test("rejects newest admission when the provider queue is full", async () => {
    setProviderRequestPacingLimitsForTest({ maxQueueDepth: 2, maxQueueAgeMs: 5_000 });
    const configured = provider({ enabled: true, minIntervalMs: 1_000 });
    await waitForProviderRequestSlot("demo", configured, "first");
    const controller = new AbortController();
    const queued = [
      waitForProviderRequestSlot("demo", configured, "second", controller.signal),
      waitForProviderRequestSlot("demo", configured, "third", controller.signal),
    ];
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    await expect(waitForProviderRequestSlot("demo", configured, "newest")).rejects.toMatchObject({
      name: "RequestPacingQueueOverloadError",
      reason: "queue_full",
      providerName: "demo",
    });
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    controller.abort();
    await Promise.allSettled(queued);
  });

  test("expires a queued request at the bounded queued-age deadline", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 25 });
    const configured = provider({ enabled: true, minIntervalMs: 1_000 });
    await waitForProviderRequestSlot("demo", configured, "first");
    const queued = waitForProviderRequestSlot("demo", configured, "stale");
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    clock.advanceBy(25);
    await expect(queued).rejects.toMatchObject({
      name: "RequestPacingQueueOverloadError",
      reason: "queue_expired",
      providerName: "demo",
    });
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(0);
  });

  test("a concurrency-blocked waiter refused at the queue deadline reports a floored retry-after", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 25 });
    // Pure concurrency cap: no interval to report, so the interval-based math would
    // answer 1s and invite second-by-second retries against a saturated provider.
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    await waitForProviderRequestSlot("demo", configured, "model-a");
    const queued = waitForProviderRequestSlot("demo", configured, "model-a");
    clock.advanceBy(25);
    const rejection = await queued.then(
      () => undefined,
      error => error as RequestPacingQueueOverloadError,
    );
    expect(rejection?.reason).toBe("queue_expired");
    expect(rejection?.retryAfterSeconds).toBe(REQUEST_PACING_CONCURRENCY_RETRY_AFTER_SECONDS);
  });

  test("generation reconciliation removes deleted providers and rejects their queued waiters", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({ enabled: true, minIntervalMs: 100 });

    await waitForProviderRequestSlot("live", configured, "model");
    await waitForProviderRequestSlot("removed", configured, "model");
    const liveQueued = waitForProviderRequestSlot("live", configured, "model");
    const removedQueued = waitForProviderRequestSlot("removed", configured, "model");
    const removedOutcome = removedQueued.then(
      () => null,
      error => error,
    );
    expect(clock.pendingTimerCount()).toBe(2);

    expect(reconcileProviderRequestPacing({
      generation: 1,
      providerNames: new Set(["live"]),
      comboIds: new Set(),
      comboTargets: new Set(),
      codexAccountIds: new Set(),
      oauthAccountKeys: new Set(),
      configRoots: new Set(),
    })).toBe(1);

    expect(await removedOutcome).toMatchObject({
      name: "RequestPacingProviderRemovedError",
      providerName: "removed",
    });
    expect(providerRequestPacingStatus("removed", configured).queued).toBe(0);
    expect(providerRequestPacingStatus("live", configured).queued).toBe(1);
    expect(clock.pendingTimerCount()).toBe(1);
    clock.advanceBy(100);
    await liveQueued;
    expect(clock.pendingTimerCount()).toBe(0);
  });

  test("maps pacing admission overload to 429 with Retry-After", async () => {
    const response = requestPacingOverloadResponse(new RequestPacingQueueOverloadError("demo", "queue_full", 3));
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("3");
    expect(await response?.json()).toMatchObject({ error: { type: "rate_limit_error" } });
  });

  test("manual fetchResponse slots enforce the same-model interval without wall-clock timing", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({
      enabled: true,
      minIntervalMs: 50,
      models: { slow: { minIntervalMs: 180 } },
    });
    await waitForProviderRequestSlot("demo", configured, "slow");
    const second = waitForProviderRequestSlot("demo", configured, "slow");
    clock.advanceBy(179);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    clock.advanceBy(1);
    await second;
    expect(clock.now()).toBe(180);
  });

  test("an eligible sibling bypasses a slower model lane with an injected clock", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({
      enabled: true,
      minIntervalMs: 80,
      models: { slow: { minIntervalMs: 400 } },
    });
    await waitForProviderRequestSlot("demo", configured, "slow");
    const secondSlow = waitForProviderRequestSlot("demo", configured, "slow");
    const fast = waitForProviderRequestSlot("demo", configured, "fast");
    clock.advanceBy(80);
    await fast;
    expect(clock.now()).toBe(80);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    clock.advanceBy(320);
    await secondSlow;
    expect(clock.now()).toBe(400);
  });

  test("disabled policies preserve the unpaced legacy path", async () => {
    const configured = provider({ enabled: false, requestsPerMinute: 1 });
    await Promise.all([
      waitForProviderRequestSlot("demo", configured, "a"),
      waitForProviderRequestSlot("demo", configured, "b"),
    ]);
    expect(providerRequestPacingStatus("demo", configured).enabled).toBe(false);
  });

  test("queue waiting does not consume the response-header timeout budget", async () => {
    const fetchImpl = Object.assign(async () => {
      await Bun.sleep(20);
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, minIntervalMs: 120 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const executor = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    await fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {}, new AbortController().signal, 50, false, executor);
    const second = await fetchWithHeaderTimeout("https://example.test/v1/chat/completions", {}, new AbortController().signal, 50, false, executor);
    expect(second.status).toBe(200);
  });

  test("Google AI Studio providerFetch paces each attempt through waitForPacing", async () => {
    let pacingWaited = 0;
    const configured: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "key",
      requestPacing: { enabled: true, minIntervalMs: 50 },
      fetch: (async () => new Response("ok")) as typeof fetch,
    };
    const executor = providerFetch(configured, undefined, { providerName: "google-direct", modelId: "gemini-2.5-flash" });
    const originalWaitForPacing = executor.waitForPacing;
    executor.waitForPacing = async (signal) => {
      pacingWaited++;
      await originalWaitForPacing?.(signal);
    };
    const res = await fetchWithHeaderTimeout("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {}, new AbortController().signal, 500, false, executor);
    expect(res.status).toBe(200);
    expect(pacingWaited).toBe(1);
  });
});

describe("request pacing concurrency caps", () => {
  function openBodyStream(): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
      },
    });
  }

  function trackedFetch(started: string[]): typeof globalThis.fetch {
    return Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      started.push(String(input));
      return new Response(openBodyStream(), { status: 200 });
    }, { preconnect() {} }) as typeof globalThis.fetch;
  }

  test("caps in-flight requests per provider until a response body completes", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const started: string[] = [];
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 2 }),
      fetch: trackedFetch(started),
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    const first = await send("https://example.test/one");
    const second = await send("https://example.test/two");
    const third = send("https://example.test/three");
    expect(started).toEqual(["https://example.test/one", "https://example.test/two"]);
    const status = providerRequestPacingStatus("demo", configured);
    expect(status.inFlight).toBe(2);
    expect(status.queued).toBe(1);
    await first.body!.cancel();
    const thirdResponse = await third;
    expect(started).toHaveLength(3);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(2);
    await second.body!.cancel();
    await thirdResponse.body!.cancel();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a model override tightens the provider cap while other models keep it", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const started: string[] = [];
    const configured = {
      ...provider({
        enabled: true,
        maxConcurrentRequests: 3,
        models: { narrow: { maxConcurrentRequests: 1 } },
      }),
      fetch: trackedFetch(started),
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = (modelId: string) => providerFetch(configured, undefined, { providerName: "demo", modelId });
    const narrowFirst = await send("narrow")("https://example.test/narrow-1");
    const narrowSecond = send("narrow")("https://example.test/narrow-2");
    const wide = await send("wide")("https://example.test/wide");
    expect(started).toEqual(["https://example.test/narrow-1", "https://example.test/wide"]);
    await narrowFirst.body!.cancel();
    const narrowSecondResponse = await narrowSecond;
    expect(started).toHaveLength(3);
    await wide.body!.cancel();
    await narrowSecondResponse.body!.cancel();
  });

  test("a null-body response releases the lease immediately", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const started: string[] = [];
    const fetchImpl = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      started.push(String(input));
      return new Response(null, { status: 204 });
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    await send("https://example.test/one");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    await send("https://example.test/two");
    expect(started).toHaveLength(2);
  });

  test("a failed send releases the lease for queued requests", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const started: string[] = [];
    let calls = 0;
    const fetchImpl = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      calls += 1;
      if (calls === 1) throw new Error("upstream refused");
      started.push(String(input));
      return new Response(null, { status: 204 });
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    await expect(send("https://example.test/one")).rejects.toThrow("upstream refused");
    await send("https://example.test/two");
    expect(started).toEqual(["https://example.test/two"]);
  });

  test("rejects newest admission when in-flight leases saturate the bounded queue", async () => {
    setProviderRequestPacingLimitsForTest({ maxQueueDepth: 2 });
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const inFlight = await waitForProviderRequestSlot("demo", configured, "model-a");
    const controller = new AbortController();
    const queued = [
      waitForProviderRequestSlot("demo", configured, "model-a"),
      waitForProviderRequestSlot("demo", configured, "model-a", controller.signal),
    ];
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    await expect(waitForProviderRequestSlot("demo", configured, "model-a")).rejects.toMatchObject({
      name: "RequestPacingQueueOverloadError",
      reason: "queue_full",
      providerName: "demo",
    });
    inFlight.release();
    await queued[0];
    controller.abort();
    await Promise.allSettled(queued);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
  });

  test("fetchWithHeaderTimeout releases the lease when the tracked body completes", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const started: string[] = [];
    const fetchImpl = Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      started.push(String(input));
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const executor = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    const first = await fetchWithHeaderTimeout(
      "https://example.test/one",
      { method: "GET" },
      new AbortController().signal,
      1_000,
      false,
      executor,
    );
    expect(await first.text()).toBe("ok");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    const second = await fetchWithHeaderTimeout(
      "https://example.test/two",
      { method: "GET" },
      new AbortController().signal,
      1_000,
      false,
      executor,
    );
    await second.text();
    expect(started).toHaveLength(2);
  });

  test("fetchWithHeaderTimeout rejects an invalid header before acquiring the lease", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    let sends = 0;
    const fetchImpl = Object.assign(async () => {
      sends += 1;
      return new Response("ok");
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const executor = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    // A newline in an adapter-built header value rejects at Headers construction, which
    // must happen before the pacing acquire so the rejection cannot strand the lease.
    await expect(fetchWithHeaderTimeout(
      "https://example.test/one",
      { method: "GET", headers: { "x-bad": "value\nwith-newline" } },
      new AbortController().signal,
      1_000,
      false,
      executor,
    )).rejects.toThrow();
    expect(sends).toBe(0);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("status reports model-only concurrency caps as in-flight", async () => {
    const configured = provider({ enabled: true, models: { narrow: { maxConcurrentRequests: 1 } } });
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    const first = await waitForProviderRequestSlot("demo", configured, "narrow");
    const second = waitForProviderRequestSlot("demo", configured, "narrow");
    const blocked = providerRequestPacingStatus("demo", configured);
    expect(blocked.inFlight).toBe(1);
    expect(blocked.queued).toBe(1);
    first.release();
    const secondSlot = await second;
    secondSlot.release();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a fractional maxConcurrentRequests floors to the integer below", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1.5 });
    const first = await waitForProviderRequestSlot("demo", configured, "model-a");
    const second = waitForProviderRequestSlot("demo", configured, "model-a");
    const blocked = providerRequestPacingStatus("demo", configured);
    expect(blocked.inFlight).toBe(1);
    expect(blocked.queued).toBe(1);
    first.release();
    const secondSlot = await second;
    secondSlot.release();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a fractional maxConcurrentRequests below one keeps a cap of one", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 0.5 });
    const first = await waitForProviderRequestSlot("demo", configured, "model-a");
    const second = waitForProviderRequestSlot("demo", configured, "model-a");
    const blocked = providerRequestPacingStatus("demo", configured);
    expect(blocked.inFlight).toBe(1);
    expect(blocked.queued).toBe(1);
    first.release();
    const secondSlot = await second;
    secondSlot.release();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a source read settling after consumer cancel stays inert and released", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    let settleSourcePull: (() => void) | undefined;
    const source = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(resolve => { settleSourcePull = resolve; }),
    });
    const response = trackProviderRequestSlotBody(slot, new Response(source));
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    await new Promise(resolve => setTimeout(resolve, 0));
    await reader.cancel("consumer closed the exchange");
    settleSourcePull?.();
    await pendingRead.then(() => undefined, () => undefined);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a source body locked by another reader releases the lease when getReader throws", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); },
    });
    // A second reader on the same source makes getReader() throw from the pull
    // algorithm; the lease must return even though the consumer never saw a byte.
    const original = new Response(source);
    const response = trackProviderRequestSlotBody(slot, original);
    const otherReader = original.body!.getReader();
    const reader = response.body!.getReader();
    await expect(reader.read()).rejects.toBeInstanceOf(TypeError);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    await otherReader.cancel("test cleanup");
  });

  test("interval-only acquisition serves a saturated provider without taking a lease", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const held = await waitForProviderRequestSlot("demo", configured, "model-a");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    const followUp = await waitForProviderRequestSlot(
      "demo", configured, "model-a", undefined, { concurrency: false },
    );
    expect(followUp.leased).toBe(false);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    followUp.release();
    held.release();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("an unread tracked body releases its lease and cancels the source at the deadline", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); },
      cancel: () => { cancelled = true; },
    });
    trackProviderRequestSlotBody(slot, new Response(source));
    // Let the stream's start and pull algorithms run first, as they do in production
    // before any timer fires; with zero capacity and no reader, pull must not run.
    await new Promise(resolve => setTimeout(resolve, 0));
    clock.advanceBy(REQUEST_PACING_UNCONSUMED_BODY_MS - 1);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    clock.advanceBy(1);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
    const next = await waitForProviderRequestSlot("demo", configured, "model-a");
    next.release();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a body read once and abandoned reclaims its lease at the inactivity deadline", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    const response = trackProviderRequestSlotBody(slot, new Response(openBodyStream()));
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("chunk");
    // The first pull swaps the short unconsumed deadline for the longer inactivity
    // window, so a slowly-arriving next chunk never reclaims a live stream...
    clock.advanceBy(REQUEST_PACING_BODY_INACTIVITY_MS - 1);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    // ...but a consumer that stops reading (a clone-based peek that cancelled only its
    // own tee branch) must still return the lease instead of holding it forever.
    clock.advanceBy(1);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    await reader.cancel("consumer closed").catch(() => {});
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a non-conforming status returns the original response and releases the lease immediately", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("chunk")); controller.close(); },
      cancel: () => { cancelled = true; },
    });
    // Bun's fetch passes a raw non-2xx-5xx status through; rewrapping it in new Response
    // throws AFTER markBodyTracked, and boundary cleanup skips body-tracked slots. The
    // abandoned rewrap never locked the source, so the original response goes back intact:
    // rethrowing would make the retry ladders replay a request whose response did arrive.
    const raw = new Response(source);
    Object.defineProperty(raw, "status", { value: 601 });
    const tracked = trackProviderRequestSlotBody(slot, raw);
    expect(tracked).toBe(raw);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cancelled).toBe(false);
    expect(await new Response(raw.body).text()).toBe("chunk");
    const next = await waitForProviderRequestSlot("demo", configured, "model-a");
    next.release();
  });

  test("turn-boundary release skips a lease a tracked body still owns", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    const response = trackProviderRequestSlotBody(slot, new Response(openBodyStream()));
    expect(slot.bodyTracked).toBe(true);
    releaseProviderRequestSlot(slot);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    await response.body!.cancel("turn done");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    const bare = await waitForProviderRequestSlot("demo", configured, "model-a");
    releaseProviderRequestSlot(bare);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("turn-scoped providerFetch follow-up sends do not queue behind the turn's own lease", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: (async () => new Response(openBodyStream())) as typeof fetch,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    const executor = providerFetch(configured, undefined, {
      providerName: "demo",
      modelId: "model-a",
      pacingSlotAcquired: true,
      pacingSlot: slot,
      turnScopedPacing: true,
    });
    const first = await executor("https://example.test/runsse");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    // A BidiAppend behind the still-open RunSSE body: interval-only, never lease-blocked.
    const second = await executor("https://example.test/bidi-append");
    expect(second.status).toBe(200);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    await first.body!.cancel("run finished");
    await second.body!.cancel("append finished");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a turn-scoped follow-up re-acquires with concurrency once its lease was released", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    let failFirstDial = true;
    let calls = 0;
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: (async () => {
        calls += 1;
        if (failFirstDial) {
          failFirstDial = false;
          throw new Error("dial failed before commit");
        }
        return new Response("redial ok");
      }) as typeof fetch,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    const executor = providerFetch(configured, undefined, {
      providerName: "demo",
      modelId: "model-a",
      pacingSlotAcquired: true,
      pacingSlot: slot,
      turnScopedPacing: true,
    });
    // A pre-commit dial failure throws out of the send: the executor's catch releases
    // the turn lease, and the slot now reports it.
    await expect(executor("https://example.test/runsse")).rejects.toThrow("dial failed before commit");
    expect(slot.released).toBe(true);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    // Another turn takes the only lease. The redial through the SAME stateful wrapper
    // must queue behind it with concurrency admission instead of firing uncounted.
    const holder = await waitForProviderRequestSlot("demo", configured, "model-a");
    const redial = executor("https://example.test/redial");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    holder.release();
    const response = await redial;
    expect(calls).toBe(2);
    expect(await response.text()).toBe("redial ok");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("beforeAdmission drops a parked body ahead of the pacing wait, not behind it", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const send = providerFetch(configured, undefined, { providerName: "demo", modelId: "model-a" });
    const physical = createAdapterPhysicalSend({}, send);
    // A retryable-looking response parks its tracked body; under a cap of one the next
    // attempt can only be admitted once that body is cancelled.
    const first = await physical({
      url: "https://example.test/attempt",
      dispatch: async () => new Response(openBodyStream()),
    });
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    const admittedAt: number[] = [];
    const second = await physical({
      url: "https://example.test/retry",
      beforeAdmission: () => { void first.body!.cancel().catch(() => {}); },
      beforeDispatch: () => { admittedAt.push(clock.now()); },
      dispatch: async () => new Response("retried"),
    });
    expect(await second.text()).toBe("retried");
    expect(admittedAt).toEqual([0]);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("a configured cap without providerName refuses the send instead of skipping enforcement", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const executor = providerFetch(configured);
    await expect(executor("https://example.test/v1/send"))
      .rejects.toThrow("providerName");
  });

  test("pacingSlotAcquired without a slot refuses the send instead of skipping enforcement", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const executor = providerFetch(configured, undefined, {
      providerName: "demo",
      modelId: "model-a",
      pacingSlotAcquired: true,
    });
    await expect(executor("https://example.test/v1/send"))
      .rejects.toThrow("providerFetch requires pacingSlot");
  });

  test("a concurrency cap downgrades an eligible WebSocket turn to HTTP/SSE once per provider", async () => {
    __resetEgressWebsocketDowngradeNotices();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      const sends: string[] = [];
      const configured = {
        ...provider({ enabled: true, maxConcurrentRequests: 2 }),
        fetch: (async (input: Parameters<typeof globalThis.fetch>[0]) => {
          sends.push(String(input));
          return new Response("http ok");
        }) as typeof globalThis.fetch,
      } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
      const executor = providerFetch(configured, "1.4.0", { providerName: "demo", modelId: "model-a" });
      const init = { method: "POST", body: JSON.stringify({ stream: true }) };
      const first = await executor(CODEX_RESPONSES_HTTP_URL, init);
      expect(await first.text()).toBe("http ok");
      // The custom executor only sits under the HTTP path, so a served body proves the
      // downgrade; the WebSocket upstream was never dialed.
      expect(sends).toEqual([CODEX_RESPONSES_HTTP_URL]);
      const second = await executor(CODEX_RESPONSES_HTTP_URL, init);
      expect(await second.text()).toBe("http ok");
      expect(sends.length).toBe(2);
      const downgradeWarnings = warnings.filter(warning => warning.includes("requestPacing.maxConcurrentRequests"));
      expect(downgradeWarnings.length).toBe(1);
      expect(downgradeWarnings[0]).toContain("served over HTTP/SSE");
      expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a send refused before the executor consumes the lease returns it at the boundary release", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const slot = await waitForProviderRequestSlot("demo", configured, "model-a");
    const executor = providerFetch(configured, undefined, {
      providerName: "demo",
      modelId: "model-a",
      pacingSlotAcquired: true,
      pacingSlot: slot,
    });
    const controller = new AbortController();
    controller.abort(new Error("client gone"));
    const send = createAdapterPhysicalSend({ abortSignal: controller.signal }, executor);
    // The refusal fires before waitForPacing, so the executor never consumes the lease...
    await expect(send({
      url: "https://example.test/inference",
      dispatch: async () => new Response("never"),
    })).rejects.toBeTruthy();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    // ...and the dispatch-boundary finally (releaseProviderRequestSlot) returns it.
    releaseProviderRequestSlot(slot);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    const next = await waitForProviderRequestSlot("demo", configured, "model-a");
    next.release();
  });

  test("a retried send after a refused dispatch re-acquires a real lease", async () => {
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: (async () => new Response(openBodyStream())) as typeof fetch,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const initial = await waitForProviderRequestSlot("demo", configured, "model-a");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    // Attempt 0: the selection guard refuses the first dispatch inside the executor,
    // and the executor's catch releases the pre-acquired lease before rethrowing.
    let selectionCurrent = false;
    const firstExecutor = providerFetch(configured, undefined, {
      providerName: "demo",
      modelId: "model-a",
      pacingSlotAcquired: true,
      pacingSlot: initial,
      turnScopedPacing: true,
      beforeDispatch: () => {
        if (!selectionCurrent) throw new Error("Account selection changed before the first turn dispatch");
      },
    });
    await expect(firstExecutor("https://example.test/runsse"))
      .rejects.toThrow("Account selection changed before the first turn dispatch");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    // The transport's retry must acquire a fresh lease rather than resend on the
    // released handle: the retried send counts against the cap while its body is open.
    const retrySlot = await waitForProviderRequestSlot("demo", configured, "model-a");
    expect(retrySlot.leased).toBe(true);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    selectionCurrent = true;
    const retryExecutor = providerFetch(configured, undefined, {
      providerName: "demo",
      modelId: "model-a",
      pacingSlotAcquired: true,
      pacingSlot: retrySlot,
      turnScopedPacing: true,
    });
    const retried = await retryExecutor("https://example.test/runsse");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    // Turn boundary: the tracked body still owns the lease, so the release is skipped.
    releaseProviderRequestSlot(retrySlot);
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    await retried.body!.cancel("run finished");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("wrapping a leased response preserves identity-based replay markers", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const first = await waitForProviderRequestSlot("demo", configured, "model-a");
    const refusal = retainReplayRefusal(new Response("refused"));
    const wrappedRefusal = trackProviderRequestSlotBody(first, refusal);
    expect(isNonReplayableResponse(wrappedRefusal)).toBe(true);
    expect(isReplayRefusalResponse(wrappedRefusal)).toBe(true);
    await wrappedRefusal.text();
    const second = await waitForProviderRequestSlot("demo", configured, "model-a");
    const plain = trackProviderRequestSlotBody(second, new Response("ok"));
    expect(isNonReplayableResponse(plain)).toBe(false);
    expect(isReplayRefusalResponse(plain)).toBe(false);
    await plain.text();
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });

  test("withProviderRequestSlot returns the lease when the send fails before dispatch", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    await expect(withProviderRequestSlot("demo", configured, "model-a", undefined, async () => {
      throw new Error("send refused before the wire");
    })).rejects.toThrow("send refused before the wire");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
    const next = await waitForProviderRequestSlot("demo", configured, "model-a");
    expect(next.leased).toBe(true);
    next.release();
  });

  test("withProviderRequestSlot leaves a body-owned lease to the body lifecycle", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const tracked = await withProviderRequestSlot("demo", configured, "model-a", undefined, async slot => {
      return trackProviderRequestSlotBody(slot, new Response(openBodyStream()));
    });
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(1);
    await tracked.body!.cancel("consumer done");
    expect(providerRequestPacingStatus("demo", configured).inFlight).toBe(0);
  });
});

describe("requestPacingConfigError concurrency validation", () => {
  test("accepts concurrency-only pacing at provider and model level", () => {
    expect(requestPacingConfigError({ enabled: true, maxConcurrentRequests: 5 })).toBeNull();
    expect(requestPacingConfigError({
      enabled: true,
      requestsPerMinute: 40,
      models: { "zai/glm-5.3": { maxConcurrentRequests: 2 } },
    })).toBeNull();
    expect(requestPacingConfigError({ enabled: true, models: { busy: { maxConcurrentRequests: 1 } } })).toBeNull();
  });

  test("rejects invalid concurrency caps", () => {
    expect(requestPacingConfigError({ enabled: true, maxConcurrentRequests: 0 })).toMatch(/maxConcurrentRequests/);
    expect(requestPacingConfigError({ enabled: true, maxConcurrentRequests: 1.5 })).toMatch(/maxConcurrentRequests/);
    expect(requestPacingConfigError({ enabled: true, maxConcurrentRequests: 1001 })).toMatch(/maxConcurrentRequests/);
    expect(requestPacingConfigError({ enabled: true, maxConcurrentRequest: 2 })).toMatch(/maxConcurrentRequests/);
  });
});
