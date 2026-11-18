import { afterAll, expect, test } from "bun:test";
import { nativeChatSse } from "../../src/server/chat-native-sse";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { foldChatCompletion } from "../../src/protocols/encoders/chat";
import { formatErrorResponse } from "../../src/bridge/errors";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { AdapterEvent, OcxConfig } from "../../src/types";

import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
const releaseSpendHome = acquireOwnedSpendHome();
afterAll(() => releaseSpendHome());

const KEY = "zq7Vb2LmN4pX9tR1sK8wD3fH6jY0cA5e";
const bytes = (text: string) => { const data = new TextEncoder().encode(text); let offset = 0; return new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= data.length) controller.close(); else { controller.enqueue(data.slice(offset, offset + 7)); offset += 7; } } }); };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function relay(text: string) {
  return nativeChatSse(bytes(text), { requestedModel: "fixture", translatorBudget: createTestTranslatorBudget(),
    signal: new AbortController().signal, onUsage() {} });
}
for (const postOutput of [false, true]) {
  test(`native top-level error uses canonical framing after output=${postOutput}`, async () => {
    const text = await new Response(relay((postOutput ? frame({ choices: [{ delta: { content: "hello" } }] }) : "")
      + `id: ${KEY}\r\nevent: ${KEY}\r\nretry: ${KEY}\r\n: ${KEY}\r\ndata: ${JSON.stringify({ error: { message: `invalid api key ${KEY}`, type: KEY, code: KEY, param: KEY } })}\r\n\r\n`)).text();
    const payloads = text.split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const error = payloads.find(value => value.error)?.error;
    expect(error).toBeDefined();
    expect(error.type).toBe("authentication_error");
    expect(error.code).toBeNull();
    expect(text).not.toContain(KEY);
  });
  for (const error of [{ message: KEY, type: KEY, code: KEY, metadata: KEY }, KEY, 7]) {
    test(`native choice error is rebuilt after output=${postOutput}, shape=${typeof error}`, async () => {
      const text = await new Response(relay((postOutput ? frame({ choices: [{ delta: { content: "hello" } }] }) : "")
        + `id: ${KEY}\nevent: ${KEY}\nretry: ${KEY}\n: ${KEY}\n` + frame({ id: "upstream-id", object: "chat.completion.chunk", created: 1, model: "upstream-model", metadata: "retained",
          choices: [{ index: 0, delta: {}, finish_reason: "error", error }, { index: 1, delta: { content: "ok" }, finish_reason: "stop" }] })
        + "data: [DONE]\n\n")).text();
      const chunk = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)))
        .find(value => value.choices?.[0]?.error);
      expect(chunk).toBeDefined();
      expect(chunk.choices[0].finish_reason).toBe("error");
      expect(chunk.choices[0].error.type).toBe("server_error");
      expect(chunk.choices[0].error.code).toBeNull();
      expect(chunk.choices[1].delta.content).toBe("ok");
      expect(text).toContain("data: [DONE]");
      expect(text).not.toContain(KEY);
    });
  }
}
for (const [status, code, message] of [[401, "invalid_api_key", "invalid api key"], [404, "model_not_found", "model not found"],
  [429, "rate_limit_exceeded", "rate limit"], [400, "cyber_policy", "cyber policy"], [400, "invalid_prompt", "invalid prompt"],
  [502, "upstream_server_error", "transport failed"]] as const) {
  test(`direct collected failure preserves legacy verdict ${code}`, async () => {
    const events: AdapterEvent[] = [{ type: "error", message: `${message} ${KEY}`, status, errorType: "upstream_error", code }];
    const response = await foldChatCompletion((async function* () { yield* events; })(), { model: "fixture", translatorBudget: createTestTranslatorBudget() });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(code === "model_not_found" ? "invalid_request_error" : code);
    expect(typeof body.error.type).toBe("string");
    expect(JSON.stringify(body)).not.toContain(KEY);
  });
}
for (const adapter of ["openai-chat", "openai-responses"]) {
  for (const status of [400, 401, 404, 429, 500]) {
    test(`${adapter} HTTP ${status} normalizes client error`, async () => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: KEY, type: "invalid_request_error", code: KEY, param: KEY } }, { status }) });
      try {
        const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter, baseUrl: `${server.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
        const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
        expect(response.status).toBe(status);
        const body = await response.json();
        expect(body.error).toBeDefined();
        expect(typeof body.error.type).toBe("string");
        expect(body.error.param).toBeNull();
        expect(JSON.stringify(body)).not.toContain(KEY);
      } finally { await server.stop(true); }
    });
  }
}
test("Responses translated error envelope remains unchanged", async () => {
  const response = formatErrorResponse(401, "authentication_error", `invalid api key ${KEY}`);
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.code).toBe("invalid_api_key");
  expect(body.error.message).toBe(`invalid api key ${KEY}`);
});

test("mixed choice errors preserve all ordinary non-error JSON fields", async () => {
  const chunk = { id: "id", object: "chat.completion.chunk", created: 3, model: "fixture", usage: { prompt_tokens: 4, completion_tokens: 2 }, extra: "kept",
    choices: [{ index: 0, finish_reason: "error", delta: {}, error: { message: KEY, type: KEY, code: KEY, nested: KEY } },
      { index: 1, finish_reason: null, delta: { role: "assistant", content: "hello", refusal: "no", reasoning_content: "reason", function_call: { name: "f", arguments: "{}" }, tool_calls: [] }, logprobs: null }] };
  const ordinary = { ...chunk, choices: chunk.choices.map(choice => { const copy = { ...choice }; delete copy.error; return copy; }) };
  const text = await new Response(relay(`id: ${KEY}\nevent: ${KEY}\nretry: ${KEY}\n: ${KEY}\n${frame(chunk)}data: [DONE]\n\n`)).text();
  const received = JSON.parse(text.split("\n").find(line => line.startsWith("data: {"))!.slice(6));
  expect(received.choices[0].error).toEqual({ message: "The provider failed to complete the request.", type: "server_error", code: null });
  delete received.choices[0].error;
  expect(received).toEqual(ordinary);
  expect(text).not.toContain(KEY);
});

for (const stream of [false]) test(`native buffered JSON preserves choice representation stream=${stream}`, async () => {
  const original = { id: "buffered-id", object: "chat.completion", created: 4, model: "upstream", extra: "kept", usage: { prompt_tokens: 2, completion_tokens: 3 },
    choices: [{ index: 0, finish_reason: "error", message: { role: "assistant", content: "partial", reasoning_content: "why" }, error: { message: KEY, type: KEY, code: KEY, nested: KEY } }, { index: 1, finish_reason: null, message: { role: "assistant", content: "other" } }] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(original) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: `${server.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/model", stream, messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    const text = await response.text();
    const received = stream ? JSON.parse(text.split("\n").find(line => line.startsWith("data: {"))!.slice(6)) : JSON.parse(text);
    expect(received.choices[0].error).toEqual({ message: "The provider failed to complete the request.", type: "server_error", code: null });
    expect(received.choices[0].message).toEqual(original.choices[0]!.message);
    expect(received.choices[1]).toEqual(original.choices[1]);
    expect(received.usage).toEqual(original.usage);
    expect(text).not.toContain(KEY);
  } finally { await server.stop(true); }
});
for (const mode of ["json-error", "transport"] as const) test(`native upstream ${mode} normalizes body`, async () => {
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { if (mode === "transport") throw new Error(`fixture read failed ${KEY}`); return Response.json({ error: { message: KEY, status: 502, type: KEY, code: KEY } }); }) as typeof fetch;
  try {
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(502);
    const body = await response.json(); expect(body.error).toBeDefined(); expect(body.error.type).toBe("server_error"); expect(body.error.code).toBeNull();
    expect(JSON.stringify(body)).not.toContain(KEY);
  } finally { globalThis.fetch = originalFetch; }
});

test("cached disabled-catalog preflight normalizes a zero-send combo failure", async () => {
  const { parseCatalogBuffer, setCachedCatalogForTests } = await import("../../src/adapters/devin/cloud-direct/catalog");
  const { encodeMessage, encodeString, encodeVarintField } = await import("../../src/adapters/devin/cloud-direct/wire");
  const host = "https://server.codeium.com";
  setCachedCatalogForTests(parseCatalogBuffer(encodeMessage(1, Buffer.concat([encodeString(1, KEY), encodeString(22, "fixture-model"), encodeVarintField(4, 1)])), KEY, host));
  const originalFetch = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = (async () => { sends++; throw new Error("Unexpected network call"); }) as typeof fetch;
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "devin", baseUrl: host, authMode: "key", apiKey: KEY, models: ["fixture-model"], liveModels: false } }, combos: { fixture: { strategy: "failover", targets: [{ provider: "fixture", model: "fixture-model" }] } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "combo/fixture", messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(502);
    const body = await response.json(); expect(body.error.type).toBe("server_error"); expect(body.error.code).toBe("upstream_server_error");
    expect(sends).toBe(0);
    expect(JSON.stringify(body)).not.toContain(KEY);
  } finally { globalThis.fetch = originalFetch; setCachedCatalogForTests(null); }
});

test("listener retains CORS and the proxy log id on normalized Chat errors", async () => {
  const { saveConfig } = await import("../../src/config");
  const { startServer } = await import("../../src/server");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: KEY, type: KEY, code: KEY } }, { status: 401, headers: { "x-request-id": KEY, "retry-after": KEY } }) });
  saveConfig({ port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY, models: ["model"] } } });
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/chat/completions", server.url), { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "hi" }] }) });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(response.headers.get("x-opencodex-request-id")).toBeTruthy();
    const body = await response.json(); expect(body.error.type).toBe("authentication_error"); expect(body.error.code).toBe("invalid_api_key");
    expect(JSON.stringify(body)).not.toContain(KEY); expect(JSON.stringify([...response.headers])).not.toContain(KEY);
  } finally { await server.stop(true); await upstream.stop(true); }
});

test("Responses ingress retains its translated upstream error message", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: `invalid api key ${KEY}`, type: "authentication_error", code: "invalid_api_key" } }, { status: 401 }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: "fixture-key" } } };
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/model", input: "hi", stream: false }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(401);
    const body = await response.json(); expect(body.error.type).toBe("authentication_error"); expect(body.error.code).toBe("invalid_api_key"); expect(body.error.message).toContain(KEY);
  } finally { await upstream.stop(true); }
});

test("local validation retains its zero-send message", async () => {
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true, authMode: "key", apiKey: "fixture-key" } } };
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/model", messages: [] }) }), config, { model: "", provider: "" });
  expect(response.status).toBe(400); const body = await response.json();
  expect(body.error.type).toBe("invalid_request_error"); expect(body.error.message).toBe("messages must be a non-empty array");
});

