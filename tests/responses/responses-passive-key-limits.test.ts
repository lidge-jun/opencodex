import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { handleResponses } from "../../src/server/responses/core";
import { handleResponsesCompact } from "../../src/server/responses/compact";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { handleManagementAPI } from "../../src/server/management-api";
import * as observations from "../../src/providers/passive-key-observation";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { ManagementRequest } from "../helpers/management-auth";
import { setProviderKeychainEntryFactoryForTests } from "../../src/providers/api-key-resolve";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { markPassiveKeyTransparent } from "../../src/lib/passive-key-fetch-proof";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { MistralBudgetPacer } from "../../src/providers/mistral-transport";
import { registerUpstreamRewriter } from "../../src/plugins/upstream-hooks";
import { runPassiveRead } from "../../src/lib/passive-read";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("local and passive quota responses hide credential-shaped account ids", async () => {
  const secretId = ["sk", "synthetic-credential-shaped-account-id"].join("-");
  const config = getDefaultConfig();
  config.providers = { fixture: { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authMode: "key",
    apiKey: "synthetic-key", apiKeyPool: [{ id: secretId, key: "synthetic-key" }], models: ["model"], liveModels: false } };
  const physical = markPassiveKeyTransparent((async () => new Response(null, { headers: { "x-ratelimit-remaining-requests": "5" } })) as typeof fetch);
  try {
    await observations.passiveKeyPhysicalFetch(physical, config, "fixture", routedProviderConfig("fixture", config.providers.fixture!))(
      "https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model: "model" }) });
    const url = new URL("http://localhost/api/provider-quotas");
    const read = async () => (await handleManagementAPI(new ManagementRequest(url), url, config))!.json();
    const local = await read(), passive = await runPassiveRead(read);
    expect(local.passiveKeyLimits).toHaveLength(1);
    expect(passive.passiveKeyLimits).toEqual(local.passiveKeyLimits);
    expect(JSON.stringify(local)).not.toContain(secretId);
    expect(JSON.stringify(passive)).not.toContain(secretId);
  } finally { observations.clearPassiveKeyLimits(); }
});

test("keychain-backed Responses account reports its wire limits without additional OS reads", async () => {
  const config = getDefaultConfig();
  config.defaultProvider = "keychain-fixture";
  config.defaultModel = "wire-model";
  config.providers = { "keychain-fixture": { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1",
    authMode: "key", apiKey: "keychain:keychain-fixture", models: ["wire-model"], liveModels: false } };
  let reads = 0, readsAtSend = 0;
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return "synthetic-keychain-secret"; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    globalThis.fetch = (async (_input, init) => {
      readsAtSend = reads;
      expect(new Headers(init?.headers).get("authorization")).toBe(["Bearer", "synthetic-keychain-secret"].join(" "));
      return Response.json({ id: "synthetic", object: "chat.completion", model: "wire-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
      { headers: { "x-ratelimit-remaining-requests": "42" } });
    }) as typeof fetch;
    const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "keychain-fixture/wire-model", input: "hi", stream: false, store: false }) });
    const response = await handleResponses(request, config, { provider: "", model: "" }, {});
    await response.text();
    expect(response.status).toBe(200);
    expect(readsAtSend).toBeGreaterThan(0);
    expect(reads).toBe(readsAtSend);
    const url = new URL("http://localhost/api/provider-quotas");
    for (let i = 0; i < 3; i++) {
      const report = await handleManagementAPI(new ManagementRequest(url), url, config);
      expect(report!.status).toBe(200);
      const json = await report!.json();
      expect(json.passiveKeyLimits).toMatchObject([{ provider: "keychain-fixture", model: "wire-model", windows: [{ remaining: 42 }, { dimension: "tokens" }] }]);
      expect(JSON.stringify(json)).not.toContain("synthetic-keychain-secret");
      expect(reads).toBe(readsAtSend);
    }
  } finally { setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("provider quotas isolate a malformed unobserved keychain account", async () => {
  const config = getDefaultConfig();
  config.providers = { fixture: { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authMode: "key",
    apiKey: "synthetic-key", apiKeyPool: [{ id: "good", key: "synthetic-key" }, { id: "bad", key: "keychain:fixture/bad" }],
    models: ["model"], liveModels: false } };
  let reads = 0, sends = 0;
  setProviderKeychainEntryFactoryForTests(() => ({ getPassword: () => { reads++; return '{"type":"service_account","private_key":"synthetic"}'; }, setPassword: () => {}, deletePassword: () => false }));
  try {
    const physical = markPassiveKeyTransparent((async () => { sends++; return new Response(null, { headers: { "x-ratelimit-remaining-requests": "5" } }); }) as typeof fetch);
    const send = observations.passiveKeyPhysicalFetch(physical, config, "fixture", routedProviderConfig("fixture", config.providers.fixture!));
    await send("https://api.groq.com/openai/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer synthetic-key" }, body: JSON.stringify({ model: "model" }) });
    const url = new URL("http://localhost/api/provider-quotas");
    const report = await handleManagementAPI(new ManagementRequest(url), url, config);
    expect(report!.status).toBe(200);
    expect((await report!.json()).passiveKeyLimits).toMatchObject([{ provider: "fixture", keyId: observations.passiveKeyQuotaId("fixture", "good"), model: "model" }]);
    expect(reads).toBe(0);
    expect(sends).toBe(1);
  } finally { setProviderKeychainEntryFactoryForTests(null); observations.clearPassiveKeyLimits(); }
});

