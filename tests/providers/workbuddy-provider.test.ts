import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { saveCredential, getCredential } from "../../src/oauth/store";
import { buildModelsRequest, getValidAccessTokenSnapshot, OAUTH_PROVIDERS } from "../../src/oauth";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../src/codex/model-cache";
import { extractProviderModelItems, resolveProviderModelDiscovery } from "../../src/providers/model-discovery";
import { handleResponses } from "../../src/server/responses";
import { handleChatCompletions } from "../../src/server/chat-completions";
import { credentialPinnedProviderConfigError } from "../../src/config/provider-validation";
import { routeModel } from "../../src/router";
import type { OAuthCredentials } from "../../src/oauth/types";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
let home: ReturnType<typeof createTempHome>, release: () => void;
beforeEach(() => { home = createTempHome("ocx-workbuddy-"); release = acquireOwnedSpendHome(); clearModelCache("workbuddy-ai"); });
afterEach(() => { globalThis.fetch = originalFetch; clearModelCache("workbuddy-ai"); release(); home.remove(); });
const credential = (id = "a"): OAuthCredentials => ({
  access: `fixture-access-${id}`, refresh: `fixture-refresh-${id}`, expires: Date.now() + 3_600_000,
  accountId: id, workbuddy: { uid: `fixture-user-${id}`, domain: "international", enterpriseId: `fixture-team-${id}` },
});
const provider = (): OcxProviderConfig => ({ ...OAUTH_PROVIDERS["workbuddy-ai"]!.providerConfig, fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch });
const catalog = (id = "glm-fixture") => ({ code: 0, data: {
  agents: [{ name: "cli", models: [id] }],
  models: [{ id, name: "Fixture model", maxInputTokens: 256000, maxOutputTokens: 16000, supportsImages: true,
    supportsReasoning: true, reasoning: { supportedEfforts: ["low", "high"], canDisableThinking: true } }, { id: "not-cli" }],
} });

test("live catalog publishes only CLI models and current account metadata", async () => {
  await saveCredential("workbuddy-ai", credential());
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://www.workbuddy.ai/v3/config");
    const headers = new Headers(init?.headers), uid = headers.get("x-user-id")!;
    calls.push(uid);
    expect(headers.get("authorization")).toBe(`Bearer fixture-access-${uid.endsWith("a") ? "a" : "b"}`);
    return Response.json(catalog(uid.endsWith("a") ? "glm-fixture" : "gpt-fixture"));
  }) as typeof fetch;
  const first = await fetchProviderModels("workbuddy-ai", provider(), 60_000);
  expect(first.map(m => m.id)).toEqual(["glm-fixture"]);
  expect(first[0]).toMatchObject({ contextWindow: 256000, maxOutputTokens: 16000, inputModalities: ["text"], reasoningEfforts: ["none", "low", "high"] });
  await saveCredential("workbuddy-ai", credential("b"));
  const second = await fetchProviderModels("workbuddy-ai", provider(), 60_000);
  expect(second.map(m => m.id)).toEqual(["gpt-fixture"]);
  expect(calls).toEqual(["fixture-user-a", "fixture-user-b"]);
});

test("captured snapshot keeps its identity after another account becomes active", async () => {
  await saveCredential("workbuddy-ai", credential());
  const snapshot = await getValidAccessTokenSnapshot("workbuddy-ai");
  await saveCredential("workbuddy-ai", credential("b"));
  const request = buildModelsRequest(provider(), snapshot.accessToken, "workbuddy-ai", snapshot);
  expect(request.headers["X-User-Id"]).toBe("fixture-user-a");
  expect(request.headers.Authorization).toBe("Bearer fixture-access-a");
  const bad = { ...provider(), baseUrl: "https://other.example/v2", adapter: "openai-chat" };
  expect(credentialPinnedProviderConfigError("workbuddy-ai", bad)).not.toBeNull();
  expect(buildModelsRequest(bad, snapshot.accessToken, "workbuddy-ai", snapshot).headers.Authorization).toBeUndefined();
  const config: OcxConfig = { port: 0, defaultProvider: "workbuddy-ai", providers: { "workbuddy-ai": { ...provider(), modelAdapters: { "default-model": "openai-responses" } } } };
  expect(routeModel(config, "workbuddy-ai/default-model").provider.adapter).toBe("workbuddy-ai");
});