for (const kind of ["quota", "cyber"]) test(`native combo preserves ${kind} routing with normalized client text`, async () => {
  const { clearComboTargetCooldowns, clearComboSelectionState } = await import("../../src/combos");
  clearComboTargetCooldowns(); clearComboSelectionState();
  const sends: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { model: string }; sends.push(body.model);
    return body.model === "first" ? Response.json({ error: { message: `${kind === "quota" ? "quota exhausted" : "cyber policy"} ${KEY}`, type: "upstream_error", code: kind === "quota" ? "insufficient_quota" : "cyber_policy" } }, { status: 500 })
      : Response.json({ id: "fixture-completion", object: "chat.completion", created: 1, model: "next", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  } });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY, transientRetryOn5xx: { attempts: 1 } }, backup: { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: "fixture-backup" } }, combos: { fixture: { strategy: "failover", targets: [{ provider: "fixture", model: "first" }, { provider: "backup", model: "next" }] } }, protocols: { rollout: { nativeChatCombos: true } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "combo/fixture", messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(kind === "quota" ? 200 : 400);
    const body = await response.json();
    if (kind === "quota") { expect(body.choices[0].message.content).toBe("ok"); expect(sends).toEqual(["first", "next"]); }
    else { expect(body.error.type).toBe("upstream_error"); expect(body.error.code).toBe("cyber_policy"); expect(sends).toEqual(["first"]); }
    expect(JSON.stringify(body)).not.toContain(KEY);
  } finally { await upstream.stop(true); clearComboTargetCooldowns(); clearComboSelectionState(); }
});

type FlatEvent = "error" | "message";
function flatFixture(event: FlatEvent, postOutput: boolean) {
  const payload = { ...(event === "message" ? { type: "error" } : {}), message: KEY, code: KEY, param: KEY, metadata: { detail: KEY }, id: KEY, created: 1 };
  const content = postOutput ? frame({ id: "fixture-content", created: 1, choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] }) : "";
  const input = content + `id: ${KEY}\r\nevent: ${event}\r\nretry: ${KEY}\r\n: ${KEY}\r\ndata: ${JSON.stringify(payload)}\r\n\r\ndata: [DONE]\r\n\r\n`;
  // The legacy ordinary relay preserved this payload and added its completion envelope fields.
  const legacy = content + `event: ${event}\n` + frame({ ...payload, object: "chat.completion.chunk", model: "fixture" }) + "data: [DONE]\n\n";
  return { input, legacy };
}
function completionFacts(value: Record<string, unknown>) {
  const { id, created, ...facts } = value;
  return facts;
}
async function flatNativeObservation(event: FlatEvent, postOutput: boolean) {
  const { collectChatCompletion, isChatCompletionsStreamError } = await import("../../src/chat/outbound");
  const terminals: Array<{ status: number; message?: string }> = [];
  const sink: import("../../src/chat/failure-verdict").FailureVerdictSink = {};
  const fixture = flatFixture(event, postOutput);
  const legacy = await collectChatCompletion(bytes(fixture.legacy), "fixture", createTestTranslatorBudget());
  const [wire, buffered] = nativeChatSse(bytes(fixture.input), { requestedModel: "fixture", translatorBudget: createTestTranslatorBudget(),
    signal: new AbortController().signal, failureVerdictSink: sink, onUsage() {}, onTerminal(status, message) { terminals.push({ status, ...(message === undefined ? {} : { message }) }); } }).tee();
  const [text, outcome] = await Promise.all([new Response(wire).text(), (async () => {
    try { return { status: 200, completion: completionFacts(await collectChatCompletion(buffered, "fixture", createTestTranslatorBudget(), sink)) }; }
    catch (error) {
      expect(isChatCompletionsStreamError(error)).toBe(true);
      const failure = error as import("../../src/chat/outbound").ChatCompletionsStreamError;
      return { status: failure.status, type: failure.type, code: failure.code };
    }
  })()]);
  return { terminals, sink, text, outcome, legacy: { status: 200, completion: completionFacts(legacy) } };
}
for (const metric of ["terminal", "buffered", "collector", "bytes"]) for (const event of ["error", "message"] as const) for (const postOutput of [false, true]) {
  test(`flat native ${metric} matches legacy relay event=${event} after output=${postOutput}`, async () => {
    const result = await flatNativeObservation(event, postOutput);
    if (metric === "terminal") expect(result.terminals).toEqual([{ status: 200 }]);
    else if (metric === "buffered") expect(result.outcome).toEqual(result.legacy);
    else if (metric === "collector") expect(result.sink.verdict).toBeUndefined();
    else {
      const payloads = result.text.split(/\r?\n/).filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const flat = payloads.find(value => Object.hasOwn(value, "message"));
      expect(flat).toBeDefined();
      expect(flat).toEqual({ message: "The provider failed to complete the request.", type: "server_error", param: null, code: null });
      expect(result.text).toContain("data: [DONE]");
      expect(result.text).not.toContain(KEY);
      const flatBlock = result.text.split(/\r?\n\r?\n/).find(block => block.includes(`data: ${JSON.stringify(flat)}`));
      expect(flatBlock).toBe(`${event === "error" ? "event: error\n" : ""}data: ${JSON.stringify(flat)}`);
    }
  });
}

test("translated errors select condition wording despite an upstream local-refusal header", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: KEY, type: "upstream_error", code: "workflow_sends_exhausted" } },
    { status: 500, headers: { "x-opencodex-local-refusal": "credentials_paused" } }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY, transientRetryOn5xx: { attempts: 1 } } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/model", messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe("server_error"); expect(body.error.code).toBe("upstream_server_error");
    expect(body.error.message).toBe("The provider failed to complete the request.");
    expect(JSON.stringify(body)).not.toContain(KEY);
  } finally { await upstream.stop(true); }
});

