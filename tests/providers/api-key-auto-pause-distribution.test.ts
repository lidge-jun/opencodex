import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { handleManagementAPI } from "../../src/server/management-api";
import { captureAccountAutoPauseAttempt, wasAccountAutoPaused } from "../../src/oauth/account-auto-pause";
import { providerApiKeySelectionIsCurrent, resolveCurrentProviderApiKeyTransport } from "../../src/providers/api-key-selection";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, selectProactiveApiKeyTransport } from "../../src/providers/key-failover";
import { routedProviderConfig } from "../../src/router";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;
let previousHome: string | undefined;
let releaseSpend: () => void;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-pause-distribution-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
  clearKeyCooldowns(); forgetApiKeyRotationCursor();
});
afterEach(() => {
  releaseSpend();
  clearKeyCooldowns(); forgetApiKeyRotationCursor();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});
function fixture() {
  const config = getDefaultConfig();
  config.providers = { fixture: { adapter: "openai-chat", authMode: "key", baseUrl: "https://example.test/v1",
    apiKey: "synthetic-A", apiKeySelectionRevision: "saved-revision",
    apiKeyPool: [{ id: "A", key: "synthetic-A" }, { id: "B", key: "synthetic-B" }],
    requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
    accountAutoPause: { enabled: true, consecutiveFailures: 1 },
  } };
  saveConfig(config);
  const provider = config.providers.fixture!;
  const route = routedProviderConfig("fixture", { ...provider, apiKey: "synthetic-B", _apiKeyAttempt: {
    entryId: "B", reference: "synthetic-B", revision: provider.apiKeySelectionRevision, distributed: true,
  } });
  return { config, route };
}
const refusal = () => Response.json({ error: { type: "permission_error", message: "Your subscription has expired." } }, { status: 403 });

test("a non-active distributed key pauses durably without changing the active key", async () => {
  const { config, route } = fixture();
  const observe = captureAccountAutoPauseAttempt("fixture", route, { config }, new Headers({ authorization: `Bearer ${route.apiKey}` }))!;
  const response = await observe(refusal());
  expect(wasAccountAutoPaused(response)).toBe(true);
  for (const provider of [config.providers.fixture!, loadConfig().providers.fixture!]) {
    expect(provider.apiKey).toBe("synthetic-A");
    expect(provider.apiKeyPool![0]!.disabled).not.toBe(true);
    expect(provider.apiKeyPool![1]).toMatchObject({ disabled: true, pauseDetails: { reason: "subscription_expired" } });
  }
  expect(providerApiKeySelectionIsCurrent(config, "fixture", route)).toBe(false);
  const fresh = resolveCurrentProviderApiKeyTransport(config, "fixture", { ...route, _apiKeyAttempt: undefined })!;
  for (let n = 0; n < 3; n++) expect(selectProactiveApiKeyTransport(config, "fixture", fresh)?.apiKey).toBe("synthetic-A");
});

for (const change of ["revision", "disabled", "headers"] as const) test(`distributed pause rejects stale or unowned ${change}`, async () => {
  const { config, route } = fixture();
  const headers = new Headers({ authorization: `Bearer ${change === "headers" ? "synthetic-override" : route.apiKey}` });
  const observe = captureAccountAutoPauseAttempt("fixture", route, { config }, headers);
  if (change === "revision") config.providers.fixture!.apiKeySelectionRevision = "replacement";
  if (change === "disabled") config.providers.fixture!.accountAutoPause = { enabled: false };
  saveConfig(config);
  const response = refusal();
  if (observe) await observe(response);
  expect(wasAccountAutoPaused(response)).toBe(false);
  expect(loadConfig().providers.fixture!.apiKeyPool![1]!.disabled).not.toBe(true);
});

test("a disabled distributed selection cannot dispatch even if its revision is unchanged", () => {
  const { config, route } = fixture();
  config.providers.fixture!.apiKeyPool![1]!.disabled = true;
  expect(providerApiKeySelectionIsCurrent(config, "fixture", route)).toBe(false);
  expect(resolveCurrentProviderApiKeyTransport(config, "fixture", route)).toBeNull();
  const fresh = routedProviderConfig("fixture", config.providers.fixture!);
  for (let n = 0; n < 3; n++) expect(selectProactiveApiKeyTransport(config, "fixture", fresh)?.apiKey).toBe("synthetic-A");
});