test("catalog rejects business errors, invalid IDs and oversized rosters", () => {
  const discovery = resolveProviderModelDiscovery("workbuddy-ai", provider());
  expect(extractProviderModelItems({ code: 1, data: catalog().data }, discovery).ok).toBe(false);
  expect(extractProviderModelItems(catalog("bad\nmodel"), discovery).ok).toBe(false);
  expect(extractProviderModelItems(catalog(), { ...discovery, maxModels: 1 })).toMatchObject({ ok: false, reason: "too_many_models" });
});

for (const stream of [false, true]) test(`Responses pipeline sends WorkBuddy credentials and handles SSE (stream=${stream})`, async () => {
  await saveCredential("workbuddy-ai", credential());
  let sends = 0;
  const p = provider();
  p.fetch = (async (input, init) => {
    sends++;
    expect(String(input)).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(new Headers(init?.headers).get("x-user-id")).toBe("fixture-user-a");
    expect(new Headers(init?.headers).get("x-tenant-id")).toBe("fixture-team-a");
    expect(JSON.parse(String(init?.body)).stream).toBe(true);
    return new Response('data: {"choices":[{"delta":{"content":"Hello fixture"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const config: OcxConfig = { port: 0, defaultProvider: "workbuddy-ai", providers: { "workbuddy-ai": p } };
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "workbuddy-ai/default-model", input: "Hello", stream }) }), config, { model: "", provider: "" });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("Hello fixture");
  expect(text).not.toContain("fixture-access");
  expect(sends).toBe(1);
});

test("401 refresh uses the same account identity and retries once with the rotated token", async () => {
  await saveCredential("workbuddy-ai", credential());
  let refreshes = 0, sends = 0;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://www.workbuddy.ai/v2/plugin/auth/token/refresh");
    expect(new Headers(init?.headers).get("x-refresh-token")).toBe("fixture-refresh-a");
    refreshes++;
    return Response.json({ code: 0, data: { accessToken: "fixture-renewed", refreshToken: "fixture-rotated", expiresIn: 3600 } });
  }) as typeof fetch;
  const p = provider();
  p.fetch = (async (_input, init) => {
    sends++;
    const headers = new Headers(init?.headers);
    expect(headers.get("x-user-id")).toBe("fixture-user-a");
    expect(headers.get("x-tenant-id")).toBe("fixture-team-a");
    if (sends === 1) return Response.json({ code: 11001 }, { status: 401 });
    expect(headers.get("authorization")).toBe("Bearer fixture-renewed");
    return new Response('data: {"choices":[{"delta":{"content":"Renewed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const response = await handleResponses(new Request("http://localhost/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "workbuddy-ai/default-model", input: "Hello", stream: false }) }), { port: 0, defaultProvider: "workbuddy-ai", providers: { "workbuddy-ai": p } }, { model: "", provider: "" });
  expect(await response.text()).toContain("Renewed");
  expect(response.status).toBe(200);
  expect(refreshes).toBe(1); expect(sends).toBe(2);
  expect(getCredential("workbuddy-ai")?.refresh).toBe("fixture-rotated");
});

test("Chat Completions ingress also uses the subscription adapter", async () => {
  await saveCredential("workbuddy-ai", credential());
  const p = provider();
  p.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://www.workbuddy.ai/v2/chat/completions");
    expect(new Headers(init?.headers).get("x-user-id")).toBe("fixture-user-a");
    return new Response('data: {"choices":[{"delta":{"content":"Chat fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const response = await handleChatCompletions(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "workbuddy-ai/default-model", messages: [{ role: "user", content: "Hello" }], stream: false }),
  }), { port: 0, defaultProvider: "workbuddy-ai", providers: { "workbuddy-ai": p } }, { model: "", provider: "" });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Chat fixture");
});
