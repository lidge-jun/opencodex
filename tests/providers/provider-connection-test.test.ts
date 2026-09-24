import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setFetchCursorUsableModelsForTests } from "../../src/adapters/cursor/live-models";
import { setFetchQoderModelsForTests } from "../../src/adapters/qoder/live-models";
import { clearCachedUserJwt } from "../../src/adapters/devin/cloud-direct/auth";
import { setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { encodeMessage, encodeString } from "../../src/adapters/devin/cloud-direct/wire";
import { handleManagementAPI } from "../../src/server/management-api";
import { saveConfig } from "../../src/config";
import { OAUTH_PROVIDERS } from "../../src/oauth";
import { saveCredential } from "../../src/oauth/store";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import type { OcxConfig } from "../../src/types";
import { withRegistryDiscovery } from "../helpers/provider-registry-discovery";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_DIR = join(tmpdir(), "ocx-conn-test");
const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  setFetchCursorUsableModelsForTests(null);
  setFetchQoderModelsForTests(null);
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(TEST_DIR);
});

function baseConfig(providers: OcxConfig["providers"]): OcxConfig {
  if (globalThis.fetch !== originalFetch) {
    for (const provider of Object.values(providers)) {
      (provider as typeof provider & { fetch?: typeof fetch }).fetch = globalThis.fetch;
    }
  }
  const config = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: Object.keys(providers)[0]!,
    providers,
  } as OcxConfig;
  saveConfig(config);
  return config;
}

