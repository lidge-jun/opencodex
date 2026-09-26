import { afterEach, describe, expect, test } from "bun:test";
import {
  providerRequestPacingStatus,
  reconcileProviderRequestPacing,
  RequestPacingQueueOverloadError,
  requestPacingIntervalMs,
  resetProviderRequestPacingForTest,
  setProviderRequestPacingLimitsForTest,
  setProviderRequestPacingRuntimeForTest,
  waitForProviderRequestSlot,
  type RequestPacingRuntime,
} from "../../src/providers/request-pacing";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import { requestPacingOverloadResponse } from "../../src/server/responses/pacing-overload";
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

describe("provider request concurrency", () => {
  test("an active body holds capacity until cancellation", async () => {
    let sends = 0;
    const fetchImpl = Object.assign(async () => {
      sends += 1;
      return new Response(new ReadableStream({ start() {} }));
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = { ...provider({ enabled: true, maxConcurrentRequests: 1 }), fetch: fetchImpl };
    const executor = providerFetch(configured, undefined, { providerName: "demo", modelId: "a" });
    const first = await executor("https://example.test/first");
    const second = executor("https://example.test/second", { signal: AbortSignal.timeout(250) });
    await Bun.sleep(0);
    expect(sends).toBe(1);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    await first.body!.cancel();
    const resumed = await second;
    expect(sends).toBe(2);
    await resumed.body!.cancel();
  });

  test("an errored body and failed send return their leases", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let sends = 0;
    const fetchImpl = Object.assign(async () => {
      sends += 1;
      if (sends === 2) throw new Error("send failed");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; },
      }));
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = { ...provider({ enabled: true, maxConcurrentRequests: 1 }), fetch: fetchImpl };
    const executor = providerFetch(configured, undefined, { providerName: "demo", modelId: "a" });
    const first = await executor("https://example.test/first");
    const reading = first.text();
    streamController!.error(new Error("body failed"));
    await expect(reading).rejects.toThrow("body failed");
    await expect(executor("https://example.test/failed", { signal: AbortSignal.timeout(250) })).rejects.toThrow("send failed");
    const third = await executor("https://example.test/third", { signal: AbortSignal.timeout(250) });
    expect(sends).toBe(3);
    await third.body!.cancel();
  });

  test("a pre-acquired lease transfers to the response body", async () => {
    const fetchImpl = Object.assign(async () => new Response("ok"), { preconnect() {} }) as typeof globalThis.fetch;
    const configured = { ...provider({ enabled: true, maxConcurrentRequests: 1 }), fetch: fetchImpl };
    const pacingSlot = await waitForProviderRequestSlot("demo", configured, "a");
    const executor = providerFetch(configured, undefined, {
      providerName: "demo", modelId: "a", pacingSlotAcquired: true, pacingSlot,
    });
    expect(await (await executor("https://example.test/first")).text()).toBe("ok");
    expect(await (await executor("https://example.test/second", { signal: AbortSignal.timeout(250) })).text()).toBe("ok");
  });

  test("completed streamed response returns capacity for the next physical send", async () => {
    let sends = 0;
    const fetchImpl = Object.assign(async () => {
      sends += 1;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
        },
      }));
    }, { preconnect() {} }) as typeof globalThis.fetch;
    const configured = {
      ...provider({ enabled: true, maxConcurrentRequests: 1 }),
      fetch: fetchImpl,
    } as OcxProviderConfig & { fetch: typeof globalThis.fetch };
    const executor = providerFetch(configured, undefined, { providerName: "demo", modelId: "a" });
    const first = await fetchWithHeaderTimeout("https://example.test/v1/first", {}, new AbortController().signal, 1_000, false, executor);
    expect(await first.text()).toBe("ok");

    const secondSignal = AbortSignal.timeout(250);
    const second = await fetchWithHeaderTimeout("https://example.test/v1/second", {}, secondSignal, 1_000, false, executor);
    expect(await second.text()).toBe("ok");
    expect(sends).toBe(2);
  });

  test("caps all models together and release is idempotent", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 2 });
    const first = await waitForProviderRequestSlot("demo", configured, "a");
    const second = await waitForProviderRequestSlot("demo", configured, "b");
    const third = waitForProviderRequestSlot("demo", configured, "c");
    const fourth = waitForProviderRequestSlot("demo", configured, "d");
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    first.release();
    first.release();
    const releaseThird = await third;
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    second.release();
    const releaseFourth = await fourth;
    releaseThird.release();
    releaseFourth.release();
  });

  test("model limit tightens provider cap without blocking eligible siblings", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 3,
      models: { slow: { maxConcurrentRequests: 1 }, fast: { maxConcurrentRequests: 10 } } });
    const slow = await waitForProviderRequestSlot("demo", configured, "slow");
    const queuedSlow = waitForProviderRequestSlot("demo", configured, "slow");
    const fast = await waitForProviderRequestSlot("demo", configured, "fast");
    const anotherFast = await waitForProviderRequestSlot("demo", configured, "fast");
    const queuedFast = waitForProviderRequestSlot("demo", configured, "fast");
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(2);
    fast.release();
    const lastFast = await queuedFast;
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    slow.release();
    (await queuedSlow).release();
    anotherFast.release();
    lastFast.release();
  });

  test("model-only cap leaves other models and providers independent", async () => {
    const configured = provider({ enabled: true, models: { slow: { maxConcurrentRequests: 1 } } });
    const first = await waitForProviderRequestSlot("demo", configured, "slow");
    const queued = waitForProviderRequestSlot("demo", configured, "slow");
    (await waitForProviderRequestSlot("demo", configured, "other")).release();
    (await waitForProviderRequestSlot("other-provider", configured, "slow")).release();
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    first.release();
    (await queued).release();
  });

  test("aborting an active request frees exactly one slot", async () => {
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const controller = new AbortController();
    const release = await waitForProviderRequestSlot("demo", configured, "a", controller.signal);
    const next = waitForProviderRequestSlot("demo", configured, "a");
    controller.abort();
    const releaseNext = await next;
    release.release();
    const last = waitForProviderRequestSlot("demo", configured, "a");
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    releaseNext.release();
    (await last).release();
  });

  test("concurrency wait expires without spinning and preserves active capacity", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    setProviderRequestPacingLimitsForTest({ maxQueueAgeMs: 25, maxQueueDepth: 1 });
    const configured = provider({ enabled: true, maxConcurrentRequests: 1 });
    const release = await waitForProviderRequestSlot("demo", configured);
    const queued = waitForProviderRequestSlot("demo", configured);
    await expect(waitForProviderRequestSlot("demo", configured)).rejects.toMatchObject({ reason: "queue_full" });
    expect(clock.pendingTimerCount()).toBe(1);
    clock.advanceBy(25);
    await expect(queued).rejects.toMatchObject({ reason: "queue_expired" });
    expect(clock.pendingTimerCount()).toBe(0);
    const next = waitForProviderRequestSlot("demo", configured);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    release.release();
    (await next).release();
  });

  test("releasing capacity still honors the start interval", async () => {
    const clock = fakePacingClock();
    setProviderRequestPacingRuntimeForTest(clock.runtime);
    const configured = provider({ enabled: true, maxConcurrentRequests: 1, minIntervalMs: 100 });
    const release = await waitForProviderRequestSlot("demo", configured);
    const next = waitForProviderRequestSlot("demo", configured);
    release.release();
    clock.advanceBy(99);
    expect(providerRequestPacingStatus("demo", configured).queued).toBe(1);
    clock.advanceBy(1);
    (await next).release();
  });
});
