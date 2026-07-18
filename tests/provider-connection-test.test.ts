import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleManagementAPI } from "../src/server/management-api";
import { saveConfig } from "../src/config";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(tmpdir(), "ocx-conn-test");
const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function baseConfig(providers: OcxConfig["providers"]): OcxConfig {
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
  test("unreachable upstream reports ok:false with the failure reason", async () => {
    const config = baseConfig({
      dead: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x", allowPrivateNetwork: true },
    });
    const { status, body } = await probe(config, "dead");
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  test("static catalog cannot masquerade as a live connection", async () => {
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
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("static catalog only");
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