async function flatEndpointExchange(combo: boolean, stream: boolean, flat: boolean, withContent = false, withMetadata = false, deltaOverride: Record<string, unknown> = {}, early?: { form: EarlyErrorForm; ending: "done" | "eof" }) {
  const { clearComboTargetCooldowns, clearComboSelectionState } = await import("../../src/combos");
  const { clearKeyCooldowns } = await import("../../src/providers/key-failover");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  clearComboTargetCooldowns(); clearComboSelectionState(); clearKeyCooldowns();
  const sends: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { model: string }; sends.push(body.model);
    if (body.model === "backup") return Response.json({ id: "fixture-backup", object: "chat.completion", created: 1, model: "backup", choices: [{ index: 0, message: { role: "assistant", content: "backup" }, finish_reason: "stop" }] });
    if (early) return new Response(earlyErrorTranscript(early.form, flat ? "error" : "message", early.ending), { headers: { "content-type": "text/event-stream" } });
    return new Response(`id: ${KEY}\nevent: ${flat ? "error" : "message"}\nretry: ${KEY}\n: ${KEY}\n${frame({ message: KEY, code: KEY, param: KEY, metadata: KEY, ...(withContent ? { service_tier: withMetadata ? KEY : "default", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, ...(withMetadata ? { error: { message: KEY, type: KEY, code: KEY, param: KEY } } : {}) }, choices: [{ index: 0, delta: { role: "assistant", content: "retained content", reasoning_content: "retained reasoning", ...deltaOverride }, finish_reason: "stop" }] } : {}) })}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const row = { adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key" as const, apiKey: KEY, transientRetryOn5xx: { attempts: 1 } };
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: row, backup: { ...row, apiKey: "fixture-backup" } },
      combos: { fixture: { strategy: "failover", targets: [{ provider: "fixture", model: "first" }, { provider: "backup", model: "backup" }] } }, protocols: { rollout: { nativeChatCombos: true } } };
    const ctx: import("../../src/server/request-log").RequestLogContext = { model: "", provider: "" };
    const requestId = `flat-relay-${crypto.randomUUID()}`;
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: combo ? "combo/fixture" : "fixture/first", stream, messages: [{ role: "user", content: "hi" }] }) }), config, ctx, { requestId, start: Date.now() });
    const text = await response.text();
    const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
    expect(rows).toHaveLength(1);
    const log = rows[0]!;
    return { status: response.status, text, sends, facts: {
      upstreamError: ctx.upstreamError, upstreamErrorType: ctx.upstreamErrorType, upstreamErrorCode: ctx.upstreamErrorCode,
      status: log.status, errorCode: log.errorCode, upstreamCondition: log.upstreamCondition, terminalStatus: log.terminalStatus, usage: log.usage,
      closeReason: log.closeReason, attempts: log.attempts?.map(attempt => ({ status: attempt.status, errorCode: attempt.errorCode, sendCount: attempt.sendCount })),
    } };
  } finally { await upstream.stop(true); clearComboTargetCooldowns(); clearComboSelectionState(); clearKeyCooldowns(); }
}
for (const stream of [false, true]) for (const metric of ["buffered endpoint", "log facts"]) test(`flat native ${metric} matches legacy relay stream=${stream}`, async () => {
  const legacy = await flatEndpointExchange(false, stream, false);
  const current = await flatEndpointExchange(false, stream, true);
  expect(legacy.status).toBe(200); expect(legacy.facts.upstreamError).toBeUndefined();
  if (metric === "log facts") expect(current.facts).toEqual(legacy.facts);
  else {
    expect(current.status).toBe(legacy.status);
    if (!stream) {
      const body = JSON.parse(current.text); expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
      expect(completionFacts(body)).toEqual(completionFacts(JSON.parse(legacy.text)));
    } else { expect(current.text).toContain("data: [DONE]"); }
    expect(current.text).not.toContain(KEY);
  }
});
test("flat native combo send sequence matches legacy relay", async () => {
  const legacy = await flatEndpointExchange(true, false, false);
  const current = await flatEndpointExchange(true, false, true);
  expect(legacy.status).toBe(200); expect(legacy.sends).toEqual(["first"]);
  expect(current.status).toBe(legacy.status); expect(current.sends).toEqual(legacy.sends);
  expect(current.facts).toEqual(legacy.facts);
  const body = JSON.parse(current.text); expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  expect(completionFacts(body)).toEqual(completionFacts(JSON.parse(legacy.text)));
  expect(current.text).not.toContain(KEY);
});
for (const combo of [false, true]) test(`flat native buffered data matches legacy relay combo=${combo}`, async () => {
  const legacy = await flatEndpointExchange(combo, false, false, true);
  const current = await flatEndpointExchange(combo, false, true, true);
  expect(legacy.status).toBe(200);
  const baselineBody = JSON.parse(legacy.text);
  expect(baselineBody.choices[0].message.content).toBe("retained content"); expect(baselineBody.usage.total_tokens).toBe(5);
  expect(current.status).toBe(legacy.status);
  const body = JSON.parse(current.text); expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  expect(completionFacts(body)).toEqual(completionFacts(baselineBody));
  expect(current.facts).toEqual(legacy.facts); expect(current.sends).toEqual(["first"]);
  expect(current.text).not.toContain(KEY);
});

async function collectFlatMetadata(chunk: Record<string, unknown>) {
  const { ChatCompletionsCollectorSource, collectChatCompletion } = await import("../../src/chat/outbound");
  const budget = createTestTranslatorBudget();
  const source = new ChatCompletionsCollectorSource(budget);
  const payload = { message: "The provider failed to complete the request.", type: "server_error", code: null, param: null };
  source.retain(JSON.stringify(payload), chunk);
  return await collectChatCompletion(bytes(frame(payload) + "data: [DONE]\n\n"), "fixture", budget, undefined, source);
}
const numericFlatUsage = {
  prompt_tokens: 11, completion_tokens: 5, total_tokens: 16,
  prompt_tokens_details: { cached_tokens: 3, audio_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 1, audio_tokens: 2, accepted_prediction_tokens: 3, rejected_prediction_tokens: 4 },
};
test("flat collector usage keeps numeric values and removes additional fields", async () => {
  const raw = { ...numericFlatUsage, error: { message: KEY, type: KEY, code: KEY, param: KEY }, [KEY]: 7,
    prompt_tokens_details: { ...numericFlatUsage.prompt_tokens_details, error: { message: KEY } },
    completion_tokens_details: { ...numericFlatUsage.completion_tokens_details, metadata: KEY } };
  const body = await collectFlatMetadata({ usage: raw, service_tier: "default" });
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  const usage = body.usage as Record<string, unknown>;
  expect(usage.prompt_tokens).toBe(11); expect(usage.completion_tokens).toBe(5); expect(usage.total_tokens).toBe(16);
  expect(usage).toEqual(numericFlatUsage);
  expect(raw.error.message).toBe(KEY);
  expect(JSON.stringify(body)).not.toContain(KEY);
});
test("flat collector usage accepts only finite non-negative counters", async () => {
  const body = await collectFlatMetadata({ usage: { prompt_tokens: -1, completion_tokens: Infinity, total_tokens: "16",
    prompt_tokens_details: { cached_tokens: null, audio_tokens: NaN },
    completion_tokens_details: { reasoning_tokens: { message: KEY }, audio_tokens: 0, accepted_prediction_tokens: 2.5, rejected_prediction_tokens: -4 } } });
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  expect(body.usage).toEqual({ completion_tokens_details: { audio_tokens: 0, accepted_prediction_tokens: 2.5 } });
  expect(JSON.stringify(body)).not.toContain(KEY);
});
for (const [tier, expected] of [[KEY, undefined], [" Priority ", "priority"], ["default", "default"]] as const) test(`flat collector bounds service tier ${tier}`, async () => {
  const body = await collectFlatMetadata({ usage: numericFlatUsage, service_tier: tier });
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1); expect(body.usage).toEqual(numericFlatUsage);
  expect(body.service_tier).toBe(expected);
  expect(JSON.stringify(body)).not.toContain(KEY);
});
test("flat collector restores completion content with closed metadata", async () => {
  const body = await collectFlatMetadata({ usage: numericFlatUsage, choices: [{ index: 0, finish_reason: KEY, error: { message: KEY },
    delta: { content: "visible", refusal: "declined", reasoning_content: "thinking", metadata: KEY,
      reasoning_details: [{ type: "reasoning.text", text: "summary", index: 0, format: KEY, error: { message: KEY } }, { type: KEY, message: KEY }],
      tool_calls: [{ index: 0, id: "fixture-call", type: "function", metadata: KEY, function: { name: "lookup", arguments: "{}", error: { message: KEY } } }] } }] });
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  const choice = (body.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  expect(message.content).toBe("visible"); expect(message.refusal).toBe("declined"); expect(message.reasoning_content).toBe("thinking");
  expect(choice.finish_reason).toBe("error");
  expect(message.reasoning_details).toEqual([{ type: "reasoning.text", text: "summary", index: 0 }]);
  expect(message.tool_calls).toEqual([{ id: "fixture-call", type: "function", function: { name: "lookup", arguments: "{}" } }]);
  expect(JSON.stringify(body)).not.toContain(KEY);
});
test("buffered flat metadata projection preserves numeric log facts", async () => {
  const legacy = await flatEndpointExchange(false, false, false, true);
  const current = await flatEndpointExchange(false, false, true, true, true);
  expect(legacy.status).toBe(200); expect(current.status).toBe(200);
  const baselineBody = JSON.parse(legacy.text); const body = JSON.parse(current.text);
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  expect(body.usage.prompt_tokens).toBe(3); expect(body.usage.completion_tokens).toBe(2); expect(body.usage.total_tokens).toBe(5);
  expect(body.usage).toEqual(baselineBody.usage); expect(body.service_tier).toBeUndefined();
  expect(current.facts).toEqual(legacy.facts); expect(current.sends).toEqual(["first"]);
  expect(current.text).not.toContain(KEY);
});
for (const event of ["error", KEY]) test(`flat event framing uses only the fixed error name: ${event}`, async () => {
  const sink: import("../../src/chat/failure-verdict").FailureVerdictSink = {};
  const terminals: number[] = [];
  const payload = { type: "error", message: KEY, code: KEY, param: KEY };
  const text = await new Response(nativeChatSse(bytes(`event: ${event}\nid: ${KEY}\nretry: ${KEY}\n: ${KEY}\n${frame(payload)}data: [DONE]\n\n`), {
    requestedModel: "fixture", translatorBudget: createTestTranslatorBudget(), signal: new AbortController().signal, failureVerdictSink: sink,
    onUsage() {}, onTerminal(status) { terminals.push(status); },
  })).text();
  const flat = { message: "The provider failed to complete the request.", type: "server_error", param: null, code: null };
  expect(terminals).toEqual([200]); expect(sink.verdict).toBeUndefined();
  const data = text.split("\n").find(line => line.startsWith("data: {")); expect(data).toBeDefined(); expect(JSON.parse(data!.slice(6))).toEqual(flat);
  expect(text).toBe(`${event === "error" ? "event: error\n" : ""}${frame(flat)}data: [DONE]\n\n`);
  expect(text).not.toContain(KEY);
});
test("flat collector reasoning entries retain content without additional metadata", async () => {
  const body = await collectFlatMetadata({ choices: [{ finish_reason: "stop", delta: { content: "visible", reasoning_details: [
    { type: "reasoning.text", text: "summary", data: KEY, index: 0, format: KEY, metadata: { error: { message: KEY, type: KEY, code: KEY, param: KEY } } },
    { type: KEY, text: KEY },
  ] } }] });
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
  expect(message.content).toBe("visible");
  expect(message.reasoning_details).toEqual([{ type: "reasoning.text", text: "summary", index: 0 }]);
  expect(JSON.stringify(body)).not.toContain(KEY);
});

const flatReasoningFixtures: Record<string, Record<string, unknown>> = {
  summary: { type: "reasoning.summary", summary: "Summary text\nΩ.", index: 0 },
  "summary identity": { type: "reasoning.summary", summary: "Summary with identity.", index: 1, format: "openai-responses-v1", id: "rs_summary_1" },
  text: { type: "reasoning.text", text: "Reasoning text\nΩ.", index: 0 },
  "signed text": { type: "reasoning.text", text: "Signed text.", signature: "SyntheticReasoningSignature0000==", index: 2, format: "anthropic-claude-v1", id: "reasoning-text-2" },
  "MiniMax text": { type: "reasoning.text", text: "MiniMax text.", index: 0, format: "MiniMax-response-v1", id: "reasoning-text-1" },
  encrypted: { type: "reasoning.encrypted", data: "SyntheticEncryptedReasoningPayload", index: 0 },
  "encrypted identity": { type: "reasoning.encrypted", data: "SyntheticEncryptedReasoningPayload", index: 3, format: "anthropic-claude-v1", id: "rs_encrypted_1" },
};
function flatCompletionDelta(details: Record<string, unknown>, diagnostics = false) {
  return { role: "assistant", content: "Answer text\nΩ.", refusal: "Refusal content.", reasoning_content: "Visible thinking.",
    reasoning_details: [{ ...details, ...(diagnostics ? { error: { message: KEY, type: KEY, code: KEY, param: KEY }, metadata: KEY } : {}) }],
    tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "lookup", arguments: '{"q":"Ω"}' } }],
    ...(diagnostics ? { error: { message: KEY }, metadata: KEY } : {}),
  };
}
for (const [name, details] of Object.entries(flatReasoningFixtures)) {
  test(`flat reasoning content matches the base collector: ${name}`, async () => {
    const { collectChatCompletion } = await import("../../src/chat/outbound");
    const clean = { usage: numericFlatUsage, service_tier: "default", choices: [{ index: 0, finish_reason: "stop", delta: flatCompletionDelta(details) }] };
    const legacy = await collectChatCompletion(bytes(frame(clean) + "data: [DONE]\n\n"), "fixture", createTestTranslatorBudget());
    const current = await collectFlatMetadata({ ...clean, choices: [{ index: 0, finish_reason: "stop", delta: flatCompletionDelta(details, true) }] });
    expect(legacy.object).toBe("chat.completion"); expect(current.object).toBe("chat.completion"); expect(current.choices).toHaveLength(1);
    const expectedMessage = (legacy.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
    expect(expectedMessage.reasoning_details).toEqual([details]);
    expect(completionFacts(current)).toEqual(completionFacts(legacy));
    expect(JSON.stringify(current)).not.toContain(KEY);
  });
  test(`flat reasoning content matches the base handler: ${name}`, async () => {
    const legacy = await flatEndpointExchange(false, false, false, true, false, flatCompletionDelta(details));
    const current = await flatEndpointExchange(false, false, true, true, false, flatCompletionDelta(details, true));
    expect(legacy.status).toBe(200); expect(current.status).toBe(200);
    const expected = JSON.parse(legacy.text); const body = JSON.parse(current.text);
    expect(expected.choices[0].message.reasoning_details).toEqual([details]);
    expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
    expect(completionFacts(body)).toEqual(completionFacts(expected));
    expect(current.facts).toEqual(legacy.facts); expect(current.sends).toEqual(["first"]);
    expect(current.text).not.toContain(KEY);
  });
}
test("flat summary entries keep text while excluding invalid primitives and diagnostics", async () => {
  const body = await collectFlatMetadata({ choices: [{ finish_reason: "stop", delta: { reasoning_details: [
    { type: "reasoning.summary", summary: "Summary content.", index: KEY, format: { message: KEY }, id: KEY, error: { message: KEY, type: KEY, code: KEY, param: KEY } },
  ] } }] });
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  const message = (body.choices as Array<{ message: Record<string, unknown> }>)[0]!.message;
  expect(message.reasoning_details).toEqual([{ type: "reasoning.summary", summary: "Summary content." }]);
  expect(JSON.stringify(body)).not.toContain(KEY);
});
test("flat native capture retains the reasoning alias while buffered content matches base", async () => {
  const { ChatCompletionsCollectorSource, collectChatCompletion } = await import("../../src/chat/outbound");
  const delta = { role: "assistant", content: "Answer.", reasoning: "Capture-only reasoning.",
    function_call: { name: "legacy", arguments: "{}" },
    tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "lookup", arguments: "{}" } }] };
  const clean = { choices: [{ index: 0, finish_reason: "stop", delta }] };
  const legacy = await collectChatCompletion(bytes(frame(clean) + "data: [DONE]\n\n"), "fixture", createTestTranslatorBudget());
  const raw = { ...clean, type: "error", message: KEY, code: KEY };
  const budget = createTestTranslatorBudget(); const source = new ChatCompletionsCollectorSource(budget);
  const observed: Record<string, unknown>[] = [];
  const stream = nativeChatSse(bytes(frame(raw) + "data: [DONE]\n\n"), { requestedModel: "fixture", translatorBudget: budget, collectorSource: source,
    signal: new AbortController().signal, onUsage() {}, onChunk(chunk) { observed.push(chunk); } });
  const body = await collectChatCompletion(stream, "fixture", budget, undefined, source);
  expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
  expect(observed).toHaveLength(1); expect(observed[0]).toEqual(raw);
  expect(completionFacts(body)).toEqual(completionFacts(legacy));
  expect((body.choices as Array<{ message: Record<string, unknown> }>)[0]!.message.reasoning_content).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain(KEY);
});

type EarlyErrorForm = "absent" | "empty" | "done";
function earlyErrorBlock(form: EarlyErrorForm, event: string) {
  return [`id: ${KEY}`, `event: ${event}`, `retry: ${KEY}`, `: ${KEY}`, `other: ${KEY}`,
    ...(form === "absent" ? [] : [form === "empty" ? "data:" : "data: [DONE]"])].join("\r\n") + "\r\n\r\n";
}
function fixedEarlyErrorBlock(form: EarlyErrorForm) {
  return "event: error\n" + (form === "absent" ? "" : form === "empty" ? "data: \n" : "data: [DONE]\n") + "\n";
}
function earlyErrorTranscript(form: EarlyErrorForm, event: string, ending: "done" | "eof") {
  const after = form === "done" ? frame({ error: { message: `must remain unread ${KEY}` } })
    : ending === "eof" ? ""
    : frame({ id: "fixture-after", created: 1, choices: [{ index: 0, delta: { content: "after early block" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + "data: [DONE]\n\n";
  return earlyErrorBlock(form, event) + after;
}
async function earlyNativeObservation(form: EarlyErrorForm, event: string, ending: "done" | "eof") {
  const { collectChatCompletion, isChatCompletionsStreamError } = await import("../../src/chat/outbound");
  const input = new TextEncoder().encode(earlyErrorTranscript(form, event, ending)); let offset = 0;
  const cancelled: unknown[] = []; const terminals: Array<{ status: number; message?: string }> = [];
  const chunks: Record<string, unknown>[] = []; const usages: unknown[] = [];
  const sink: import("../../src/chat/failure-verdict").FailureVerdictSink = {};
  const body = new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= input.length) controller.close(); else { controller.enqueue(input.slice(offset, offset + 7)); offset += 7; }
  }, cancel(reason) { cancelled.push(reason instanceof Error ? reason.message : reason); } });
  const [wire, buffered] = nativeChatSse(body, { requestedModel: "fixture", translatorBudget: createTestTranslatorBudget(),
    signal: new AbortController().signal, failureVerdictSink: sink, onUsage(usage) { usages.push(usage); }, onChunk(chunk) { chunks.push(chunk); },
    onTerminal(status, message) { terminals.push({ status, ...(message === undefined ? {} : { message }) }); },
  }).tee();
  const response = new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const [text, collected] = await Promise.all([response.text(), (async () => {
    try { return { status: 200, completion: completionFacts(await collectChatCompletion(buffered, "fixture", createTestTranslatorBudget(), sink)) }; }
    catch (error) {
      expect(isChatCompletionsStreamError(error)).toBe(true);
      const failure = error as import("../../src/chat/outbound").ChatCompletionsStreamError;
      return { status: failure.status, type: failure.type, code: failure.code, message: failure.message };
    }
  })()]);
  return { status: response.status, text, collected, terminals, cancelled, chunks, usages, verdict: sink.verdict };
}
const earlyErrorCases: Array<{ form: EarlyErrorForm; ending: "done" | "eof" }> = [
  { form: "absent", ending: "done" }, { form: "empty", ending: "done" }, { form: "done", ending: "done" },
  { form: "absent", ending: "eof" }, { form: "empty", ending: "eof" },
];
for (const { form, ending } of earlyErrorCases) test(`named early error frame preserves native control: ${form} ${ending}`, async () => {
  const legacy = await earlyNativeObservation(form, "message", ending);
  const current = await earlyNativeObservation(form, "error", ending);
  expect(legacy.status).toBe(200); expect(current.status).toBe(legacy.status);
  expect(current.terminals).toEqual(legacy.terminals); expect(current.collected).toEqual(legacy.collected);
  expect(current.cancelled).toEqual(legacy.cancelled); expect(current.chunks).toEqual(legacy.chunks); expect(current.usages).toEqual(legacy.usages);
  expect(current.verdict).toEqual(legacy.verdict);
  expect(current.collected.status).toBe(ending === "eof" ? 502 : 200);
  if (ending === "eof") {
    expect(current.verdict).toMatchObject({ status: 502, type: "upstream_error", code: "upstream_sse_truncated" });
  } else { expect(current.verdict).toBeUndefined(); expect(current.terminals).toEqual([{ status: 200 }]); }
  expect(current.text.startsWith(fixedEarlyErrorBlock(form))).toBe(true);
  expect(current.text).not.toContain(KEY);
});
for (const { form, ending } of earlyErrorCases) for (const stream of [false, true]) for (const combo of [false, true]) {
  test(`named early error frame preserves handler facts: ${form} ${ending} stream=${stream} combo=${combo}`, async () => {
    const legacy = await flatEndpointExchange(combo, stream, false, false, false, {}, { form, ending });
    const current = await flatEndpointExchange(combo, stream, true, false, false, {}, { form, ending });
    expect(current.status).toBe(legacy.status); expect(current.sends).toEqual(legacy.sends); expect(current.facts).toEqual(legacy.facts);
    expect(legacy.sends).toEqual(combo && !stream && ending === "eof" ? ["first", "backup"] : ["first"]);
    if (stream) {
      expect(current.status).toBe(200);
      expect(current.text.startsWith(fixedEarlyErrorBlock(form))).toBe(true);
    } else {
      const body = JSON.parse(current.text); const expected = JSON.parse(legacy.text);
      if (ending === "eof" && !combo) {
        expect(current.status).toBe(502); expect(body.error.type).toBe("upstream_error"); expect(body.error.code).toBe("upstream_sse_truncated");
        expect(body).toEqual(expected);
      } else {
        expect(current.status).toBe(200); expect(body.object).toBe("chat.completion"); expect(body.choices).toHaveLength(1);
        expect(completionFacts(body)).toEqual(completionFacts(expected));
      }
    }
    expect(current.text).not.toContain(KEY);
  });
}
for (const form of ["absent", "empty", "done"] as const) test(`ordinary early block retains its control lines: ${form}`, async () => {
  const result = await earlyNativeObservation(form, "message", "done");
  expect(result.status).toBe(200); expect(result.terminals).toEqual([{ status: 200 }]); expect(result.verdict).toBeUndefined();
  expect(result.text).toContain(`id: ${KEY}`); expect(result.text).toContain(`retry: ${KEY}`); expect(result.text).toContain(`: ${KEY}`);
});

for (const error of [null, undefined]) test(`empty choice error retains ordinary SSE framing: ${error}`, async () => {
  const chunk = { id: "empty-choice", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: 0, delta: { content: "normal answer" }, finish_reason: "stop", error }] };
  const ordinary = `id: ordinary-id\nretry: 1000\n: ordinary comment\n${frame(chunk)}data: [DONE]\n\n`;
  const terminals: number[] = [];
  const output = await new Response(nativeChatSse(bytes(ordinary), { requestedModel: "fixture",
    translatorBudget: createTestTranslatorBudget(), signal: new AbortController().signal,
    onUsage() {}, onTerminal(status) { terminals.push(status); } })).text();
  expect(terminals).toEqual([200]);
  expect(output).toBe(ordinary);
  const { collectChatCompletion } = await import("../../src/chat/outbound");
  const base = await collectChatCompletion(bytes(ordinary), "fixture", createTestTranslatorBudget());
  const actual = await collectChatCompletion(bytes(output), "fixture", createTestTranslatorBudget());
  expect(actual.choices).toEqual(base.choices);
  expect(actual.choices[0].message.content).toBe("normal answer");
});

test("null choice error keeps the native buffered JSON representation", async () => {
  const original = { id: "empty-choice", object: "chat.completion", created: 1, model: "fixture/model",
    choices: [{ index: 0, message: { role: "assistant", content: "normal answer" }, finish_reason: "stop", error: null }] };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(original) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-chat", baseUrl: `${server.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "fixture/model", messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(original);
  } finally { await server.stop(true); }
});

