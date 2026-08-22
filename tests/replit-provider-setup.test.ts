import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import {
  ConfigMutationLockError,
  getConfigPath,
  loadConfig,
  mutatePersistedConfig,
  saveConfig,
} from "../src/config";
import { apiKeyPoolEntryId } from "../src/providers/api-keys";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import {
  MAX_REPLIT_GATEWAY_KEY_LENGTH,
  REPLIT_ANTHROPIC_PROVIDER_ID,
  REPLIT_OPENAI_PROVIDER_ID,
} from "../src/providers/replit/constants";
import { deriveReplitProviderPair, setReplitRegistrySeedTestHooks } from "../src/providers/replit/derive";
import {
  canonicalizeReplitOrigin,
  validateReplitOrigin,
} from "../src/providers/replit/origin";
import { probeReplitGateway } from "../src/providers/replit/probe";
import {
  isReplitCredentialHeader,
  preserveReplitCustomHeaders,
} from "../src/providers/replit/headers";
import {
  detectReplitPairCollisions,
  installReplitProviderPair,
  preserveReplitProviderOverlays,
  validateReplitGatewayKey,
} from "../src/providers/replit/setup";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";

const ORIGIN = "https://my-app.replit.app";
const GATEWAY_KEY = "gateway-key-01234567890123456789012";
const OTHER_KEY = "other-gateway-key-0123456789012345678901";
const originalFetch = globalThis.fetch;
let stubFetch: typeof globalThis.fetch = originalFetch;

function baseConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-test",
      },
    },
    ...overrides,
  };
}

