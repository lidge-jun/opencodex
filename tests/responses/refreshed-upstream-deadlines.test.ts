import { expect, spyOn, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { handleResponses } from "../../src/server/responses";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { clearKeyCooldowns } from "../../src/providers/key-failover";

for (const trigger of ["queued", "key-rotation"] as const) for (const adapter of ["openai-chat", "openai-responses", "command-code"] as const) test.each([
  { initial: "http://127.0.0.1:8000/v1", final: "https://gateway.example/v1", clocks: 1 },
  { initial: "https://gateway.example/v1", final: "http://127.0.0.1:8000/v1", clocks: 0 },
])(`${trigger} Responses ${adapter} uses final header policy: $initial -> $final`, async row => {
  const release = acquireOwnedSpendHome();
  resetProviderRequestPacingForTest();
  clearKeyCooldowns();
  const originalTimer = globalThis.setTimeout;
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const callbacks: Array<() => void> = [];
  const timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    if (delay !== 200_000) return originalTimer(callback, delay, ...args);
    callbacks.push(callback);
    const timer = originalTimer(() => {}, 2_000_000);
    timers.push(timer);
    return timer;
  }) as typeof setTimeout);
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>();
  const headers = Promise.withResolvers<void>();
  const parent = new AbortController();
  const sends: string[] = [];
  globalThis.fetch = (async input => {
    sends.push(String(input));
    if (trigger === "key-rotation" && sends.length === 1) {
      config.providers.fixture = { ...config.providers.fixture!, baseUrl: row.final };
      saveConfig(config);
      return Response.json({ error: { message: "fixture rejected credential" } }, { status: adapter === "openai-responses" ? 429 : 401 });
    }
    entered.resolve(); await headers.promise;
    if (adapter === "command-code") return new Response('{"type":"text-delta","text":"fixture reply"}\n{"type":"finish","finishReason":"stop"}\n');
    if (adapter === "openai-chat") return Response.json({ id: "fixture", choices: [{ message: { role: "assistant", content: "fixture reply" }, finish_reason: "stop" }] });
    return Response.json({ id: "fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "fixture reply" }] }] });
  }) as typeof fetch;
  const config: OcxConfig = { defaultProvider: "fixture", providers: { fixture: {
    adapter, authMode: "key", apiKey: "fixture-key", baseUrl: row.initial,
    models: ["fixture-model"], allowPrivateNetwork: true, apiKeySelectionRevision: "initial",
    ...(trigger === "key-rotation" ? { apiKeyPool: [{ id: "first", key: "fixture-key" }, { id: "second", key: "fixture-refreshed-key" }] } : {}),
    requestPacing: { enabled: true, maxConcurrentRequests: 1 },
  } } };
  saveConfig(config);
  const provider = config.providers.fixture!;
  const held = trigger === "queued" ? await waitForProviderRequestSlot("fixture", provider, "fixture-model") : undefined;
  const pending = handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
    body: JSON.stringify({ model: "fixture/fixture-model", input: "fixture", stream: false }),
  }), config, { model: "", provider: "" });
  let settled: Response | undefined;
  void pending.then(response => { settled = response; });
  try {
    while (trigger === "queued" && providerRequestPacingStatus("fixture", provider).queued === 0) {
      if (settled) throw new Error(`never queued: ${settled.status} ${await settled.text()}`);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (trigger === "queued") {
      config.providers.fixture = { ...provider, baseUrl: row.final, apiKey: "fixture-refreshed-key", apiKeySelectionRevision: "refreshed" };
      saveConfig(config); held!.release();
    }
    await Promise.race([entered.promise, pending.then(result => { throw new Error(`never dispatched: ${result.status}`); })]);
    const suffix = adapter === "openai-chat" ? "/chat/completions" : adapter === "command-code" ? "/alpha/generate" : "/responses";
    expect(sends).toEqual([...(trigger === "key-rotation" ? [`${row.initial}${suffix}`] : []), `${row.final}${suffix}`]);
    expect(callbacks).toHaveLength(row.clocks + (trigger === "key-rotation" && row.initial.startsWith("https:") ? 1 : 0));
    headers.resolve();
    const response = await pending;
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(body).toContain("fixture reply");
  } finally {
    parent.abort(); headers.resolve(); held?.release(); await pending.catch(() => {});
    globalThis.fetch = originalFetch; timerSpy.mockRestore(); timers.forEach(clearTimeout);
    resetProviderRequestPacingForTest(); clearKeyCooldowns(); release();
  }
});

