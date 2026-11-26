import { expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { handleResponses, handleResponsesCompact } from "../../src/server/responses";
import { clientWireOf } from "../../src/server/inference/client-wire";
import * as adapterResolver from "../../src/server/adapter-resolve";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import { parseRequest } from "../../src/responses/parser";
import { planWebSearch } from "../../src/web-search";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { REPLAY_REFUSAL_MESSAGE } from "../../src/lib/upstream-retry";
import { repoPath } from "../helpers/repo-root";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Provider-scoped budgets: a provider's own connectTimeoutMs / stallTimeoutSec must win over the
// global value on routed adapter sends, while a provider without an override keeps the global.

function fixtureConfig(globals: Partial<OcxConfig>, overrides: Partial<OcxProviderConfig>): OcxConfig {
  return { port: 10100, defaultProvider: "fixture", ...globals, providers: { fixture: {
    adapter: "openai-chat", authMode: "key", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1",
    proxy: "direct", // Keep inherited SOCKS routing inside this file's in-memory fetch fixtures.
    models: ["fixture-model"], ...overrides,
  } } };
}

for (const row of [
  { name: "provider override wins", globalMs: 23_011, providerMs: 17_013, armed: [17_013] },
  { name: "provider without override keeps the global", globalMs: 23_011, providerMs: undefined, armed: [23_011] },
  { name: "provider 0 disables only its own header clock", globalMs: 23_011, providerMs: 0, armed: [] },
  { name: "passthrough keeps the global over a positive override", globalMs: 23_011, providerMs: 17_013, armed: [23_011], passthrough: true },
  { name: "passthrough keeps the global over a zero override", globalMs: 23_011, providerMs: 0, armed: [23_011], passthrough: true },
]) test(`Responses header deadline: ${row.name}`, async () => {
  const release = acquireOwnedSpendHome();
  clearKeyCooldowns();
  const watched = new Set([17_013, 23_011, 200_000]);
  const armed: number[] = [];
  const callbacks: Array<() => void> = [];
  const originalTimer = globalThis.setTimeout;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    if (typeof delay !== "number" || !watched.has(delay)) return originalTimer(callback, delay, ...args);
    armed.push(delay); callbacks.push(callback as () => void);
    const timer = originalTimer(() => {}, 2_000_000);
    timers.push(timer); return timer;
  }) as typeof setTimeout);
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>();
  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends++;
    const signal = init!.signal!;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const config = fixtureConfig({ connectTimeoutMs: row.globalMs }, {
    ...(row.passthrough ? { adapter: "openai-responses" } : {}),
    ...(row.providerMs === undefined ? {} : { connectTimeoutMs: row.providerMs }),
  });
  saveConfig(config);
  const parent = new AbortController();
  const pending = handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
    body: JSON.stringify({ model: "fixture/fixture-model", input: "fixture", stream: false }),
  }), config, { model: "", provider: "" });
  try {
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`never dispatched: ${result.status}`); })]);
    expect(armed).toEqual(row.armed);
    if (row.armed.length > 0) {
      callbacks[0]!();
      const response = await pending;
      expect(sends).toBe(1);
      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(response.headers.get("retry-after")).toBeNull();
      expect(await response.json()).toMatchObject({ error: {
        code: "upstream_reset_replay_refused", message: REPLAY_REFUSAL_MESSAGE,
      } });
    }
  } finally {
    parent.abort(); await pending.catch(() => {});
    globalThis.fetch = originalFetch; timerSpy.mockRestore(); timers.forEach(clearTimeout);
    clearKeyCooldowns(); release();
  }
});

