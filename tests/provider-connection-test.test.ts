import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setFetchCursorUsableModelsForTests } from "../src/adapters/cursor/live-models";
import { handleManagementAPI } from "../src/server/management-api";
import { saveConfig } from "../src/config";
import { OAUTH_PROVIDERS } from "../src/oauth";
import { saveCredential } from "../src/oauth/store";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";
import { withRegistryDiscovery } from "./helpers/provider-registry-discovery";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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

  test("Google's models-array response shape is accepted (x-goog-api-key path)", async () => {
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ models: [{ name: "models/gemini-3-pro" }, { name: "models/gemini-3-flash" }, { name: "models/gemini-3-lite" }] }), {
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
    expect(body.models).toBe(3);
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
import { ManagementRequest as Request } from "./helpers/management-auth";