for (const wire of ["responses", "chat", "messages"] as const) test.each([
  { initial: "https://gateway.example/v1", final: "http://127.0.0.1:8000/v1", explicit: undefined, expires: false },
  { initial: "http://127.0.0.1:8000/v1", final: "https://gateway.example/v1", explicit: undefined, expires: true },
  { initial: "https://gateway.example/v1", final: "http://127.0.0.1:8000/v1", explicit: 1, expires: true },
])(`streaming ${wire} continuation follows final stall policy: $initial -> $final, explicit=$explicit`, async row => {
  const release = acquireOwnedSpendHome();
  const originalFetch = globalThis.fetch;
  const originalInterval = globalThis.setInterval;
  const beats: Array<() => void> = [];
  const intervals: Array<ReturnType<typeof setInterval>> = [];
  const clock = spyOn(globalThis, "setInterval").mockImplementation(((callback, delay, ...args) => {
    if (delay !== 2_000) return originalInterval(callback, delay, ...args);
    beats.push(callback as () => void);
    const handle = originalInterval(() => {}, 2_000_000);
    intervals.push(handle); return handle;
  }) as typeof setInterval);
  const parent = new AbortController();
  const reading = Promise.withResolvers<void>();
  let secondSignal!: AbortSignal;
  const sends: string[] = [];
  const config: OcxConfig = { defaultProvider: "fixture", stallTimeoutSec: row.explicit, providers: { fixture: {
    adapter: "openai-chat", authMode: "key", apiKey: "fixture-key", baseUrl: row.initial,
    models: ["fixture-model"], allowPrivateNetwork: true, apiKeySelectionRevision: "initial", terminalContinuationGuard: true,
  } } };
  saveConfig(config);
  globalThis.fetch = (async (input, init) => {
    sends.push(String(input));
    if (sends.length === 1) {
      config.providers.fixture = { ...config.providers.fixture!, baseUrl: row.final, apiKeySelectionRevision: "refreshed" };
      saveConfig(config);
      return new Response('data: {"id":"fixture","choices":[{"delta":{"content":"I will modify the file now."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }
    secondSignal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({ pull() { reading.resolve(); } }, { highWaterMark: 0 }),
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  let body: Promise<string> | undefined;
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
      body: JSON.stringify({ model: "fixture/fixture-model", input: "Please modify the file", stream: true,
        tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: {} } }] }),
    }), config, { model: "", provider: "" }, wire === "responses" ? {} : { clientEncoder: { protocol: wire === "chat" ? "chat" : "anthropic", model: "fixture-model", stream: true } });
    body = response.text();
    await Promise.race([reading.promise, body.then(text => { throw new Error(`no continuation: ${text}`); })]);
    expect(sends).toEqual([`${row.initial}/chat/completions`, `${row.final}/chat/completions`]);
    // Drain each beat's frames so client backpressure cannot suppress the watchdog.
    for (let tick = 0; tick < 200; tick++) {
      for (const beat of beats) beat();
      for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    }
    expect(secondSignal.aborted).toBe(row.expires);
    if (row.expires) expect(await body).toContain("upstream_stall_timeout");
    else {
      parent.abort();
      expect(secondSignal.aborted).toBe(true);
      expect(await body).not.toContain("upstream_stall_timeout");
    }
  } finally {
    parent.abort(); await body?.catch(() => {});
    globalThis.fetch = originalFetch; clock.mockRestore(); intervals.forEach(clearInterval); release();
  }
});