for (const row of [
  { name: "provider override expires a silent stream", providerSec: 1, expires: true },
  { name: "provider without override keeps the longer global", providerSec: undefined, expires: false },
]) test(`Responses stall watchdog: ${row.name}`, async () => {
  const release = acquireOwnedSpendHome();
  clearKeyCooldowns();
  const originalInterval = globalThis.setInterval;
  const beats: Array<() => void> = [];
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  const clock = spyOn(globalThis, "setInterval").mockImplementation(((callback, delay, ...args) => {
    if (delay !== 2_000) return originalInterval(callback, delay, ...args);
    beats.push(callback as () => void);
    const handle = originalInterval(() => {}, 2_000_000);
    intervals.push(handle); return handle;
  }) as typeof setInterval);
  const originalFetch = globalThis.fetch;
  const reading = Promise.withResolvers<void>();
  let upstreamSignal!: AbortSignal;
  globalThis.fetch = (async (_input, init) => {
    upstreamSignal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(); } }, { highWaterMark: 0 }),
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const config = fixtureConfig({ stallTimeoutSec: 600 }, row.providerSec === undefined ? {} : { stallTimeoutSec: row.providerSec });
  saveConfig(config);
  const parent = new AbortController();
  let body: Promise<string> | undefined;
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
      body: JSON.stringify({ model: "fixture/fixture-model", input: "fixture", stream: true }),
    }), config, { model: "", provider: "" });
    body = response.text();
    await Promise.race([reading.promise, body.then(text => { throw new Error(`never read upstream: ${text}`); })]);
    // Drain each beat's frames so client backpressure cannot suppress the watchdog.
    for (let tick = 0; tick < 20; tick++) {
      for (const beat of beats) beat();
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    }
    expect(upstreamSignal.aborted).toBe(row.expires);
    if (row.expires) expect(await body).toContain("upstream_stall_timeout");
    else {
      parent.abort();
      expect(await body).not.toContain("upstream_stall_timeout");
    }
  } finally {
    parent.abort(); await body?.catch(() => {});
    globalThis.fetch = originalFetch; clock.mockRestore(); intervals.forEach(clearInterval);
    clearKeyCooldowns(); release();
  }
});

test.each([
  { wire: "chat", completed: '"finish_reason":"stop"' },
  { wire: "messages", completed: "event: message_stop" },
  { wire: "responses", completed: "event: response.completed" },
] as const)("$wire stall watchdog measures the gap between parsed upstream events", async ({ wire, completed }) => {
  for (const expires of [false, true]) {
    const release = acquireOwnedSpendHome();
    const config = fixtureConfig({ stallTimeoutSec: 40 }, { stallTimeoutSec: 3 });
    const originalFetch = globalThis.fetch;
    const originalInterval = globalThis.setInterval;
    const beats: Array<() => void> = [];
    const intervals: Array<ReturnType<typeof setInterval>> = [];
    const clock = spyOn(globalThis, "setInterval").mockImplementation(((callback, delay, ...args) => {
      if (delay !== 2_000) return originalInterval(callback, delay, ...args);
      beats.push(callback as () => void);
      const handle = originalInterval(() => {}, 2_000_000);
      intervals.push(handle);
      return handle;
    }) as typeof setInterval);
    const waitingForMiddle = Promise.withResolvers<void>();
    const sendMiddle = Promise.withResolvers<void>();
    const waitingForEnd = Promise.withResolvers<void>();
    const sendEnd = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        switch (++pullCount) {
          case 1:
            controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"first event"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"split'));
            break;
          case 2:
            waitingForMiddle.resolve();
            await sendMiddle.promise;
            if (cancelled) return;
            controller.enqueue(encoder.encode(" frame"));
            break;
          case 3:
            waitingForEnd.resolve();
            await sendEnd.promise;
            if (cancelled) return;
            controller.enqueue(encoder.encode(' complete"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
            controller.close();
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const parent = new AbortController();
    const translatorBudget = createTestTranslatorBudget();
    let body: Promise<string> | undefined;
    try {
      saveConfig(config);
      const request = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
        body: JSON.stringify({ model: "fixture/fixture-model", stream: true, input: "fixture" }),
      });
      const response = await handleResponses(request, config, { model: "", provider: "" }, {
        translatorBudget,
        ...(wire === "responses" ? {} : {
          inboundWire: wire === "chat" ? "chat" : "anthropic",
          clientEncoder: { protocol: wire, stream: true, model: "fixture/fixture-model" },
        }),
      });
      body = response.text();
      expect(clientWireOf(response)).toBe(wire === "responses" ? undefined : wire);
      const endedEarly = body.then(text => { throw new Error(`stream ended before the partial frame: ${text}`); });
      await Promise.race([waitingForMiddle.promise, endedEarly]);
      expect(beats).toHaveLength(1);
      const [beat] = beats;
      beat!(); // Observe the first parsed event and start counting idle beats.
      sendMiddle.resolve();
      await Promise.race([waitingForEnd.promise, endedEarly]);
      beat!(); // Two seconds since the last parsed event, despite the middle chunk.
      if (expires) beat!(); // Four seconds without a parsed event exceeds the three-second override.
      sendEnd.resolve();

      const text = await body;
      expect(text).toContain("first event");
      if (expires) {
        expect(text).toContain("upstream_stall_timeout");
        expect(text).not.toContain("split frame complete");
        expect(text).not.toContain(completed);
      } else {
        expect(text).toContain("split frame complete");
        expect(text).toContain(completed);
        expect(text).not.toContain("upstream_stall_timeout");
      }
    } finally {
      parent.abort();
      sendMiddle.resolve();
      sendEnd.resolve();
      await body?.catch(() => {});
      globalThis.fetch = originalFetch;
      clock.mockRestore();
      intervals.forEach(clearInterval);
      translatorBudget.dispose();
      clearKeyCooldowns();
      release();
    }
  }
});

test("web-search plan sizes its bridge stall from the routed provider's budgets", () => {
  const routed: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "routed-key" };
  const forward: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.test/v1", authMode: "forward" };
  const plan = (provider: OcxProviderConfig) => planWebSearch(
    { port: 10100, defaultProvider: "routed", providers: { routed: provider, chatgpt: forward } },
    parseRequest({ model: "routed/model", input: "Search current docs", stream: true, tools: [{ type: "web_search" }] }),
    false, provider, "model",
    { providerName: "openai", provider: forward, accountMode: "direct", authContext: { kind: "main", accountId: null },
      headers: new Headers({ authorization: "Bearer chatgpt" }) },
  );
  const inherited = plan(routed);
  const widened = plan({ ...routed, connectTimeoutMs: 900_000, stallTimeoutSec: 1_200 });
  expect(inherited?.stallTimeoutSec).toBeLessThan(1_200);
  expect(widened?.stallTimeoutSec).toBeGreaterThanOrEqual(1_200);
});

