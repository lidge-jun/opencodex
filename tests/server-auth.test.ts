import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { clearAccountNeedsReauth, clearAccountQuota, updateAccountQuota } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { saveConfig } from "../src/config";
import {
  assertServerAuthConfig,
  corsHeaders,
  disableResponsesRequestTimeout,
  hasValidApiAuth,
  isApiAuthRequired,
  isLoopbackHostname,
  resolveGuiFilePath,
  rootFallbackPayload,
  safeConfigDTO,
  startServer,
} from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const TEST_DIR = join(import.meta.dir, ".tmp-server-auth-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;

function config(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { "X-Custom": "provider-secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
});

afterEach(() => {
  if (previousApiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousApiToken;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountNeedsReauth("pool-a");
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

describe("server local API auth", () => {
  test("responses timeout helper disables Bun request timeout when available", () => {
    const req = new Request("http://localhost/v1/responses", { method: "POST" });
    const calls: Array<[Request, number]> = [];
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push([request, seconds]);
      },
    };

    expect(disableResponsesRequestTimeout(req, server)).toBe(true);
    expect(calls).toEqual([[req, 0]]);
  });

  test("responses timeout helper is safe when the runtime hook is unavailable", () => {
    const req = new Request("http://localhost/v1/responses", { method: "POST" });

    expect(disableResponsesRequestTimeout(req, undefined)).toBe(false);
    expect(disableResponsesRequestTimeout(req, {
      timeout() {
        throw new Error("unsupported");
      },
    })).toBe(false);
  });

  test("loopback hostnames do not require opencodex API auth", () => {
    expect(isLoopbackHostname(undefined)).toBe(true);
    expect(isLoopbackHostname("")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isApiAuthRequired(config())).toBe(false);
    expect(isApiAuthRequired(config("127.0.0.1"))).toBe(false);
  });

  test("non-loopback binding requires env token before startup", () => {
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    expect(isApiAuthRequired(config("0.0.0.0"))).toBe(true);
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).toThrow("OPENCODEX_API_AUTH_TOKEN");

    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(() => assertServerAuthConfig(config("0.0.0.0"))).not.toThrow();
  });

  test("auth header must match env token when non-loopback auth is required", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    const cfg = config("0.0.0.0");

    expect(hasValidApiAuth(new Request("http://localhost/api/config"), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "wrong" },
    }), cfg)).toBe(false);
    expect(hasValidApiAuth(new Request("http://localhost/api/config", {
      headers: { "x-opencodex-api-key": "local-secret" },
    }), cfg)).toBe(true);
  });

  test("loopback remains allowed even when env token exists", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    expect(hasValidApiAuth(new Request("http://localhost/api/config"), config("127.0.0.1"))).toBe(true);
  });

  test("CORS preflight permits the opencodex API key header", () => {
    expect(corsHeaders()["Access-Control-Allow-Headers"]).toContain("X-OpenCodex-API-Key");
  });

  test("safeConfigDTO redacts provider secrets and exposes booleans", () => {
    const dto = safeConfigDTO(config("127.0.0.1")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    expect(JSON.stringify(dto)).not.toContain("sk-secret-value");
    expect(JSON.stringify(dto)).not.toContain("provider-secret");
    expect(dto.providers.openai).toMatchObject({
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "gpt-test",
      hasApiKey: true,
      hasHeaders: true,
    });
    expect(dto.providers.openai).not.toHaveProperty("apiKey");
    expect(dto.providers.openai).not.toHaveProperty("headers");
    expect(dto.providers.openai.disabled).toBeUndefined();
  });

  test("safeConfigDTO strips URL-embedded provider secrets", () => {
    const dto = safeConfigDTO({
      ...config("127.0.0.1"),
      providers: {
        leaky: {
          adapter: "openai-chat",
          baseUrl: "https://user:pass@example.test/v1?token=secret#frag",
          apiKey: "sk-secret-value",
        },
      },
    } as OcxConfig) as { providers: Record<string, { baseUrl: string }> };

    expect(dto.providers.leaky.baseUrl).toBe("https://example.test/v1");
    expect(JSON.stringify(dto)).not.toContain("pass");
    expect(JSON.stringify(dto)).not.toContain("secret");
  });

  test("safeConfigDTO does not echo malformed provider URLs back to the GUI", () => {
    const dto = safeConfigDTO({
      ...config("127.0.0.1"),
      providers: {
        malformed: {
          adapter: "openai-chat",
          baseUrl: "not a url with pasted-token-sk-secret",
        },
        file: {
          adapter: "openai-chat",
          baseUrl: "file:///tmp/sk-secret",
        },
      },
    } as OcxConfig) as { providers: Record<string, { baseUrl: string }> };

    expect(dto.providers.malformed.baseUrl).toBe("(invalid URL)");
    expect(dto.providers.file.baseUrl).toBe("(invalid URL)");
    expect(JSON.stringify(dto)).not.toContain("pasted-token-sk-secret");
    expect(JSON.stringify(dto)).not.toContain("/tmp/sk-secret");
  });

  test("root fallback explains missing dashboard build", () => {
    expect(rootFallbackPayload()).toMatchObject({
      status: "ok",
      service: "opencodex",
      dashboard: { available: false },
      endpoints: {
        health: "/healthz",
        models: "/v1/models",
        responses: "/v1/responses",
        management: "/api/*",
      },
    });
  });

  test("GUI static file resolver stays inside gui/dist", () => {
    const root = join(TEST_DIR, "gui", "dist");

    expect(resolveGuiFilePath(root, "/")).toBe(join(root, "index.html"));
    expect(resolveGuiFilePath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolveGuiFilePath(root, "/../config.json")).toBeNull();
    expect(resolveGuiFilePath(root, "/%2e%2e/config.json")).toBeNull();
    expect(resolveGuiFilePath(root, "/..%2fconfig.json")).toBeNull();
    expect(resolveGuiFilePath(root, "/%00")).toBeNull();
  });

  test("/v1/models requires API auth and local Origin on non-loopback bindings", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    const modelsUrl = `http://127.0.0.1:${server.port}/v1/models`;
    try {
      const missingAuth = await fetch(modelsUrl);
      expect(missingAuth.status).toBe(401);

      const badOrigin = await fetch(modelsUrl, {
        headers: { "x-opencodex-api-key": "local-secret", origin: "https://attacker.test" },
      });
      expect(badOrigin.status).toBe(403);

      const ok = await fetch(modelsUrl, {
        headers: { "x-opencodex-api-key": "local-secret" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toHaveProperty("data");

      const sameOrigin = await fetch(modelsUrl, {
        headers: { "x-opencodex-api-key": "local-secret", origin: new URL(modelsUrl).origin },
      });
      expect(sameOrigin.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects externally supplied forward auth providers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "evil-forward",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://attacker.example/backend-api/codex",
            authMode: "forward",
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('authMode "forward"'),
      });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects namespace-breaking or reserved provider names", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      for (const name of ["openrouter/custom", "__proto__", "constructor"]) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            provider: {
              adapter: "openai-chat",
              baseUrl: "https://api.example.test/v1",
            },
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining("provider name"),
        });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects base URLs with embedded credentials", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "leaky",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://user:pass@example.test/v1?token=secret",
          },
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("baseUrl must not include embedded credentials"),
      });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects invalid or non-http base URLs", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      for (const baseUrl of ["not a url", "file:///tmp/provider"]) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `bad-${baseUrl.startsWith("file") ? "file" : "url"}`,
            provider: {
              adapter: "openai-chat",
              baseUrl,
            },
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining("baseUrl"),
        });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects sensitive or injectable provider headers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      for (const { name, headers, message } of [
        { name: "bad-auth", headers: { Authorization: "Bearer provider-secret" }, message: "sensitive header" },
        { name: "bad-cookie", headers: { Cookie: "session=secret" }, message: "sensitive header" },
        { name: "bad-injection", headers: { "X-Custom": "ok\r\nInjected: yes" }, message: "line breaks" },
      ]) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name,
            provider: {
              adapter: "openai-chat",
              baseUrl: "https://api.example.test/v1",
              headers,
            },
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining(message),
        });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("provider deletion does not treat inherited object keys as configured providers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers?name=constructor", server.url), {
        method: "DELETE",
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("provider deletion removes stale provider context caps", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
        },
        removable: {
          adapter: "openai-chat",
          baseUrl: "https://api.removable.test/v1",
          apiKey: "sk-removable",
        },
      },
      providerContextCaps: { removable: 350_000 },
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers?name=removable", server.url), {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      const caps = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await caps.json()).toMatchObject({ caps: {} });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management can disable and re-enable non-default providers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
          liveModels: false,
          models: ["extra-model"],
        },
      },
    });

    const server = startServer(0);
    try {
      const disable = await fetch(new URL("/api/providers?name=extra", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      });
      expect(disable.status).toBe(200);
      expect(await disable.json()).toMatchObject({ success: true, name: "extra", disabled: true });

      const disabledConfig = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        providers: Record<string, { disabled?: boolean }>;
      };
      expect(disabledConfig.providers.extra.disabled).toBe(true);

      const enable = await fetch(new URL("/api/providers?name=extra", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      });
      expect(enable.status).toBe(200);
      expect(await enable.json()).toMatchObject({ success: true, name: "extra", disabled: false });

      const enabledConfig = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        providers: Record<string, { disabled?: boolean }>;
      };
      expect(enabledConfig.providers.extra.disabled).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects disabling the default provider", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers?name=openai", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("cannot disable the default provider"),
      });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management allows restoring the built-in ChatGPT forward provider preset", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "openai",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authMode: "forward",
          },
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, name: "openai" });
    } finally {
      await server.stop(true);
    }
  });

  test("provider context-cap API persists toggles and annotates model rows", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
          liveModels: false,
          models: ["wide-model", "small-model"],
          modelContextWindows: {
            "wide-model": 500_000,
            "small-model": 64_000,
          },
        },
      },
    });

    const server = startServer(0);
    try {
      const initial = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({ cap: 350_000, caps: {} });

      const enabled = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", enabled: true }),
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ ok: true, caps: { openai: 350_000 } });

      const models = await fetch(new URL("/api/models", server.url));
      expect(models.status).toBe(200);
      const body = await models.json() as Array<{ id: string; contextWindow?: number; contextCap?: number; contextCapped?: boolean }>;
      expect(body.find(m => m.id === "wide-model")).toMatchObject({
        contextWindow: 350_000,
        contextCap: 350_000,
        contextCapped: true,
      });
      expect(body.find(m => m.id === "small-model")).toMatchObject({
        contextWindow: 64_000,
        contextCap: 350_000,
        contextCapped: false,
      });

      const unknown = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "missing", enabled: true }),
      });
      expect(unknown.status).toBe(404);

      const disabled = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", enabled: false }),
      });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({ ok: true, caps: {} });
    } finally {
      await server.stop(true);
    }
  });

  test("provider context-cap API supports global value and set-all toggles", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
          liveModels: false,
          models: ["wide-model"],
          modelContextWindows: { "wide-model": 800_000 },
        },
        other: {
          adapter: "openai-chat",
          baseUrl: "https://api2.example.test/v1",
          apiKey: "sk-secret-value-2",
          liveModels: false,
          models: ["other-model"],
          modelContextWindows: { "other-model": 800_000 },
        },
      },
    });

    const server = startServer(0);
    try {
      const initial = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await initial.json()).toMatchObject({ cap: 350_000, value: 350_000, caps: {} });

      // Enable one provider, then change the global value: the enabled provider re-points.
      await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai", enabled: true }),
      });
      const valued = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 500_000 }),
      });
      expect(valued.status).toBe(200);
      expect(await valued.json()).toMatchObject({ ok: true, value: 500_000, caps: { openai: 500_000 } });

      // Enabling another provider now uses the current global value, not the constant.
      const enabledAfter = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "other", enabled: true }),
      });
      expect(await enabledAfter.json()).toMatchObject({ caps: { openai: 500_000, other: 500_000 } });

      // Catalog reflects the global value.
      const models = await fetch(new URL("/api/models", server.url));
      const body = await models.json() as Array<{ id: string; contextWindow?: number; contextCap?: number }>;
      expect(body.find(m => m.id === "wide-model")).toMatchObject({ contextWindow: 500_000, contextCap: 500_000 });

      // Set-all off clears every cap.
      const cleared = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setAll: false }),
      });
      expect(await cleared.json()).toMatchObject({ ok: true, value: 500_000, caps: {} });

      // Set-all on caps every provider at the current value.
      const all = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setAll: true }),
      });
      expect(await all.json()).toMatchObject({ ok: true, caps: { openai: 500_000, other: 500_000 } });

      // Invalid global value is rejected.
      const bad = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 0 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("management GET rejects non-local Origin even with a valid API key", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
    });

    const server = startServer(0);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: { "x-opencodex-api-key": "local-secret", origin: "https://attacker.test" },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "cross-origin request blocked" });

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: { "x-opencodex-api-key": "local-secret", origin: `http://127.0.0.1:${server.port}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("OPTIONS preflight rejects non-local Origin before CORS headers are trusted", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    const loopbackOrigin = `http://127.0.0.1:${server.port}`;
    try {
      const rejected = await fetch(new URL("/api/settings", server.url), {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.test",
          "access-control-request-method": "GET",
        },
      });
      expect(rejected.status).toBe(403);

      const accepted = await fetch(new URL("/api/settings", server.url), {
        method: "OPTIONS",
        headers: {
          origin: loopbackOrigin,
          "access-control-request-method": "GET",
        },
      });
      expect(accepted.status).toBe(204);
      expect(accepted.headers.get("access-control-allow-origin")).toBe(loopbackOrigin);
    } finally {
      await server.stop(true);
    }
  });

  test("loopback management API rejects host-header same-origin rebinding", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const attackerOrigin = `http://attacker.test:${server.port}`;
      const response = await fetch(`http://127.0.0.1:${server.port}/api/config`, {
        headers: {
          host: `attacker.test:${server.port}`,
          origin: attackerOrigin,
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "cross-origin request blocked" });
    } finally {
      await server.stop(true);
    }
  });

  test("management CORS echoes validated loopback Origin and covers delegated codex-auth responses", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      const settings = await fetch(new URL("/api/settings", server.url), {
        headers: { origin },
      });
      expect(settings.status).toBe(200);
      expect(settings.headers.get("access-control-allow-origin")).toBe(origin);
      expect(settings.headers.get("vary")).toContain("Origin");

      const active = await fetch(new URL("/api/codex-auth/active", server.url), {
        headers: { origin },
      });
      expect(active.status).toBe(200);
      expect(active.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await server.stop(true);
    }
  });

  test("non-loopback management API allows same-origin GUI requests with API token", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
    });

    const server = startServer(0);
    const origin = `http://lan.example.test:${server.port}`;
    try {
      const missing = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        headers: {
          host: `lan.example.test:${server.port}`,
          origin,
        },
      });
      expect(missing.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${server.port}/api/settings`, {
        headers: {
          host: `lan.example.test:${server.port}`,
          origin,
          "x-opencodex-api-key": "local-secret",
        },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
    } finally {
      await server.stop(true);
    }
  });

  test("websocket upgrade rejects hostile Origin even with a valid API token", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    process.env.OPENCODEX_API_AUTH_TOKEN = "local-secret";
    saveConfig({
      ...config("0.0.0.0"),
      port: 0,
      websockets: true,
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: {
          authorization: "Bearer inbound-main-token",
          connection: "Upgrade",
          upgrade: "websocket",
          origin: "https://attacker.test",
          "x-opencodex-api-key": "local-secret",
        },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "origin_rejected" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("websocket upgrade returns 426 when the WS transport is disabled", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({ ...config(), port: 0, websockets: false });

    const server = startServer(0);
    try {
      // codex-rs maps a connect-time 426 to a clean session-scoped HTTP fallback
      // (WebsocketStreamOutcome::FallbackToHttp) — this must NOT accept the socket.
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
        },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toMatchObject({
        error: { type: "upgrade_required" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("after a 426'd upgrade the same client can immediately fall back to HTTP POST", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "chatcmpl-fb", object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "http fallback ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        });
      },
    });
    saveConfig({
      port: 0, websockets: false, defaultProvider: "routed-fb",
      providers: {
        "routed-fb": { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "key-fb-000111222333" },
      },
    } as never);

    const server = startServer(0);
    try {
      // codex-rs FallbackToHttp: the 426 must leave the connection/session fully usable for HTTP.
      const upgrade = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      expect(upgrade.status).toBe(426);
      const post = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "routed-fb/some-model", input: "hello", stream: false }),
      });
      expect(post.status).toBe(200);
      const json = await post.json() as { output?: { type: string; content?: { text?: string }[] }[] };
      expect(json.output?.find(o => o.type === "message")?.content?.[0]?.text).toBe("http fallback ok");
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });

  test("compact v1 on a routed model propagates a summarizer failure instead of fabricating history", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ error: { message: "summarizer exploded" } }), {
          status: 500, headers: { "content-type": "application/json" },
        });
      },
    });
    saveConfig({
      port: 0, defaultProvider: "routed-cmp",
      providers: {
        "routed-cmp": { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${upstream.port}/v1`, apiKey: "key-cmp-000111222333" },
      },
    } as never);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "routed-cmp/some-model",
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "long history" }] }],
        }),
      });
      expect(response.ok).toBe(false);
      const body = await response.json() as { error?: { message?: string } };
      expect(body.error?.message ?? "").toContain("500");
    } finally {
      await server.stop(true);
      upstream.stop(true);
    }
  });

  test("unknown /v1/* paths return JSON 404, never GUI index.html", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;
    saveConfig({ ...config(), port: 0 });

    const server = startServer(0);
    try {
      // Unsupported codex-rs endpoint clients (memories/*, realtime/*) must get a clean 404
      // instead of a 200 HTML page that fails serde with a confusing decode error.
      // (/v1/images/* and /v1/alpha/search are real relay routes covered by dedicated tests.)
      for (const path of ["/v1/realtime/sessions", "/v1/memories/trace_summarize"]) {
        const response = await fetch(new URL(path, server.url), { method: "POST" });
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("application/json");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("POST /v1/responses/compact on a routed model returns v1 replacement history", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    delete process.env.OPENCODEX_API_AUTH_TOKEN;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        // Anthropic non-stream response carrying the summarizer's text.
        return Response.json({
          content: [{ type: "text", text: "compact summary body" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "anthropic-test",
      providers: {
        "anthropic-test": {
          adapter: "anthropic",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          apiKey: "provider-key",
          defaultModel: "claude-fable-5",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "anthropic-test/claude-fable-5",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "original ask" }] },
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "work done" }] },
          ],
          instructions: "base instructions",
        }),
      });
      expect(response.status).toBe(200);
      const json = await response.json() as { output: { type: string; role?: string; content?: { text: string }[] }[] };
      expect(Array.isArray(json.output)).toBe(true);
      // Retained real user message + summary user message; codex-rs installs this as history.
      expect(json.output[0]).toMatchObject({ type: "message", role: "user" });
      expect(json.output[0].content?.[0].text).toBe("original ask");
      const last = json.output[json.output.length - 1];
      expect(last.role).toBe("user");
      expect(last.content?.[0].text).toContain("compact summary body");
      // No ocx1 envelope may leak into v1 output.
      expect(JSON.stringify(json)).not.toContain("ocx1:");
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("expired thread affinity returns 409 before HTTP or WebSocket passthrough", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");
    clearAccountQuota();

    let upstreamRequests = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        upstreamRequests += 1;
        return Response.json({ id: "resp_test", object: "response", status: "completed", output: [] });
      },
    });
    const now = 1_800_000_000_000;
    saveConfig({
      port: 0,
      defaultProvider: "chatgpt",
      websockets: true,
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url}backend-api/codex`,
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const originalNow = Date.now;
    const server = startServer(0);
    try {
      Date.now = () => now;
      for (const threadId of ["expired-http", "expired-ws"]) {
        const response = await fetch(new URL("/v1/responses", server.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer inbound-main-token",
            "x-codex-parent-thread-id": threadId,
          },
          body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
        });
        expect(response.status).toBe(200);
      }
      expect(upstreamRequests).toBe(2);

      Date.now = () => now + CODEX_THREAD_AFFINITY_IDLE_TTL_MS + 1;
      const httpResponse = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
          "x-codex-parent-thread-id": "expired-http",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });
      expect(httpResponse.status).toBe(409);

      const wsResponse = await fetch(new URL("/v1/responses", server.url), {
        method: "GET",
        headers: {
          authorization: "Bearer inbound-main-token",
          connection: "Upgrade",
          upgrade: "websocket",
          "x-codex-parent-thread-id": "expired-ws",
        },
      });
      expect(wsResponse.status).toBe(409);
      expect(upstreamRequests).toBe(2);
    } finally {
      Date.now = originalNow;
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("websocket passthrough refreshes pool auth for each response.create turn", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const seenAuth: Array<string | null> = [];
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        seenAuth.push(req.headers.get("authorization"));
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","status":"completed","output":[]}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const now = 1_800_000_000_000;
    saveConfig({
      port: 0,
      defaultProvider: "chatgpt",
      websockets: true,
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url}backend-api/codex`,
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: now + 120_000,
      chatgptAccountId: "acct-pool-a",
    });

    const originalNow = Date.now;
    const originalFetch = globalThis.fetch;
    const server = startServer(0);
    const wsUrl = new URL("/v1/responses", server.url);
    wsUrl.protocol = "ws:";
    try {
      Date.now = () => now;
      globalThis.fetch = (async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(JSON.stringify({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const ws = new WebSocket(wsUrl);
      const waitForOpen = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const waitForTerminal = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket terminal timeout")), 1000);
        const onMessage = (event: MessageEvent) => {
          const text = typeof event.data === "string" ? event.data : "";
          if (text.includes('"type":"response.completed"')) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve();
          }
        };
        ws.addEventListener("message", onMessage);
      });

      await waitForOpen;
      ws.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "hello" }));
      await waitForTerminal();
      Date.now = () => now + 180_000;
      ws.send(JSON.stringify({ type: "response.create", model: "gpt-test", input: "again" }));
      await waitForTerminal();
      ws.close();

      expect(seenAuth).toEqual(["Bearer old-access-token", "Bearer new-access-token"]);
      const logs = await fetch(new URL("/api/logs?tail=2", server.url)).then(r => r.json()) as Array<{ status: number }>;
      expect(logs.map(entry => entry.status)).toEqual([200, 200]);
    } finally {
      Date.now = originalNow;
      globalThis.fetch = originalFetch;
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("websocket routed adapter records completed usage in request logs", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response([
          'event: message_start\n',
          'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
          'event: content_block_delta\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: message_delta\n',
          'data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
          'event: message_stop\n',
          'data: {"type":"message_stop"}\n\n',
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "anthropic-test",
      websockets: true,
      providers: {
        "anthropic-test": {
          adapter: "anthropic",
          baseUrl: upstream.url.toString().replace(/\/$/, ""),
          apiKey: "provider-key",
          defaultModel: "claude-fable-5",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    const wsUrl = new URL("/v1/responses", server.url);
    wsUrl.protocol = "ws:";
    try {
      const ws = new WebSocket(wsUrl);
      const waitForOpen = new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
      });
      const waitForTerminal = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket terminal timeout")), 1000);
        const onMessage = (event: MessageEvent) => {
          const text = typeof event.data === "string" ? event.data : "";
          if (text.includes('"type":"response.completed"')) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMessage);
            resolve();
          }
        };
        ws.addEventListener("message", onMessage);
      });

      await waitForOpen;
      ws.send(JSON.stringify({ type: "response.create", model: "anthropic-test/claude-fable-5", input: "hello" }));
      await waitForTerminal();
      ws.close();

      const logs = await fetch(new URL("/api/logs?tail=1", server.url)).then(r => r.json()) as Array<{
        status: number;
        terminalStatus?: string;
        closeReason?: string;
        usageStatus?: string;
        totalTokens?: number;
        usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number };
      }>;
      expect(logs.at(-1)).toMatchObject({
        status: 200,
        terminalStatus: "completed",
        closeReason: "terminal",
        usageStatus: "reported",
        // display total includes cache-write tokens (25 + 4 + 2) since cache_write_tokens support
        totalTokens: 31,
        usage: {
          inputTokens: 25,
          outputTokens: 4,
          cachedInputTokens: 5,
          cacheCreationInputTokens: 2,
        },
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("passthrough connect failure records selected pool account health", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    saveConfig({
      port: 0,
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: "http://127.0.0.1:9/backend-api/codex",
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
      connectTimeoutMs: 200,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    // Known low quota keeps "pool-a" the deterministic active (this case tests
    // failure-health recording, not the all-unknown rotation added in Phase 10).
    updateAccountQuota("pool-a", 10, 5);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: false }),
      });

      expect(response.status).toBe(502);
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        consecutiveFailures: 1,
        lastFailureStatus: 0,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("passthrough SSE terminal failure is recorded without clearing health on initial 200", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const cfg = {
      port: 0,
      defaultProvider: "chatgpt",
      providers: {
        chatgpt: {
          adapter: "openai-responses",
          baseUrl: `${upstream.url}backend-api/codex`,
          authMode: "forward",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
    } as OcxConfig;
    saveConfig(cfg);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });
    recordCodexUpstreamOutcome(cfg, "pool-a", 503);
    recordCodexUpstreamOutcome(cfg, "pool-a", 503);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      await response.text();
      expect(getCodexUpstreamHealth("pool-a")).toMatchObject({
        consecutiveFailures: 3,
        lastFailureStatus: 502,
      });
      const logs = await fetch(new URL("/api/logs?tail=1", server.url)).then(r => r.json()) as Array<{ status: number; errorCode?: string; terminalStatus?: string; closeReason?: string }>;
      expect(logs.at(-1)).toMatchObject({
        status: 502,
        errorCode: "upstream_server_error",
        terminalStatus: "failed",
        closeReason: "terminal",
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("native passthrough SSE records completed usage without pool terminal tracking", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            "event: response.completed",
            'data: {"type":"response.completed","response":{"status":"completed","model":"gpt-5.5","usage":{"input_tokens":11,"output_tokens":7,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-responses",
          baseUrl: upstream.url.toString(),
          apiKey: "provider-key",
          defaultModel: "gpt-5.5",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      await response.text();
      const logs = await fetch(new URL("/api/logs?tail=1", server.url)).then(r => r.json()) as Array<{
        status: number;
        terminalStatus?: string;
        closeReason?: string;
        usageStatus?: string;
        totalTokens?: number;
        usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningOutputTokens?: number };
      }>;
      expect(logs.at(-1)).toMatchObject({
        status: 200,
        terminalStatus: "completed",
        closeReason: "terminal",
        usageStatus: "reported",
        totalTokens: 18,
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          cachedInputTokens: 3,
          reasoningOutputTokens: 2,
        },
      });

      const usage = await fetch(new URL("/api/usage?range=all", server.url)).then(r => r.json()) as {
        summary: { requests: number; reportedRequests: number; totalTokens: number };
        models: Array<{ provider: string; model: string; reportedRequests: number; totalTokens: number }>;
      };
      expect(usage.summary).toMatchObject({ requests: 1, reportedRequests: 1, totalTokens: 18 });
      expect(usage.models.at(-1)).toMatchObject({
        provider: "test-openai",
        model: "gpt-5.5",
        reportedRequests: 1,
        totalTokens: 18,
      });
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });

  test("passthrough SSE client cancel aborts the upstream request", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;

    let releaseAbort!: () => void;
    const upstreamAborted = new Promise<void>(resolve => { releaseAbort = resolve; });
    const originalFetch = globalThis.fetch;
    const enc = new TextEncoder();
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://upstream.example/backend-api/codex/v1/responses") {
        init?.signal?.addEventListener("abort", releaseAbort, { once: true });
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(enc.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
                return;
              }
              return new Promise<void>(() => {});
            },
            cancel() {
              releaseAbort();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-responses",
          baseUrl: "https://upstream.example/backend-api/codex",
          apiKey: "provider-key",
          defaultModel: "gpt-test",
        },
      },
    } as OcxConfig);

    const server = startServer(0);
    try {
      const clientAbort = new AbortController();
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
        signal: clientAbort.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      clientAbort.abort("client gone");
      await reader.cancel("client gone").catch(() => {});

      await Promise.race([
        upstreamAborted,
        new Promise((_, reject) => setTimeout(() => reject(new Error("upstream was not aborted")), 500)),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await server.stop(true);
    }
  });

  test("non-forward generated stream does not mutate active pool health", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    clearCodexUpstreamHealth();
    clearThreadAccountMap();
    clearAccountNeedsReauth("pool-a");

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
            'data: {"error":{"message":"upstream failed","code":"server_error"}}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-chat",
          baseUrl: `${upstream.url}v1`,
          apiKey: "provider-key",
          defaultModel: "gpt-test",
        },
      },
      codexAccounts: [
        { id: "main", email: "main@example.test", isMain: true },
        { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "acct-pool-a" },
      ],
      activeCodexAccountId: "pool-a",
      upstreamFailoverThreshold: 3,
    } as OcxConfig);
    saveCodexAccountCredential("pool-a", {
      accessToken: "pool-access-token",
      refreshToken: "pool-refresh-token",
      expiresAt: Date.now() + 5 * 60_000,
      chatgptAccountId: "acct-pool-a",
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer inbound-main-token",
        },
        body: JSON.stringify({ model: "gpt-test", input: "hello", stream: true }),
      });

      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("response.failed");
      expect(getCodexUpstreamHealth("pool-a")).toBeNull();
    } finally {
      await server.stop(true);
      await upstream.stop(true);
    }
  });
});