for (const stream of [false, true]) for (const [code, message] of [
  ["undeclared_tool_call", `routed provider emitted undeclared client tool "${KEY}"; only request-declared tools may be called`],
  ["workflow_sends_exhausted", `OAuth authentication failed. Check the OpenCodex account status and retry. ${KEY}`],
  [KEY, `upstream stream ended early (upstream_stall_timeout) ${KEY}`],
]) test(`upstream proxy-message copies remain normalized: ${code} stream=${stream}`, async () => {
  const error = { type: "upstream_error", code, message, proxyAuthored: true };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    `event: response.failed\n${frame({ type: "response.failed", response: { status: "failed", error } })}`,
    { headers: { "content-type": "text/event-stream", "x-opencodex-local-refusal": "credentials_paused" } }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-responses", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "fixture/model", stream, messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(stream ? 200 : 502);
    const text = await response.text();
    const body = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error) : JSON.parse(text);
    expect(body.error).toBeDefined();
    expect(body.error.type).toBe(code === "workflow_sends_exhausted" ? "authentication_error" : "server_error");
    expect(body.error.code).toBe(code === "undeclared_tool_call" ? code : code === "workflow_sends_exhausted" ? "invalid_api_key" : "upstream_server_error");
    expect(body.error.message).not.toBe(message);
    expect(text).not.toContain(KEY);
  } finally { await upstream.stop(true); }
});