function compactRequest(model: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses/compact", {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ model, input: [{ type: "message", role: "user", content: "Keep the task state." }] }),
  });
}

for (const overrides of [
  { connectTimeoutMs: 17_013, stallTimeoutSec: 31 },
  { connectTimeoutMs: 0, stallTimeoutSec: 0 },
]) test(`compact HTTP sends, retry and buffered body use global deadlines with provider overrides ${JSON.stringify(overrides)}`, async () => {
  const release = acquireOwnedSpendHome();
  clearKeyCooldowns();
  const config = fixtureConfig({ connectTimeoutMs: 23_011, stallTimeoutSec: 39 }, {
    ...overrides, transientRetryOn5xx: { attempts: 2 },
  });
  const headerBudgets: number[] = [];
  const budgetsAtSend: number[][] = [];
  const bodyBudgets = new Set<number>();
  const originalTimer = globalThis.setTimeout;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    if (delay === 17_013 || delay === 23_011) headerBudgets.push(delay);
    if (budgetsAtSend.length === 2 && typeof delay === "number") {
      for (const ms of [31_000, 39_000]) {
        if (delay > ms - 100 && delay <= ms) bodyBudgets.add(ms);
      }
    }
    return originalTimer(callback, delay, ...args);
  }) as typeof setTimeout);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    budgetsAtSend.push(headerBudgets.splice(0));
    if (budgetsAtSend.length === 1) {
      return Response.json({ error: { message: "temporary upstream failure" } }, { status: 503 });
    }
    return Response.json({
      id: "chatcmpl-fixture", model: "fixture-model",
      choices: [{ index: 0, message: { role: "assistant", content: "Retain progress and resume the task." }, finish_reason: "stop" }],
    });
  }) as typeof fetch;
  try {
    saveConfig(config);
    const response = await handleResponsesCompact(compactRequest("fixture/fixture-model"), config, { model: "", provider: "" });
    expect({ status: response.status, budgetsAtSend, bodyBudgets: [...bodyBudgets] }).toEqual({
      status: 200, budgetsAtSend: [[23_011], [23_011]], bodyBudgets: [39_000],
    });
  } finally {
    globalThis.fetch = originalFetch;
    clock.mockRestore();
    clearKeyCooldowns();
    release();
  }
});

