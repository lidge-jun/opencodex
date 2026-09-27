/**
 * Ingress refusal of unrepresentable features (PF-06). Under `protocols.unrepresentable:
 * "reject"` a single-provider Chat or Messages route whose path would drop a requested feature
 * answers 400 in its own error shape, sends nothing upstream, and logs a blocked trace. The
 * legacy default forwards the same request and only reports the loss in the trace.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

let upstream: ReturnType<typeof Bun.serve> | undefined;
let requests = 0;
let releaseSpendHome: (() => void) | undefined;

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  await upstream?.stop(true);
  upstream = undefined;
});

function fixtureConfig(policy?: "reject" | "legacy"): OcxConfig {
  requests = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    requests++;
    await req.text();
    return Response.json({ id: "resp_fixture", status: "completed", output: [],
      usage: { input_tokens: 3, output_tokens: 1 } });
  } });
  releaseSpendHome ??= acquireOwnedSpendHome();
  return {
    port: 0,
    defaultProvider: "fixture",
    providers: { fixture: {
      adapter: "openai-responses", baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
      authMode: "key", apiKey: "fixture-key", allowPrivateNetwork: true, models: ["model"],
    } },
    ...(policy ? { protocols: { unrepresentable: policy } } : {}),
  } as OcxConfig;
}

function rowFor(requestId: string) {
  const rows = getRequestLogEntries().filter(entry => entry.requestId === requestId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function chatRequest(): Request {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", n: 2, stream: false, messages: [{ role: "user", content: "fixture" }] }),
  });
}

function messagesRequest(): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/model", max_tokens: 32, top_k: 5, stream: false,
      messages: [{ role: "user", content: "fixture" }] }),
  });
}

describe("Chat Completions ingress guard", () => {
  test("reject: n > 1 into a Responses upstream is refused with no upstream send", async () => {
    const config = fixtureConfig("reject");
    const requestId = `pf06-chat-reject-${crypto.randomUUID()}`;
    const response = await handleChatCompletions(chatRequest(), config, { model: "", provider: "" },
      { requestId, start: Date.now() });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: {
      type: "invalid_request_error",
      code: "unsupported_feature",
      message: "The selected route cannot carry these request features: request.multiple_choices",
    } });
    expect(requests).toBe(0);
    const row = rowFor(requestId);
    expect(row.status).toBe(400);
    expect(row.protocolTrace).toMatchObject({
      inbound: "chat", mode: "blocked", requestPath: [], reasonCodes: ["feature-unrepresentable"],
    });
  });

  test("legacy default: the same request is forwarded and the loss shows in the trace", async () => {
    const config = fixtureConfig();
    const requestId = `pf06-chat-legacy-${crypto.randomUUID()}`;
    const response = await handleChatCompletions(chatRequest(), config, { model: "", provider: "" },
      { requestId, start: Date.now() });
    await response.text();
    expect(response.status).not.toBe(400);
    expect(requests).toBe(1);
    expect(rowFor(requestId).protocolTrace).toMatchObject({
      inbound: "chat",
      requestPath: ["chat", "responses"],
      featureEffects: [{ feature: "request.multiple_choices", disposition: "unsupported" }],
    });
  });
});

describe("Messages ingress guard", () => {
  test("reject: top_k into a Responses upstream is refused in Anthropic error shape", async () => {
    const config = fixtureConfig("reject");
    const requestId = `pf06-messages-reject-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(messagesRequest(), config, { model: "", provider: "" },
      { requestId, start: Date.now() });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ type: "error", error: {
      type: "invalid_request_error",
      message: "The selected route cannot carry these request features: request.top_k",
    } });
    expect(requests).toBe(0);
    const row = rowFor(requestId);
    expect(row.status).toBe(400);
    expect(row.protocolTrace).toMatchObject({
      inbound: "messages", mode: "blocked", requestPath: [], reasonCodes: ["feature-unrepresentable"],
    });
  });

  test("legacy default: the same request is forwarded", async () => {
    const config = fixtureConfig();
    const requestId = `pf06-messages-legacy-${crypto.randomUUID()}`;
    const response = await handleClaudeMessages(messagesRequest(), config, { model: "", provider: "" },
      { requestId, start: Date.now() });
    await response.text();
    expect(response.status).not.toBe(400);
    expect(requests).toBe(1);
  });
});
