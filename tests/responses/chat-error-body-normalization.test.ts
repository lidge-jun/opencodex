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

async function flatEndpointExchange(combo: boolean, stream: boolean, flat: boolean, withContent = false, withMetadata = false) {
  const { clearComboTargetCooldowns, clearComboSelectionState } = await import("../../src/combos");
  const { clearKeyCooldowns } = await import("../../src/providers/key-failover");
  const { getRequestLogEntries } = await import("../../src/server/request-log");
  clearComboTargetCooldowns(); clearComboSelectionState(); clearKeyCooldowns();
  const sends: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const body = await req.json() as { model: string }; sends.push(body.model);
    if (body.model === "backup") return Response.json({ id: "fixture-backup", object: "chat.completion", created: 1, model: "backup", choices: [{ index: 0, message: { role: "assistant", content: "backup" }, finish_reason: "stop" }] });
    return new Response(`id: ${KEY}\nevent: ${flat ? "error" : "message"}\nretry: ${KEY}\n: ${KEY}\n${frame({ message: KEY, code: KEY, param: KEY, metadata: KEY, ...(withContent ? { service_tier: withMetadata ? KEY : "default", usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, ...(withMetadata ? { error: { message: KEY, type: KEY, code: KEY, param: KEY } } : {}) }, choices: [{ index: 0, delta: { role: "assistant", content: "retained content", reasoning_content: "retained reasoning" }, finish_reason: "stop" }] } : {}) })}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
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