for (const stream of [true, false]) test(`null choice error keeps full-handler SSE behavior stream=${stream}`, async () => {
  const chunk = { id: "empty-choice", object: "chat.completion.chunk", created: 1, model: "fixture/model",
    choices: [{ index: 0, delta: { role: "assistant", content: "normal answer" }, finish_reason: "stop", error: null }] };
  const ordinary = `id: ordinary-id\nretry: 1000\n: ordinary comment\n${frame(chunk)}data: [DONE]\n\n`;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => new Response(ordinary, { headers: { "content-type": "text/event-stream" } }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-chat", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
    const context = { model: "", provider: "" };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: "fixture/model", stream, messages: [{ role: "user", content: "hi" }] }) }), config, context);
    expect(response.status).toBe(200);
    const text = await response.text();
    if (stream) expect(text).toBe(ordinary);
    else {
      const { collectChatCompletion } = await import("../../src/chat/outbound");
      const base = await collectChatCompletion(bytes(ordinary), "fixture/model", createTestTranslatorBudget());
      expect(JSON.parse(text).choices).toEqual(base.choices);
      expect(JSON.parse(text).choices[0].message.content).toBe("normal answer");
    }
    expect((context as Record<string, unknown>).upstreamError).toBeUndefined();
  } finally { await upstream.stop(true); }
});

for (const stream of [false, true]) test(`combo retains its locally constructed tool refusal stream=${stream}`, async () => {
  const comboId = `owned-tool-${stream}`;
  const tool = { type: "function_call", id: "fc_owned", call_id: "call_owned", name: "Write", arguments: "{}" };
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    frame({ type: "response.created", response: { id: "resp_owned", status: "in_progress", output: [] } })
      + frame({ type: "response.output_item.added", item: tool, output_index: 0 }),
    { headers: { "content-type": "text/event-stream" } }) });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
      adapter: "openai-responses", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } },
      combos: { [comboId]: { strategy: "failover", targets: [{ provider: "fixture", model: "model" }] } } };
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        model: `combo/${comboId}`, stream, tools: [], messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("undeclared_tool_call");
    expect(body.error.message).toContain("undeclared client tool");
    expect(body.error.message).not.toContain("Write");
  } finally { await upstream.stop(true); }
});

for (const stream of [false, true]) test(`direct encoder retains an identified local recovery refusal stream=${stream}`, async () => {
  const { rememberProxyErrorMessage } = await import("../../src/lib/client-error-body");
  const { encodeChatCompletionSse } = await import("../../src/protocols/encoders/chat");
  const context = {}; const message = "owned local api key refusal";
  rememberProxyErrorMessage(context, message, { status: 401, type: "authentication_error", code: "invalid_api_key" });
  const options = { model: "fixture", translatorBudget: createTestTranslatorBudget(), proxyErrorContext: context };
  const events: AdapterEvent[] = [{ type: "error", message, status: 401, errorType: "authentication_error", code: "invalid_api_key" }];
  const response = stream ? new Response(encodeChatCompletionSse((async function* () { yield* events; })(), options))
    : await foldChatCompletion((async function* () { yield* events; })(), options);
  expect(response.status).toBe(stream ? 200 : 401);
  const text = await response.text();
  const body = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error) : JSON.parse(text);
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.code).toBe("invalid_api_key");
  expect(body.error.message).toBe(message);
});

for (const stream of [false, true]) test(`copied recovery metadata cannot claim a local message stream=${stream}`, async () => {
  const { rememberProxyErrorMessage } = await import("../../src/lib/client-error-body");
  const { encodeChatCompletionSse } = await import("../../src/protocols/encoders/chat");
  const context = {}; const message = "owned local api key refusal";
  rememberProxyErrorMessage(context, message, { status: 401, type: "authentication_error", code: "invalid_api_key" });
  const options = { model: "fixture", translatorBudget: createTestTranslatorBudget(), proxyErrorContext: context };
  const event = Object.assign({ type: "error", message: `${message} ${KEY}`, status: 401,
    errorType: "authentication_error", code: "invalid_api_key" } as AdapterEvent, { proxyAuthored: true });
  const response = stream ? new Response(encodeChatCompletionSse((async function* () { yield event; })(), options))
    : await foldChatCompletion((async function* () { yield event; })(), options);
  expect(response.status).toBe(stream ? 200 : 401);
  const text = await response.text();
  const body = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error) : JSON.parse(text);
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.code).toBe("invalid_api_key");
  expect(body.error.message).toBe("The provider rejected the configured credentials.");
  expect(text).not.toContain(KEY);
});

for (const stream of [false, true]) test(`copied local message cannot claim different error fields stream=${stream}`, async () => {
  const { rememberProxyErrorMessage, CLIENT_ERROR_CONTRACTS } = await import("../../src/lib/client-error-body");
  const { encodeChatCompletionSse } = await import("../../src/protocols/encoders/chat");
  const context = {}; const message = "owned local api key refusal";
  rememberProxyErrorMessage(context, message, { status: 401, type: "authentication_error", code: "invalid_api_key" });
  const options = { model: "fixture", translatorBudget: createTestTranslatorBudget(), proxyErrorContext: context };
  const event: AdapterEvent = { type: "error", message, errorType: KEY, code: "cyber_policy", status: 400 };
  const response = stream ? new Response(encodeChatCompletionSse((async function* () { yield event; })(), options))
    : await foldChatCompletion((async function* () { yield event; })(), options);
  expect(response.status).toBe(stream ? 200 : 400);
  const text = await response.text();
  const body = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error) : JSON.parse(text);
  expect(body.error.code).toBe("cyber_policy");
  expect(body.error.type).toBe("invalid_request_error");
  expect(body.error.message).toBe(CLIENT_ERROR_CONTRACTS.cyber_policy);
  expect(text).not.toContain(KEY);
});

for (const reason of ["adapter_eof", "upstream_stall_timeout", "missing_terminal_event"]) {
  for (const route of ["direct", "translated", "passthrough"] as const) {
    test(`copied incomplete sentence stays upstream-derived reason=${reason} route=${route}`, async () => {
      const { CLIENT_ERROR_CONTRACTS } = await import("../../src/lib/client-error-body");
      const { encodeChatCompletionSse } = await import("../../src/protocols/encoders/chat");
      const { bridgeToResponsesSSE } = await import("../../src/bridge");
      const { responsesSseToChatCompletionsSse } = await import("../../src/chat/outbound");
      const message = `upstream stream ended early (${reason})`;
      const events: AdapterEvent[] = [{ type: "incomplete", reason, message }];
      const context = {};
      const budget = createTestTranslatorBudget();
      const options = { model: "fixture", translatorBudget: budget, proxyErrorContext: context };
      const source = route === "direct" ? encodeChatCompletionSse((async function* () { yield* events; })(), options)
        : responsesSseToChatCompletionsSse(route === "translated"
          ? bridgeToResponsesSSE((async function* () { yield* events; })(), "fixture", undefined, undefined, undefined, undefined, 2_000, { translatorBudget: budget })
          : bytes("event: response.incomplete\n" + frame({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason, message } } })), "fixture", options);
      const text = await new Response(source).text();
      const failure = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error);
      expect(failure).toBeDefined();
      expect(failure.error.type).toBe("server_error");
      expect(failure.error.code).toBe("upstream_server_error");
      expect(failure.error.message).toBe(CLIENT_ERROR_CONTRACTS.stream_incomplete);
    });
  }
}

for (const buffered of [false, true]) test(`bridge undeclared refusal uses proxy wording buffered=${buffered}`, async () => {
  const { bridgeToResponsesSSE, buildResponseJSON } = await import("../../src/bridge");
  const events: AdapterEvent[] = [{ type: "tool_call_start", id: "call_fixture", name: KEY }, { type: "done" }];
  const replay = async function* () { yield* events; };
  const options = { translatorBudget: createTestTranslatorBudget(), declaredToolNames: new Set<string>() };
  const text = buffered ? JSON.stringify(await buildResponseJSON(events, "fixture", options))
    : await new Response(bridgeToResponsesSSE(replay(), "fixture", undefined, undefined, undefined, undefined, 2_000, options)).text();
  const payloads = buffered ? [JSON.parse(text)] : text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const failure = payloads.find(value => value.error || value.response?.error);
  expect(failure).toBeDefined();
  const error = failure.error ?? failure.response.error;
  expect(error.type).toBe(buffered ? "upstream_error" : "server_error");
  expect(error.code).toBe("upstream_server_error");
  expect(error.message).toContain("undeclared client tool");
  expect(text).not.toContain(KEY);
});

for (const reason of ["adapter_eof", "upstream_stall_timeout", "missing_terminal_event"]) for (const stream of [false, true]) {
  test(`upstream incomplete copy is normalized by the full Chat handler reason=${reason} stream=${stream}`, async () => {
    const { CLIENT_ERROR_CONTRACTS } = await import("../../src/lib/client-error-body");
    const message = `upstream stream ended early (${reason})`;
    const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
      "event: response.incomplete\n" + frame({ type: "response.incomplete", response: { id: "resp_incomplete", status: "incomplete", output: [], incomplete_details: { reason, message } } }),
      { headers: { "content-type": "text/event-stream" } }) });
    try {
      const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: {
        adapter: "openai-responses", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true, authMode: "key", apiKey: KEY } } };
      const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          model: "fixture/model", stream, messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" });
      expect(response.status).toBe(stream ? 200 : 502);
      const text = await response.text();
      const failure = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error) : JSON.parse(text);
      expect(failure).toBeDefined();
      expect(failure.error.type).toBe("server_error");
      expect(failure.error.code).toBe("upstream_server_error");
      expect(failure.error.message).toBe(CLIENT_ERROR_CONTRACTS.stream_incomplete);
    } finally { await upstream.stop(true); }
  });
}

test("a genuine bridge EOF retains its message through a request-owned wrapper", async () => {
  const { bridgeToResponsesSSE } = await import("../../src/bridge");
  const { responsesSseToChatCompletionsSse } = await import("../../src/chat/outbound");
  const { hasProxyIncomplete } = await import("../../src/lib/client-error-body");
  const context = {};
  const budget = createTestTranslatorBudget();
  const bridge = bridgeToResponsesSSE((async function* () {})(), "fixture", undefined, undefined, undefined, undefined, 2_000,
    { translatorBudget: budget, proxyErrorContext: context });
  expect(hasProxyIncomplete(context, "adapter_eof")).toBe(false);
  const text = await new Response(responsesSseToChatCompletionsSse(bridge.pipeThrough(new TransformStream()), "fixture",
    { translatorBudget: budget, proxyErrorContext: context })).text();
  const failure = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error);
  expect(failure).toBeDefined();
  expect(failure.error.type).toBe("server_error");
  expect(failure.error.code).toBe("upstream_server_error");
  expect(failure.error.message).toBe("upstream stream ended early (adapter_eof)");
  expect(hasProxyIncomplete(context, "adapter_eof")).toBe(true);
});

