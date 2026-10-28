import { expect, spyOn, test } from "bun:test";
import { fetchWithHeaderTimeout } from "../../src/server/responses/fetch-helpers";
import { fetchWithHeaderDeadline } from "../../src/server/claude-messages";
import { clearableDeadline } from "../../src/lib/abort";
import { readBoundedResponseBody } from "../../src/lib/bounded-body";
import { isLocalUpstream } from "../../src/lib/local-upstream";
import { resolveConnectTimeoutMs, resolveJsonBodyReadTimeoutMs } from "../../src/stall-timeout";
import { handleResponsesCompact } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig } from "../../src/types";
import { saveConfig } from "../../src/config";
import { providerRequestPacingStatus, resetProviderRequestPacingForTest, waitForProviderRequestSlot } from "../../src/providers/request-pacing";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { compactionRequest, keyProviderConfig } from "../helpers/compaction-routing-fixtures";
import { createCommandCodeAdapter } from "../../src/adapters/command-code";

// Advance only the policy's clock, without a 200-second sleep or host-speed assumptions.
function clockAt(ms: number) {
  const callbacks: Array<() => void> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const original = globalThis.setTimeout;
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === ms) {
      callbacks.push(callback);
      const timer = original(() => {}, 2_000_000);
      timers.push(timer);
      return timer;
    }
    return original(callback, delay, ...args);
  }) as typeof setTimeout);
  return { callbacks, restore: () => { spy.mockRestore(); timers.forEach(clearTimeout); } };
}

