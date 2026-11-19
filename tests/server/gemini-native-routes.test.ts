import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import { nativeGeminiDestination } from "../../src/server/gemini-native-catalog";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const MODEL = "gemini-3.8-flash";
const WIRE_MODEL = "gemini-3.8-flash-medium";
const PROVIDER = "google-antigravity";
const TARGET = `${PROVIDER}/${MODEL}`;
const CCA = "https://daily-cloudcode-pa.googleapis.com";
const CHAT = "https://chat-fixture.invalid";
const GOOGLE_KEY = "fixture-local-ingress-key";
const OAUTH_TOKEN = "fixture-google-oauth-access";
const SCOPE_KEY = "ocx_data_" + "d".repeat(40);
const MODEL_SCOPE_KEY = "ocx_data_" + "b".repeat(40);
const RAW = '{"contents":[{"role":"user","parts":[{"text":"hello"}]}], "future":9007199254740993123}';
const PAYLOAD = '{"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"future":9007199254740993123}';
const originalFetch = globalThis.fetch;
const previousEnv = {
  OPENCODEX_HOME: process.env.OPENCODEX_HOME,
  OPENCODEX_API_AUTH_TOKEN: process.env.OPENCODEX_API_AUTH_TOKEN,
};
const seen: Array<{ url: URL; headers: Headers; body: string }> = [];
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-native-gemini-routes-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = GOOGLE_KEY;
  await saveCredential(PROVIDER, {
    access: OAUTH_TOKEN, refresh: "fixture-google-oauth-refresh",
    expires: Date.now() + 3_600_000, accountId: "fixture-google-account",
    projectId: "fixture-google-project", source: "oauth",
  });
});
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (home) removeTreeWithRetry(home);
});

beforeEach(() => {
  seen.length = 0;
  const fixtureFetch: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
    if (url.origin !== CCA && url.origin !== CHAT) throw new Error("unexpected external fetch in Gemini fixture");
    if (init?.method !== "POST" || !url.pathname.includes("generateContent") && !url.pathname.includes("streamGenerateContent") && !url.pathname.endsWith("/chat/completions")) {
      return Response.json({ models: [], data: [] });
    }
    seen.push({ url, headers: new Headers(init.headers), body: String(init.body) });
    if (url.origin === CHAT) {
      return Response.json({
        id: "chatcmpl-gemini-route-fixture", object: "chat.completion", created: 1, model: MODEL,
        choices: [{ index: 0, message: { role: "assistant", content: "translated" }, finish_reason: "stop" }],
      });
    }
    const envelope = `{"project":"fixture-private-project","response":${PAYLOAD}}`;
    if (url.pathname.endsWith(":streamGenerateContent")) {
      return new Response(`data: ${envelope}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(envelope, { headers: { "content-type": "application/json", "set-cookie": "fixture-private" } });
  }, { preconnect: originalFetch.preconnect });
  globalThis.fetch = fixtureFetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

function config(flag?: boolean): OcxConfig {
  return {
    port: 0, hostname: "0.0.0.0", defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: { adapter: "google", authMode: "oauth", baseUrl: CCA, googleMode: "cloud-code-assist", models: [MODEL, WIRE_MODEL] },
      fx: { adapter: "openai-chat", authMode: "key", baseUrl: CHAT + "/v1", apiKey: "fixture-chat-access", models: [MODEL] },
    },
    ...(flag === undefined ? {} : { protocols: { rollout: { geminiNativeAntigravity: flag } } }),
    apiKeys: [
      { id: "gemini-scope", name: "Gemini scope", key: SCOPE_KEY, createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: ["fx"] },
      { id: "gemini-model-scope", name: "Gemini model scope", key: MODEL_SCOPE_KEY, createdAt: "2026-01-01T00:00:00.000Z",
        allowedProviders: [PROVIDER], allowedModels: [`${PROVIDER}/gemini-4-argon`] },
    ],
  };
}
async function withServer(cfg: OcxConfig, run: (base: URL) => Promise<void>) {
  saveConfig(cfg);
  const server = startServer(0);
  try { await run(server.url); } finally { await server.stop(true); }
}
const key = { "x-goog-api-key": GOOGLE_KEY };
const generation = (model = TARGET, method = "generateContent", version = "v1beta") => `/${version}/models/${model}:${method}`;
const post = (base: URL, path: string, headers: Record<string, string> = key) =>
  originalFetch(new URL(path, base), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: RAW });
const get = (base: URL, path: string, headers: Record<string, string> = key) =>
  originalFetch(new URL(path, base), { headers });

test("opted-in Gemini routes preserve native JSON and replace every ingress credential", async () => {
  await withServer(config(true), async base => {
    const response = await post(base, generation() + `?key=${GOOGLE_KEY}`, {});
    expect(response.status).toBe(200);
    expect(response.headers.get("x-opencodex-request-id")).toBeTruthy();
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.text()).toBe(PAYLOAD);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.href).toBe(CCA + "/v1internal:generateContent");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer " + OAUTH_TOKEN);
    expect(seen[0]!.headers.has("x-goog-api-key")).toBe(false);
    expect(seen[0]!.headers.has("x-opencodex-api-key")).toBe(false);
    expect(seen[0]!.body).toContain(`"request":${RAW}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: WIRE_MODEL, project: "fixture-google-project" });
  });
});