async function probe(config: OcxConfig, name: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://127.0.0.1/api/providers/test?name=${name}`, { method: "POST" });
  const res = await handleManagementAPI(req, new URL(req.url), config, {});
  if (!res) throw new Error("handler returned no response");
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe("POST /api/providers/test (WP040 connectivity probe)", () => {
  test("Devin probes its snapshot's EU tenant destination", async () => {
    const baseUrl = "https://eu.windsurf.com/_route/api_server";
    const urls: string[] = [];
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
      "fixture-signature",
    ].join(".");
    globalThis.fetch = (async input => {
      const url = String(input);
      urls.push(url);
      return new Response(new Uint8Array(url.endsWith("/GetUserJwt")
        ? encodeString(1, jwt)
        : encodeMessage(1, Buffer.concat([encodeString(1, "tenant-model"), encodeString(22, "tenant-model")]))));
    }) as typeof fetch;
    await saveCredential("devin", {
      access: "fixture-devin-eu", refresh: "fixture-devin-eu",
      expires: Number.MAX_SAFE_INTEGER, apiBaseUrl: baseUrl,
    });
    const config = baseConfig({ devin: { ...structuredClone(OAUTH_PROVIDERS.devin!.providerConfig) } });
    setCachedCatalogForTests(null);
    clearCachedUserJwt();
    try {
      const { body } = await probe(config, "devin");
      expect(urls.some(url => new URL(url).hostname === "server.codeium.com")).toBe(false);
      expect(urls).toEqual([
        `${baseUrl}/exa.auth_pb.AuthService/GetUserJwt`,
        `${baseUrl}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`,
      ]);
      expect(body).toMatchObject({ ok: true, models: 1 });
    } finally {
      setCachedCatalogForTests(null);
      clearCachedUserJwt();
    }
  });

  test("Copilot key probe uses the configured endpoint instead of a stored OAuth host", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "fixture-model" }] });
    }) as typeof fetch;
    await saveCredential("github-copilot", {
      access: "fixture-oauth", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
      apiBaseUrl: "https://api.business.githubcopilot.com",
    });
    const config = baseConfig({
      "github-copilot": {
        ...structuredClone(OAUTH_PROVIDERS["github-copilot"]!.providerConfig),
        authMode: "key", apiKey: "fixture-row-key", baseUrl: "https://api.githubcopilot.com",
      },
    });

    const { body } = await probe(config, "github-copilot");

    expect(calls).toEqual([{ url: "https://api.githubcopilot.com/models", authorization: "Bearer fixture-row-key" }]);
    expect(body).toMatchObject({ ok: true, models: 1 });
  });

  test("Copilot probe keeps account A's refreshed bearer and host when the active account switches to B", async () => {
    const previous = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };
    const root = mkdtempSync(join(tmpdir(), "ocx-copilot-probe-refresh-"));
    process.env.HOME = join(root, "home");
    process.env.OPENCODEX_HOME = join(root, "opencodex");
    process.env.CODEX_HOME = join(root, "codex");
    const originalRefresh = OAUTH_PROVIDERS["github-copilot"]!.refresh;
    const calls: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "fixture-model" }] });
    }) as typeof fetch;
    let refreshCalls = 0;
    try {
      await saveCredential("github-copilot", {
        accountId: "account-a", access: "fixture-account-a-old", refresh: "fixture-refresh-a",
        expires: Date.now() - 1, apiBaseUrl: "https://api.githubcopilot.com",
      });
      OAUTH_PROVIDERS["github-copilot"]!.refresh = async () => {
        refreshCalls += 1;
        await saveCredential("github-copilot", {
          accountId: "account-b", access: "fixture-account-b", refresh: "fixture-refresh-b",
          expires: Date.now() + 3_600_000, apiBaseUrl: "https://api.business.githubcopilot.com",
        });
        return {
          accountId: "account-a", access: "fixture-account-a-new", refresh: "fixture-refresh-a",
          expires: Date.now() + 3_600_000, apiBaseUrl: "https://api.githubcopilot.com",
        };
      };
      const config = baseConfig({
        "github-copilot": { ...structuredClone(OAUTH_PROVIDERS["github-copilot"]!.providerConfig) },
      });
      const { body } = await probe(config, "github-copilot");

      expect(refreshCalls).toBe(1);
      expect(calls).toEqual([{ url: "https://api.githubcopilot.com/models", authorization: "Bearer fixture-account-a-new" }]);
      expect(body).toMatchObject({ ok: true, models: 1 });
    } finally {
      OAUTH_PROVIDERS["github-copilot"]!.refresh = originalRefresh;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeTreeWithRetry(root);
    }
  });

  test("Copilot probe of a legacy snapshot without an API host never borrows another account's stored host", async () => {
    const previous = { HOME: process.env.HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME, CODEX_HOME: process.env.CODEX_HOME };
    const root = mkdtempSync(join(tmpdir(), "ocx-copilot-probe-legacy-"));
    process.env.HOME = join(root, "home");
    process.env.OPENCODEX_HOME = join(root, "opencodex");
    process.env.CODEX_HOME = join(root, "codex");
    const originalRefresh = OAUTH_PROVIDERS["github-copilot"]!.refresh;
    const calls: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = (async (input, init) => {
      calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return Response.json({ data: [{ id: "fixture-model" }] });
    }) as typeof fetch;
    try {
      await saveCredential("github-copilot", {
        accountId: "account-a", access: "fixture-account-a-old", refresh: "fixture-refresh-a", expires: Date.now() - 1,
      });
      // The refresh races an account switch: the live store now names account B's business host,
      // while account A's refreshed snapshot carries no host of its own.
      OAUTH_PROVIDERS["github-copilot"]!.refresh = async () => {
        await saveCredential("github-copilot", {
          accountId: "account-b", access: "fixture-account-b", refresh: "fixture-refresh-b",
          expires: Date.now() + 3_600_000, apiBaseUrl: "https://api.business.githubcopilot.com",
        });
        return { accountId: "account-a", access: "fixture-account-a-new", refresh: "fixture-refresh-a", expires: Date.now() + 3_600_000 };
      };
      const config = baseConfig({
        "github-copilot": { ...structuredClone(OAUTH_PROVIDERS["github-copilot"]!.providerConfig) },
      });
      await probe(config, "github-copilot");

      expect(calls).toEqual([{ url: "https://api.githubcopilot.com/models", authorization: "Bearer fixture-account-a-new" }]);
    } finally {
      OAUTH_PROVIDERS["github-copilot"]!.refresh = originalRefresh;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      removeTreeWithRetry(root);
    }
  });

  test("Devin probe of a snapshot without an API host falls back only to the allowlisted default", async () => {
    const urls: string[] = [];
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
      "fixture-signature",
    ].join(".");
    globalThis.fetch = (async input => {
      const url = String(input);
      urls.push(url);
      return new Response(new Uint8Array(url.endsWith("/GetUserJwt")
        ? encodeString(1, jwt)
        : encodeMessage(1, Buffer.concat([encodeString(1, "tenant-model"), encodeString(22, "tenant-model")]))));
    }) as typeof fetch;
    await saveCredential("devin", {
      access: "fixture-devin-legacy", refresh: "fixture-devin-legacy", expires: Number.MAX_SAFE_INTEGER,
    });
    // A configured base outside the Devin allowlist must never receive the account token.
    const config = baseConfig({ devin: {
      ...structuredClone(OAUTH_PROVIDERS.devin!.providerConfig), baseUrl: "https://collector.example.test/_route/api_server",
    } });
    setCachedCatalogForTests(null);
    clearCachedUserJwt();
    try {
      await probe(config, "devin");
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(new URL(url).hostname).toBe("server.codeium.com");
    } finally {
      setCachedCatalogForTests(null);
      clearCachedUserJwt();
    }
  });

  test("Qoder probes the official CLI model list for the configured PAT", async () => {
    const calls: Array<{ providerId: string; token: string }> = [];
    setFetchQoderModelsForTests((profile, token) => {
      calls.push({ providerId: profile.providerId, token });
      return { ok: true, models: ["Qwen3.8-Max", "GLM-5.3"] };
    });
    const config = baseConfig({
      qoder: { adapter: "qoder", baseUrl: "https://qoder.com", apiKey: "qoder-pat", authMode: "key", liveModels: true },
    });

    const { body } = await probe(config, "qoder");

    expect(body).toMatchObject({ ok: true, models: 2, message: "Connected. 2 models." });
    expect(calls).toEqual([{ providerId: "qoder", token: "qoder-pat" }]);
  });

  test("Qoder CN probes its own CLI profile and PAT", async () => {
    const calls: Array<{ providerId: string; token: string }> = [];
    setFetchQoderModelsForTests((profile, token) => {
      calls.push({ providerId: profile.providerId, token });
      return { ok: true, models: ["Qwen3.8-Flash"] };
    });
    const config = baseConfig({
      "qoder-cn": { adapter: "qoder", baseUrl: "https://qoder.cn", apiKey: "cn-pat", authMode: "key", liveModels: true },
    });

    const { body } = await probe(config, "qoder-cn");

    expect(body).toMatchObject({ ok: true, models: 1, message: "Connected. 1 models." });
    expect(calls).toEqual([{ providerId: "qoder-cn", token: "cn-pat" }]);
  });

  test("Cursor probes GetUsableModels and reports the live model count", async () => {
    const calls: { apiKey: string; baseUrl?: string }[] = [];
    setFetchCursorUsableModelsForTests(async options => {
      calls.push({ apiKey: options.apiKey, baseUrl: options.baseUrl });
      return { ok: true, models: ["gpt-5.6-high", "claude-4.6-opus-high"] };
    });
    await saveCredential("cursor", {
      access: "cursor-access-token",
      refresh: "cursor-refresh-token",
      expires: Date.now() + 3_600_000,
    });
    const config = baseConfig({
      cursor: { ...structuredClone(OAUTH_PROVIDERS.cursor.providerConfig) },
    });

    const { body } = await probe(config, "cursor");

    expect(body).toMatchObject({ ok: true, models: 2, message: "Connected. 2 models." });
    expect(calls).toEqual([{ apiKey: "cursor-access-token", baseUrl: "https://api2.cursor.sh" }]);
  });

  test("Cursor discovery failures are surfaced with their classification", async () => {
    setFetchCursorUsableModelsForTests(async () => ({ ok: false, error: "http" }));
    await saveCredential("cursor", {
      access: "cursor-access-token",
      refresh: "cursor-refresh-token",
      expires: Date.now() + 3_600_000,
    });
    const config = baseConfig({
      cursor: { ...structuredClone(OAUTH_PROVIDERS.cursor.providerConfig) },
    });

    const { body } = await probe(config, "cursor");

    expect(body.ok).toBe(false);
    expect(body.error).toBe("cursor discovery http");
  });

  test("disabled Cursor fails fast without probing discovery", async () => {
    let probes = 0;
    setFetchCursorUsableModelsForTests(async () => {
      probes += 1;
      return { ok: true, models: ["should-not-be-used"] };
    });
    const config = baseConfig({
      cursor: { ...structuredClone(OAUTH_PROVIDERS.cursor.providerConfig), disabled: true },
    });

    const { body } = await probe(config, "cursor");

    expect(body.ok).toBe(false);
    expect(body.error).toBe("Provider is disabled");
    expect(probes).toBe(0);
  });

  test("unreachable upstream reports ok:false with the failure reason", async () => {
    globalThis.fetch = (async () => { throw new TypeError("connection refused"); }) as typeof fetch;
    const config = baseConfig({
      dead: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x", allowPrivateNetwork: true },
    });
    const { status, body } = await probe(config, "dead");
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  test("metadata endpoints stay blocked even with private-network opt-in", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({ data: [{ id: "should-not-load" }] }), { status: 200 });
    }) as typeof fetch;
    const config = baseConfig({
      metadata: {
        adapter: "openai-chat",
        baseUrl: "http://169.254.169.254/latest/meta-data",
        apiKey: "sk-x",
        allowPrivateNetwork: true,
      },
    });

    const { body } = await probe(config, "metadata");

    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("blocked metadata endpoint");
    expect(fetches).toBe(0);
  });

  test("static catalog reports a neutral non-applicable connection test", async () => {
    const config = baseConfig({
      staticprov: {
        adapter: "openai-chat",
        baseUrl: "https://static.example.test/v1",
        apiKey: "sk-x",
        liveModels: false,
        models: ["m-1", "m-2"],
      },
    });
    const { body } = await probe(config, "staticprov");
    expect(body).toEqual({ applicable: false, reason: "static_catalog", latencyMs: 0 });
  });

  test("Google Antigravity reports not-applicable without credentials or network access (#723)", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      throw new Error("static Antigravity catalog must not probe upstream");
    }) as typeof fetch;
    const config = baseConfig({
      "google-antigravity": {
        ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
        liveModels: false,
      },
    });

    const { body } = await probe(config, "google-antigravity");

    expect(body).toEqual({ applicable: false, reason: "static_catalog", latencyMs: 0 });
    expect(fetches).toBe(0);
  });

  test("Google Antigravity probes its CCA agent-model RPC", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return Response.json({
        models: {
          "any-agent-model": { maxTokens: 123_456 },
          "not-an-agent-model": { maxTokens: 65_536 },
        },
        agentModelSorts: [{ groups: [{ modelIds: ["any-agent-model"] }] }],
        tabModelIds: ["not-an-agent-model"],
      });
    }) as typeof fetch;
    await saveCredential("google-antigravity", {
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 3_600_000,
      projectId: "test-project-id",
    });
    const config = baseConfig({
      "google-antigravity": {
        ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
        project: "configured-project",
      },
    });

    const { body } = await probe(config, "google-antigravity");

    expect(body).toMatchObject({ ok: true, models: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(seen[0]?.init?.method).toBe("POST");
    expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer test-access-token");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ project: "configured-project" });
  });

  test("a fake key gets the upstream rejection, not a catalog-presence pass", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const config = baseConfig({
      fake: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-fake", models: ["m-1"] },
    });
    const { body } = await probe(config, "fake");
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("401");
  });

  test("releases a rejected upstream response body", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }), { status: 401 })) as typeof fetch;
    const config = baseConfig({
      fake: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-fake" },
    });
    const { body } = await probe(config, "fake");
    expect(body.ok).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("blocks an unsafe discovery destination before sending provider headers", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return Response.json({ data: [] });
    }) as typeof fetch;
    const config = baseConfig({
      blocked: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-secret" },
    });
    config.providers.blocked!.baseUrl = "http://127.0.0.1:8080/v1";

    const { body } = await probe(config, "blocked");
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("destination policy");
    expect(fetches).toBe(0);
  });

  test("disabled providers fail fast without touching the network", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const config = baseConfig({
      off: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x", disabled: true },
      other: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x" },
    });
    config.defaultProvider = "other";
    const { body } = await probe(config, "off");
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("disabled");
    expect(fetches).toBe(0);
  });

  test("forward providers report honest passthrough, not a fake upstream check", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => { fetches++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const config = baseConfig({
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    });
    const { body } = await probe(config, "openai");
    expect(body.ok).toBe(true);
    expect(String(body.message)).toContain("Passthrough");
    expect(fetches).toBe(0);
  });

  test("a live 200 with model data reports ok:true with the count", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "m-1" }, { id: "m-2" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const config = baseConfig({
      live: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-live" },
    });
    const { body } = await probe(config, "live");
    expect(body.ok).toBe(true);
    expect(body.models).toBe(2);
  });

  test("reports only eligible deduplicated models from a registry discovery contract", async () => {
    await withRegistryDiscovery("together", {
      filter: { anyOf: [{ path: ["type"], equalsAny: ["chat"] }] },
    }, async () => {
      globalThis.fetch = (async () => Response.json({
        data: [
          { id: "chat-model", type: "chat" },
          { id: "chat-model", type: "chat" },
          { id: "embedding-model", type: "embedding" },
        ],
      })) as typeof fetch;
      const config = baseConfig({
        together: {
          adapter: "openai-chat",
          baseUrl: "https://api.together.xyz/v1",
          apiKey: "sk-live",
        },
      });
      const { body } = await probe(config, "together");
      expect(body.ok).toBe(true);
      expect(body.models).toBe(1);
    });
  });

  test("Nous probe accepts 390 synthetic paid/free rows above 256 KiB (#3939)", async () => {
    const payload = JSON.stringify({
      data: Array.from({ length: 390 }, (_, index) => ({
        id: index === 0 ? "tencent/hy3:free" : `vendor/model-${index}`,
        metadata: { description: "x".repeat(1_400) },
      })),
    });
    const bytes = new TextEncoder().encode(payload).byteLength;
    expect(bytes).toBeGreaterThan(262_144);
    expect(bytes).toBeLessThan(1_048_576);
    let fetches = 0;
    globalThis.fetch = (async (input, init) => {
      fetches += 1;
      expect(String(input)).toBe("https://inference-api.nousresearch.com/v1/models");
      expect(init?.method ?? "GET").toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token-nous-probe-fixture");
      return new Response(payload, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    await saveCredential("nous", {
      access: "access-token-nous-probe-fixture",
      refresh: "nous-probe-fixture-refresh",
      expires: Date.now() + 3_600_000,
    });
    const config = baseConfig({
      nous: { ...structuredClone(OAUTH_PROVIDERS.nous!.providerConfig) },
    });

    const { status, body } = await probe(config, "nous");

    expect(status).toBe(200);
    expect(fetches).toBe(1);
    expect(body).toMatchObject({ ok: true, models: 390 });
  });

  test("Google's models-array response counts only generateContent models", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3-pro", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent", "countTokens"] }, { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }, { name: "models/gemini-missing-methods" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const config = baseConfig({
      google: { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "g-key" },
    });
    const { body } = await probe(config, "google");
    expect(requestedUrl).toContain("/v1beta/models");
    expect(body.ok).toBe(true);
    expect(body.models).toBe(2);
  });

  test("Google AI Studio probe skips malformed or toxic rows while counting valid models", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      models: [
        null,
        "invalid-row",
        { name: "models/bad name", supportedGenerationMethods: ["generateContent"] },
        { name: "models/ padded ", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-valid", supportedGenerationMethods: ["generateContent"] },
      ],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const config = baseConfig({
      google: { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "g-key" },
    });
    const { body } = await probe(config, "google");
    expect(body.ok).toBe(true);
    expect(body.models).toBe(1);
  });

  test("non-ai-studio providers preserve generic models[] connection-test fallback", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ models: [{ id: "m-1" }, { id: "m-2" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const config = baseConfig({
      generic: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x" },
    });
    const { body } = await probe(config, "generic");
    expect(body.ok).toBe(true);
    expect(body.models).toBe(2);
  });

  test("Together-style top-level /models array is accepted (#617)", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: "meta/llama" }, { id: "Qwen/Qwen" }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const config = baseConfig({
      together: { adapter: "openai-chat", baseUrl: "https://api.together.xyz/v1", apiKey: "tg-key" },
    });
    const { body } = await probe(config, "together");
    expect(body.ok).toBe(true);
    expect(body.models).toBe(2);
  });

  test("malformed 2xx data is an explicit failure, not a silent pass", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const config = baseConfig({
      weird: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x" },
    });
    const { body } = await probe(config, "weird");
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("unexpected shape");
  });

  test("a malformed model row fails the probe like authoritative discovery", async () => {
    globalThis.fetch = (async () => Response.json({
      data: [{ id: "valid" }, { id: " padded" }],
    })) as typeof fetch;
    const config = baseConfig({
      weird: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x" },
    });
    const { body } = await probe(config, "weird");
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("unexpected shape");
  });

  test("unknown provider is a 404", async () => {
    const config = baseConfig({
      real: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", apiKey: "sk-x" },
    });
    const { status } = await probe(config, "ghost");
    expect(status).toBe(404);
  });
});

describe("POST /api/oauth/login/cancel (WP040)", () => {
  test("rejects unknown providers and accepts public oauth providers", async () => {
    const config = baseConfig({
      xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth" },
    });
    const cancel = async (provider: string) => {
      const req = new Request("http://127.0.0.1/api/oauth/login/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const res = await handleManagementAPI(req, new URL(req.url), config, {});
      if (!res) throw new Error("handler returned no response");
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    const bad = await cancel("not-a-provider");
    expect(bad.status).toBe(400);

    // chatgpt is oauth-internal but NOT publicly startable — the hardened public
    // predicate must reject it (an isOAuthProvider downgrade mutant fails here).
    const internal = await cancel("chatgpt");
    expect(internal.status).toBe(400);

    // xai is a public oauth provider; no flow is in progress so cancelled is false.
    const ok = await cancel("xai");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, cancelled: false });
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";