test("a proxied response without rate headers shows unknown headroom and sends no probe", async () => {
  const config = getDefaultConfig();
  config.defaultProvider = "unknown-fixture";
  config.defaultModel = "unknown-model";
  config.providers = { "unknown-fixture": { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1",
    authMode: "key", apiKey: "synthetic-unknown-key", models: ["unknown-model"], liveModels: false } };
  let sends = 0;
  globalThis.fetch = (async () => {
    sends++;
    return Response.json({ id: "synthetic", object: "chat.completion", model: "unknown-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "unknown-fixture/unknown-model", input: "hi", stream: false, store: false }) });
  await (await handleResponses(request, config, { provider: "", model: "" }, {})).text();
  const url = new URL("http://localhost/api/provider-quotas");
  const body = await (await handleManagementAPI(new ManagementRequest(url), url, config))!.json();
  // A headerless response proves nothing about the account's counters: the first one shows the
  // key as observed with unknown headroom, carrying no count, remaining value or reset.
  expect(body.passiveKeyLimits).toHaveLength(1);
  const [row] = body.passiveKeyLimits;
  expect(row).toMatchObject({ provider: "unknown-fixture", model: "unknown-model" });
  expect(row.windows.map((window: { dimension: string }) => window.dimension)).toEqual(["requests", "tokens"]);
  for (const window of row.windows) {
    expect(window.stale).toBe(false);
    expect(window).not.toHaveProperty("remaining");
    expect(window).not.toHaveProperty("limit");
    expect(window).not.toHaveProperty("resetAt");
  }
  expect(sends).toBe(1);
});

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
  expect(observations.getPassiveKeyLimits(config, "fixture", "wire-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 42 }, { dimension: "tokens", window: "minute" }]);
  expect(observations.listPassiveKeyLimits(config)).toMatchObject([{ provider: "fixture", model: "wire-model", windows: [{ dimension: "requests", limit: 100, remaining: 42 }, { dimension: "tokens", window: "minute" }] }]);
  const url = new URL("http://localhost/api/provider-quotas");
  const report = await handleManagementAPI(new ManagementRequest(url), url, config);
  const json = await report!.json();
  expect(report!.status).toBe(200);
  expect(json.passiveKeyLimits).toMatchObject([{ provider: "fixture", model: "wire-model", windows: [{ remaining: 42 }, { dimension: "tokens", window: "minute" }] }]);
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
    expect(observations.getPassiveKeyLimits(config, "anthropic-fixture", "claude-test-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 42 }, { dimension: "input-tokens" }, { dimension: "output-tokens" }, { dimension: "tokens" }]);
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
  expect(observations.getPassiveKeyLimits(config, "chat-fixture", "chat-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 34 }, { dimension: "tokens", window: "minute" }]);
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
    expect(observations.getPassiveKeyLimits(config, "openai-apikey", "compact-model")).toMatchObject([{ dimension: "requests", limit: 100, remaining: 21 }, { dimension: "tokens" }]);
  } finally { release(); }
});

for (const fixture of [
  { name: "xai", baseUrl: "https://api.x.ai/v1", model: "grok-test", header: "x-ratelimit-remaining-tokens" },
  { name: "mistral", baseUrl: "https://api.mistral.ai/v1", model: "mistral-test", header: "x-ratelimit-remaining-tokens-minute" },
] as const) {
  test(`${fixture.name} records limit headers through its built-in transport`, async () => {
    const config = getDefaultConfig();
    config.defaultProvider = fixture.name;
    config.defaultModel = fixture.model;
    config.providers = { [fixture.name]: { adapter: "openai-chat", baseUrl: fixture.baseUrl,
      authMode: "key", apiKey: "synthetic-transport-key", models: [fixture.model], liveModels: false } };
    globalThis.fetch = (async () => Response.json({ id: "synthetic", object: "chat.completion", model: fixture.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    { headers: { [fixture.header]: "23" } })) as typeof fetch;
    const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${fixture.name}/${fixture.model}`, input: "hi", stream: false, store: false }) });
    const response = await handleResponses(request, config, { provider: "", model: "" }, {});
    await response.text();
    expect(response.status).toBe(200);
    expect(observations.getPassiveKeyLimits(config, fixture.name, fixture.model)).toMatchObject(fixture.name === "mistral"
      ? [{ dimension: "requests", window: "minute" }, { dimension: "tokens", window: "minute", remaining: 23 }, { dimension: "tokens", window: "month" }]
      : [{ dimension: "requests" }, { dimension: "tokens", remaining: 23 }]);
  });
}

test("an in-flight response stays attributed to its key after another key becomes active", async () => {
  const config = getDefaultConfig();
  config.defaultProvider = "rotating-fixture";
  config.defaultModel = "wire-model";
  config.providers = { "rotating-fixture": { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authMode: "key",
    apiKey: "first-synthetic-key", apiKeyPool: [{ id: "first", key: "first-synthetic-key" }, { id: "second", key: "second-synthetic-key" }],
    models: ["wire-model"], liveModels: false } };
  let finish!: () => void, started!: () => void;
  const sent = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  globalThis.fetch = (async () => {
    started(); await gate;
    return Response.json({ id: "synthetic", object: "chat.completion", model: "wire-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    { headers: { "x-ratelimit-remaining-requests": "42" } });
  }) as typeof fetch;
  const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "rotating-fixture/wire-model", input: "hi", stream: false, store: false }) });
  const pending = handleResponses(request, config, { provider: "", model: "" }, {});
  await sent;
  config.providers["rotating-fixture"]!.apiKey = "second-synthetic-key";
  finish();
  await (await pending).text();
  expect(observations.listPassiveKeyLimits(config)).toMatchObject([{ provider: "rotating-fixture", keyId: observations.passiveKeyQuotaId("rotating-fixture", "first"), model: "wire-model", windows: [{ remaining: 42 }, { dimension: "tokens", window: "minute" }] }]);
});

for (const scenario of [
  { name: "pacing", patches: [{ requestPacing: { enabled: true, requestsPerMinute: 30 } }] },
  { name: "note", patches: [{ note: "operator note" }, { baseUrl: "https://api.groq.com/openai/v1", disabled: false, authMode: "key" }] },
  { name: "disabled ABA", patches: [{ disabled: true }, { disabled: false }], retire: true },
  { name: "destination ABA", patches: [{ baseUrl: "https://api.x.ai/v1" }, { baseUrl: "https://api.groq.com/openai/v1" }], retire: true },
  { name: "auth ABA", patches: [{ authMode: "local" }, { authMode: "key" }], retire: true },
  { name: "account headers ABA", patches: [{ headers: { "OpenAI-Organization": "other-account" } }, { headers: null }], retire: true },
  { name: "rebased destination ABA", patches: [{ requestPacing: { enabled: true, requestsPerMinute: 30 } }, { baseUrl: "https://api.groq.com/openai/v1" }], retire: true, rebase: true },
  { name: "rebased account label", patches: [{ requestPacing: { enabled: true, requestsPerMinute: 30 } }], rebaseLabel: true },
  { name: "provider replacement", patches: [], retire: true, replace: true },
] as const) {
  test(`authenticated provider PATCH ${scenario.name} preserves or retires cached and pending observations`, async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-passive-patch-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.OPENCODEX_HOME = join(home, "ocx");
    process.env.CODEX_HOME = join(home, "codex");
    const config = getDefaultConfig();
    config.defaultProvider = "fallback";
    config.providers = {
      fallback: { adapter: "openai-chat", baseUrl: "https://example.com/v1", models: ["fallback"], liveModels: false },
      observed: { adapter: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", authMode: "key",
        apiKey: "synthetic-patch-key", models: ["cached", "pending"], liveModels: false },
    };
    if ("rebaseLabel" in scenario) config.providers.observed!.apiKeyPool = [{ id: "account", key: "synthetic-patch-key", label: "before" }];
    saveConfig(config);
    const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent = new Promise<void>(resolve => { started = resolve; });
    const networkFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "api.groq.com") return networkFetch(input, init);
      const model = JSON.parse(String(init?.body)).model;
      if (model === "pending") { started(); await gate; }
      return Response.json({ id: "synthetic", object: "chat.completion", model,
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
      { headers: { "x-ratelimit-remaining-requests": model === "cached" ? "42" : "17" } });
    }) as typeof fetch;
    const previousAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "synthetic-patch-admin";
    const server = startServer(0);
    const auth = { "x-opencodex-api-key": "synthetic-patch-admin" };
    const request = (path: string, init?: RequestInit) => networkFetch(new URL(path, server.url), init);
    const send = (model: string) => request("/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `observed/${model}`, input: "hi", stream: false, store: false }) });
    const rows = async () => {
      const response = await request("/api/provider-quotas", { headers: auth });
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(Array.isArray(body.passiveKeyLimits)).toBe(true);
      return body.passiveKeyLimits.filter((row: { provider: string }) => row.provider === "observed")
        .map((row: { model: string; windows: Array<{ remaining?: number }> }) => ({ model: row.model, remaining: row.windows[0]?.remaining }));
    };
    let pending: Promise<Response> | undefined;
    try {
      expect((await send("cached")).status).toBe(200);
      pending = send("pending");
      await sent;
      expect(await rows()).toEqual([{ model: "cached", remaining: 42 }]);
      if (scenario.name === "pacing") {
        const denied = await request("/api/providers?name=observed", { method: "PATCH",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ disabled: true }) });
        expect(denied.status).toBe(401);
        const invalid = await request("/api/providers?name=observed", { method: "PATCH",
          headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ disabled: "yes" }) });
        expect(invalid.status).toBe(400);
        expect(await rows()).toEqual([{ model: "cached", remaining: 42 }]);
      }
      if ("rebase" in scenario) {
        const path = join(process.env.OPENCODEX_HOME!, "config.json");
        const disk = JSON.parse(readFileSync(path, "utf8"));
        disk.providers.observed.baseUrl = "https://api.x.ai/v1";
        writeFileSync(path, JSON.stringify(disk));
      }
      if ("rebaseLabel" in scenario) {
        const path = join(process.env.OPENCODEX_HOME!, "config.json");
        const disk = JSON.parse(readFileSync(path, "utf8"));
        disk.providers.observed.apiKeyPool[0].label = "after";
        writeFileSync(path, JSON.stringify(disk));
      }
      for (const body of scenario.patches) {
        const response = await request("/api/providers?name=observed", { method: "PATCH",
          headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
        expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
        if ("rebase" in scenario && "requestPacing" in body) {
          const disk = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME!, "config.json"), "utf8"));
          expect(disk.providers.observed.baseUrl).toBe("https://api.x.ai/v1");
        }
      }
      if ("rebaseLabel" in scenario) {
        const disk = JSON.parse(readFileSync(join(process.env.OPENCODEX_HOME!, "config.json"), "utf8"));
        expect(disk.providers.observed.apiKeyPool[0].label).toBe("after");
      }
      if ("replace" in scenario) {
        const response = await request("/api/providers", { method: "POST", headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ name: "observed", provider: config.providers.observed }) });
        expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
      }
      if (!("retire" in scenario)) expect(await rows()).toEqual([{ model: "cached", remaining: 42 }]);
      release();
      expect((await pending).status).toBe(200);
      const result = await rows();
      if ("retire" in scenario) expect(result).toEqual([]);
      else expect(result).toEqual(expect.arrayContaining([{ model: "cached", remaining: 42 }, { model: "pending", remaining: 17 }]));
    } finally {
      release();
      if (pending) await pending.catch(() => {});
      await server.stop(true);
      if (previousAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdmin;
      resolved.mockRestore();
      observations.clearPassiveKeyLimits("observed");
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      removeTreeWithRetry(home);
    }
  }, 60_000);
}

for (const { status, stream } of [{ status: 200, stream: false }, { status: 400, stream: false }, { status: 200, stream: true }]) {
  test(`Mistral observations follow physical send order after pacing (${status}, stream=${stream})`, async () => {
    const config = getDefaultConfig();
    const model = `pacer-order-${status}-${stream}`;
    config.defaultProvider = "mistral-order";
    config.defaultModel = model;
    config.providers = { "mistral-order": { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1",
      authMode: "key", apiKey: `synthetic-order-${status}`, models: [model], liveModels: false,
      retryOn429: { enabled: false } } };
    const wire: string[] = [];
    let releaseB!: () => void, sentA!: () => void, sentB!: () => void;
    const bGate = new Promise<void>(resolve => { releaseB = resolve; });
    const aSent = new Promise<void>(resolve => { sentA = resolve; });
    const bSent = new Promise<void>(resolve => { sentB = resolve; });
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const label = JSON.stringify(body).includes("request-A") ? "A" : JSON.stringify(body).includes("request-B") ? "B" : "warm";
      wire.push(label);
      if (label === "B") { sentB(); await bGate; }
      if (label === "A") sentA();
      const headers = { "x-ratelimit-remaining-tokens-minute": label === "A" ? "11" : label === "B" ? "22" : "0",
        ...(label === "warm" ? { "retry-after": "0.5" } : {}) };
      if (label !== "warm" && status === 200 && stream) {
        const chunk = { id: "synthetic", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          { headers: { ...headers, "content-type": "text/event-stream" } });
      }
      return label === "warm" || status === 200
        ? Response.json({ id: "synthetic", object: "chat.completion", model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }, { headers })
        : Response.json({ error: { message: "fixture refusal", type: "invalid_request_error" } }, { status, headers });
    }) as typeof fetch;
    const request = (input: string) => new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `mistral-order/${model}`, input, stream: input === "warm" ? false : stream, store: false }) });
    let spy: ReturnType<typeof spyOn> | undefined;
    try {
      await (await handleResponses(request("warm"), config, { provider: "", model: "" }, {})).text();
      let enteredA!: () => void;
      const waitingA = new Promise<void>(resolve => { enteredA = resolve; });
      const acquire = MistralBudgetPacer.prototype.acquire;
      spy = spyOn(MistralBudgetPacer.prototype, "acquire").mockImplementation(function (...args) {
        enteredA();
        return acquire.apply(this, args);
      });
      const a = handleResponses(request("request-A"), config, { provider: "", model: "" }, {});
      await waitingA;
      config.providers["mistral-order"]!.requestPacing = { enabled: false };
      const b = handleResponses(request("request-B"), config, { provider: "", model: "" }, {});
      await bSent;
      await aSent;
      const aResponse = await a;
      const aBody = await aResponse.text();
      releaseB();
      const bResponse = await b;
      const bBody = await bResponse.text();
      expect([aResponse.status, bResponse.status]).toEqual([status, status]);
      if (status === 200) { expect(aBody).toContain("ok"); expect(bBody).toContain("ok"); }
      expect(wire).toEqual(["warm", "B", "A"]);
      expect(observations.getPassiveKeyLimits(config, "mistral-order", model)).toMatchObject([
        { dimension: "requests" }, { dimension: "tokens", window: "minute", remaining: 11 }, { dimension: "tokens", window: "month" },
      ]);
    } finally { spy?.mockRestore(); releaseB(); observations.clearPassiveKeyLimits(); }
  });
}

for (const rewrite of ["destination", "credential"] as const) {
  test(`Mistral plugin ${rewrite} rewrite cannot publish another owner's limits`, async () => {
    const config = getDefaultConfig();
    config.defaultProvider = "mistral-rewrite";
    config.defaultModel = "wire-model";
    config.providers = { "mistral-rewrite": { adapter: "openai-chat", baseUrl: "https://api.mistral.ai/v1",
      authMode: "key", apiKey: "synthetic-key", models: ["wire-model"], liveModels: false } };
    let sends = 0;
    const unregister = registerUpstreamRewriter("fixture", target => {
      if (rewrite === "destination") target.url = "http://127.0.0.1:9191/v1/chat/completions";
      else target.headers.set("authorization", "Bearer synthetic-plugin-key");
    });
    globalThis.fetch = (async (input, init) => {
      sends++;
      expect(rewrite === "destination" ? String(input) : new Headers(init?.headers).get("authorization"))
        .toBe(rewrite === "destination" ? "http://127.0.0.1:9191/v1/chat/completions" : "Bearer synthetic-plugin-key");
      return Response.json({ id: "synthetic", object: "chat.completion", model: "wire-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
      { headers: { "x-ratelimit-remaining-tokens-minute": "42" } });
    }) as typeof fetch;
    try {
      const request = new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mistral-rewrite/wire-model", input: "hi", stream: false, store: false }) });
      const response = await handleResponses(request, config, { provider: "", model: "" }, {});
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toBe(1);
      expect(observations.getPassiveKeyLimits(config, "mistral-rewrite", "wire-model")).toEqual([]);
    } finally { unregister(); observations.clearPassiveKeyLimits(); }
  });
}