test("flag off, v1, and a Gemini model on another provider use the Chat bridge", async () => {
  for (const flag of [undefined, false, true]) {
    await withServer(config(flag), async base => {
      const path = flag === true ? generation(TARGET, "generateContent", "v1") : generation() + "?ocx_native=true";
      const translated = await post(base, path);
      expect(translated.status).toBe(200);
      expect(await translated.json()).not.toHaveProperty("future");
      expect(seen.at(-1)?.body).not.toContain(RAW);
      const other = await post(base, generation(`fx/${MODEL}`));
      expect(other.status).toBe(200);
      expect(await other.text()).toContain("translated");
      expect(seen.at(-1)?.url.origin).toBe(CHAT);
      expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ model: MODEL, messages: [{ role: "user", content: "hello" }] });
    });
  }
});

test("a Google OAuth clone and an overridden wire cannot take the canonical native leg", () => {
  const cfg = config(true);
  const canonical = cfg.providers[PROVIDER]!;
  const req = new Request("http://localhost/v1beta/models");
  expect(nativeGeminiDestination(cfg, req, TARGET)?.wireModel).toBe(WIRE_MODEL);
  cfg.providers.mirror = { ...canonical };
  expect(nativeGeminiDestination(cfg, req, `mirror/${MODEL}`)).toBeUndefined();
  canonical.modelAdapters = { [MODEL]: "openai-responses" };
  expect(nativeGeminiDestination(cfg, req, TARGET)).toBeUndefined();
});

test("native streaming preserves records in both Gemini response formats", async () => {
  await withServer(config(true), async base => {
    const path = generation(TARGET, "streamGenerateContent");
    const sse = await post(base, path + "?alt=sse");
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    expect(await sse.text()).toBe(`data: ${PAYLOAD}\n\n`);
    const discoverySse = await post(base, path + "?$alt=sse");
    expect(discoverySse.headers.get("content-type")).toContain("text/event-stream");
    expect(await discoverySse.text()).toBe(`data: ${PAYLOAD}\n\n`);
    const json = await post(base, path);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.text()).toBe(`[\n${PAYLOAD}\n]`);
    expect(seen.map(call => call.url.href)).toEqual(Array(3).fill(CCA + "/v1internal:streamGenerateContent?alt=sse"));
  });
});

test("native selection shares key, origin, host, and model-scope refusals", async () => {
  await withServer(config(true), async base => {
    for (const [headers, status, errorStatus] of [
      [{}, 401, "UNAUTHENTICATED"],
      [{ "x-goog-api-key": "wrong" }, 401, "UNAUTHENTICATED"],
      [{ ...key, origin: "https://foreign.example" }, 403, "PERMISSION_DENIED"],
      [{ "x-goog-api-key": SCOPE_KEY }, 403, "PERMISSION_DENIED"],
      [{ "x-goog-api-key": MODEL_SCOPE_KEY }, 403, "PERMISSION_DENIED"],
    ] as const) {
      const response = await post(base, generation(), { ...headers });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code: status, status: errorStatus } });
    }
    expect(seen).toHaveLength(0);
    expect((await get(base, generation())).headers.get("allow")).toBe("POST");
    const interactions = await get(base, "/v1beta/interactions");
    expect(interactions.status).toBe(405);
    expect(interactions.headers.get("allow")).toBe("POST");
    expect(await interactions.json()).toMatchObject({ error: { code: 405, status: "UNIMPLEMENTED" } });
  });
  await withServer({ ...config(true), hostname: "127.0.0.1" }, async base => {
    const headers = { ...key, host: "rebind.example" };
    const response = await post(base, generation(), headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 403, status: "PERMISSION_DENIED" } });
    expect((await get(base, "/v1beta/models", headers)).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

test("model lookup and discovery expose only scoped, routable native wire aliases", async () => {
  const cfg = config(true);
  cfg.providers[PROVIDER]!.defaultMaxOutputTokens = 4096;
  await withServer(cfg, async base => {
    const response = await get(base, "/v1beta/models");
    const payload = await response.json() as { models: Array<{ name: string }> };
    const names = payload.models.map(model => model.name);
    expect(names).toContain(`models/${WIRE_MODEL}`);
    expect(names).toContain(`models/${TARGET}`);
    expect(names).toContain(`models/fx/${MODEL}`);
    const one = await get(base, `/v1beta/models/${WIRE_MODEL}`);
    expect(one.status).toBe(200);
    const alias = {
      name: `models/${WIRE_MODEL}`,
      outputTokenLimit: 4096,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    };
    expect(await one.json()).toMatchObject(alias);
    expect(payload.models.find(model => model.name === alias.name)).toMatchObject(alias);
    const count = await post(base, generation(WIRE_MODEL, "countTokens"));
    expect(count.status).toBe(200);
    expect((await count.json() as { totalTokens: number }).totalTokens).toBeGreaterThan(0);
    const scoped = { "x-goog-api-key": SCOPE_KEY };
    const filtered = await get(base, "/v1beta/models", scoped);
    expect(await filtered.json()).toMatchObject({ models: [{ name: `models/fx/${MODEL}` }] });
    expect((await get(base, `/v1beta/models/${WIRE_MODEL}`, scoped)).status).toBe(404);
    expect((await post(base, generation(WIRE_MODEL, "countTokens"), scoped)).status).toBe(404);
    expect((await get(base, "/v1beta/models/gemini-no-such-model")).status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});