for (const providerSec of [600, 0]) test(`compact streaming runTurn uses the global stall watchdog with provider override ${providerSec}`, async () => {
  const release = acquireOwnedSpendHome();
  const config = fixtureConfig({
    stallTimeoutSec: 1,
    combos: { compact: { targets: [{ provider: "fixture", model: "fixture-model" }] } },
  }, { stallTimeoutSec: providerSec });
  const entered = Promise.withResolvers<AbortSignal>();
  const originalResolve = adapterResolver.resolveAdapter;
  const adapter = spyOn(adapterResolver, "resolveAdapter").mockImplementation((provider, cache) => ({
    ...originalResolve(provider, cache),
    async runTurn(_parsed, meta, emit) {
      const signal = meta.abortSignal!;
      emit({ type: "text_delta", text: "Starting the summary." });
      entered.resolve(signal);
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
  }));
  const originalInterval = globalThis.setInterval;
  const watchdogArmed = Promise.withResolvers<void>();
  const beats: Array<() => void> = [];
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  const clock = spyOn(globalThis, "setInterval").mockImplementation(((callback, delay, ...args) => {
    if (delay !== 2_000) return originalInterval(callback, delay, ...args);
    beats.push(callback as () => void);
    watchdogArmed.resolve();
    const handle = originalInterval(() => {}, 2_000_000);
    intervals.push(handle);
    return handle;
  }) as typeof setInterval);
  const parent = new AbortController();
  let pending: Promise<Response> | undefined;
  try {
    saveConfig(config);
    pending = handleResponsesCompact(compactRequest("combo/compact", parent.signal), config, { model: "", provider: "" });
    const [signal] = await Promise.race([
      Promise.all([entered.promise, watchdogArmed.promise]),
      pending.then(result => { throw new Error(`runTurn ended before the watchdog started: ${result.status}`); }),
    ]);
    // Let compact drain the created/in-progress frames before advancing each heartbeat.
    for (let tick = 0; tick < 4 && !signal.aborted; tick++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const beat of beats) beat();
    }
    expect(signal.aborted).toBe(true);
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("compaction turn did not complete (status: incomplete)");
  } finally {
    parent.abort();
    await pending?.catch(() => {});
    adapter.mockRestore();
    clock.mockRestore();
    intervals.forEach(clearInterval);
    release();
  }
});

test("management writes reject malformed provider budgets and accept 0 or a positive integer", () => {
  const provider = { adapter: "openai-chat", authMode: "key", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1" };
  for (const value of [-1, 1.5, "120000", Number.NaN, 2_147_483_648]) {
    expect(providerManagementConfigError("fixture", { ...provider, connectTimeoutMs: value })).toContain("connectTimeoutMs");
  }
  expect(providerManagementConfigError("fixture", { ...provider, stallTimeoutSec: 2_147_484 })).toContain("stallTimeoutSec");
  for (const value of [0, 1, 120_000]) {
    expect(providerManagementConfigError("fixture", { ...provider, connectTimeoutMs: value, stallTimeoutSec: value === 120_000 ? 600 : value })).toBeNull();
  }
});

test("provider timeout API docs distinguish HTTP headers from runTurn inactivity", async () => {
  const source = await Bun.file(repoPath("src/types/provider.ts")).text();
  const headerDoc = source.match(/\/\*\*\s*\n\s*\* Per-provider override of the global `connectTimeoutMs`[^]*?\*\/\s*connectTimeoutMs\?: number;/)?.[0];
  const stallDoc = source.match(/\/\*\*\s*\n\s*\* Per-provider override of the global `stallTimeoutSec`[^]*?\*\/\s*stallTimeoutSec\?: number;/)?.[0];
  expect(headerDoc).toMatch(/\brouted HTTP\b/);
  expect(headerDoc).toMatch(/\brunTurn owns its transport\b/);
  expect(stallDoc).toMatch(/\bstreaming runTurn\b/);
});