for (const direct of [false, true]) test(`Zed generated EOF keeps its proxy origin direct=${direct}`, async () => {
  const { translateZedOpenAiStream } = await import("../../src/adapters/zed-openai-stream");
  const { encodeChatCompletionSse } = await import("../../src/protocols/encoders/chat");
  const { bridgeToResponsesSSE } = await import("../../src/bridge");
  const { responsesSseToChatCompletionsSse } = await import("../../src/chat/outbound");
  const budget = createTestTranslatorBudget();
  const events = translateZedOpenAiStream(bytes(frame({ type: "response.output_item.added", output_index: 0,
    item: { type: "function_call", id: "fc_eof", call_id: "call_eof", name: "lookup", arguments: "", status: "in_progress" } })), budget);
  const source = direct ? encodeChatCompletionSse(events, { model: "fixture", translatorBudget: budget })
    : responsesSseToChatCompletionsSse(bridgeToResponsesSSE(events, "fixture", undefined, undefined, undefined, undefined, 2_000,
      { translatorBudget: budget }), "fixture", { translatorBudget: budget });
  const text = await new Response(source).text();
  const failure = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error);
  expect(failure).toBeDefined();
  expect(failure.error.type).toBe("server_error");
  expect(failure.error.code).toBe("upstream_server_error");
  expect(failure.error.message).toBe("upstream stream ended early (adapter_eof)");
});

for (const message of ["upstream stream ended early (adapter_eof)", KEY]) {
  test(`a prior synthetic reason cannot authorize a supplied incomplete message shape=${message === KEY ? "sentinel" : "copy"}`, async () => {
    const { rememberProxyIncomplete, CLIENT_ERROR_CONTRACTS } = await import("../../src/lib/client-error-body");
    const { responsesSseToChatCompletionsSse } = await import("../../src/chat/outbound");
    const context = {};
    rememberProxyIncomplete(context, "adapter_eof");
    const text = await new Response(responsesSseToChatCompletionsSse(bytes("event: response.incomplete\n" + frame({
      type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "adapter_eof", message } },
    })), "fixture", { translatorBudget: createTestTranslatorBudget(), proxyErrorContext: context })).text();
    const failure = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error);
    expect(failure).toBeDefined();
    expect(failure.error.type).toBe("server_error");
    expect(failure.error.code).toBe("upstream_server_error");
    expect(failure.error.message).toBe(CLIENT_ERROR_CONTRACTS.stream_incomplete);
    expect(text).not.toContain(KEY);
  });
}

for (const route of ["direct", "translated", "passthrough"] as const) test(`explicit incomplete contract precedes copied structural wording route=${route}`, async () => {
  const { CLIENT_ERROR_CONTRACTS } = await import("../../src/lib/client-error-body");
  const { encodeChatCompletionSse } = await import("../../src/protocols/encoders/chat");
  const { bridgeToResponsesSSE } = await import("../../src/bridge");
  const { responsesSseToChatCompletionsSse } = await import("../../src/chat/outbound");
  const message = "upstream returned malformed Chat Completions JSON";
  const budget = createTestTranslatorBudget();
  const events: AdapterEvent[] = [{ type: "incomplete", reason: "adapter_eof", message }];
  const source = route === "direct" ? encodeChatCompletionSse((async function* () { yield* events; })(), { model: "fixture", translatorBudget: budget })
    : responsesSseToChatCompletionsSse(route === "translated"
      ? bridgeToResponsesSSE((async function* () { yield* events; })(), "fixture", undefined, undefined, undefined, undefined, 2_000, { translatorBudget: budget })
      : bytes("event: response.incomplete\n" + frame({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "adapter_eof", message } } })), "fixture", { translatorBudget: budget });
  const text = await new Response(source).text();
  const failure = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.error);
  expect(failure).toBeDefined();
  expect(failure.error.type).toBe("server_error");
  expect(failure.error.code).toBe("upstream_server_error");
  expect(failure.error.message).toBe(CLIENT_ERROR_CONTRACTS.stream_incomplete);
});

for (const stream of [false, true]) for (const slot of ["userinfo", "path", "query", "provider"] as const) {
  test(`combo refusal bounds configured target ${slot}, stream=${stream}`, async () => {
    const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../src/combos");
    const { getRequestLogEntries } = await import("../../src/server/request-log");
    clearComboSelectionState(); clearComboTargetCooldowns();
    const model = slot === "userinfo" ? `https://${KEY}@provider.example/model` : slot === "query" ? `https://provider.example/model?key=${KEY}` : `https://provider.example/${KEY}`;
    const provider = slot === "provider" ? `https://${KEY}@provider.example` : "missing";
    const config: OcxConfig = { port: 0, providers: {}, combos: { bounded: { strategy: "failover", targets: [{ provider, model }] } } };
    const requestId = crypto.randomUUID();
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "combo/bounded", stream, messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
    expect(response.status).toBe(503);
    const text = await response.text(); const payload = JSON.parse(text);
    expect(payload.error.type).toBe("server_error"); expect(payload.error.code).toBe("server_is_overloaded");
    expect(text).not.toContain(KEY);
    expect(payload.error.message).toContain("target 1");
    const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
    expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe(503);
    expect(JSON.stringify(rows)).not.toContain(KEY);
    await assertPersistedRefusal(requestId, 503);
  });
}

for (const stream of [false, true]) test(`Antigravity cached native model stays internal stream=${stream}`, async () => {
  const { saveCredential, getAccountSet } = await import("../../src/oauth/store");
  const { setCached, clearModelCache } = await import("../../src/codex/model-cache");
  const { encodeRoutedModelId } = await import("../../src/providers/slug-codec");
  const { recordAntigravityAccountRoster, clearAntigravityAccountRosters } = await import("../../src/providers/antigravity-account-roster");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const provider = "google-antigravity"; const native = `https://${KEY}@provider.example/${KEY}?key=${KEY}`;
  await saveCredential(provider, { access: "synthetic-model-label", refresh: "synthetic-model-refresh", expires: Date.now() + 3_600_000, projectId: "synthetic-project", source: "oauth" });
  const account = getAccountSet(provider)!.activeAccountId;
  recordAntigravityAccountRoster(provider, account, [{ id: "other", wireModelId: "other" } as never]);
  setCached(provider, [{ id: native } as never]);
  const config: OcxConfig = { port: 0, defaultProvider: provider, providers: { [provider]: { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", googleMode: "cloud-code-assist" } } };
  const requestId = crypto.randomUUID();
  try {
    const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `${provider}/${encodeRoutedModelId(native)}`, stream, messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
    expect(response.status).toBe(403); const text = await response.text(); const payload = JSON.parse(text);
    expect(payload.error.type).toBe("permission_error"); expect(payload.error.code).toBe("permission_denied");
    expect(text).not.toContain(KEY);
    const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
    expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe(403); expect(JSON.stringify(rows)).not.toContain(KEY);
    await assertPersistedRefusal(requestId, 403);
  } finally { clearModelCache(provider); clearAntigravityAccountRosters(); }
});

test("input admission uses the original selector after memory routing", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const config: OcxConfig = { port: 0, defaultProvider: "gateway", providers: { gateway: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: "https://provider.example/v1", contextWindow: 16 } }, memoryModels: { extract: { model: `gateway/${KEY}` } } };
  const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory", thread_source: "memory_consolidation" }) }, body: JSON.stringify({ model: "gpt-5.6-luna", input: "a".repeat(4000) }) }), config, ctx);
  expect(response.status).toBe(413);
  const text = await responseWithDeferredRequestLog(response, requestId, Date.now(), ctx).text(); const payload = JSON.parse(text);
  expect(payload.error.type).toBe("invalid_request_error"); expect(payload.error.code).toBe("input_admission_refused");
  expect(text).not.toContain(KEY);
  const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
  expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe(413); expect(JSON.stringify(rows)).not.toContain(KEY);
  await assertPersistedRefusal(requestId, 413);
});

for (const child of [false, true]) test(`compaction scope denial keeps the original client selector child=${child}`, async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const config: OcxConfig = { port: 0, defaultProvider: "gateway", providers: { gateway: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: "https://provider.example/v1" } }, compactionRouting: { model: `gateway/${KEY}` } };
  const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }) }, body: JSON.stringify({ model: child ? `gateway/${KEY}` : "gateway/client-model", input: [{ type: "compaction_trigger" }] }) }), config, ctx, { admissionScope: { providers: ["other"], models: [] }, ...(child ? { compactionRoutingOverride: { sourceModel: "gateway/client-model" } } : {}) });
  expect(response.status).toBe(403);
  const text = await responseWithDeferredRequestLog(response, requestId, Date.now(), ctx).text(); const payload = JSON.parse(text);
  expect(payload.error.type).toBe("model_not_allowed_for_key"); expect(payload.error.code).toBeUndefined(); expect(payload.error.message).toContain("not allowed for this API key");
  expect(text).not.toContain(KEY);
  const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
  expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe(403); expect(JSON.stringify(rows)).not.toContain(KEY);
  await assertPersistedRefusal(requestId, 403);
});

for (const surface of ["responses", "chat-buffered", "chat-stream"]) test(`Command Code rewritten plan model stays internal surface=${surface}`, async () => {
  let wireModel: unknown;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { wireModel = (await req.json() as { params: { model: unknown } }).params.model; return Response.json({ success: false, error: { code: "FORBIDDEN", message: "MODEL_NOT_IN_PLAN: fixture" } }, { status: 403 }); } });
  try {
    const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "command-code", models: [KEY], defaultModel: KEY, authMode: "key", apiKey: "synthetic", baseUrl: `${upstream.url}`, allowPrivateNetwork: true } }, blockedModelRedirects: { "client-model": KEY } };
    const { handleResponses } = await import("../../src/server/responses");
    const handler = surface === "responses" ? handleResponses : handleChatCompletions;
    const response = await handler(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture/client-model", stream: surface === "chat-stream", ...(surface === "responses" ? { input: "hi" } : { messages: [{ role: "user", content: "hi" }] }) }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(400); const text = await response.text(); const payload = JSON.parse(text);
    expect(payload.error.type).toBe("invalid_request_error"); expect(payload.error.code).toBe(surface === "responses" ? "model_not_in_plan" : "invalid_request_error"); expect(text).toContain("MODEL_NOT_IN_PLAN");
    expect(wireModel).toBe(KEY); expect(text).not.toContain(KEY);
  } finally { await upstream.stop(true); }
});

test("Chat request read failures use a fixed local diagnostic", async () => {
  const req = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: new ReadableStream({ start(controller) { controller.error(new Error(KEY)); } }), duplex: "half" } as RequestInit);
  const response = await handleChatCompletions(req, { port: 0, providers: {} }, { model: "", provider: "" });
  expect(response.status).toBe(400); const text = await response.text(); const payload = JSON.parse(text);
  expect(payload.error.type).toBe("invalid_request_error"); expect(payload.error.code).toBeNull(); expect(payload.error.message).toBe("Invalid JSON body");
  expect(text).not.toContain(KEY);
});