test("setProviderApiKeyPaused rotates in ring order, preserves auto-pause details on idempotent pause, and restores active key on resume", async () => {
  const { setProviderApiKeyPaused } = await import("../../src/providers/api-key-pause");
  const config = getDefaultConfig();
  config.providers = {
    "google-vertex": {
      adapter: "google", authMode: "key", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
      apiKey: "vertex-B",
      apiKeyPool: [
        { id: "A", key: "vertex-A" },
        { id: "B", key: "vertex-B" },
        { id: "C", key: "vertex-C" },
      ],
    },
  };
  saveConfig(config);
  // Pausing active B advances in ring order to C (not back to index 0 A).
  expect(setProviderApiKeyPaused(config, "google-vertex", "B", true)).toBe(true);
  expect(config.providers["google-vertex"]!.apiKey).toBe("vertex-C");
  // Seed auto-pause details on B and verify manual idempotent pause does not erase them.
  config.providers["google-vertex"]!.apiKeyPool![1]!.pauseDetails = { reason: "subscription_expired", pausedAt: 12345 };
  saveConfig(config);
  expect(setProviderApiKeyPaused(config, "google-vertex", "B", true)).toBe(true);
  expect(config.providers["google-vertex"]!.apiKeyPool![1]!.pauseDetails).toEqual({ reason: "subscription_expired", pausedAt: 12345 });
  // Pause C -> wraps around ring to A; pause A -> deletes apiKey.
  expect(setProviderApiKeyPaused(config, "google-vertex", "C", true)).toBe(true);
  expect(config.providers["google-vertex"]!.apiKey).toBe("vertex-A");
  expect(setProviderApiKeyPaused(config, "google-vertex", "A", true)).toBe(true);
  expect(config.providers["google-vertex"]!.apiKey).toBeUndefined();
  // Resuming B into an all-paused pool restores B as active and clears pauseDetails.
  expect(setProviderApiKeyPaused(config, "google-vertex", "B", false)).toBe(true);
  expect(config.providers["google-vertex"]!.apiKey).toBe("vertex-B");
  expect(config.providers["google-vertex"]!.apiKeyPool![1]!.pauseDetails).toBeUndefined();
});

test("all-paused google-vertex and google (AI Studio) pools refuse with 403 permission_error and never leak env or ADC credentials", async () => {
  const { setProviderApiKeyPaused } = await import("../../src/providers/api-key-pause");
  const { handleResponses } = await import("../../src/server/responses/core");
  const { handleChatCompletions } = await import("../../src/server/chat-completions");
  const { handleClaudeMessages } = await import("../../src/server/claude-messages");
  const prevEnvKey = process.env.GOOGLE_CLOUD_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.GOOGLE_CLOUD_API_KEY = "leaked-ambient-env-key";
  let upstreamCalls = 0;
  globalThis.fetch = (async () => { upstreamCalls++; return new Response("unexpected upstream call", { status: 200 }); }) as typeof fetch;
  try {
    const config = getDefaultConfig();
    config.protocols = { rollout: { managedMessagesNative: true } };
    config.providers = {
      "google-vertex": {
        adapter: "google", authMode: "key", googleMode: "vertex", project: "demo-proj", location: "global",
        baseUrl: "https://aiplatform.googleapis.com", models: ["gemini-3-flash"],
        apiKey: "vertex-key-1", apiKeyPool: [{ id: "v1", key: "vertex-key-1" }],
      },
      google: {
        adapter: "google", authMode: "key", baseUrl: "https://generativelanguage.googleapis.com", models: ["gemini-3-flash"],
        apiKey: "aistudio-key-1", apiKeyPool: [{ id: "g1", key: "aistudio-key-1" }, { id: "g2", key: "aistudio-key-2" }],
        requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
      },
      "chat-paused": {
        adapter: "openai-chat", authMode: "key", baseUrl: "https://example.test/v1", models: ["gpt-4o"],
        apiKey: "chat-key-1", apiKeyPool: [{ id: "c1", key: "chat-key-1" }, { id: "c2", key: "chat-key-2" }],
        requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
      },
      "anth-paused": {
        adapter: "anthropic", authMode: "key", baseUrl: "https://api.anthropic.com", models: ["claude-sonnet-4-5"],
        apiKey: "anth-key-1", apiKeyPool: [{ id: "a1", key: "anth-key-1" }, { id: "a2", key: "anth-key-2" }],
        requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
      },
    };
    saveConfig(config);
    expect(setProviderApiKeyPaused(config, "google-vertex", "v1", true)).toBe(true);
    expect(setProviderApiKeyPaused(config, "google", "g1", true)).toBe(true);
    expect(setProviderApiKeyPaused(config, "google", "g2", true)).toBe(true);
    expect(setProviderApiKeyPaused(config, "chat-paused", "c1", true)).toBe(true);
    expect(setProviderApiKeyPaused(config, "chat-paused", "c2", true)).toBe(true);
    expect(setProviderApiKeyPaused(config, "anth-paused", "a1", true)).toBe(true);
    expect(setProviderApiKeyPaused(config, "anth-paused", "a2", true)).toBe(true);

    for (const model of ["google-vertex/gemini-3-flash", "google/gemini-3-flash"]) {
      const res = await handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hi", stream: false, store: false }),
      }), config, { model: "", provider: "" });
      expect(res.status).toBe(403);
      const body = await res.json() as { error?: { type?: string; message?: string } };
      expect(body.error?.type).toBe("permission_error");
      expect(body.error?.message).toContain("API key is paused");
    }
    const chatRes = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chat-paused/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false }),
    }), config, { model: "", provider: "" });
    expect(chatRes.status).toBe(403);
    expect((await chatRes.json() as { error?: { type?: string } }).error?.type).toBe("permission_error");

    const msgRes = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "anth-paused/claude-sonnet-4-5", max_tokens: 32, messages: [{ role: "user", content: "hi" }], stream: false }),
    }), config, { model: "", provider: "" });
    expect(msgRes.status).toBe(403);
    expect((await msgRes.json() as { error?: { type?: string } }).error?.type).toBe("permission_error");
    expect(upstreamCalls).toBe(0);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnvKey === undefined) delete process.env.GOOGLE_CLOUD_API_KEY;
    else process.env.GOOGLE_CLOUD_API_KEY = prevEnvKey;
  }
});