test.each([0, -1])("Command Code disabled header budget %s keeps pending headers and parent cancellation", async timeoutMs => {
  const clock = clockAt(timeoutMs);
  const parent = new AbortController();
  const entered = Promise.withResolvers<AbortSignal>();
  const executor = (async (_input, init) => {
    const signal = init!.signal!;
    entered.resolve(signal);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const adapter = createCommandCodeAdapter({ baseUrl: "http://127.0.0.1:8000", apiKey: "fixture" });
  const pending = adapter.fetchResponse!({ url: "http://127.0.0.1:8000/alpha/generate", method: "POST", headers: {}, body: "{}" },
    { timeoutMs, abortSignal: parent.signal, executor }).catch(error => error);
  try {
    const signal = await entered.promise;
    expect(clock.callbacks).toHaveLength(0);
    expect(signal.aborted).toBe(false);
    const reason = new DOMException("client cancelled", "AbortError");
    parent.abort(reason);
    expect(await pending).toBe(reason);
  } finally { parent.abort(); await pending; clock.restore(); }
});

test.each([undefined, 17_011])("Command Code public header budget %s rejects pending headers and clears on success", async timeoutMs => {
  const clock = clockAt(timeoutMs ?? 200_000);
  const entered = Promise.withResolvers<AbortSignal>();
  const parent = new AbortController();
  const executor = (async (_input, init) => {
    const signal = init!.signal!;
    entered.resolve(signal);
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const adapter = createCommandCodeAdapter({ baseUrl: "https://gateway.example", apiKey: "fixture" });
  const request = { url: "https://gateway.example/alpha/generate", method: "POST", headers: {}, body: "{}" };
  const pending = adapter.fetchResponse!(request, { timeoutMs, abortSignal: parent.signal, executor }).catch(error => error);
  try {
    await entered.promise;
    expect(clock.callbacks).toHaveLength(1);
    clock.callbacks[0]!();
    expect(await pending).toMatchObject({ name: "TimeoutError" });
    let bodySignal!: AbortSignal;
    const clear = spyOn(globalThis, "clearTimeout");
    try {
      const result = await adapter.fetchResponse!(request, { timeoutMs, abortSignal: parent.signal,
        executor: (async (_input, init) => { bodySignal = init!.signal!; expect(init!.redirect).toBe("manual"); return new Response("fixture"); }) as typeof fetch });
      expect(await result.text()).toBe("fixture");
      expect(clear).toHaveBeenCalled();
      expect(bodySignal.aborted).toBe(false);
      parent.abort();
      expect(bodySignal.aborted).toBe(true);
    } finally { clear.mockRestore(); }
  } finally { parent.abort(); await pending; clock.restore(); }
});

test("local header wait retains an enclosing overall deadline", async () => {
  const clock = clockAt(17_009);
  const overall = clearableDeadline(17_009);
  const entered = Promise.withResolvers<void>();
  const executor = (async (_input, init) => {
    const signal = init!.signal!;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  try {
    const pending = fetchWithHeaderTimeout("http://127.0.0.1/v1", {}, overall.signal,
      resolveConnectTimeoutMs(undefined, { localUpstream: true }), false, executor).catch(error => error);
    await entered.promise;
    expect(clock.callbacks).toHaveLength(1);
    clock.callbacks[0]!();
    expect(await pending).toBe(overall.timeoutReason);
  } finally { overall.clear(); clock.restore(); }
});

test.each(["responses", "claude"] as const)("%s public default rejects a pending header wait", async wire => {
  const clock = clockAt(200_000);
  const entered = Promise.withResolvers<void>();
  const executor = (async (_input, init) => {
    const signal = init!.signal!;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  const url = "https://public.example/v1";
  const ms = resolveConnectTimeoutMs(undefined, { localUpstream: isLocalUpstream(url) });
  try {
    const pending = wire === "responses"
      ? fetchWithHeaderTimeout(url, {}, new AbortController().signal, ms, false, executor).catch(error => error)
      : fetchWithHeaderDeadline(url, {}, ms, undefined, undefined, executor);
    await entered.promise;
    expect(clock.callbacks).toHaveLength(1);
    clock.callbacks[0]!();
    const result = await pending;
    if (wire === "responses") expect(result).toMatchObject({ name: "TimeoutError" });
    else expect(result).toEqual({ kind: "timeout" });
  } finally { clock.restore(); }
});

test.each(["responses", "claude"] as const)("%s disabled local header clock retains cancellation", async wire => {
  const parent = new AbortController();
  const clock = clockAt(200_000);
  const entered = Promise.withResolvers<void>();
  const reason = new DOMException("client cancelled", "AbortError");
  const executor = (async (_input, init) => {
    const signal = init!.signal!;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as typeof fetch;
  try {
    const ms = resolveConnectTimeoutMs(undefined, { localUpstream: true });
    const pending = wire === "responses"
      ? fetchWithHeaderTimeout("http://127.0.0.1/v1", {}, parent.signal, ms, false, executor).catch(error => error)
      : fetchWithHeaderDeadline("http://127.0.0.1/v1", {}, ms, parent.signal, undefined, executor);
    await entered.promise;
    expect(clock.callbacks).toHaveLength(0);
    parent.abort(reason);
    const result = await pending;
    if (wire === "responses") expect(result).toBe(reason);
    else expect(result).toEqual({ kind: "error", error: reason });
  } finally { clock.restore(); }
});

test.each(["total", "stall", "client"] as const)("local body with no header deadline retains %s bound", async cause => {
  const budget = resolveJsonBodyReadTimeoutMs(cause === "stall" ? 1 : undefined, { localUpstream: true });
  const clock = clockAt(cause === "total" ? 17_003 : 1_000);
  const parent = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const reason = new DOMException("client cancelled", "AbortError");
  try {
    const pending = readBoundedResponseBody(new Response(body), {
      signal: parent.signal, totalTimeoutMs: cause === "total" ? 17_003 : 0, inactivityTimeoutMs: budget,
    }).catch(error => error);
    if (cause === "client") parent.abort(reason);
    else {
      expect(clock.callbacks).toHaveLength(1);
      clock.callbacks[0]!();
    }
    const result = await pending;
    if (cause === "client") expect(result).toBe(reason);
    else expect(result).toMatchObject({ timedOut: true, totalTimedOut: cause === "total", inactivityTimedOut: cause === "stall" });
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  } finally { parent.abort(reason); clock.restore(); }
});

test.each(["http://127.0.0.1:8000/v1", "https://gateway.example/v1"])("compact applies destination-aware header default: %s", async baseUrl => {
  const release = acquireOwnedSpendHome();
  const clock = clockAt(200_000);
  const originalFetch = globalThis.fetch;
  const sends: string[] = [];
  globalThis.fetch = (async input => {
    sends.push(String(input));
    return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
  }) as typeof fetch;
  try {
    const config = keyProviderConfig({ baseUrl, supportsNativeCompactEndpoint: true, allowPrivateNetwork: true, models: ["test"] });
    const response = await handleResponsesCompact(compactionRequest({ model: "gw/test", input: [{ role: "user", content: "fixture" }] }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    await response.text();
    expect(sends).toEqual([`${baseUrl}/responses/compact`]);
    expect(clock.callbacks).toHaveLength(isLocalUpstream(baseUrl) ? 0 : 1);
  } finally { globalThis.fetch = originalFetch; clock.restore(); release(); }
});

test.each(["chat", "messages"] as const)("native %s local JSON arms inactivity without a stall-derived total deadline", async wire => {
  const release = acquireOwnedSpendHome();
  const clock = clockAt(1_000);
  const originalFetch = globalThis.fetch;
  const reading = Promise.withResolvers<void>();
  const parent = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; }, pull() { reading.resolve(); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  const config = { defaultProvider: "fixture", stallTimeoutSec: 1,
    protocols: { rollout: { managedMessagesNative: true } }, providers: { fixture: {
      adapter: wire === "chat" ? "openai-chat" : "anthropic", authMode: "key", apiKey: "fixture-key",
      baseUrl: "http://127.0.0.1:8000/v1", models: ["fixture-model"], allowPrivateNetwork: true,
    } } } as OcxConfig;
  const request = new Request(`http://localhost/v1/${wire === "chat" ? "chat/completions" : "messages"}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
    body: JSON.stringify({ model: "fixture/fixture-model", max_tokens: 10, stream: false, messages: [{ role: "user", content: "fixture" }] }),
  });
  try {
    const pending = wire === "chat" ? handleChatCompletions(request, config, { model: "", provider: "" })
      : handleClaudeMessages(request, config, { model: "", provider: "" });
    // Failure before body consumption must surface rather than leave a hanging test.
    await Promise.race([reading.promise, pending.then(() => { throw new Error("native body was not read"); })]);
    expect(clock.callbacks).toHaveLength(1);
    source.enqueue(new TextEncoder().encode(JSON.stringify(wire === "chat"
      ? { id: "fixture", choices: [{ message: { role: "assistant", content: "fixture reply" }, finish_reason: "stop" }] }
      : { id: "fixture", type: "message", role: "assistant", content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })));
    source.close();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture reply");
  } finally { parent.abort(); globalThis.fetch = originalFetch; clock.restore(); release(); }
});

test.each([
  { initial: "http://127.0.0.1:8000/v1", final: "https://gateway.example/v1", clocks: 1 },
  { initial: "https://gateway.example/v1", final: "http://127.0.0.1:8000/v1", clocks: 0 },
])("queued compact refresh applies final destination's header clock: $initial -> $final", async row => {
  const release = acquireOwnedSpendHome();
  resetProviderRequestPacingForTest();
  const clock = clockAt(200_000);
  const originalFetch = globalThis.fetch;
  const parent = new AbortController();
  const config = keyProviderConfig({ baseUrl: row.initial, supportsNativeCompactEndpoint: true,
    allowPrivateNetwork: true, models: ["test"], apiKeySelectionRevision: "initial",
    requestPacing: { enabled: true, maxConcurrentRequests: 1 },
  });
  saveConfig(config);
  const provider = config.providers.gw!;
  const held = await waitForProviderRequestSlot("gw", provider, "test");
  const sends: string[] = [];
  globalThis.fetch = (async input => {
    sends.push(String(input));
    return Response.json({ object: "response.compaction", output: [{ type: "compaction", encrypted_content: "fixture" }] });
  }) as typeof fetch;
  try {
    const pending = handleResponsesCompact(compactionRequest({ model: "gw/test", input: [{ role: "user", content: "fixture" }] }, parent.signal), config, { model: "", provider: "" });
    for (let turn = 0; providerRequestPacingStatus("gw", provider).queued === 0; turn++) {
      if (turn > 1000) throw new Error("compact never queued");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    config.providers.gw = { ...provider, baseUrl: row.final, apiKey: "fixture-refreshed-key", apiKeySelectionRevision: "refreshed" };
    saveConfig(config);
    held.release();
    const response = await pending;
    expect(response.status).toBe(200);
    await response.text();
    expect(sends).toEqual([`${row.final}/responses/compact`]);
    expect(clock.callbacks).toHaveLength(row.clocks);
  } finally {
    parent.abort(); held.release(); globalThis.fetch = originalFetch;
    clock.restore(); resetProviderRequestPacingForTest(); release();
  }
});

for (const wire of ["chat", "messages"] as const) test.each([
  { initial: "http://127.0.0.1:8000/v1", final: "https://gateway.example/v1", clocks: 1 },
  { initial: "https://gateway.example/v1", final: "http://127.0.0.1:8000/v1", clocks: 0 },
])(`queued native ${wire} refresh uses final header and JSON policy: $initial -> $final`, async row => {
  const release = acquireOwnedSpendHome();
  resetProviderRequestPacingForTest();
  const clock = clockAt(200_000);
  const originalFetch = globalThis.fetch;
  const entered = Promise.withResolvers<void>();
  const headers = Promise.withResolvers<void>();
  const reading = Promise.withResolvers<void>();
  const parent = new AbortController();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const sends: string[] = [];
  globalThis.fetch = (async input => {
    sends.push(String(input));
    entered.resolve();
    await headers.promise;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; }, pull() { reading.resolve(); },
    }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const config: OcxConfig = { defaultProvider: "fixture", stallTimeoutSec: 1,
    protocols: { rollout: { managedMessagesNative: true } }, providers: { fixture: {
      adapter: wire === "chat" ? "openai-chat" : "anthropic", authMode: "key", apiKey: "fixture-key",
      baseUrl: row.initial, models: ["fixture-model"], allowPrivateNetwork: true,
      apiKeySelectionRevision: "initial", requestPacing: { enabled: true, maxConcurrentRequests: 1 },
    } } };
  saveConfig(config);
  const provider = config.providers.fixture!;
  const held = await waitForProviderRequestSlot("fixture", provider, "fixture-model");
  const request = new Request(`http://localhost/v1/${wire === "chat" ? "chat/completions" : "messages"}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: parent.signal,
    body: JSON.stringify({ model: "fixture/fixture-model", max_tokens: 10, stream: false, messages: [{ role: "user", content: "fixture" }] }),
  });
  const pending = wire === "chat" ? handleChatCompletions(request, config, { model: "", provider: "" })
    : handleClaudeMessages(request, config, { model: "", provider: "" });
  try {
    for (let turn = 0; providerRequestPacingStatus("fixture", provider).queued === 0; turn++) {
      if (turn > 1000) throw new Error("native request never queued");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    config.providers.fixture = { ...provider, baseUrl: row.final, apiKey: "fixture-refreshed-key", apiKeySelectionRevision: "refreshed" };
    saveConfig(config);
    held.release();
    await Promise.race([entered.promise, pending.then(() => { throw new Error("native request never sent"); })]);
    expect(sends).toEqual([`${row.final}/${wire === "chat" ? "chat/completions" : "messages"}`]);
    expect(clock.callbacks).toHaveLength(row.clocks);
    headers.resolve();
    await Promise.race([reading.promise, pending.then(() => { throw new Error("native body was not read"); })]);
    // Public JSON owns total + inactivity clocks as well as the completed header clock.
    expect(clock.callbacks).toHaveLength(row.clocks * 3);
    source.enqueue(new TextEncoder().encode(JSON.stringify(wire === "chat"
      ? { id: "fixture", choices: [{ message: { role: "assistant", content: "fixture reply" }, finish_reason: "stop" }] }
      : { id: "fixture", type: "message", role: "assistant", content: [{ type: "text", text: "fixture reply" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })));
    source.close();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fixture reply");
  } finally {
    parent.abort(); headers.resolve(); held.release(); await pending.catch(() => {});
    globalThis.fetch = originalFetch; clock.restore(); resetProviderRequestPacingForTest(); release();
  }
});
