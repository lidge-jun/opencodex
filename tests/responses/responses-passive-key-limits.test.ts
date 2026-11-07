import { afterEach, expect, test } from "bun:test";
import { getDefaultConfig } from "../../src/config";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleManagementAPI } from "../../src/server/management-api";
import * as observations from "../../src/providers/passive-key-observation";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { ManagementRequest } from "../helpers/management-auth";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("Responses dispatch records canonical key headers for the physical wire model", async () => {
  const config = getDefaultConfig();
  config.defaultProvider = "fixture";
  config.defaultModel = "wire-model";
  config.providers = { fixture: { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1",
    authMode: "key", apiKey: "synthetic-key", models: ["wire-model"], liveModels: false } };
  let sends = 0;
  globalThis.fetch = (async (_input, init) => {
    sends++;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key");
    expect(JSON.parse(String(init?.body)).model).toBe("wire-model");
    return Response.json({ id: "synthetic", object: "chat.completion", model: "wire-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "42" } });
  }) as typeof fetch;
  const req = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture/wire-model", input: "synthetic", stream: false, store: false }) });
  const response = await handleResponses(req, config, { provider: "fixture", model: "wire-model" }, {});
  await response.text();
  expect(sends).toBe(1);
  expect(observations.getPassiveKeyLimits(config, "fixture", "wire-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 42 }]);
  expect(observations.listPassiveKeyLimits(config)).toMatchObject([{ provider: "fixture", model: "wire-model", windows: [{ dimension: "requests", limit: 100, remaining: 42 }] }]);
  const url = new URL("http://localhost/api/provider-quotas");
  const report = await handleManagementAPI(new ManagementRequest(url), url, config);
  const json = await report!.json();
  expect(report!.status).toBe(200);
  expect(json.passiveKeyLimits).toMatchObject([{ provider: "fixture", model: "wire-model", windows: [{ remaining: 42 }] }]);
  expect(JSON.stringify(json)).not.toContain("synthetic-key");
  expect(sends).toBe(1);
});

test("native Anthropic Messages records the actual API-key limits", async () => {
  const release = acquireOwnedSpendHome();
  try {
    const config = getDefaultConfig();
    config.defaultProvider = "anthropic-fixture";
    config.defaultModel = "claude-test-model";
    config.protocols = { rollout: { managedMessagesNative: true } };
    config.providers = { "anthropic-fixture": { adapter: "anthropic", baseUrl: "https://api.anthropic.com/v1",
      authMode: "key", apiKey: "synthetic-anthropic-key", models: ["claude-test-model"], liveModels: false } };
    globalThis.fetch = (async (_input, init) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("synthetic-anthropic-key");
      return Response.json({ id: "synthetic", type: "message", role: "assistant", model: "claude-test-model",
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
      { headers: { "anthropic-ratelimit-requests-limit": "100", "anthropic-ratelimit-requests-remaining": "42" } });
    }) as typeof fetch;
    const request = new Request("http://localhost/v1/messages", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anthropic-fixture/claude-test-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
    const response = await handleClaudeMessages(request, config, { provider: "", model: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(observations.getPassiveKeyLimits(config, "anthropic-fixture", "claude-test-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 42 }]);
  } finally { release(); }
});

test("native Chat records the physical key's rate-limit headers", async () => {
  const release = acquireOwnedSpendHome();
  try {
  const config = getDefaultConfig();
  config.defaultProvider = "chat-fixture";
  config.defaultModel = "chat-model";
  config.providers = { "chat-fixture": { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1",
    authMode: "key", apiKey: "synthetic-chat-key", models: ["chat-model"], liveModels: false } };
  globalThis.fetch = (async () => Response.json({ id: "synthetic", object: "chat.completion", model: "chat-model",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
  { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "34" } })) as typeof fetch;
  const request = new Request("http://localhost/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chat-fixture/chat-model", messages: [{ role: "user", content: "hi" }], stream: false }) });
  const response = await handleChatCompletions(request, config, { provider: "", model: "" });
  await response.text();
  expect(response.status).toBe(200);
  expect(observations.getPassiveKeyLimits(config, "chat-fixture", "chat-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 34 }]);
  } finally { release(); }
});

test("compact sends record the physical OpenAI key's limits", async () => {
  const release = acquireOwnedSpendHome();
  try {
    const config = getDefaultConfig();
    config.defaultProvider = "openai-apikey";
    config.defaultModel = "compact-model";
    config.providers = { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1",
      authMode: "key", apiKey: ["sk", "synthetic", "compact", "key"].join("-"), models: ["compact-model"], liveModels: false } };
    globalThis.fetch = (async () => Response.json({ id: "synthetic", object: "response.compaction", output: [] },
      { headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "21" } })) as typeof fetch;
    const request = new Request("http://localhost/v1/responses/compact", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai-apikey/compact-model", input: "hi" }) });
    const response = await handleResponsesCompact(request, config, { provider: "", model: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(observations.getPassiveKeyLimits(config, "openai-apikey", "compact-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 21 }]);
  } finally { release(); }
});