test("readProviderApiKeyQuotas skips probes for paused keys while preserving last-good cached quota", async () => {
  const { clearProviderApiKeyQuotaCache, readProviderApiKeyQuotas, setCachedProviderApiKeyQuotaForTests } = await import("../../src/providers/quota-key-accounts");
  clearProviderApiKeyQuotaCache();
  const config = getDefaultConfig();
  config.providers = {
    openrouter: {
      adapter: "openai-chat", authMode: "key", baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "key-active",
      apiKeyPool: [
        { id: "paused-slot", key: "key-paused", disabled: true },
        { id: "active-slot", key: "key-active" },
      ],
    },
  };
  const cachedQuota = { fiveHourPercent: 42, updatedAt: Date.now() };
  setCachedProviderApiKeyQuotaForTests("openrouter", config.providers.openrouter!, "paused-slot", "key-paused", cachedQuota);
  const probedKeys: string[] = [];
  const rows = await readProviderApiKeyQuotas(config, "openrouter", true, async provider => {
    probedKeys.push(provider.apiKey!);
    return { kind: "quota", quota: { fiveHourPercent: 15, updatedAt: Date.now() } };
  });
  expect(probedKeys).toEqual(["key-active"]);
  expect(rows.find(r => r.keyId === "paused-slot")?.quota).toEqual(cachedQuota);
  expect(rows.find(r => r.keyId === "active-slot")?.quota?.fiveHourPercent).toBe(15);
  clearProviderApiKeyQuotaCache();
});

