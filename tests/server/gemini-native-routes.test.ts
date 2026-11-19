import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import { rawJsonMember } from "../../src/server/gemini-native-wire";
import { getRequestLogEntries } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const provider = "google-antigravity";
const model = "gemini-3.8-flash-medium";
const qualifiedModel = `${provider}/${model}`;
const generationPath = `/v1beta/models/${qualifiedModel}:generateContent`;
const streamingPath = `/v1beta/models/${qualifiedModel}:streamGenerateContent`;
const key = "ocx_data_" + "1".repeat(40);
const blockedModelKey = "ocx_data_" + "2".repeat(40);
const blockedProviderKey = "ocx_data_" + "3".repeat(40);
const accessToken = "fixture-antigravity-access";
const projectId = "fixture-antigravity-project";
const raw = '{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"candidateCount":2},"opaque":9007199254740993123}';
const first = '{"candidates":[{"index":0,"content":{"parts":[{"thoughtSignature":"fixture-signature"}]}}],"opaque":9007199254740993123}';
const terminal = '{"candidates":[{"index":0,"finishReason":"STOP"}]}';
const oldHome = process.env.OPENCODEX_HOME;
const oldDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
let home = "";
let upstream: ReturnType<typeof Bun.serve>;
let server: ReturnType<typeof startServer>;
const sends: Array<{ path: string; auth: string | null; key: string | null; body: string }> = [];

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "ocx-gemini-native-route-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = "ocx_data_gemini_native_fixture";
  upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST") return new Response(null, { status: 404 });
    sends.push({ path: url.pathname + url.search, auth: req.headers.get("authorization"),
      key: req.headers.get("x-opencodex-api-key") ?? req.headers.get("x-goog-api-key"), body: await req.text() });
    if (url.pathname.endsWith(":streamGenerateContent")) {
      return new Response(`data: {"response":${first}}\n\ndata: {"response":${terminal}}\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(`{"response":${first}}`);
  } });
  const scopes = [
    { allowedProviders: [provider], allowedModels: [qualifiedModel] },
    { allowedProviders: [provider], allowedModels: [`${provider}/gemini-3.8-flash-high`] },
    { allowedProviders: ["google"], allowedModels: [model] },
  ];
  saveConfig({
    port: 0, hostname: "0.0.0.0", defaultProvider: provider,
    providers: { [provider]: { adapter: "google", authMode: "oauth", googleMode: "cloud-code-assist",
      baseUrl: upstream.url.origin, allowPrivateNetwork: true, models: [model] } },
    apiKeys: [key, blockedModelKey, blockedProviderKey].map((secret, index) => ({
      id: `gemini-native-key-${index}`, key: secret, name: `Gemini fixture ${index}`, createdAt: "2026-01-01T00:00:00.000Z", ...scopes[index],
    })),
  } as OcxConfig);
  await saveCredential(provider, {
    access: accessToken, refresh: "fixture-antigravity-refresh", expires: Date.now() + 3_600_000,
    accountId: "fixture-antigravity-account", projectId, source: "oauth",
  });
  server = startServer(0);
});

afterAll(async () => {
  await server?.stop(true);
  upstream?.stop(true);
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  if (oldDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = oldDataToken;
  if (home) removeTreeWithRetry(home);
});

function generate(path: string, headers: Record<string, string> = { "x-goog-api-key": key }) {
  return fetch(new URL(path, server.url), {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw,
  });
}

test("the shared Gemini route preserves original JSON only for opted-in Antigravity generation", async () => {
  const count = sends.length;
  for (const path of [generationPath, generationPath + "?ocx_native=false",
    generationPath.replace("/v1beta/", "/v1/") + "?ocx_native=true",
    generationPath.replace(provider + "/", "agy/") + "?ocx_native=true"]) {
    const translated = await generate(path);
    expect(translated.status).toBe(400); // The compatibility codec rejects candidateCount > 1.
    await translated.text();
  }
  expect(sends).toHaveLength(count);
  const response = await generate(generationPath + `?ocx_native=true&key=${key}`, {});
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(first);
  const send = sends[count]!;
  expect(sends).toHaveLength(count + 1);
  expect(send).toMatchObject({ path: "/v1internal:generateContent", auth: "Bearer " + accessToken, key: null });
  expect(rawJsonMember(send.body, "request")).toBe(raw);
  expect(JSON.parse(send.body)).toMatchObject({ model, project: projectId });
  const requestId = response.headers.get("x-opencodex-request-id");
  expect(requestId).toBeTruthy();
  expect(getRequestLogEntries().filter(row => row.requestId === requestId)).toMatchObject([
    { provider, model, requestedModel: qualifiedModel, apiKeyId: "gemini-native-key-0", status: 200 },
  ]);
});

test("opted-in generation still enforces shared auth, origin and destination scope", async () => {
  const count = sends.length;
  const path = generationPath + "?ocx_native=true";
  for (const [headers, status] of [
    [{}, 401],
    [{ "x-goog-api-key": key, origin: "https://evil.invalid" }, 403],
    [{ "x-goog-api-key": blockedModelKey }, 403],
    [{ "x-goog-api-key": blockedProviderKey }, 403],
  ] as const) {
    const refused = await generate(path, headers);
    expect(refused.status).toBe(status);
    await refused.text();
  }
  expect(sends).toHaveLength(count);
});

test("native streaming keeps the Gemini client's SSE or JSON-array framing", async () => {
  const count = sends.length;
  const sse = await generate(streamingPath + "?ocx_native=true&alt=sse");
  expect(sse.status).toBe(200);
  expect(sse.headers.get("content-type")).toContain("text/event-stream");
  expect(await sse.text()).toBe(`data: ${first}\n\ndata: ${terminal}\n\n`);
  const array = await generate(streamingPath + "?ocx_native=true");
  expect(array.status).toBe(200);
  expect(array.headers.get("content-type")).toContain("application/json");
  expect(await array.text()).toBe(`[\n${first},\n${terminal}\n]`);
  expect(sends.slice(count).map(send => send.path)).toEqual([
    "/v1internal:streamGenerateContent?alt=sse", "/v1internal:streamGenerateContent?alt=sse",
  ]);
});