async function assertPersistedRefusal(requestId: string, status: number, expected?: { model?: string; requestedModel?: string; errorCode?: string }): Promise<void> {
  const { readUsageEntries, resetUsageReadCacheForTests } = await import("../../src/usage/log");
  resetUsageReadCacheForTests();
  const row = readUsageEntries().find(entry => entry.requestId === requestId);
  expect(row).toBeDefined(); expect(row!.status).toBe(status);
  if (expected?.model !== undefined) expect(row!.model).toBe(expected.model);
  if (expected?.requestedModel !== undefined) expect(row!.requestedModel).toBe(expected.requestedModel);
  if (expected?.errorCode !== undefined) expect(row!.errorCode).toBe(expected.errorCode);
  expect(JSON.stringify(row)).not.toContain(KEY);
}

for (const stream of [false, true]) test(`policy alias refusal uses the client selector stream=${stream}`, async () => {
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-chat", baseUrl: "https://provider.example/v1", disabled: true } }, routingProfiles: { [KEY]: { alias: "client-policy", candidates: [{ provider: "fixture", model: "model" }] } } };
  const requestId = crypto.randomUUID();
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "client-policy", stream, messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" }, { requestId, start: Date.now() });
  expect(response.status).toBe(404); const text = await response.text(); const payload = JSON.parse(text);
  expect(payload.error.type).toBe("invalid_request_error"); expect(payload.error.code).toBe("model_not_found"); expect(payload.error.message).toContain("No eligible candidates");
  expect(text).not.toContain(KEY);
  const rows = getRequestLogEntries().filter(row => row.requestId === requestId);
  expect(rows).toHaveLength(1); expect(rows[0]!.status).toBe(404); expect(JSON.stringify(rows)).not.toContain(KEY);
  await assertPersistedRefusal(requestId, 404);
});

for (const slot of ["model", "provider"] as const) test(`scope refusals project late-bound log ${slot}`, async () => {
  const { AdmissionModelDeniedError, admissionModelDeniedResponse, projectAdmissionModelDeniedLog } = await import("../../src/server/admission-model-scope");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const requestId = crypto.randomUUID();
  const ctx = { model: slot === "model" ? KEY : "gpt-6", provider: slot === "provider" ? `https://${KEY}@provider.example/path` : "fixture", requestedModel: "client-selector", errorCode: "model_not_allowed_for_key", wireModel: KEY, resolvedModel: KEY, servedModel: KEY, responseModelEcho: KEY };
  // Exercise runtime callers too: an unbranded label must never authorize copied text.
  const failure = new AdmissionModelDeniedError("client-selector" as never, { providerName: "fixture", modelId: KEY });
  const response = admissionModelDeniedResponse(projectAdmissionModelDeniedLog(failure, ctx));
  expect(response.status).toBe(403);
  const text = await responseWithDeferredRequestLog(response, requestId, Date.now(), ctx).text();
  expect(JSON.parse(text).error.type).toBe("model_not_allowed_for_key"); expect(JSON.parse(text).error.code).toBeUndefined();
  expect(text).not.toContain(KEY);
  const row = getRequestLogEntries().find(row => row.requestId === requestId);
  expect(row).toBeDefined(); expect(row!.status).toBe(403); expect(row!.errorCode).toBe("permission_denied");
  expect(JSON.stringify(row)).not.toContain(KEY); await assertPersistedRefusal(requestId, 403);
});

for (const stream of [false, true]) for (const endpoint of ["responses", "compact", "compact-recall"] as const) test(`original model labels survive combo overflow endpoint=${endpoint} stream=${stream}`, async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { handleResponsesCompact } = await import("../../src/server/responses/compact");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../src/combos");
  clearComboSelectionState(); clearComboTargetCooldowns();
  let sends = 0;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { sends++; return Response.json({ error: { message: "fixture input too large", type: "invalid_request_error", code: "context_length_exceeded" } }, { status: 413 }); } });
  try {
    const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true } }, combos: { [KEY]: { strategy: endpoint === "responses" ? "jev" : "failover", targets: [{ provider: "fixture", model: "model" }] } }, compactionRouting: { model: `combo/${KEY}` } };
    config.providers.jev = { adapter: "jev-decision", apiKey: "synthetic", baseUrl: "https://api.typesafe.ai/v1/systemone", fetch: (async () => Response.json({ answers: { route: { choice: "fixture/model:none" } } })) as typeof fetch };
    config.providers.fixture!.reasoningEfforts = [];
    const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
    if (endpoint === "compact-recall") {
      delete config.compactionRouting;
      const { rememberComboForLane, clearComboRecallForTests } = await import("../../src/server/responses/combo-session-recall");
      const { sessionLaneIdFromRequest } = await import("../../src/server/request-log-conversation");
      const { captureConfigGeneration } = await import("../../src/lib/state-store-sweeper");
      clearComboRecallForTests();
      rememberComboForLane(sessionLaneIdFromRequest(new Headers({ session_id: requestId })), KEY, { provider: "fixture", model: "model" }, "client-model", captureConfigGeneration());
    }
    const req = new Request(`http://localhost/v1/responses${endpoint !== "responses" ? "/compact" : ""}`, { method: "POST", headers: { "content-type": "application/json", session_id: requestId, ...(endpoint === "compact-recall" ? {} : { "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }) }) }, body: JSON.stringify({ model: "client-model", stream, input: [{ type: "compaction_trigger" }] }) });
    const response = endpoint !== "responses" ? await handleResponsesCompact(req, config, ctx) : await handleResponses(req, config, ctx);
    expect(response.status).toBe(endpoint !== "responses" ? 502 : stream ? 200 : 413);
    const text = await responseWithDeferredRequestLog(response, requestId, Date.now(), ctx).text();
    const payload = stream && endpoint === "responses" ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.type === "response.failed")?.response : JSON.parse(text);
    expect(payload).toBeDefined(); expect(payload.error.type).toBe(endpoint !== "responses" ? "server_error" : "invalid_request_error"); expect(payload.error.code).toBe(endpoint !== "responses" ? "upstream_server_error" : "context_length_exceeded"); expect(sends).toBe(1);
    if (stream && endpoint === "responses") { expect(payload.status).toBe("failed"); expect(payload.model).toBe("client-model"); }
    expect(text).not.toContain(KEY);
    const row = getRequestLogEntries().find(row => row.requestId === requestId);
    expect(row).toBeDefined(); expect(row!.status).toBe(endpoint !== "responses" ? 502 : stream ? 400 : 413); expect(row!.model).toBe("client-model"); expect(row!.requestedModel).toBe("client-model"); expect(JSON.stringify(row)).not.toContain(KEY);
    await assertPersistedRefusal(requestId, endpoint !== "responses" ? 502 : stream ? 400 : 413, { model: "client-model", requestedModel: "client-model" });
  } finally { await upstream.stop(true); }
});

for (const selector of ["directive", "picker"] as const) test(`Messages model label precedes ${selector} decoding`, async () => {
  const { handleClaudeMessages } = await import("../../src/server/claude-messages");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const config: OcxConfig = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: "https://provider.example/v1" } }, claudeCode: { model: `fixture/${KEY}` }, apiKeys: [{ id: "scope", name: "scope", key: "synthetic-scope", createdAt: "2026-01-01T00:00:00Z", allowedProviders: ["other"] }] };
  const requestId = crypto.randomUUID();
  const original = selector === "picker" ? `ocx-claude-native--claude-${KEY}-${"x".repeat(80)}` : "client-model";
  if (selector === "picker") { expect(original.length).toBeGreaterThan(128); expect((await import("../../src/claude/alias")).resolveAlias(original)!.length).toBeLessThanOrEqual(128); }
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: original, max_tokens: 16, ...(selector === "directive" ? { system: `<!-- ocx-route: fixture/${KEY} -->` } : {}), messages: [{ role: "user", content: "hi" }] }) }), config, { model: "", provider: "" }, { requestId, start: Date.now(), admission: { kind: "configured", keyId: "scope", source: "bearer" } });
  expect(response.status).toBe(403); const text = await response.text(); const payload = JSON.parse(text);
  expect(payload.error.type).toBe("model_not_allowed_for_key"); expect(payload.error.code).toBeUndefined();
  expect(payload.error.model).toBeUndefined();
  expect(text.length).toBeGreaterThan(0); expect(text).not.toContain(KEY); expect(text).not.toContain("client-model");
  expect(text).not.toContain(`fixture/${KEY}`);
  expect(text).not.toContain(KEY);
  const row = getRequestLogEntries().find(row => row.requestId === requestId);
  expect(row).toBeDefined(); expect(row!.status).toBe(403); expect(JSON.stringify(row)).not.toContain(KEY); await assertPersistedRefusal(requestId, 403, { requestedModel: selector === "picker" ? "the requested model" : "client-model", errorCode: "permission_denied" });
});

for (const slot of ["combo", "model", "url"] as const) test(`combo service diagnostics bound configured ${slot}`, async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../src/combos");
  clearComboSelectionState(); clearComboTargetCooldowns();
  const output: string[] = []; const warn = console.warn; const debug = console.debug;
  console.warn = (...args) => output.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
  console.debug = console.warn;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ error: { message: "fixture failure" } }, { status: 500 }); } });
  try {
    const combo = slot === "combo" ? KEY : "bounded-diagnostics";
    const model = slot === "url" ? `https://${KEY}@provider.example/model?key=${KEY}` : slot === "model" ? KEY : "model";
    const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true } }, combos: { [combo]: { strategy: "failover", targets: [{ provider: "fixture", model }] } } };
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `combo/${combo}`, input: "hi" }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(500); const payload = await response.json(); expect(payload.error).toBeDefined(); expect(payload.error.type).toBe("server_error"); expect(payload.error.code).toBe("upstream_server_error");
    expect(output.some(line => line.includes("failed with 500"))).toBe(true);
    expect(output.join("\n")).not.toContain(KEY);
    expect(output.join("\n")).toContain("target 1 (fixture)");
  } finally { console.warn = warn; console.debug = debug; await upstream.stop(true); }
});

for (const stream of [false, true]) test(`concrete compaction overflow uses the client model stream=${stream}`, async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.json({ error: { message: "fixture context overflow" } }, { status: 413 }); } });
  try {
    const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true } }, compactionRouting: { model: `fixture/${KEY}` } };
    const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", compaction: { trigger: "manual" } }) }, body: JSON.stringify({ model: "client-model", stream, input: [{ type: "compaction_trigger" }] }) }), config, ctx);
    expect(response.status).toBe(stream ? 200 : 413);
    const text = await responseWithDeferredRequestLog(response, requestId, Date.now(), ctx).text();
    const body = stream ? text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.type === "response.failed")?.response : JSON.parse(text);
    expect(body).toBeDefined(); expect(body.error.type).toBe("invalid_request_error"); expect(body.error.code).toBe("context_length_exceeded");
    expect(text).not.toContain(KEY);
    const row = getRequestLogEntries().find(row => row.requestId === requestId);
    expect(row).toBeDefined(); expect(row!.status).toBe(stream ? 400 : 413); expect(JSON.stringify(row)).not.toContain(KEY);
  } finally { await upstream.stop(true); }
});

