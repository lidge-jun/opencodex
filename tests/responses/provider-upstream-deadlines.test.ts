import { expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { handleResponses } from "../../src/server/responses";
import { providerManagementConfigError } from "../../src/server/auth-cors";
import { parseRequest } from "../../src/responses/parser";
import { planWebSearch } from "../../src/web-search";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";

// Provider-scoped budgets: a provider's own connectTimeoutMs / stallTimeoutSec must win over the
// global value on routed adapter sends, while a provider without an override keeps the global.

function fixtureConfig(globals: Partial<OcxConfig>, overrides: Partial<OcxProviderConfig>): OcxConfig {
  return { defaultProvider: "fixture", ...globals, providers: { fixture: {
    adapter: "openai-chat", authMode: "key", apiKey: "fixture-key", baseUrl: "https://gateway.example/v1",
    models: ["fixture-model"], ...overrides,
  } } };
}

for (const row of [
  { name: "provider override wins", globalMs: 23_011, providerMs: 17_013, armed: [17_013] },
  { name: "provider without override keeps the global", globalMs: 23_011, providerMs: undefined, armed: [23_011] },
  { name: "provider 0 disables only its own header clock", globalMs: 23_011, providerMs: 0, armed: [] },
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
  globalThis.fetch = (async (_input, init) => {
    const signal = init!.signal!;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const config = fixtureConfig({ connectTimeoutMs: row.globalMs }, row.providerMs === undefined ? {} : { connectTimeoutMs: row.providerMs });
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
      expect(response.status).toBeGreaterThanOrEqual(500);
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