function richExistingReplitProviders(origin = ORIGIN): OcxConfig["providers"] {
  return {
    [REPLIT_OPENAI_PROVIDER_ID]: {
      adapter: "openai-chat",
      baseUrl: `${origin}/v1`,
      apiKey: "old-key",
      contextWindow: 128_000,
      defaultModel: "gpt-4o",
      models: ["gpt-4o"],
      selectedModels: ["gpt-4o"],
      headers: { "X-Custom": "overlay" },
      modelCosts: { "gpt-4o": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      modelInputModalities: { "gpt-4o": ["text"] },
      noStructuredOutputModels: ["gpt-4o-mini"],
      apiKeyPool: [{ id: "abcd1234", key: "old-key", label: "primary" }],
    },
    [REPLIT_ANTHROPIC_PROVIDER_ID]: {
      adapter: "anthropic",
      baseUrl: origin,
      apiKey: "old-key",
      apiKeyTransport: "bearer",
      requestPacing: { enabled: true, minIntervalMs: 250 },
      note: "operator note",
    },
  };
}

function stubGatewayFetch(origin = ORIGIN): typeof fetch {
  stubFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.origin !== new URL(origin).origin) return originalFetch(input, init);
    if (url.pathname === "/healthz") {
      return Promise.resolve(new Response("ok", { status: 200 }));
    }
    if (url.pathname === "/v1/models") {
      const auth = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${GATEWAY_KEY}` && auth !== `Bearer ${OTHER_KEY}`) {
        return Promise.resolve(new Response("unauthorized", { status: 401 }));
      }
      return Promise.resolve(Response.json({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }],
      }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  globalThis.fetch = stubFetch;
  return stubFetch;
}

async function installWithDisk(
  liveConfig: OcxConfig,
  input: Parameters<typeof installReplitProviderPair>[1],
  extraDeps: Parameters<typeof installReplitProviderPair>[2] = {},
) {
  return installReplitProviderPair(liveConfig, input, {
    probeFetch: stubFetch,
    ...extraDeps,
  });
}

async function replitPairApi(
  config: OcxConfig,
  body: Record<string, unknown>,
  deps: Parameters<typeof handleManagementAPI>[3] = {},
): Promise<Response | null> {
  const req = new Request("http://127.0.0.1/api/providers/replit-pair", {
    method: "POST",
    headers: { "content-type": "application/json", Host: "127.0.0.1" },
    body: JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    createManagementConvergeCodex: catalogConvergenceFactory(),
    ...deps,
  });
}

function withTempHome(run: (dir: string) => Promise<void> | void): Promise<void> {
  const previousHome = process.env.OPENCODEX_HOME;
  const dir = mkdtempSync(join(tmpdir(), "ocx-replit-pair-"));
  process.env.OPENCODEX_HOME = dir;
  return Promise.resolve(run(dir)).finally(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
}

beforeEach(() => {
  stubGatewayFetch();
  setReplitRegistrySeedTestHooks(null);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  stubFetch = originalFetch;
  setReplitRegistrySeedTestHooks(null);
});

describe("replit origin validation", () => {
  test("canonicalizes https .replit.app origins and strips default :443", () => {
    expect(canonicalizeReplitOrigin("https://my-app.replit.app/")).toBe(ORIGIN);
    expect(canonicalizeReplitOrigin("https://my-app.replit.app:443")).toBe(ORIGIN);
    expect(validateReplitOrigin("https://my-app.replit.app")).toEqual({ ok: true, origin: ORIGIN });
  });

  test("rejects non-https, credentialed, and pathful origins", () => {
    expect(validateReplitOrigin("http://my-app.replit.app").ok).toBe(false);
    expect(validateReplitOrigin("https://user:pass@my-app.replit.app").ok).toBe(false);
    expect(validateReplitOrigin("https://my-app.replit.app/gateway").ok).toBe(false);
  });

  test("requires .replit.app unless allowCustomDomain is set", () => {
    expect(validateReplitOrigin("https://gateway.example.com").ok).toBe(false);
    expect(validateReplitOrigin("https://gateway.example.com", { allowCustomDomain: true })).toEqual({
      ok: true,
      origin: "https://gateway.example.com",
    });
  });
});

describe("replit gateway key validation", () => {
  test("rejects keys below minimum, above maximum, or with invalid characters", () => {
    expect(validateReplitGatewayKey("short").ok).toBe(false);
    expect(validateReplitGatewayKey("a".repeat(MAX_REPLIT_GATEWAY_KEY_LENGTH + 1)).ok).toBe(false);
    expect(validateReplitGatewayKey("key with spaces 012345678901234567890123456").ok).toBe(false);
    expect(validateReplitGatewayKey(GATEWAY_KEY)).toEqual({ ok: true, key: GATEWAY_KEY });
  });
});

describe("replit provider pair derivation", () => {
  test("derives openai-chat and anthropic bearer transports from validated origin", () => {
    const origin = canonicalizeReplitOrigin(ORIGIN);
    const pair = deriveReplitProviderPair(origin);
    expect(pair.openai.provider).toMatchObject({
      adapter: "openai-chat",
      baseUrl: `${ORIGIN}/v1`,
      authMode: "key",
      liveModels: true,
    });
    expect(pair.openai.provider.apiKeyTransport).toBeUndefined();
    expect(pair.anthropic.provider).toMatchObject({
      adapter: "anthropic",
      baseUrl: ORIGIN,
      authMode: "key",
      apiKeyTransport: "bearer",
      liveModels: false,
    });
  });

  test("seeds from synthetic promoted registry metadata when present", () => {
    setReplitRegistrySeedTestHooks({
      openai: {
        id: REPLIT_OPENAI_PROVIDER_ID,
        label: "Replit",
        adapter: "openai-chat",
        baseUrl: "https://placeholder.replit.app/v1",
        authKind: "key",
        apiKeyTransport: "bearer",
        liveModels: true,
        defaultModel: "gpt-promoted",
        models: ["gpt-promoted"],
        contextWindow: 200_000,
      },
      anthropic: {
        id: REPLIT_ANTHROPIC_PROVIDER_ID,
        label: "Replit Anthropic",
        adapter: "anthropic",
        baseUrl: "https://placeholder.replit.app",
        authKind: "key",
        apiKeyTransport: "bearer",
        liveModels: false,
        defaultModel: "claude-promoted",
      },
    });
    const pair = deriveReplitProviderPair(canonicalizeReplitOrigin(ORIGIN));
    expect(pair.openai.provider.defaultModel).toBe("gpt-promoted");
    expect(pair.openai.provider.baseUrl).toBe(`${ORIGIN}/v1`);
    expect(pair.anthropic.provider.defaultModel).toBe("claude-promoted");
    expect(pair.anthropic.provider.baseUrl).toBe(ORIGIN);
  });

  test("does not promote replit ids into the canonical registry", () => {
    expect(PROVIDER_REGISTRY.some(entry => entry.id === REPLIT_OPENAI_PROVIDER_ID)).toBe(false);
    expect(PROVIDER_REGISTRY.some(entry => entry.id === REPLIT_ANTHROPIC_PROVIDER_ID)).toBe(false);
  });
});

describe("replit provider pair preservation and collisions", () => {
  test("detects collisions without exposing existing provider secrets", () => {
    const collisions = detectReplitPairCollisions(baseConfig({
      providers: {
        ...baseConfig().providers,
        ...richExistingReplitProviders(),
      },
    }));
    expect(collisions).toEqual([
      { providerId: REPLIT_OPENAI_PROVIDER_ID },
      { providerId: REPLIT_ANTHROPIC_PROVIDER_ID },
    ]);
    expect(JSON.stringify(collisions)).not.toContain("old-key");
  });

  test("preserves operator overlays and resets the active gateway key pool on replacement", () => {
    const existing = richExistingReplitProviders();
    const derived = deriveReplitProviderPair(canonicalizeReplitOrigin(ORIGIN));
    const preservedOpenAi = preserveReplitProviderOverlays(
      existing[REPLIT_OPENAI_PROVIDER_ID],
      { ...derived.openai.provider, apiKey: GATEWAY_KEY },
      GATEWAY_KEY,
    );
    expect(preservedOpenAi.contextWindow).toBe(128_000);
    expect(preservedOpenAi.defaultModel).toBe("gpt-4o");
    expect(preservedOpenAi.selectedModels).toEqual(["gpt-4o"]);
    expect(preservedOpenAi.headers).toEqual({ "X-Custom": "overlay" });
    expect(preservedOpenAi.modelCosts).toEqual({ "gpt-4o": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    expect(preservedOpenAi.noStructuredOutputModels).toEqual(["gpt-4o-mini"]);
    expect(preservedOpenAi.apiKey).toBe(GATEWAY_KEY);
    expect(preservedOpenAi.apiKeyPool).toEqual([{ id: apiKeyPoolEntryId(GATEWAY_KEY), key: GATEWAY_KEY }]);
    expect(preservedOpenAi.baseUrl).toBe(`${ORIGIN}/v1`);
  });

  test("strips credential-bearing headers but preserves custom overlays on replacement", () => {
    const existing = richExistingReplitProviders();
    existing[REPLIT_OPENAI_PROVIDER_ID]!.headers = {
      Authorization: "Bearer stale-openai",
      "x-api-key": "stale-openai-key",
      "X-Custom": "overlay",
      "Proxy-Authorization": "Basic stale",
    };
    existing[REPLIT_ANTHROPIC_PROVIDER_ID]!.headers = {
      authorization: "Bearer stale-anthropic",
      "X-API-KEY": "stale-anthropic-key",
      "X-Operator": "keep-me",
    };
    const derived = deriveReplitProviderPair(canonicalizeReplitOrigin(ORIGIN));
    const preservedOpenAi = preserveReplitProviderOverlays(
      existing[REPLIT_OPENAI_PROVIDER_ID],
      { ...derived.openai.provider, apiKey: GATEWAY_KEY },
      GATEWAY_KEY,
    );
    const preservedAnthropic = preserveReplitProviderOverlays(
      existing[REPLIT_ANTHROPIC_PROVIDER_ID],
      { ...derived.anthropic.provider, apiKey: GATEWAY_KEY, apiKeyTransport: "bearer" },
      GATEWAY_KEY,
    );
    expect(preservedOpenAi.headers).toEqual({ "X-Custom": "overlay" });
    expect(preservedAnthropic.headers).toEqual({ "X-Operator": "keep-me" });
    expect(isReplitCredentialHeader("Authorization")).toBe(true);
    expect(isReplitCredentialHeader("x-api-key")).toBe(true);
    expect(preserveReplitCustomHeaders({
      Authorization: "Bearer stale",
      "X-Custom": "overlay",
    })).toEqual({ "X-Custom": "overlay" });
  });

  test("adapter serialization emits only the new gateway credential after replacement", async () => {
    const parsed = {
      modelId: "gpt-4o",
      context: { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] },
      stream: false,
      options: {},
    };
    const derived = deriveReplitProviderPair(canonicalizeReplitOrigin(ORIGIN));
    const openaiProvider = preserveReplitProviderOverlays(
      {
        ...derived.openai.provider,
        headers: {
          Authorization: "Bearer stale-openai",
          "x-api-key": "stale-openai-key",
          "X-Custom": "overlay",
        },
      },
      { ...derived.openai.provider, apiKey: GATEWAY_KEY },
      GATEWAY_KEY,
    );
    const anthropicProvider = preserveReplitProviderOverlays(
      {
        ...derived.anthropic.provider,
        apiKeyTransport: "bearer",
        headers: {
          authorization: "Bearer stale-anthropic",
          "X-API-KEY": "stale-anthropic-key",
          "X-Operator": "keep-me",
        },
      },
      { ...derived.anthropic.provider, apiKey: GATEWAY_KEY, apiKeyTransport: "bearer" },
      GATEWAY_KEY,
    );

    const openaiRequest = createOpenAIChatAdapter(openaiProvider).buildRequest(parsed);
    expect(openaiRequest.headers.Authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(openaiRequest.headers["x-api-key"]).toBeUndefined();
    expect(openaiRequest.headers["X-Custom"]).toBe("overlay");

    const anthropicRequest = await createAnthropicAdapter(anthropicProvider).buildRequest(parsed);
    expect(anthropicRequest.headers.Authorization).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(anthropicRequest.headers["x-api-key"]).toBeUndefined();
    expect(anthropicRequest.headers["X-Operator"]).toBe("keep-me");
  });
});

describe("replit gateway probes", () => {
  test("probes only non-billable /healthz and /v1/models with injected fetch", async () => {
    const seen: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      seen.push(`${url.pathname}`);
      if (url.pathname === "/healthz") return Promise.resolve(new Response("ok", { status: 200 }));
      if (url.pathname === "/v1/models") {
        return Promise.resolve(Response.json({ data: [{ id: "gpt-4o" }] }));
      }
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as typeof fetch;

    const result = await probeReplitGateway(canonicalizeReplitOrigin(ORIGIN), GATEWAY_KEY, { fetch: fetchImpl });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["/healthz", "/v1/models"]);
  });

  test("rejects redirects without forwarding the gateway key", async () => {
    const seenAuth: string[] = [];
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const url = new URL(requestUrl);
      const auth = init?.headers instanceof Headers
        ? init.headers.get("authorization")
        : new Headers(init?.headers).get("authorization");
      if (auth) seenAuth.push(auth);
      if (url.pathname === "/healthz") {
        return Promise.resolve(Response.redirect("https://evil.example/steal", 302));
      }
      return Promise.resolve(new Response("nope", { status: 404 }));
    }) as typeof fetch;

    const result = await probeReplitGateway(canonicalizeReplitOrigin(ORIGIN), GATEWAY_KEY, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("redirect_rejected");
      expect(seenAuth).toEqual([]);
    }
  });

  test("cancels health response bodies that are not consumed", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (() => Promise.resolve(new Response(body, { status: 500 }))) as typeof fetch;
    const result = await probeReplitGateway(canonicalizeReplitOrigin(ORIGIN), GATEWAY_KEY, { fetch: fetchImpl });
    expect(result.ok).toBe(false);
    expect(cancelled).toBe(true);
  });
});

describe("atomic replit provider installation", () => {
  test("installs both providers after successful probes", async () => {
    await withTempHome(async () => {
      saveConfig(baseConfig());
      const liveConfig = loadConfig();
      const result = await installWithDisk(liveConfig, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
      });
      expect(result.ok).toBe(true);
      expect(liveConfig.providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKey).toBe(GATEWAY_KEY);
      expect(liveConfig.providers[REPLIT_ANTHROPIC_PROVIDER_ID]?.apiKey).toBe(GATEWAY_KEY);
    });
  });

  test("refuses silent replacement when reserved ids already exist on disk", async () => {
    await withTempHome(async () => {
      saveConfig(baseConfig({ providers: { ...baseConfig().providers, ...richExistingReplitProviders() } }));
      const staleLive = structuredClone(loadConfig());
      const result = await installWithDisk(staleLive, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("provider_collision");
      expect(loadConfig().providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKey).toBe("old-key");
    });
  });

  test("stale live snapshot cannot overwrite an on-disk pair without replace", async () => {
    await withTempHome(async () => {
      saveConfig(baseConfig());
      const writerA = loadConfig();
      await installWithDisk(writerA, { origin: ORIGIN, gatewayKey: GATEWAY_KEY });
      const staleB = structuredClone(baseConfig());
      const result = await installWithDisk(staleB, { origin: ORIGIN, gatewayKey: OTHER_KEY });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("provider_collision");
      expect(loadConfig().providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKey).toBe(GATEWAY_KEY);
    });
  });

  test("replaces existing pair when replace is explicit and preserves overlays", async () => {
    await withTempHome(async () => {
      saveConfig(baseConfig({ providers: { ...baseConfig().providers, ...richExistingReplitProviders() } }));
      const liveConfig = loadConfig();
      const result = await installWithDisk(liveConfig, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
        replace: true,
      });
      expect(result.ok).toBe(true);
      expect(liveConfig.providers[REPLIT_OPENAI_PROVIDER_ID]?.contextWindow).toBe(128_000);
      expect(liveConfig.providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKey).toBe(GATEWAY_KEY);
      expect(liveConfig.providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKeyPool).toEqual([
        { id: apiKeyPoolEntryId(GATEWAY_KEY), key: GATEWAY_KEY },
      ]);
    });
  });

  test("maps config lock contention to config_busy", async () => {
    await withTempHome(async () => {
      saveConfig(baseConfig());
      const liveConfig = loadConfig();
      const result = await installWithDisk(liveConfig, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
      }, {
        mutatePersistedConfig: () => {
          throw new ConfigMutationLockError("busy");
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("config_busy");
        expect(result.error).toBe("Configuration is busy; retry shortly");
      }
    });
  });

  test("refuses setDefault when replaced openai provider is disabled without persisting", async () => {
    await withTempHome(async () => {
      const existing = richExistingReplitProviders();
      existing[REPLIT_OPENAI_PROVIDER_ID]!.disabled = true;
      saveConfig(baseConfig({ providers: { ...baseConfig().providers, ...existing } }));
      const before = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;

      const liveConfig = loadConfig();
      const result = await installWithDisk(liveConfig, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
        replace: true,
        setDefault: true,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("persist_failed");
        expect(result.error).toBe("failed to persist replit provider pair");
      }
      expect(JSON.parse(readFileSync(getConfigPath(), "utf8"))).toEqual(before);
      expect(liveConfig.defaultProvider).toBe("openai");
      expect(liveConfig.providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKey).toBe("old-key");
    });
  });
});

describe("replit provider management route", () => {
  test("POST /api/providers/replit-pair installs atomically and persists", async () => {
    await withTempHome(async () => {
      saveConfig(baseConfig());
      const config = loadConfig();
      const response = await replitPairApi(config, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
      }, { probeFetch: stubFetch });
      expect(response?.status).toBe(200);
      const body = await response!.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      expect(persisted.providers[REPLIT_OPENAI_PROVIDER_ID]?.baseUrl).toBe(`${ORIGIN}/v1`);
    });
  });

  test("management route requires explicit replace on collision", async () => {
    const config = baseConfig({ providers: { ...baseConfig().providers, ...richExistingReplitProviders() } });
    const response = await replitPairApi(config, {
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
    }, {
      mutatePersistedConfig: mutate => {
        const tentative = structuredClone(config);
        const result = mutate(tentative);
        return result.changed
          ? { status: "committed", value: result.value }
          : { status: "unchanged", value: result.value };
      },
      probeFetch: stubFetch,
    });
    expect(response?.status).toBe(409);
  });

  test("management route uses injected mutatePersistedConfig without writing real home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-replit-route-seam-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = dir;
    try {
      const config = baseConfig();
      const response = await replitPairApi(config, {
        origin: ORIGIN,
        gatewayKey: GATEWAY_KEY,
      }, {
        mutatePersistedConfig: mutate => {
          const result = mutate(config);
          return result.changed
            ? { status: "committed", value: result.value }
            : { status: "unchanged", value: result.value };
        },
        probeFetch: stubFetch,
      });
      expect(response?.status).toBe(200);
      expect(existsSync(getConfigPath())).toBe(false);
      expect(config.providers[REPLIT_OPENAI_PROVIDER_ID]?.apiKey).toBe(GATEWAY_KEY);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("management route returns 503 with Retry-After on config_busy", async () => {
    const config = baseConfig();
    const response = await replitPairApi(config, {
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
    }, {
      mutatePersistedConfig: () => {
        throw new ConfigMutationLockError("busy");
      },
      probeFetch: stubFetch,
    });
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Retry-After")).toBe("1");
  });

  test("management route refuses setDefault when derived openai provider is disabled", async () => {
    const config = baseConfig({
      providers: { ...baseConfig().providers, ...richExistingReplitProviders() },
    });
    config.providers[REPLIT_OPENAI_PROVIDER_ID]!.disabled = true;
    const before = structuredClone(config);

    const response = await replitPairApi(config, {
      origin: ORIGIN,
      gatewayKey: GATEWAY_KEY,
      replace: true,
      setDefault: true,
    }, {
      mutatePersistedConfig: mutate => {
        const tentative = structuredClone(config);
        const result = mutate(tentative);
        return result.changed
          ? { status: "committed", value: result.value }
          : { status: "unchanged", value: result.value };
      },
      probeFetch: stubFetch,
    });

    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({
      code: "persist_failed",
      error: "failed to persist replit provider pair",
    });
    expect(config).toEqual(before);
  });
});
