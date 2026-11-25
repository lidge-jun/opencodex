import { expect, spyOn, test } from "bun:test";
import { fetchGoogleWithRetry } from "../../../src/adapters/google-http";
import { providerFetch } from "../../../src/server/responses/fetch-helpers";
import {
  providerRequestPacingStatus,
  REQUEST_PACING_UNCONSUMED_BODY_MS,
  resetProviderRequestPacingForTest,
  setProviderRequestPacingRuntimeForTest,
} from "../../../src/providers/request-pacing";
import type { OcxProviderConfig } from "../../../src/types";

// Regression: release the previous response before waiting for another pacing lease.
// Every executor is in memory; virtual time drives both pacing and Google backoff.
async function reproduce(lanes: number) {
  let now = 0, nextId = 1, cancelled = 0, pulled = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const schedule = (callback: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
    return id;
  };
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const advanceTo = async (target: number) => {
    await flush();
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id); now = timer.at; timer.callback(); await flush();
    }
    now = target; await flush();
  };
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(schedule as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(handle => { timers.delete(Number(handle)); });
  const dateSpy = spyOn(Date, "now").mockImplementation(() => now);
  const perfSpy = spyOn(performance, "now").mockImplementation(() => now);
  const randomSpy = spyOn(Math, "random").mockReturnValue(0); // Google backoff = 200ms.
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  const parent = new AbortController();
  const sends: Array<{ lane: number; ordinal: number; at: number }> = [];
  const counts = new Map<number, number>();
  const completions: Promise<string>[] = [];
  const configured: OcxProviderConfig = {
    adapter: "google", googleMode: "cloud-code-assist", authMode: "oauth",
    baseUrl: "https://held-lease.invalid",
    requestPacing: { enabled: true, maxConcurrentRequests: 5, minIntervalMs: 0 },
  };
  const executor = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const lane = Number(init?.body);
    const ordinal = (counts.get(lane) ?? 0) + 1;
    counts.set(lane, ordinal); sends.push({ lane, ordinal, at: now });
    if (ordinal > 1) return new Response("ok");
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode("retryable")); controller.close(); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 }), { status: 503 });
  }, { preconnect() {} }) as typeof fetch;
  setProviderRequestPacingRuntimeForTest({
    now: () => now, setTimer: schedule, clearTimer: handle => { timers.delete(Number(handle)); },
    enqueueMicrotask: queueMicrotask, random: () => 0,
  });
  const paced = providerFetch({ ...configured, fetch: executor }, undefined,
    { providerName: "google-antigravity", modelId: "fixture" });
  try {
    for (let lane = 0; lane < lanes; lane++) {
      // Consume EACH final 200 immediately: waiting for Promise.all before reading would
      // introduce a second, fixture-created lease bottleneck and invalidate this test.
      completions.push(fetchGoogleWithRetry("Antigravity", {
        url: "https://held-lease.invalid/inference", method: "POST", headers: {}, body: String(lane),
      }, { executor: paced, abortSignal: parent.signal, timeoutMs: 200_000, returnRawErrors: true })
        .then(response => response.text()));
    }
    await flush();
    expect(sends).toHaveLength(lanes);
    expect(pulled).toBe(0);
    expect(providerRequestPacingStatus("google-antigravity", configured)).toMatchObject({ inFlight: 0, queued: 0 });
    expect(cancelled).toBe(lanes);
    await advanceTo(199);
    expect(sends).toHaveLength(lanes);
    await advanceTo(250);
    expect(sends.filter(send => send.ordinal === 2)).toHaveLength(lanes);
    expect(sends.filter(send => send.ordinal === 2).every(send => send.at === 200)).toBe(true);
    expect(await Promise.all(completions)).toEqual(Array(lanes).fill("ok"));
    expect(cancelled).toBe(lanes); expect(pulled).toBe(0);
    expect(providerRequestPacingStatus("google-antigravity", configured)).toMatchObject({ inFlight: 0, queued: 0 });
    expect(timers.size).toBe(0);
  } finally {
    parent.abort(); await Promise.allSettled(completions);
    resetProviderRequestPacingForTest(); timers.clear();
    warnSpy.mockRestore(); randomSpy.mockRestore(); perfSpy.mockRestore(); dateSpy.mockRestore();
    clearSpy.mockRestore(); timerSpy.mockRestore();
  }
}

test("five unread 503 bodies release all leases before retry backoff", () => reproduce(5));
test("single retry also releases its lease before backoff", () => reproduce(1));

test("real loopback HTTP: five saturated retries complete without 30-second lease reclamation", async () => {
  const counts = new Map<string, number>();
  const seen: Array<{ lane: string; authorization: string | null; model: string | null }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const lane = await request.text();
    seen.push({ lane, authorization: request.headers.get("authorization"), model: request.headers.get("x-model") });
    const n = (counts.get(lane) ?? 0) + 1; counts.set(lane, n);
    return new Response(n === 1 ? "retryable" : "ok", { status: n === 1 ? 503 : 200 });
  } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("loopback stalled")), 5000);
  const configured: OcxProviderConfig = {
    adapter: "google", googleMode: "cloud-code-assist", authMode: "oauth",
    baseUrl: server.url.origin,
    requestPacing: { enabled: true, maxConcurrentRequests: 5, minIntervalMs: 0 },
  };
  const executor = providerFetch({ ...configured, fetch: globalThis.fetch }, undefined,
    { providerName: "google-antigravity", modelId: "fixture-argon" });
  const tasks: Promise<string>[] = [];
  try {
    for (let lane = 0; lane < 5; lane++) tasks.push(fetchGoogleWithRetry("Antigravity", {
      url: server.url.href, method: "POST", body: String(lane),
      headers: { authorization: "Bearer fixture-only", "x-model": "fixture-argon" },
    }, { executor, abortSignal: controller.signal, timeoutMs: 4000, returnRawErrors: true })
      .then(response => response.text()));
    expect(await Promise.all(tasks)).toEqual(Array(5).fill("ok"));
    expect(seen).toHaveLength(10);
    expect([...counts.values()]).toEqual(Array(5).fill(2));
    expect(seen.every(row => row.authorization === "Bearer fixture-only" && row.model === "fixture-argon")).toBe(true);
    expect(providerRequestPacingStatus("google-antigravity", configured)).toMatchObject({ inFlight: 0, queued: 0 });
  } finally {
    clearTimeout(timer); controller.abort(); await Promise.allSettled(tasks);
    server.stop(true); resetProviderRequestPacingForTest();
  }
}, 10_000);