test("combo effort diagnostics omit the configured model", async () => {
  const { concreteComboRequestBody } = await import("../../src/combos/request");
  const output: unknown[][] = []; const debug = console.debug;
  console.debug = (...args) => { output.push(args); };
  try {
    const body = concreteComboRequestBody({ input: "hi" }, { provider: "fixture", model: KEY }, "high", []);
    expect(body.model).toBe(`fixture/${KEY}`);
    expect(output).toHaveLength(1); expect(output[0]![0]).toBe("[opencodex] combo default effort omitted");
    expect(JSON.stringify(output)).not.toContain(KEY);
  } finally { console.debug = debug; }
});

for (const mode of ["wait", "last-resort", "reprobe"] as const) test(`combo cooldown diagnostics use positions mode=${mode}`, async () => {
  const { clearComboSelectionState, pickComboTargetWithWait } = await import("../../src/combos/resolve");
  const { clearComboTargetCooldowns, coolComboTarget } = await import("../../src/combos/failover");
  clearComboSelectionState(); clearComboTargetCooldowns();
  const model = `https://${KEY}@provider.example/${KEY}?key=${KEY}`;
  const target = { provider: "fixture", model };
  const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-chat", baseUrl: "https://provider.example/v1" } }, combos: { [KEY]: { strategy: "failover", targets: [target, ...(mode === "last-resort" ? [{ provider: "fixture", model: "backup", lastResort: true }] : [])], ...(mode === "last-resort" ? { cooldownWaitPolicy: "before-last-resort" } : {}), ...(mode === "reprobe" ? { cooldownReprobe: { enabled: true, intervalMs: 1000 } } : {}) } } };
  const now = Date.now(); coolComboTarget(KEY, target, { now, cooldownMs: 10 });
  const output: string[] = []; const warn = console.warn;
  console.warn = (...args) => { output.push(args.join(" ")); };
  try {
    const pick = await pickComboTargetWithWait(config, KEY, { now, waitForCooldownMs: 100, sleep: async () => {} });
    expect(pick).not.toBeNull(); expect(pick!.target.model).toBe(model);
    expect(output).toHaveLength(1); expect(output[0]).toContain(mode === "reprobe" ? "reserving all-cooled" : mode === "last-resort" ? "deferring last resort" : "all targets cooling");
    expect(output.join("\n")).not.toContain(KEY);
    if (mode !== "reprobe") expect(output[0]).toContain("target 1 (fixture)");
  } finally { console.warn = warn; clearComboTargetCooldowns(); clearComboSelectionState(); }
});

for (const surface of ["chat", "claude", "compact", "native-messages"] as const) test(`scope row projection precedes final logging surface=${surface}`, async () => {
  const { handleClaudeMessages } = await import("../../src/server/claude-messages");
  const { handleResponsesCompact } = await import("../../src/server/responses/compact");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const native = surface === "native-messages";
  const selector = surface === "compact" || native ? "fixture/client-model" : `fixture/${"x".repeat(130)}${KEY}`;
  const config: OcxConfig = { port: 0, providers: { fixture: { adapter: native ? "anthropic" : "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: native ? "https://api.anthropic.com" : "https://provider.example/v1" } }, apiKeys: [{ id: "scope-order", name: "scope", key: "synthetic-scope-order", createdAt: "2026-01-01T00:00:00Z", ...(native ? { allowedModels: [`fixture/${KEY}`] } : { allowedProviders: ["other"] }) }], ...(surface === "compact" ? { compactionRouting: { model: `fixture/${KEY}` } } : {}), ...(native ? { blockedModelRedirects: { "client-model": KEY }, protocols: { rollout: { managedMessagesNative: true } } } : {}) };
  const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
  const admission = { kind: "configured" as const, keyId: "scope-order", source: "bearer" as const };
  const req = new Request("http://localhost/v1/fixture", { method: "POST", headers: { "content-type": "application/json", "anthropic-beta": "advisor-tool-2026-03-01" }, body: JSON.stringify({ model: selector, stream: false, max_tokens: 16, ...(surface === "compact" ? { input: [] } : { messages: [{ role: "user", content: "hi" }] }), ...(native ? { tools: [{ type: "advisor_20260301", name: "advisor", model: "other" }] } : {}) }) });
  const response = surface === "compact" ? await handleResponsesCompact(req, config, ctx, undefined, admission) : surface === "chat" ? await handleChatCompletions(req, config, ctx, { requestId, start: Date.now(), admission }) : await handleClaudeMessages(req, config, ctx, { requestId, start: Date.now(), admission });
  expect(response.status).toBe(403);
  const text = await (surface === "compact" ? responseWithDeferredRequestLog(response, requestId, Date.now(), ctx) : response).text();
  const body = JSON.parse(text); expect(body.error.type).toBe("model_not_allowed_for_key"); expect(body.error.code).toBeUndefined();
  const row = getRequestLogEntries().find(row => row.requestId === requestId);
  expect(row).toBeDefined(); expect(row!.status).toBe(403);
  expect(row!.requestedModel).toBe(surface === "compact" || native ? selector : "the requested model");
  expect(JSON.stringify(row)).not.toContain(KEY); await assertPersistedRefusal(requestId, 403, { requestedModel: surface === "compact" || native ? selector : "the requested model", errorCode: "permission_denied" });
});

test("streaming memory admission projects the final request row", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { responseWithDeferredRequestLog } = await import("../../src/server/relay");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: "https://provider.example/v1", contextWindow: 16 } }, memoryModels: { extract: { model: `fixture/${KEY}` } } };
  const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "memory", thread_source: "memory_consolidation" }) }, body: JSON.stringify({ model: "client-model", stream: true, input: "a".repeat(4000) }) }), config, ctx);
  expect(response.status).toBe(200); const text = await responseWithDeferredRequestLog(response, requestId, Date.now(), ctx).text();
  const failed = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.type === "response.failed");
  expect(failed).toBeDefined(); expect(failed.response.status).toBe("failed"); expect(failed.response.error.code).toBe("context_length_exceeded");
  const row = getRequestLogEntries().find(row => row.requestId === requestId);
  expect(row).toBeDefined(); expect(row!.status).toBe(400); expect(JSON.stringify(row)).not.toContain(KEY); await assertPersistedRefusal(requestId, 400);
});

for (const combo of [false, true]) for (const capped of [false, true]) test(`input refusal distinguishes the input cap combo=${combo} capped=${capped}`, async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../src/combos");
  clearComboSelectionState(); clearComboTargetCooldowns();
  const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: "https://provider.example/v1", contextWindow: 100, ...(capped ? { modelMaxInputTokens: { model: 16 } } : {}) } }, ...(combo ? { combos: { bounded: { strategy: "failover", targets: [{ provider: "fixture", model: "model" }] } } } : {}) };
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: combo ? "combo/bounded" : "fixture/model", input: "a".repeat(4000), ...(combo ? { max_output_tokens: 8 } : {}) }) }), config, { model: "", provider: "" });
  expect(response.status).toBe(413); const body = await response.json(); expect(body.error.type).toBe("invalid_request_error"); expect(body.error.code).toBe(combo ? "context_length_exceeded" : "input_admission_refused");
  expect(body.error.message).toContain(capped ? "input limit" : "context window");
  expect(body.error.message).toContain("100 tokens");
  if (capped) { expect(body.error.message).toContain("16 tokens"); expect(body.error.message).not.toContain("context window of fixture/model (16 tokens)"); }
  if (combo) expect(body.error.message).toContain("No target of this combo");
});

test("combo outbound-size diagnostics use the original client label", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../src/combos");
  clearComboSelectionState(); clearComboTargetCooldowns();
  const output: string[] = []; const warn = console.warn;
  console.warn = (...args) => { output.push(args.join(" ")); };
  try {
    const config: OcxConfig = { port: 0, maxUpstreamBodyBytes: 1, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: "https://provider.example/v1" } }, combos: { bounded: { strategy: "failover", targets: [{ provider: "fixture", model: KEY }] } } };
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "combo/bounded", input: "hi" }) }), config, { model: "", provider: "" });
    expect(response.status).toBe(413); const body = await response.json(); expect(body.error.type).toBe("upstream_error"); expect(body.error.code).toBe("upstream_error");
    expect(output.some(line => line.includes("refused an oversized outbound body"))).toBe(true);
    expect(output.join("\n")).not.toContain(KEY);
  } finally { console.warn = warn; }
});

test("committed combo failure keeps the original model in its request row", async () => {
  const { handleResponses } = await import("../../src/server/responses");
  const { getRequestLogEntries, addFinalRequestLog } = await import("../../src/server/request-log");
  const { clearComboSelectionState, clearComboTargetCooldowns } = await import("../../src/combos");
  clearComboSelectionState(); clearComboTargetCooldowns();
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { let next = 0; return new Response(new ReadableStream({ async pull(controller) { if (next++ === 0) controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\n" + frame({ type: "response.output_text.delta", delta: "fixture output", item_id: "msg_fixture", output_index: 0, content_index: 0 }))); else { await Bun.sleep(10); controller.enqueue(new TextEncoder().encode("event: response.failed\n" + frame({ type: "response.failed", response: { status: "failed", model: "model", output: [], error: { type: "server_error", code: "upstream_server_error", message: "fixture failed" } } }))); controller.close(); } } }), { headers: { "content-type": "text/event-stream" } }); } });
  try {
    const config: OcxConfig = { port: 0, providers: { fixture: { adapter: "openai-responses", authMode: "key", apiKey: "synthetic", baseUrl: `${upstream.url}v1`, allowPrivateNetwork: true } }, combos: { [KEY]: { strategy: "failover", targets: [{ provider: "fixture", model: "model" }] } } };
    const requestId = crypto.randomUUID(); const ctx = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: `combo/${KEY}`, stream: true, input: "hi" }) }), config, ctx, { clientModelLabel: (await import("../../src/lib/error-destination")).clientFacingModelLabel("client-model") });
    expect(response.status).toBe(200); const text = await response.text();
    const failed = text.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(value => value.type === "response.failed");
    expect(text).toContain("fixture output"); expect(failed).toBeDefined(); expect(failed.response.status).toBe("failed"); expect(failed.response.error.type).toBe("server_error"); expect(failed.response.error.code).toBe("upstream_server_error"); expect(text).not.toContain(KEY);
    addFinalRequestLog(requestId, Date.now(), ctx, 500, { closeReason: "terminal", terminalStatus: "failed" });
    const row = getRequestLogEntries().find(row => row.requestId === requestId);
    expect(row).toBeDefined(); expect(row!.status).toBe(500); expect(row!.errorCode).toBe("upstream_server_error"); expect(JSON.stringify(row)).not.toContain(KEY); await assertPersistedRefusal(requestId, 500);
  } finally { await upstream.stop(true); }
});
