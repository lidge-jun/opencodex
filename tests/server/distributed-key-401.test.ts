import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearKeyCooldowns, forgetApiKeyRotationCursor, getKeyCooldownUntil } from "../../src/providers/key-failover";
import { startServer } from "../../src/server";
import { handleResponsesCompact } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { baseCompactionBody, compactionRequest, completedPayload, jsonResponse, removeCompactionFixture } from "../helpers/compaction-routing-fixtures";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";

const originalFetch = globalThis.fetch;
const DIRECT_CHATGPT_TOKEN = fakeChatGptJwt({ chatgpt_account_id: "fixture" });
const disabledOpenAiProvider = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward", disabled: true };
function keyedProvider(_baseUrl: string) { return { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-platform-key" }; }
let home: string;
let previousHome: string | undefined;
let previousToken: string | undefined;
let codexHome: IsolatedCodexHome;
let releaseSpendHome: (() => void) | undefined;
const takeSpendHome = () => { releaseSpendHome ??= acquireOwnedSpendHome(); };
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousToken = process.env.OPENCODEX_API_AUTH_TOKEN;
  home = mkdtempSync(join(tmpdir(), "ocx-distributed-401-"));
  process.env.OPENCODEX_HOME = home;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  codexHome = installIsolatedCodexHome("ocx-distributed-401-codex-");
  clearKeyCooldowns(); forgetApiKeyRotationCursor();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.(); releaseSpendHome = undefined;
  await removeCompactionFixture(home);
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousToken;
  clearKeyCooldowns(); forgetApiKeyRotationCursor();
});

test("distributed image 401 cools the failed key without replaying the paid POST", async () => {
  const seen: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    seen.push(req.headers.get("authorization")!);
    return Response.json(seen.length === 1 ? { error: "invalid key" } : { data: [] }, { status: seen.length === 1 ? 401 : 200 });
  } });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return originalFetch(url.hostname === "api.openai.com" ? new URL(url.pathname, upstream.url) : input, init);
  }) as typeof fetch;
  clearKeyCooldowns();
  saveConfig({ port: 0, defaultProvider: "openai-apikey", openaiProviderTierVersion: 2,
    providers: { openai: disabledOpenAiProvider, "openai-apikey": {
      ...keyedProvider(upstream.url.toString().replace(/\/$/, "")),
      apiKeyPool: [{ id: "first", key: "sk-platform-key" }, { id: "second", key: "sk-warm-key" }],
      requestPacing: { enabled: true, keySelection: "round-robin" },
    } },
  } as unknown as OcxConfig);
  const server = startServer(0);
  try {
    for (const [index, status] of [401, 200, 200].entries()) {
      const response = await fetch(new URL("/v1/images/generations", server.url), { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}` },
        body: JSON.stringify({ prompt: "fixture", model: "gpt-image-2" }),
      });
      expect(response.status).toBe(status);
      await response.text();
      expect(seen.length).toBe(index + 1);
    }
    expect(seen).toEqual(["Bearer sk-platform-key", "Bearer sk-warm-key", "Bearer sk-warm-key"]);
  } finally { await server.stop(true); await upstream.stop(true); clearKeyCooldowns(); }
});

test("native compact distributed 401 cools the static key without replaying or refreshing an account", async () => {
  takeSpendHome();
  clearKeyCooldowns("openai-apikey");
  const config = { defaultProvider: "openai-apikey", openaiProviderTierVersion: 2, providers: {
    "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", authMode: "key",
      apiKey: "synthetic-first", apiKeyPool: [{ id: "first", key: "synthetic-first" }, { id: "second", key: "synthetic-second" }],
      requestPacing: { enabled: true, keySelection: "round-robin" },
    },
  } } as OcxConfig;
  const keys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.openai.com/v1/responses/compact");
    keys.push(new Headers(init?.headers).get("authorization")!);
    return keys.length === 1 ? Response.json({ error: { message: "invalid key" } }, { status: 401 }) : jsonResponse(completedPayload("compact fixture"));
  }) as typeof fetch;
  try {
    for (const [index, status] of [401, 200, 200].entries()) {
      const response = await handleResponsesCompact(compactionRequest(baseCompactionBody({ model: "openai-apikey/gpt-5.5" })), config, { model: "", provider: "" });
      expect(response.status).toBe(status);
      await response.text();
      expect(keys).toHaveLength(index + 1);
    }
    expect(keys).toEqual(["Bearer synthetic-first", "Bearer synthetic-second", "Bearer synthetic-second"]);
  } finally { clearKeyCooldowns("openai-apikey"); }
});

test("direct distributed Images 429 cools both keys without replaying the paid POST", async () => {
  const seen: string[] = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    seen.push(req.headers.get("authorization")!);
    return Response.json({ error: { message: "fixture capacity" } }, { status: 429, headers: { "retry-after": "60" } });
  } });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return originalFetch(url.hostname === "api.openai.com" ? new URL(url.pathname, upstream.url) : input, init);
  }) as typeof fetch;
  saveConfig({ port: 0, defaultProvider: "openai-apikey", openaiProviderTierVersion: 2,
    providers: { openai: disabledOpenAiProvider, "openai-apikey": {
      ...keyedProvider(upstream.url.toString()), apiKeyPool: [{ id: "first", key: "sk-platform-key" }, { id: "second", key: "sk-warm-key" }],
      requestPacing: { enabled: true, keySelection: "round-robin" },
    } },
  } as unknown as OcxConfig);
  const server = startServer(0); const began = Date.now();
  try {
    for (let index = 0; index < 3; index++) {
      const response = await fetch(new URL("/v1/images/generations", server.url), { method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${DIRECT_CHATGPT_TOKEN}` },
        body: JSON.stringify({ prompt: "fixture", model: "gpt-image-2" }),
      });
      expect(response.status).toBe(429); await response.text();
      expect(seen).toHaveLength(Math.min(index + 1, 2));
    }
    expect(seen).toEqual(["Bearer sk-platform-key", "Bearer sk-warm-key"]);
    for (const id of ["first", "second"]) expect(getKeyCooldownUntil("openai-apikey", id)).toBeGreaterThanOrEqual(began + 60_000);
  } finally { await server.stop(true); await upstream.stop(true); clearKeyCooldowns(); }
});