test("Google Vertex and AI Studio 429 failover skips paused keys (A sent once, C sent once, paused B never sent) and providerHasStoredApiKey preserves all-paused pools", async () => {
  const { handleResponses } = await import("../../src/server/responses/core");
  const { handleResponsesCompact } = await import("../../src/server/responses/compact");
  const { handleImages } = await import("../../src/server/images");
  const { providerHasStoredApiKey, setActiveProviderApiKey } = await import("../../src/providers/api-keys");
  const { fetchProviderModels } = await import("../../src/codex/catalog/provider-models");
  const prevFetch = globalThis.fetch;
  const sentKeys: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const h = new Headers(init?.headers);
    const key = h.get("x-goog-api-key") ?? h.get("authorization") ?? "none";
    sentKeys.push(key);
    if (key === "vertex-A") {
      return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota exceeded" } }, { status: 429 });
    }
    return Response.json({
      candidates: [{ content: { role: "model", parts: [{ text: "ok from C" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    }, { status: 200 });
  }) as typeof fetch;
  try {
    const config = getDefaultConfig();
    config.images = { provider: "custom-img" };
    config.providers = {
      "google-vertex": {
        adapter: "google", authMode: "key", googleMode: "vertex", project: "demo-proj", location: "global",
        baseUrl: "https://aiplatform.googleapis.com", models: ["gemini-3.8-flash"],
        apiKey: "vertex-A",
        apiKeyPool: [
          { id: "A", key: "vertex-A" },
          { id: "B", key: "vertex-B", disabled: true },
          { id: "C", key: "vertex-C" },
        ],
      },
      "custom-img": {
        adapter: "openai-responses", authMode: "key", baseUrl: "https://example.test/v1",
        models: ["gpt-4o"], apiKey: "img-key-1", supportsNativeCompactEndpoint: true,
        apiKeyPool: [{ id: "img-1", key: "img-key-1", disabled: true }],
        requestPacing: { enabled: true, keySelection: "round-robin", keys: { maxConcurrentRequests: 1 } },
      },
    };
    saveConfig(config);
    const res = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "google-vertex/gemini-3.8-flash", input: "ping", stream: false, store: false }),
    }), config, { model: "", provider: "" });
    const resText = await res.text();
    expect(res.status, resText).toBe(200);
    expect(sentKeys).toEqual(["vertex-A", "vertex-C"]);

    // Activating paused key B is rejected while providerHasStoredApiKey remains true for all-paused pools.
    expect(setActiveProviderApiKey(config, "google-vertex", "B")).toBe(false);
    expect(providerHasStoredApiKey({ ...config.providers["custom-img"]!, apiKey: undefined })).toBe(true);

    // Compact endpoint with all keys paused in round-robin pool returns 403 permission_error.
    sentKeys.length = 0;
    const compactRes = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "custom-img/gpt-4o", input: "ping" }),
    }), config, { model: "", provider: "" });
    expect(compactRes.status).toBe(403);
    expect((await compactRes.json() as { error?: { type?: string } }).error?.type).toBe("permission_error");
    expect(sentKeys).toEqual([]);

    // Explicit images.provider with all keys paused returns 403 permission_error.
    const imgRes = await handleImages(new Request("http://localhost/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cat" }),
    }), config, "generations", { model: "", provider: "" });
    expect(imgRes.status).toBe(403);
    expect((await imgRes.json() as { error?: { type?: string } }).error?.type).toBe("permission_error");
    expect(sentKeys).toEqual([]);

    // All-paused provider skips live /v1/models discovery without firing upstream fetch.
    sentKeys.length = 0;
    const models = await fetchProviderModels("custom-img", { ...config.providers["custom-img"]!, models: ["Static-Model"] });
    expect(models.map(m => m.id)).toEqual(["Static-Model"]);
    expect(sentKeys).toEqual([]);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("native compact falls back from a paused selected key to an enabled key", async () => {
  const { handleResponsesCompact } = await import("../../src/server/responses/compact");
  const previousFetch = globalThis.fetch;
  const sentKeys: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    sentKeys.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ id: "compact-result" });
  }) as typeof fetch;
  try {
    const config = getDefaultConfig();
    config.providers = {
      "compact-fallback": {
        adapter: "openai-responses", authMode: "key", baseUrl: "https://example.test/v1",
        models: ["gpt-4o"], apiKey: "paused-key", supportsNativeCompactEndpoint: true,
        apiKeyPool: [
          { id: "paused", key: "paused-key", disabled: true },
          { id: "enabled", key: "enabled-key" },
        ],
      },
    };
    saveConfig(config);

    const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "compact-fallback/gpt-4o", input: "ping" }),
    }), config, { model: "", provider: "" });

    expect(sentKeys).toEqual(["Bearer enabled-key"]);
    expect(response.status, await response.clone().text()).toBe(200);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("native compact selects an enabled pool key when the active key is missing", async () => {
  const { handleResponsesCompact } = await import("../../src/server/responses/compact");
  const previousFetch = globalThis.fetch;
  const sentKeys: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    sentKeys.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ id: "compact-result" });
  }) as typeof fetch;
  try {
    const config = getDefaultConfig();
    config.providers = {
      "compact-missing-active": {
        adapter: "openai-responses", authMode: "key", baseUrl: "https://example.test/v1",
        models: ["gpt-4o"], apiKeyPool: [
          { id: "paused", key: "paused-key", disabled: true },
          { id: "enabled", key: "enabled-key" },
        ], supportsNativeCompactEndpoint: true,
      },
    };
    saveConfig(config);

    const response = await handleResponsesCompact(new Request("http://localhost/v1/responses/compact", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "compact-missing-active/gpt-4o", input: "ping" }),
    }), config, { model: "", provider: "" });

    expect(sentKeys).toEqual(["Bearer enabled-key"]);
    expect(response.status, await response.clone().text()).toBe(200);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("GET /api/config reports stored API keys when every pool entry is paused", async () => {
  const config = getDefaultConfig();
  config.providers = {
    "google-vertex": {
      adapter: "google", authMode: "key", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
      apiKeyPool: [
        { id: "A", key: "vertex-A", disabled: true },
        { id: "B", key: "vertex-B", disabled: true },
      ],
    },
  };
  const req = new Request("http://127.0.0.1/api/config", { headers: { host: "127.0.0.1" } });
  const response = await handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
  }, "gui-session", undefined, { trustedLoopback: true });
  expect(response?.status, await response?.clone().text()).toBe(200);
  const dto = await response!.json() as { providers: Record<string, { hasApiKey?: boolean; apiKey?: string }> };
  expect(dto.providers["google-vertex"]?.hasApiKey).toBe(true);
  expect(dto.providers["google-vertex"]?.apiKey).toBeUndefined();
});

