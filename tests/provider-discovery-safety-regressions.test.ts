import { afterEach, expect, test } from "bun:test";
import { createMimoFreeAdapter, MIMO_CHAT_URL } from "../src/adapters/mimo-free";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("mimo-free adapter fails closed for a custom destination", () => {
  const provider: OcxProviderConfig = {
    adapter: "mimo-free",
    baseUrl: "https://custom.example/free-chat",
    authMode: "key",
  };

  expect(() => createMimoFreeAdapter(provider)).toThrow(/canonical Xiaomi MiMo Free endpoint/i);
});

test("mimo-free adapter accepts the canonical destination with a trailing slash", () => {
  const provider: OcxProviderConfig = {
    adapter: "mimo-free",
    baseUrl: `${MIMO_CHAT_URL}/`,
    authMode: "key",
  };

  expect(() => createMimoFreeAdapter(provider)).not.toThrow();
});

test("canonical static provider ignores stale liveModels true without network access", async () => {
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response("unsupported", { status: 400 });
  }) as typeof fetch;

  const config: OcxConfig = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "cline-pass",
    providers: {
      "cline-pass": {
        adapter: "openai-chat",
        baseUrl: "https://api.cline.bot/api/v1",
        authMode: "key",
        apiKey: "test-key",
        liveModels: true,
        models: ["cline-pass/kimi-k3"],
      },
    },
  };
  const req = new Request("http://127.0.0.1/api/providers/test?name=cline-pass", { method: "POST" });
  const res = await handleManagementAPI(req, new URL(req.url), config, {});
  if (!res) throw new Error("handler returned no response");

  expect(await res.json()).toEqual({ applicable: false, reason: "static_catalog", latencyMs: 0 });
  expect(fetches).toBe(0);
});