test("PUT provider API-key pause commits the active selection and preserves its response", async () => {
  const config = getDefaultConfig();
  config.providers = {
    fixture: {
      adapter: "openai-chat", authMode: "key", baseUrl: "https://example.test/v1",
      apiKey: "key-a", apiKeyPool: [{ id: "A", key: "key-a" }, { id: "B", key: "key-b" }],
    },
  };
  saveConfig(config);
  const pause = async (id: string, paused: boolean) => {
    const request = new Request("http://127.0.0.1/api/providers/keys/pause", {
      method: "PUT", headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ name: "fixture", id, paused }),
    });
    return handleManagementAPI(request, new URL(request.url), config, {
      createManagementConvergeCodex: catalogConvergenceFactory(),
    }, "gui-session", undefined, { trustedLoopback: true });
  };

  const pauseA = await pause("A", true);
  expect(pauseA?.status, await pauseA?.clone().text()).toBe(200);
  expect(await pauseA!.json()).toEqual({ ok: true, activeAccountId: "B", activeAccountChanged: true });
  expect(config.providers.fixture?.apiKey).toBe("key-b");

  const pauseB = await pause("B", true);
  expect(pauseB?.status, await pauseB?.clone().text()).toBe(200);
  expect(await pauseB!.json()).toEqual({ ok: true, activeAccountId: null, activeAccountChanged: true });
  expect(config.providers.fixture?.apiKey).toBeUndefined();

  const pauseBAgain = await pause("B", true);
  expect(pauseBAgain?.status, await pauseBAgain?.clone().text()).toBe(200);
  expect(await pauseBAgain!.json()).toEqual({ ok: true, activeAccountId: null, activeAccountChanged: false });
  expect(config.providers.fixture?.apiKey).toBeUndefined();

  const resumeA = await pause("A", false);
  expect(resumeA?.status, await resumeA?.clone().text()).toBe(200);
  expect(await resumeA!.json()).toEqual({ ok: true, activeAccountId: "A", activeAccountChanged: true });
  expect(config.providers.fixture?.apiKey).toBe("key-a");

  const resumeB = await pause("B", false);
  expect(resumeB?.status, await resumeB?.clone().text()).toBe(200);
  expect(await resumeB!.json()).toEqual({ ok: true, activeAccountId: "A", activeAccountChanged: false });
  expect(config.providers.fixture?.apiKey).toBe("key-a");
});

test("explicit images provider falls back from a paused selected key to an enabled pool key", async () => {
  const { handleImages } = await import("../../src/server/images");
  const previousFetch = globalThis.fetch;
  const sentKeys: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    sentKeys.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ data: [{ b64_json: "synthetic-image-base64" }] });
  }) as typeof fetch;
  try {
    const config = getDefaultConfig();
    config.providers = {
      "images-fallback": {
        adapter: "openai-responses", authMode: "key", baseUrl: "https://example.test/v1",
        apiKey: "paused-key",
        apiKeyPool: [
          { id: "paused", key: "paused-key", disabled: true },
          { id: "enabled", key: "enabled-key" },
        ],
      },
    };
    config.images = { provider: "images-fallback" };
    saveConfig(config);

    const response = await handleImages(new Request("http://localhost/v1/images/generations", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "cat" }),
    }), config, "generations", { model: "", provider: "" });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(sentKeys).toEqual(["Bearer enabled-key"]);
    expect(config.providers["images-fallback"]?.apiKey).toBe("enabled-key");
    expect(loadConfig().providers["images-fallback"]?.apiKey).toBe("enabled-key");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
