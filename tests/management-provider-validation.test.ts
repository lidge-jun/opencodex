import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { managementFetch as fetch, ManagementRequest as Request } from "./helpers/management-auth";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../src/codex/account-store";
import { getTrackedCodexWebSocketCountForAccount } from "../src/codex/websocket-registry";
import { clearAccountNeedsReauth, clearAccountQuota, getAccountQuota, isAccountNeedsReauth, markAccountNeedsReauth, updateAccountQuota } from "../src/codex/auth-api";
import {
  CODEX_THREAD_AFFINITY_IDLE_TTL_MS,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../src/codex/routing";
import { loadConfig, saveConfig } from "../src/config";
import { deriveProviderPresets } from "../src/providers/derive";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
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
import { handleManagementAPI } from "../src/server/management-api";
import { providerManagementConfigError } from "../src/server/auth-cors";
import { providerServiceTierConfigError, withProviderServiceTierDTO } from "../src/server/management/provider-capability-config";
import { clearModelCache, markProviderDiscoveryFailed } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import * as destinationPolicy from "../src/lib/destination-policy";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { LOCAL_PROVIDER_RELOAD_NAME_HEADER, LOCAL_PROVIDER_RELOAD_PATH } from "../src/lib/local-provider-reload-contract";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import { fastPolicyForModel } from "../src/providers/service-tier";
import { resolveWireProtocolOverride } from "../src/server/adapter-resolve";

// Full-suite Windows load: startServer + multi-step provider PATCH/GET flows exceed the
// default 5s per-test budget (same flake class as 810fa115 / claude-management-api).
setDefaultTimeout(60_000);

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
// A per-run directory, not a fixed path. The 665b65643 split copied server-auth.test.ts's
// ".tmp-server-auth-test" literal verbatim, so both files deleted and recreated the same
// directory while pointing OPENCODEX_HOME at it. See the comment in server-auth.test.ts for
// the full failure mode; mkdtempSync also covers two concurrent runs of this file alone.
const TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-management-provider-validation-"));
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

const canonicalDirect = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authMode: "forward",
  codexAccountMode: "direct",
} as const;

function poolProviders(): OcxConfig["providers"] {
  return {
    openai: { ...canonicalDirect, codexAccountMode: "pool" },
  };
}

function redirectCanonicalCodexTo(baseUrl: string): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    const prefix = "/backend-api/codex";
    if (url.hostname === "chatgpt.com" && url.pathname.startsWith(prefix)) {
      const target = new URL(`${url.pathname.slice(prefix.length)}${url.search}`, baseUrl);
      return originalGlobalFetch(target, init);
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

function stubModelDiscoveryFor(...origins: string[]): void {
  const allowed = new Set(origins);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (allowed.has(url.origin) && url.pathname.endsWith("/models")) {
      return Promise.resolve(Response.json({ data: [] }));
    }
    return originalGlobalFetch(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  isolatedCodexHome = installIsolatedCodexHome("ocx-server-auth-codex-");
});

afterEach(() => {
  globalThis.fetch = originalGlobalFetch;
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

describe("provider management validation", () => {
  test("provider reload adopts only the validated disk row without rewriting config", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "old-live-key",
        },
        stable: {
          adapter: "openai-chat",
          baseUrl: "https://stable.example.test/v1",
          apiKey: "stable-live-key",
        },
      },
    };
    saveConfig(liveConfig);
    const diskConfig = structuredClone(liveConfig);
    diskConfig.providers.xai = {
      ...diskConfig.providers.xai!,
      apiKey: "new-disk-key",
      headers: { "x-operator-header": "operator-owned" },
    };
    saveConfig(diskConfig);
    const diskBefore = readFileSync(join(TEST_DIR, "config.json"));
    const stableBefore = structuredClone(liveConfig.providers.stable);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockResolvedValue(null);
    try {
      const request = new Request(`http://127.0.0.1${LOCAL_PROVIDER_RELOAD_PATH}`, {
        method: "POST",
        headers: { [LOCAL_PROVIDER_RELOAD_NAME_HEADER]: "xai" },
      });
      const response = await handleManagementAPI(
        request,
        new URL(request.url),
        liveConfig,
        { createManagementConvergeCodex: catalogConvergenceFactory() },
        "local-provider-reload-capability",
      );
      expect(response?.status).toBe(200);
      expect(liveConfig.providers.xai).toEqual(diskConfig.providers.xai);
      expect(liveConfig.providers.stable).toEqual(stableBefore);
      expect(readFileSync(join(TEST_DIR, "config.json"))).toEqual(diskBefore);
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("provider reload rejects an untrusted principal and a disk rewrite during DNS validation", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "old-live-key",
        },
      },
    };
    saveConfig(liveConfig);
    const diskConfig = structuredClone(liveConfig);
    diskConfig.providers.xai = { ...diskConfig.providers.xai!, apiKey: "first-disk-key" };
    saveConfig(diskConfig);

    const untrusted = new Request(`http://127.0.0.1${LOCAL_PROVIDER_RELOAD_PATH}`, {
      method: "POST",
      headers: { [LOCAL_PROVIDER_RELOAD_NAME_HEADER]: "xai" },
    });
    expect((await handleManagementAPI(
      untrusted,
      new URL(untrusted.url),
      liveConfig,
      { createManagementConvergeCodex: catalogConvergenceFactory() },
      "admin-token",
    ))?.status).toBe(403);

    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockImplementation(async () => {
        const changed = loadConfig();
        changed.providers.xai = { ...changed.providers.xai!, apiKey: "second-disk-key" };
        saveConfig(changed);
        return null;
      });
    try {
      const request = new Request(`http://127.0.0.1${LOCAL_PROVIDER_RELOAD_PATH}`, {
        method: "POST",
        headers: { [LOCAL_PROVIDER_RELOAD_NAME_HEADER]: "xai" },
      });
      const response = await handleManagementAPI(
        request,
        new URL(request.url),
        liveConfig,
        { createManagementConvergeCodex: catalogConvergenceFactory() },
        "local-provider-reload-capability",
      );
      expect(response?.status).toBe(409);
      expect(liveConfig.providers.xai?.apiKey).toBe("old-live-key");
      expect(loadConfig().providers.xai?.apiKey).toBe("second-disk-key");
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("service-tier validation and public projection stay in the management boundary", () => {
    expect(providerServiceTierConfigError("relay", {
      adapter: "openai-chat",
      baseUrl: "https://relay.example/v1",
      modelSupportsServiceTier: { verified: true, blocked: false },
    })).toBeNull();
    expect(providerServiceTierConfigError("relay", {
      adapter: "openai-chat",
      baseUrl: "https://relay.example/v1",
      modelSupportsServiceTier: { verified: "yes" },
    })).toContain("modelSupportsServiceTier.verified must be a boolean");

    const config = {
      providers: {
        relay: {
          adapter: "openai-chat",
          baseUrl: "https://relay.example/v1",
          apiKey: "sk-never-project",
          modelSupportsServiceTier: { verified: true },
        },
      },
    } as unknown as OcxConfig;
    const dto = withProviderServiceTierDTO(
      { providers: { relay: { hasApiKey: true } } },
      config,
    ) as { providers: { relay: Record<string, unknown> } };
    expect(dto.providers.relay).toMatchObject({
      hasApiKey: true,
      modelSupportsServiceTier: { verified: true },
    });
    expect(JSON.stringify(dto)).not.toContain("sk-never-project");
  });

  test("validates and exposes structured-output model opt-outs", () => {
    const provider = {
      adapter: "openai-chat",
      baseUrl: "https://relay.example/v1",
      noStructuredOutputModels: ["deepseek-v4-flash"],
    };
    expect(providerManagementConfigError("relay", provider)).toBeNull();
    for (const noStructuredOutputModels of [
      "deepseek-v4-flash",
      [""],
      ["   "],
      [42],
    ]) {
      expect(providerManagementConfigError("relay", {
        ...provider,
        noStructuredOutputModels,
      })).toContain("noStructuredOutputModels");
    }

    const dto = safeConfigDTO({
      port: 10100,
      defaultProvider: "relay",
      providers: { relay: provider },
    } as OcxConfig) as { providers: Record<string, { noStructuredOutputModels?: string[] }> };
    expect(dto.providers.relay?.noStructuredOutputModels).toEqual(["deepseek-v4-flash"]);
  });

  test("normalizes hand-edited structured-output model opt-outs at load", () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify({
      ...config("127.0.0.1"),
      defaultProvider: "relay",
      providers: {
        relay: {
          adapter: "openai-chat",
          baseUrl: "https://relay.example/v1",
          noStructuredOutputModels: [" deepseek-v4-flash ", "deepseek-v4-flash", " other-model "],
        },
      },
    }));

    expect(loadConfig().providers.relay?.noStructuredOutputModels)
      .toEqual(["deepseek-v4-flash", "other-model"]);
  });

  test("provider management rejects modelCosts rows with extra fields", () => {
    const error = providerManagementConfigError("blsc", {
      adapter: "openai-chat",
      baseUrl: "https://llmapi.blsc.cn",
      modelCosts: {
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0, apiKey: "sk-leak" },
      },
    });
    expect(error).toContain("unexpected fields");
    expect(error).not.toContain("sk-leak");
    expect(providerManagementConfigError("blsc", {
      adapter: "openai-chat",
      baseUrl: "https://llmapi.blsc.cn",
      modelCosts: {
        "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
      },
    })).toBeNull();
  });

  test("provider management validates model hosted-tool preferences", () => {
    const provider = {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    };
    expect(providerManagementConfigError("custom", provider)).toBeNull();
    expect(providerManagementConfigError("custom", {
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      modelAdapters: { "provider-image-model": "openai-responses" },
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    })).toBeNull();
    expect(providerManagementConfigError("openai-apikey", {
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    })).toBeNull();
    expect(providerManagementConfigError("openai-apikey", {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      modelAdapters: { "gpt-5.6-sol": "openai-chat" },
      modelPreferHostedTools: { "gpt-5.6-sol-pro": ["image_generation"] },
    })).toContain("requires the openai-responses wire");

    for (const modelPreferHostedTools of [
      [],
      { "": ["image_generation"] },
      { model: [] },
      { model: "image_generation" },
      { model: ["web_search"] },
    ]) {
      expect(providerManagementConfigError("custom", {
        adapter: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        modelPreferHostedTools,
      })).toContain("modelPreferHostedTools");
    }

    expect(providerManagementConfigError("custom", {
      adapter: "openai-chat",
      baseUrl: "https://api.openai.com/v1",
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    })).toContain("requires the openai-responses wire");
    expect(providerManagementConfigError("openrouter", {
      adapter: "openai-responses",
      baseUrl: "https://openrouter.ai/api/v1",
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    })).toContain("requires the openai-responses wire");
    expect(providerManagementConfigError("custom", {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      modelAdapters: { "provider-image-model": "openai-chat" },
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    })).toContain("requires the openai-responses wire");
    expect(providerManagementConfigError("custom", {
      adapter: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      modelPreferHostedTools: { "gpt-5.3-codex-spark": ["image_generation"] },
    })).toContain("does not support");
    expect(providerManagementConfigError("custom-forward", {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      modelPreferHostedTools: { "provider-image-model": ["image_generation"] },
    })).toContain("not supported on forward-auth");
  });

  test("provider management permits snapshot repair only on canonical OpenAI forward seeds", () => {
    for (const mode of ["pool", "direct"] as const) {
      expect(providerManagementConfigError("openai", {
        ...canonicalDirect,
        codexAccountMode: mode,
        responsesSnapshotRepair: true,
      })).toBeNull();
    }

    expect(providerManagementConfigError("openai", {
      ...canonicalDirect,
      responsesSnapshotRepair: { enabled: true },
    })).toBe("provider openai responsesSnapshotRepair must be a boolean");

    expect(providerManagementConfigError("openai", {
      ...canonicalDirect,
      responsesSnapshotRepair: true,
      noVisionModels: ["gpt-5.6"],
    })).toContain("canonical built-in provider seed");
  });

  test("provider management validates retryOn429 bounds and unknown keys", () => {
    const base = { adapter: "openai-chat", baseUrl: "https://api.openai.com/v1" };
    expect(providerManagementConfigError("custom", {
      ...base,
      retryOn429: { enabled: true, attempts: 3, intervalMs: 1_000, maxIntervalMs: 5_000, respectRetryAfter: false },
    })).toBeNull();
    expect(providerManagementConfigError("custom", {
      ...base,
      retryOn429: { attempts: 0 },
    })).toContain("retryOn429.attempts is invalid");
    expect(providerManagementConfigError("custom", {
      ...base,
      retryOn429: { attempts: 21 },
    })).toContain("retryOn429.attempts is invalid");
    expect(providerManagementConfigError("custom", {
      ...base,
      retryOn429: { intervalMs: "fast" },
    })).toContain("retryOn429.intervalMs is invalid");
    expect(providerManagementConfigError("custom", {
      ...base,
      retryOn429: { attempt: 3 },
    })).toContain("retryOn429 has unrecognized field");
    expect(providerManagementConfigError("custom", {
      ...base,
      retryOn429: "enabled",
    })).toContain("retryOn429 is invalid");
    // A secret-shaped unknown field name must be redacted in the error, never echoed.
    const secretError = providerManagementConfigError("custom", {
      ...base,
      retryOn429: { "sk-super-secret-9876": true },
    })!;
    expect(secretError).toContain("retryOn429 has unrecognized field");
    expect(secretError).not.toContain("sk-super-secret-9876");
    expect(secretError).toContain("[REDACTED]");
    // A secret-shaped PROVIDER name must not be echoed by the retryOn429 error path either.
    const secretNameError = providerManagementConfigError("sk-super-secret-9876", {
      ...base,
      retryOn429: { attempts: 0 },
    })!;
    expect(secretNameError).toContain("retryOn429.attempts is invalid");
    expect(secretNameError).not.toContain("sk-super-secret-9876");
    expect(secretNameError).toContain("[REDACTED]");
  });

  test("provider request pacing PATCH persists provider and model limits without catalog churn", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "nvidia",
      providers: {
        nvidia: {
          adapter: "openai-chat",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "sk-nvidia",
        },
      },
    };
    saveConfig(liveConfig);
    let catalogRefreshes = 0;
    const request = async (path: string, init?: RequestInit) => {
      const req = new Request(`http://127.0.0.1${path}`, init);
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(() => { catalogRefreshes += 1; }),
      });
    };
    const policy = {
      enabled: true,
      requestsPerMinute: 38,
      minIntervalMs: 1_600,
      models: { "deepseek-ai/deepseek-v4-flash-0731": { requestsPerMinute: 10 } },
    };

    const saved = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: policy }),
    });
    expect(saved?.status).toBe(200);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);
    expect(loadConfig().providers.nvidia?.requestPacing).toEqual(policy);
    expect(catalogRefreshes).toBe(0);

    const providers = await request("/api/providers");
    expect((await providers?.json()).find((row: { name: string }) => row.name === "nvidia").requestPacing).toEqual(policy);
    const status = await request("/api/provider-request-pacing?name=nvidia");
    expect(await status?.json()).toMatchObject({ provider: "nvidia", enabled: true, queued: 0, nextSlotInMs: 0 });

    const invalid = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: { enabled: true, requestsPerMinute: -1 } }),
    });
    expect(invalid?.status).toBe(400);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);

    const timerOverflow = await request("/api/providers?name=nvidia", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestPacing: { enabled: true, requestsPerMinute: 0.001 } }),
    });
    expect(timerOverflow?.status).toBe(400);
    expect(liveConfig.providers.nvidia?.requestPacing).toEqual(policy);
  });

  test("provider discovery status is additive and omitted before an attempt", async () => {
    markProviderDiscoveryFailed("auth-broken", { reason: "http", httpStatus: 401 });
    try {
      const requestUrl = new URL("http://127.0.0.1/api/providers");
      const response = await handleManagementAPI(
        new Request(requestUrl),
        requestUrl,
        {
          port: 10100,
          defaultProvider: "auth-broken",
          providers: {
            "auth-broken": {
              adapter: "openai-chat",
              baseUrl: "https://api.example.test/v1",
              models: [],
            },
            "not-attempted": {
              adapter: "openai-chat",
              baseUrl: "https://static.example.test/v1",
              liveModels: false,
              models: [],
            },
          },
        },
      );
      const providers = await response!.json() as Array<Record<string, unknown>>;

      expect(providers).toContainEqual(expect.objectContaining({
        name: "auth-broken",
        discovery: { status: "failed", reason: "http", httpStatus: 401 },
      }));
      expect(providers.find(provider => provider.name === "not-attempted"))
        .not.toHaveProperty("discovery");
    } finally {
      clearModelCache();
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

  test("provider POST overwrite preserves modelCosts when the payload omits it", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const costs = { "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 } };
      const create = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-costs",
          provider: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", modelCosts: costs },
        }),
      });
      expect(create.status).toBe(200);

      // The dashboard's add/edit form does not send modelCosts; overwriting the
      // provider must not silently erase the hand-edited price overlay.
      const overwrite = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-costs",
          provider: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1" },
        }),
      });
      expect(overwrite.status).toBe(200);
      expect(loadConfig().providers["custom-costs"]?.modelCosts).toEqual(costs);
    } finally {
      await server.stop(true);
    }
  });

  // #1409: the add/edit form's payload type has no member for contextWindow or
  // modelContextWindows, so an overwrite arrives without them. Registry enrichment then fills
  // the absent fields from the seed and the stored row loses the user's values — for
  // opencode-go the seed is exactly {"kimi-k3": 262144}, which is what the reporter found in
  // place of their deepseek-v4-flash override.
  describe("provider POST overwrite preserves hand-edited context windows (#1409)", () => {
    async function seedProvider(url: URL, extra: Record<string, unknown>): Promise<Response> {
      return fetch(new URL("/api/providers", url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "opencode-go",
          provider: { adapter: "openai-chat", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "k", ...extra },
        }),
      });
    }

    function freshHome(): void {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
      process.env.OPENCODEX_HOME = TEST_DIR;
      saveConfig(config("127.0.0.1"));
    }

    test("an omitted modelContextWindows keeps the user's map, without registry seed keys", async () => {
      freshHome();
      const server = startServer(0);
      try {
        expect((await seedProvider(server.url, { modelContextWindows: { "deepseek-v4-flash": 900000 } })).status).toBe(200);
        expect((await seedProvider(server.url, {})).status).toBe(200);

        // The user's key survives, and the registry seed is NOT persisted into user config:
        // router.ts fills registry values beneath user entries at resolve time, so writing
        // them here would be a side effect of an unrelated save.
        expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toEqual({ "deepseek-v4-flash": 900000 });
      } finally {
        await server.stop(true);
      }
    });

    test("a submitted modelContextWindows updates that key and keeps the others", async () => {
      freshHome();
      const server = startServer(0);
      try {
        expect((await seedProvider(server.url, { modelContextWindows: { "deepseek-v4-flash": 900000 } })).status).toBe(200);
        expect((await seedProvider(server.url, { modelContextWindows: { "kimi-k3": 300000 } })).status).toBe(200);

        expect(loadConfig().providers["opencode-go"]?.modelContextWindows)
          .toEqual({ "deepseek-v4-flash": 900000, "kimi-k3": 300000 });
      } finally {
        await server.stop(true);
      }
    });

    test("an omitted contextWindow keeps the user's scalar", async () => {
      freshHome();
      const server = startServer(0);
      try {
        expect((await seedProvider(server.url, { contextWindow: 777000 })).status).toBe(200);
        expect((await seedProvider(server.url, {})).status).toBe(200);

        expect(loadConfig().providers["opencode-go"]?.contextWindow).toBe(777000);
      } finally {
        await server.stop(true);
      }
    });

    test("a submitted contextWindow still wins", async () => {
      freshHome();
      const server = startServer(0);
      try {
        expect((await seedProvider(server.url, { contextWindow: 777000 })).status).toBe(200);
        expect((await seedProvider(server.url, { contextWindow: 512000 })).status).toBe(200);

        expect(loadConfig().providers["opencode-go"]?.contextWindow).toBe(512000);
      } finally {
        await server.stop(true);
      }
    });

    test("a brand-new provider still receives the registry seed", async () => {
      freshHome();
      const server = startServer(0);
      try {
        expect((await seedProvider(server.url, {})).status).toBe(200);

        // No prior row exists, so enrichment is authoritative and the seed must land.
        expect(loadConfig().providers["opencode-go"]?.modelContextWindows).toBeDefined();
      } finally {
        await server.stop(true);
      }
    });

    test("PATCH can still delete a key with an explicit null", async () => {
      freshHome();
      const server = startServer(0);
      try {
        expect((await seedProvider(server.url, { modelContextWindows: { "deepseek-v4-flash": 900000 } })).status).toBe(200);

        const patch = await fetch(new URL("/api/providers?name=opencode-go", server.url), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ modelContextWindows: { "deepseek-v4-flash": null } }),
        });
        expect(patch.status).toBe(200);

        // Deletion is an explicit null through PATCH, which the POST carry-over must not undo.
        expect(loadConfig().providers["opencode-go"]?.modelContextWindows?.["deepseek-v4-flash"]).toBeUndefined();
      } finally {
        await server.stop(true);
      }
    });
  });

  test("provider management accepts modelCosts on the canonical openai provider", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const costs = { "gpt-5.6": { input: 1.2, output: 3.2, cacheRead: 0.12, cacheWrite: 0 } };
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "openai",
          provider: { ...canonicalDirect, codexAccountMode: "pool", modelCosts: costs },
        }),
      });
      expect(response.status).toBe(200);
      expect(loadConfig().providers.openai?.modelCosts).toEqual(costs);
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects runtime metadata and accepts only canonical OpenAI option seeds", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: { openai: canonicalDirect },
    });

    const server = startServer(0);
    try {
      for (const field of [
        "virtualModels",
        "codexAuthContext",
        "selectedForwardHeaders",
        "sidecarOutcomeRecorder",
        "_codexAccountOverride",
        "_codexAccountRequired",
      ]) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "custom-runtime",
            provider: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", [field]: true },
          }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: expect.stringContaining("runtime field") });
      }

      for (const mode of ["pool", "direct"] as const) {
        const accepted = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "openai", provider: { ...canonicalDirect, codexAccountMode: mode } }),
        });
        expect(accepted.status).toBe(200);
      }

      const legacyMulti = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "openai-multi", provider: canonicalDirect }),
      });
      expect(legacyMulti.status).toBe(400);

      for (const [, provider] of [
        ["base", { ...canonicalDirect, baseUrl: "https://attacker.example/backend-api/codex" }],
        ["mode", { ...canonicalDirect, authMode: "key" }],
        ["header", { ...canonicalDirect, headers: { "x-forged": "value" } }],
        ["capability", { ...canonicalDirect, noVisionModels: ["gpt-5.6"] }],
        // The context overlays are admitted now, but only in a shape a reader can trust.
        ["window-shape", { ...canonicalDirect, contextWindow: "wide" }],
        ["window-zero", { ...canonicalDirect, contextWindow: 0 }],
        ["window-null-on-post", { ...canonicalDirect, contextWindow: null }],
        ["map-shape", { ...canonicalDirect, modelContextWindows: [] }],
        ["map-value", { ...canonicalDirect, modelContextWindows: { "gpt-5.6-sol": "wide" } }],
        ["map-key", { ...canonicalDirect, modelContextWindows: { "  ": 500_000 } }],
      ] as const) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "openai", provider }),
        });
        expect(response.status).toBe(400);
      }

      // A user narrowing their own native rows is a supported overlay, like requestPacing:
      // the accessors only ever lower the measured window with it, so it cannot widen what
      // the proxy advertises.
      for (const [, provider] of [
        ["per-model", { ...canonicalDirect, modelContextWindows: { "gpt-5.6-sol": 500_000 } }],
        ["provider-wide", { ...canonicalDirect, contextWindow: 500_000 }],
      ] as const) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "openai", provider }),
        });
        expect(response.status).toBe(200);
      }

      const acceptedCustom = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-max-input",
          provider: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", modelMaxInputTokens: { model: 1000 } },
        }),
      });
      expect(acceptedCustom.status).toBe(200);
      for (const invalid of [null, [], { model: 0 }, { model: -1 }, { model: 1.5 }, { model: "1000" }]) {
        const rejected = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "custom-max-input",
            provider: { adapter: "openai-chat", baseUrl: "https://api.example.test/v1", modelMaxInputTokens: invalid },
          }),
        });
        expect(rejected.status).toBe(400);
      }
      expect(loadConfig().providers["custom-max-input"].modelMaxInputTokens).toEqual({ model: 1000 });

      const acceptedSummaryCapability = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-summary-capability",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://api.example.test/v1",
            modelSupportsReasoningSummaries: { strict: false },
          },
        }),
      });
      expect(acceptedSummaryCapability.status).toBe(200);
      for (const invalid of [[], { strict: "false" }, { "": false }]) {
        const rejected = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "custom-summary-capability",
            provider: {
              adapter: "openai-responses",
              baseUrl: "https://api.example.test/v1",
              modelSupportsReasoningSummaries: invalid,
            },
          }),
        });
        expect(rejected.status).toBe(400);
      }
      expect(loadConfig().providers["custom-summary-capability"].modelSupportsReasoningSummaries).toEqual({ strict: false });

      const acceptedSummaryDelivery = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-summary-delivery",
          provider: {
            adapter: "openai-responses",
            baseUrl: "https://api.example.test/v1",
            modelSupportsReasoningSummaries: { summary: true },
            modelReasoningSummaryDelivery: { summary: "sequential" },
          },
        }),
      });
      expect(acceptedSummaryDelivery.status).toBe(200);
      for (const provider of [
        {
          adapter: "openai-responses",
          baseUrl: "https://api.example.test/v1",
          modelReasoningSummaryDelivery: { summary: "serial" },
        },
        {
          adapter: "openai-responses",
          baseUrl: "https://api.example.test/v1",
          modelSupportsReasoningSummaries: { SUMMARY: false },
          modelReasoningSummaryDelivery: { summary: "sequential" },
        },
      ]) {
        const rejected = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "custom-summary-delivery", provider }),
        });
        expect(rejected.status).toBe(400);
      }
      expect(loadConfig().providers["custom-summary-delivery"].modelReasoningSummaryDelivery).toEqual({ summary: "sequential" });

      const acceptedModelAdapters = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-mixed-gateway",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            modelAdapters: { "grok-4.5": "openai-responses" },
          },
        }),
      });
      expect(acceptedModelAdapters.status).toBe(200);
      for (const invalid of [
        [],
        { "grok-4.5": true },
        { "": "openai-chat" },
        // Provider-specific adapters would change how credentials are sent (#404).
        { "grok-4.5": "cursor" },
        { "grok-4.5": "anthropic" },
      ]) {
        const rejected = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "custom-mixed-gateway",
            provider: {
              adapter: "openai-chat",
              baseUrl: "https://api.example.test/v1",
              modelAdapters: invalid,
            },
          }),
        });
        expect(rejected.status).toBe(400);
      }
      expect(loadConfig().providers["custom-mixed-gateway"].modelAdapters).toEqual({ "grok-4.5": "openai-responses" });
      const legacy = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "chatgpt", provider: canonicalDirect }),
      });
      expect(legacy.status).toBe(400);

      const dto = await fetch(new URL("/api/config", server.url)).then(response => response.json()) as {
        providers: Record<string, { codexAccountMode?: string }>;
      };
      expect(dto.providers.openai.codexAccountMode).toBe("direct");
      expect(dto.providers["openai-multi"]).toBeUndefined();
      expect(dto.providers["custom-max-input"]).not.toHaveProperty("modelMaxInputTokens");

      const presetResponse = await fetch(new URL("/api/provider-presets", server.url)).then(response => response.json()) as {
        providers: ReturnType<typeof deriveProviderPresets>;
      };
      const openAiIds = presetResponse.providers
        .map(preset => preset.id)
        .filter(id => id === "chatgpt" || id === "openai" || id.startsWith("openai-"));
      expect(openAiIds).toEqual(["openai", "openai-apikey"]);
      expect(presetResponse.providers.filter(row => !openAiIds.includes(row.id))).toEqual(
        deriveProviderPresets().filter(row => !["openai", "openai-apikey"].includes(row.id)),
      );
    } finally {
      await server.stop(true);
    }
  });

  test("provider management does not persist registry-only static auth headers for opencode-free", async () => {
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
          name: "opencode-free",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://opencode.ai/zen/v1",
            authMode: "key",
          },
        }),
      });
      expect(response.status).toBe(200);

      const saved = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf8")) as OcxConfig;
      expect(saved.providers["opencode-free"]).toBeDefined();
      expect(saved.providers["opencode-free"]?.headers).toBeUndefined();
      expect(saved.providers["opencode-free"]?.keyOptional).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("management selections preserve an OpenAI API Pro selected id without wire rewriting", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const selected = "openai-apikey/gpt-5.6-sol-pro";
    saveConfig({
      port: 0,
      defaultProvider: "openai-apikey",
      openaiProviderTierVersion: 2,
      providers: {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          liveModels: false,
        },
      },
    });
    const server = startServer(0);
    try {
      const put = (path: string, body: unknown) => fetch(new URL(path, server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      expect((await put("/api/disabled-models", { models: [selected] })).status).toBe(200);
      const modelRows = await fetch(new URL("/api/models", server.url)).then(response => response.json()) as Array<{
        namespaced: string;
        disabled: boolean;
      }>;
      expect(modelRows.find(row => row.namespaced === selected)).toMatchObject({ namespaced: selected, disabled: true });

      expect((await put("/api/subagent-models", { models: [selected] })).status).toBe(200);
      const subagent = await fetch(new URL("/api/subagent-models", server.url)).then(response => response.json()) as {
        chosen: string[];
      };
      expect(subagent.chosen).toEqual([selected]);

      expect((await put("/api/injection-model", { model: selected, effort: "high" })).status).toBe(200);
      const injection = await fetch(new URL("/api/injection-model", server.url)).then(response => response.json()) as {
        model: string | null;
        effort: string | null;
      };
      expect(injection).toMatchObject({ model: selected, effort: "high" });
      expect(loadConfig()).toMatchObject({
        disabledModels: [selected],
        subagentModels: [selected],
        injectionModel: selected,
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

  test("provider management rejects names owned by a Codex account namespace without mutating config", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const cfg = {
      ...config("127.0.0.1"),
      codexAccountNamespaces: { side: "side-account-id" },
    };
    saveConfig(cfg);
    const beforeMemory = structuredClone(cfg);
    const beforeDisk = readFileSync(join(TEST_DIR, "config.json"), "utf8");

    const requestUrl = new URL("http://127.0.0.1/api/providers");
    const response = await handleManagementAPI(
      new Request(requestUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "side",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://side.example.test/v1",
          },
        }),
      }),
      requestUrl,
      cfg,
      { createManagementConvergeCodex: catalogConvergenceFactory() },
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      error: "provider name must not collide with a configured Codex account namespace",
    });
    expect(cfg).toEqual(beforeMemory);
    expect(readFileSync(join(TEST_DIR, "config.json"), "utf8")).toBe(beforeDisk);
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

  test("provider management rejects private-network destinations without explicit opt-in", async () => {
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
          name: "custom-local",
          provider: {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("allowPrivateNetwork"),
      });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management allows private-network destinations only with explicit opt-in", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));
    stubModelDiscoveryFor("http://127.0.0.1:11434");

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "custom-local",
          provider: {
            adapter: "openai-chat",
            baseUrl: "http://127.0.0.1:11434/v1",
            allowPrivateNetwork: true,
          },
        }),
      });

      expect(response.status).toBe(200);
      const saved = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        providers: Record<string, { allowPrivateNetwork?: boolean }>;
      };
      expect(saved.providers["custom-local"].allowPrivateNetwork).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("provider management always rejects metadata endpoints", async () => {
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
          name: "metadata-hop",
          provider: {
            adapter: "openai-chat",
            baseUrl: "http://169.254.169.254/latest/meta-data",
            allowPrivateNetwork: true,
          },
        }),
      });

      expect(response.status).toBe(400);
     expect(await response.json()).toMatchObject({
       error: expect.stringContaining("metadata"),
     });
   } finally {
     await server.stop(true);
   }
 });

  test("provider PATCH can enable allowPrivateNetwork and then change baseUrl to localhost", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));
    stubModelDiscoveryFor("https://api.example.com", "http://127.0.0.1:11434");

    const server = startServer(0);
    try {
      // Step 1: create a provider with a public URL
      const createRes = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "patch-test",
          provider: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1" },
        }),
      });
      expect(createRes.status).toBe(200);

      // Step 2: PATCH allowPrivateNetwork to true
      const patchRes = await fetch(new URL("/api/providers?name=patch-test", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowPrivateNetwork: true }),
      });
      expect(patchRes.status).toBe(200);

      // Step 3: PATCH baseUrl to localhost — should succeed because flag is now true
      const urlRes = await fetch(new URL("/api/providers?name=patch-test", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "http://127.0.0.1:11434/v1" }),
      });
      expect(urlRes.status).toBe(200);

      // Verify the persisted state
      const saved = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        providers: Record<string, { allowPrivateNetwork?: boolean; baseUrl?: string }>;
      };
      expect(saved.providers["patch-test"].allowPrivateNetwork).toBe(true);
      expect(saved.providers["patch-test"].baseUrl).toContain("127.0.0.1");
    } finally {
      await server.stop(true);
    }
  });

  test("provider PATCH rejects disabling allowPrivateNetwork while baseUrl is private", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));
    stubModelDiscoveryFor("http://127.0.0.1:8080");

    const server = startServer(0);
    try {
      // Create a localhost provider with opt-in
      await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "private-toggle",
          provider: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:8080/v1", allowPrivateNetwork: true },
        }),
      });

      // Try to disable the flag while keeping the private baseUrl — should be rejected
      const patchRes = await fetch(new URL("/api/providers?name=private-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowPrivateNetwork: false }),
      });
      expect(patchRes.status).toBe(400);
      expect(await patchRes.json()).toMatchObject({
        error: expect.stringContaining("allowPrivateNetwork"),
      });
    } finally {
      await server.stop(true);
    }
  });

  test("provider PATCH persists liveModels and provider metadata exposes the normalized state", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const createRes = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "discovery-toggle",
          provider: {
            adapter: "anthropic",
            baseUrl: "https://api.example.com",
            defaultModel: "claude-sonnet-5",
            models: [],
          },
        }),
      });
      expect(createRes.status).toBe(200);

      const invalid = await fetch(new URL("/api/providers?name=discovery-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ liveModels: "false" }),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: "liveModels must be a boolean" });

      const patchRes = await fetch(new URL("/api/providers?name=discovery-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ liveModels: false }),
      });
      expect(patchRes.status).toBe(200);

      const providers = await fetch(new URL("/api/providers", server.url)).then(response => response.json()) as Array<{
        name: string;
        liveModels: boolean;
        models: string[];
        authMode?: string;
      }>;
      expect(providers.find(provider => provider.name === "discovery-toggle")).toMatchObject({
        liveModels: false,
        models: [],
      });

      const saved = await fetch(new URL("/api/config", server.url)).then(response => response.json()) as {
        providers: Record<string, { liveModels?: boolean }>;
      };
      expect(saved.providers["discovery-toggle"].liveModels).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("provider PATCH persists and clears structured-output model opt-outs", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig(config("127.0.0.1"));

    const server = startServer(0);
    try {
      const createRes = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "structured-output-toggle",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://relay.example/v1",
            liveModels: false,
            models: ["deepseek-v4-flash"],
          },
        }),
      });
      expect(createRes.status).toBe(200);

      const invalid = await fetch(new URL("/api/providers?name=structured-output-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noStructuredOutputModels: "deepseek-v4-flash" }),
      });
      expect(invalid.status).toBe(400);

      const patchRes = await fetch(new URL("/api/providers?name=structured-output-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          noStructuredOutputModels: [" deepseek-v4-flash ", "deepseek-v4-flash"],
        }),
      });
      expect(patchRes.status).toBe(200);

      const providers = await fetch(new URL("/api/providers", server.url)).then(response => response.json()) as Array<{
        name: string;
        noStructuredOutputModels?: string[];
      }>;
      expect(providers.find(provider => provider.name === "structured-output-toggle")?.noStructuredOutputModels)
        .toEqual(["deepseek-v4-flash"]);

      const clearRes = await fetch(new URL("/api/providers?name=structured-output-toggle", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ noStructuredOutputModels: null }),
      });
      expect(clearRes.status).toBe(200);

      const saved = await fetch(new URL("/api/config", server.url)).then(response => response.json()) as {
        providers: Record<string, { noStructuredOutputModels?: string[] }>;
      };
      expect(saved.providers["structured-output-toggle"].noStructuredOutputModels).toBeUndefined();
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

  test("provider deletion removes the deleted provider's OAuth credential", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "test-key",
        },
        removable: {
          adapter: "openai-chat",
          baseUrl: "https://api.removable.test/v1",
          apiKey: "test-key",
        },
      },
    });
    await saveCredential("removable", {
      access: "credential-to-delete",
      refresh: "refresh-to-delete",
      expires: Date.now() + 60_000,
    });
    await saveCredential("retained", {
      access: "credential-to-keep",
      refresh: "refresh-to-keep",
      expires: Date.now() + 60_000,
    });

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers?name=removable", server.url), {
        method: "DELETE",
      });
      expect(response.status).toBe(200);

      expect(getAccountSet("removable")).toBeNull();
      expect(getAccountSet("retained")).not.toBeNull();
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
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
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

  test("provider deletion removes that provider's custom models (#1273)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
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
      customModels: [
        { id: "keep-1", provider: "test-openai", modelId: "kept-model" },
        { id: "drop-1", provider: "removable", modelId: "ghost-model" },
      ],
      // Seeded so the assertion below covers the real persistence path, not just
      // the helper: `projectCustomModelCatalogMigration` runs inside the save and
      // must carry this marker through a provider delete unchanged.
      customModelCatalogMigration: {
        version: 1,
        legacyOwnedSlugs: ["removable/ghost-model", "test-openai/kept-model"],
      },
    } as unknown as Parameters<typeof saveConfig>[0]);

    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/providers?name=removable", server.url), {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, droppedCustomModels: 1 });

      // The dashboard model page reads this route; a surviving row here is the
      // ghost model users see pointing at a provider that no longer exists.
      const customModels = await fetch(new URL("/api/custom-models", server.url));
      expect(await customModels.json()).toEqual([
        { id: "keep-1", provider: "test-openai", modelId: "kept-model" },
      ]);

      const persisted = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf8")) as {
        customModels?: unknown;
        customModelCatalogMigration?: unknown;
      };
      expect(persisted.customModels).toEqual([
        { id: "keep-1", provider: "test-openai", modelId: "kept-model" },
      ]);
      expect(persisted.customModelCatalogMigration).toEqual({
        version: 1,
        legacyOwnedSlugs: ["removable/ghost-model", "test-openai/kept-model"],
      });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management switches the default and reassigns it when removed", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "alpha",
      providers: {
        alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", liveModels: false },
        beta: { adapter: "openai-chat", baseUrl: "https://beta.example.test/v1", liveModels: false },
      },
    });

    const server = startServer(0);
    try {
      const setDefault = await fetch(new URL("/api/providers?name=beta", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setDefault: true }),
      });
      expect(setDefault.status).toBe(200);
      expect(await setDefault.json()).toMatchObject({ success: true, defaultProvider: "beta" });

      const deleteDefault = await fetch(new URL("/api/providers?name=beta", server.url), { method: "DELETE" });
      expect(deleteDefault.status).toBe(200);
      expect(await deleteDefault.json()).toMatchObject({ success: true, defaultProvider: "alpha" });

      const saved = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        defaultProvider: string;
        providers: Record<string, unknown>;
      };
      expect(saved.defaultProvider).toBe("alpha");
      expect(saved.providers).toEqual(expect.objectContaining({ alpha: expect.any(Object) }));
      expect(saved.providers.beta).toBeUndefined();

      const deleteLast = await fetch(new URL("/api/providers?name=alpha", server.url), { method: "DELETE" });
      expect(deleteLast.status).toBe(409);
      expect(await deleteLast.json()).toMatchObject({ code: "last_provider" });
    } finally {
      await server.stop(true);
    }
  });

  test("provider management rejects POST setDefault for a disabled provider", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "alpha",
      providers: {
        alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", liveModels: false },
      },
    });

    const server = startServer(0);
    try {
      const createDisabledDefault = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "beta",
          setDefault: true,
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://beta.example.test/v1",
            liveModels: false,
            disabled: true,
          },
        }),
      });
      expect(createDisabledDefault.status).toBe(400);
      expect(await createDisabledDefault.json()).toMatchObject({ code: "default_provider_disabled" });

      const saved = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        defaultProvider: string;
        providers: Record<string, unknown>;
      };
      expect(saved.defaultProvider).toBe("alpha");
      expect(saved.providers.beta).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("provider management refuses to delete the default when only a disabled replacement remains", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "alpha",
      providers: {
        alpha: { adapter: "openai-chat", baseUrl: "https://alpha.example.test/v1", liveModels: false },
        beta: { adapter: "openai-chat", baseUrl: "https://beta.example.test/v1", liveModels: false, disabled: true },
        gamma: { adapter: "openai-chat", baseUrl: "https://gamma.example.test/v1", liveModels: false },
      },
    });

    const server = startServer(0);
    try {
      const deleteWithDisabledFirst = await fetch(new URL("/api/providers?name=alpha", server.url), { method: "DELETE" });
      expect(deleteWithDisabledFirst.status).toBe(200);
      expect(await deleteWithDisabledFirst.json()).toMatchObject({ success: true, defaultProvider: "gamma" });

      const saved = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        defaultProvider: string;
        providers: Record<string, { disabled?: boolean }>;
      };
      expect(saved.defaultProvider).toBe("gamma");
      expect(saved.providers.beta?.disabled).toBe(true);
      expect(saved.providers.alpha).toBeUndefined();

      const deleteOnlyEnabled = await fetch(new URL("/api/providers?name=gamma", server.url), { method: "DELETE" });
      expect(deleteOnlyEnabled.status).toBe(409);
      expect(await deleteOnlyEnabled.json()).toMatchObject({ code: "last_provider" });
      const stillThere = await fetch(new URL("/api/config", server.url)).then(r => r.json()) as {
        defaultProvider: string;
        providers: Record<string, unknown>;
      };
      expect(stillThere.defaultProvider).toBe("gamma");
      expect(stillThere.providers.gamma).toEqual(expect.any(Object));
      expect(stillThere.providers.beta).toEqual(expect.any(Object));
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

  test("provider management accepts canonical OpenAI modes and rejects legacy Multi", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
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
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("codexAccountMode") });

      const direct = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "openai", provider: canonicalDirect }),
      });
      expect(direct.status).toBe(200);

      const legacyMulti = await fetch(new URL("/api/providers", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "openai-multi", provider: canonicalDirect }),
      });
      expect(legacyMulti.status).toBe(400);

      for (const overlay of [{ disabled: true }, { selectedModels: ["gpt-5.6-sol"] }]) {
        const forged = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "openai", provider: { ...canonicalDirect, ...overlay } }),
        });
        expect(forged.status).toBe(400);
        expect(await forged.json()).toMatchObject({ error: expect.stringContaining("canonical") });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("canonical OpenAI POST passes allowBenchmarkAddresses into destination resolution", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
        },
      },
    };
    saveConfig(liveConfig);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockResolvedValue(null);

    try {
      const post = (body: unknown) => {
        const request = new Request("http://127.0.0.1/api/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return handleManagementAPI(request, new URL(request.url), liveConfig, {
          createManagementConvergeCodex: catalogConvergenceFactory(),
        });
      };
      const canonical = await post({ name: "openai", provider: canonicalDirect });
      expect(canonical?.status).toBe(200);
      expect(resolvedError).toHaveBeenCalledWith(
        "openai",
        expect.objectContaining({ baseUrl: canonicalDirect.baseUrl }),
        { allowBenchmarkAddresses: true },
      );

      resolvedError.mockResolvedValueOnce(
        "baseUrl hostname custom.example.test resolves to a benchmark address (198.18.0.30); set allowPrivateNetwork:true only for intentionally local/self-hosted providers",
      );
      const custom = await post({
        name: "custom",
        provider: { adapter: "openai-chat", baseUrl: "https://custom.example.test/v1" },
      });
      expect(custom?.status).toBe(400);
      expect(resolvedError).toHaveBeenCalledWith(
        "custom",
        expect.objectContaining({ baseUrl: "https://custom.example.test/v1" }),
        { allowBenchmarkAddresses: false },
      );
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("canonical OpenAI POST still rejects non-benchmark private destination answers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          apiKey: "sk-secret-value",
        },
      },
    };
    saveConfig(liveConfig);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockResolvedValue("baseUrl hostname chatgpt.com resolves to a loopback address (127.0.0.1); set allowPrivateNetwork:true only for intentionally local/self-hosted providers");

    try {
      const request = new Request("http://127.0.0.1/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "openai", provider: canonicalDirect }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      expect(response?.status).toBe(400);
      expect(await response?.json()).toMatchObject({
        error: expect.stringContaining("loopback address"),
      });
      expect(resolvedError).toHaveBeenCalledWith(
        "openai",
        expect.anything(),
        { allowBenchmarkAddresses: true },
      );
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("disabled-only PATCH cannot re-enable a noncanonical openai row unchanged", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "extra",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-chat",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "sk-malformed",
          disabled: true,
        },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
          liveModels: false,
          models: ["extra-model"],
        },
      },
    };
    saveConfig(liveConfig);

    const server = startServer(0);
    try {
      const rejected = await fetch(new URL("/api/providers?name=openai", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: expect.stringContaining("canonical built-in provider"),
      });

      const persisted = loadConfig();
      expect(persisted.providers.openai).toMatchObject({
        adapter: "openai-chat",
        baseUrl: "https://api.openai.com/v1",
        authMode: "key",
        disabled: true,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("disabled-only PATCH re-enables canonical openai and fills missing pool mode", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "extra",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          disabled: true,
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
      const enabled = await fetch(new URL("/api/providers?name=openai", server.url), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ success: true, name: "openai", disabled: false });

      const persisted = loadConfig();
      expect(persisted.providers.openai).toEqual({
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      });
      expect(persisted.providers.openai.disabled).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("disabled OpenAI recovery accepts pure Clash fake-IP via destination check", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "extra",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          disabled: true,
        },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
          liveModels: false,
          models: ["extra-model"],
        },
      },
    };
    saveConfig(liveConfig);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockImplementation(async (_name, provider, options) => {
        expect(provider).toEqual({ baseUrl: "https://chatgpt.com/backend-api/codex" });
        expect(options).toEqual({ allowBenchmarkAddresses: true });
        return null; // pure 198.18/19 allowed by the policy opt-in
      });

    try {
      const request = new Request("http://127.0.0.1/api/providers?name=openai", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      expect(response?.status).toBe(200);
      expect(resolvedError).toHaveBeenCalledTimes(1);
      expect(liveConfig.providers.openai?.disabled).toBeUndefined();
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("disabled OpenAI recovery rejects loopback, RFC1918, and metadata and stays disabled", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const disabledCanonical = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      disabled: true,
    } as const;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "extra",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...disabledCanonical },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
          liveModels: false,
          models: ["extra-model"],
        },
      },
    };
    saveConfig(liveConfig);

    const failures = [
      "baseUrl hostname chatgpt.com resolves to a loopback address (127.0.0.1); set allowPrivateNetwork:true only for intentionally local/self-hosted providers",
      "baseUrl hostname chatgpt.com resolves to a private-network address (10.0.0.5); set allowPrivateNetwork:true only for intentionally local/self-hosted providers",
      "baseUrl hostname chatgpt.com resolves to a blocked metadata endpoint (169.254.169.254)",
    ];
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError");

    try {
      for (const error of failures) {
        liveConfig.providers.openai = { ...disabledCanonical };
        saveConfig(liveConfig);
        resolvedError.mockResolvedValueOnce(error);

        const request = new Request("http://127.0.0.1/api/providers?name=openai", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: false }),
        });
        const response = await handleManagementAPI(request, new URL(request.url), liveConfig, {
          createManagementConvergeCodex: catalogConvergenceFactory(),
        });
        expect(response?.status).toBe(400);
        expect(await response?.json()).toMatchObject({ error });
        expect(liveConfig.providers.openai).toEqual(disabledCanonical);
        expect(loadConfig().providers.openai).toMatchObject({ disabled: true });
      }
      expect(resolvedError).toHaveBeenCalledTimes(failures.length);
      expect(resolvedError).toHaveBeenCalledWith(
        "openai",
        { baseUrl: "https://chatgpt.com/backend-api/codex" },
        { allowBenchmarkAddresses: true },
      );
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("disabled OpenAI recovery ignores persisted allowPrivateNetwork for DNS guard", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "extra",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          allowPrivateNetwork: true,
          disabled: true,
        },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
          liveModels: false,
          models: ["extra-model"],
        },
      },
    };
    saveConfig(liveConfig);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockImplementation(async (_name, provider, options) => {
        expect(provider).toEqual({ baseUrl: "https://chatgpt.com/backend-api/codex" });
        expect(Object.hasOwn(provider as object, "allowPrivateNetwork")).toBe(false);
        expect(options).toEqual({ allowBenchmarkAddresses: true });
        return "baseUrl hostname chatgpt.com resolves to a private-network address (10.0.0.5); set allowPrivateNetwork:true only for intentionally local/self-hosted providers";
      });

    try {
      const request = new Request("http://127.0.0.1/api/providers?name=openai", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      expect(response?.status).toBe(400);
      expect(liveConfig.providers.openai).toMatchObject({
        disabled: true,
        allowPrivateNetwork: true,
      });
      expect(loadConfig().providers.openai).toMatchObject({
        disabled: true,
        allowPrivateNetwork: true,
      });
    } finally {
      resolvedError.mockRestore();
    }
  });

  test("disabled OpenAI recovery strips allowPrivateNetwork after successful re-enable", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "extra",
      openaiProviderTierVersion: 2,
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          allowPrivateNetwork: true,
          disabled: true,
        },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
          liveModels: false,
          models: ["extra-model"],
        },
      },
    };
    saveConfig(liveConfig);
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockResolvedValue(null);

    try {
      const request = new Request("http://127.0.0.1/api/providers?name=openai", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: false }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      expect(response?.status).toBe(200);
      expect(liveConfig.providers.openai).toEqual({
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      });
      expect(Object.hasOwn(liveConfig.providers.openai as object, "allowPrivateNetwork")).toBe(false);
      expect(Object.hasOwn(loadConfig().providers.openai as object, "allowPrivateNetwork")).toBe(false);
    } finally {
      resolvedError.mockRestore();
    }
  });

  for (const [label, baseUrl] of [
    ["uppercase host", "https://CHATGPT.com/backend-api/codex"],
    ["explicit :443 port", "https://chatgpt.com:443/backend-api/codex"],
  ] as const) {
    test(`disabled-only PATCH normalizes ${label} before save-and-reload`, async () => {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
      process.env.OPENCODEX_HOME = TEST_DIR;
      saveConfig({
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: "extra",
        openaiProviderTierVersion: 2,
        providers: {
          openai: {
            adapter: "openai-responses",
            baseUrl,
            authMode: "forward",
            disabled: true,
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
        const enabled = await fetch(new URL("/api/providers?name=openai", server.url), {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: false }),
        });
        expect(enabled.status).toBe(200);

        const afterSave = loadConfig();
        expect(afterSave.providers.openai).toEqual({
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        });

        // Second load proves the persisted row survives config-schema restart checks.
        const afterReload = loadConfig();
        expect(afterReload.providers.openai.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
        expect(afterReload.providers.openai.codexAccountMode).toBe("pool");
        expect(afterReload.providers.openai.disabled).toBeUndefined();
      } finally {
        await server.stop(true);
      }
    });
  }

  test("provider mode PATCH is strict, persists live state, clears caches and affinity, and primes Pool only", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect, disabled: true },
        extra: { adapter: "openai-chat", baseUrl: "https://extra.example.test/v1" },
      },
    };
    saveConfig(liveConfig);
    let affinityClears = 0;
    let quotaCacheClears = 0;
    let catalogRefreshes = 0;
    const primes: string[] = [];
    const deps = {
      clearThreadAccountMap: () => { affinityClears += 1; },
      clearProviderQuotaCache: () => { quotaCacheClears += 1; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { catalogRefreshes += 1; }),
      primeCodexPoolQuotas: (_config: OcxConfig, reason: string) => { primes.push(reason); },
    };
    const patch = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, deps);
    };

    for (const body of [
      {},
      { disabled: false, codexAccountMode: "pool" },
      { codexAccountMode: "pool", unknown: true },
      { codexAccountMode: 1 },
      { codexAccountMode: "invalid" },
    ]) {
      expect((await patch("openai", body))?.status).toBe(400);
    }
    expect((await patch("extra", { codexAccountMode: "pool" }))?.status).toBe(400);
    expect(affinityClears).toBe(0);
    expect(quotaCacheClears).toBe(0);
    expect(primes).toEqual([]);
    expect(catalogRefreshes).toBe(0);

    const direct = await patch("openai", { codexAccountMode: "direct" });
    expect(direct?.status).toBe(200);
    expect(await direct?.json()).toEqual({ success: true, name: "openai", codexAccountMode: "direct" });
    expect(liveConfig.providers.openai).toMatchObject({ disabled: true, codexAccountMode: "direct" });
    expect(loadConfig().providers.openai).toMatchObject({ disabled: true, codexAccountMode: "direct" });
    expect({ affinityClears, quotaCacheClears, catalogRefreshes, primes }).toEqual({
      affinityClears: 1,
      quotaCacheClears: 1,
      catalogRefreshes: 0,
      primes: [],
    });

    const pool = await patch("openai", { codexAccountMode: "pool" });
    expect(pool?.status).toBe(200);
    expect(await pool?.json()).toEqual({ success: true, name: "openai", codexAccountMode: "pool" });
    expect(liveConfig.providers.openai).toMatchObject({ disabled: true, codexAccountMode: "pool" });
    expect(loadConfig().providers.openai).toMatchObject({ disabled: true, codexAccountMode: "pool" });
    expect({ affinityClears, quotaCacheClears, catalogRefreshes, primes }).toEqual({
      affinityClears: 2,
      quotaCacheClears: 2,
      catalogRefreshes: 0,
      primes: ["mode-change"],
    });
  });

  test("xAI Responses opt-in reports mixed state and atomically normalizes both model adapters", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          modelAdapters: {
            "grok-4.6": "openai-responses",
            "other-model": "openai-chat",
          },
        },
        extra: {
          adapter: "openai-chat",
          baseUrl: "https://extra.example.test/v1",
        },
      },
    };
    saveConfig(liveConfig);
    const destinationProbe = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockResolvedValue(null);
    const request = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(),
      });
    };

    try {
      const listedRequest = new Request("http://127.0.0.1/api/providers");
      const listedResponse = await handleManagementAPI(
        listedRequest,
        new URL(listedRequest.url),
        liveConfig,
        { createManagementConvergeCodex: catalogConvergenceFactory() },
      );
      const listed = await listedResponse!.json() as Array<Record<string, unknown>>;
      expect(listed.find(row => row.name === "xai")?.xaiResponsesOptInState).toBe("mixed");
      expect(listed.find(row => row.name === "extra")).not.toHaveProperty("xaiResponsesOptInState");
      const configDto = safeConfigDTO(liveConfig) as {
        providers: Record<string, { xaiResponsesOptInState?: boolean | "mixed" }>;
      };
      expect(configDto.providers.xai?.xaiResponsesOptInState).toBe("mixed");

      const wrongProvider = await request("extra", { xaiResponsesOptIn: true });
      expect(wrongProvider?.status).toBe(400);
      expect(await wrongProvider?.json()).toEqual({
        error: "xaiResponsesOptIn is valid only for provider xai",
      });
      expect((await request("xai", { xaiResponsesOptIn: "true" }))?.status).toBe(400);

      const enabled = await request("xai", { xaiResponsesOptIn: true });
      expect(enabled?.status).toBe(200);
      expect(await enabled?.json()).toMatchObject({
        success: true,
        name: "xai",
        xaiResponsesOptInState: true,
      });
      expect(liveConfig.providers.xai?.modelAdapters).toEqual({
        "grok-4.6": "openai-responses",
        "grok-4.5": "openai-responses",
        "other-model": "openai-chat",
      });
      expect(loadConfig().providers.xai?.modelAdapters).toEqual(liveConfig.providers.xai?.modelAdapters);

      for (const model of ["grok-4.6", "grok-4.5"]) {
        expect(fastPolicyForModel(liveConfig.providers.xai!, model, "xai").adapter)
          .toBe("openai-responses");
        expect(resolveWireProtocolOverride("xai", model, liveConfig.providers.xai!).adapter)
          .toBe("openai-responses");
      }

      const cleared = await request("xai", { xaiResponsesOptIn: false });
      expect(cleared?.status).toBe(200);
      expect(await cleared?.json()).toMatchObject({
        success: true,
        name: "xai",
        xaiResponsesOptInState: false,
      });
      expect(liveConfig.providers.xai?.modelAdapters).toEqual({ "other-model": "openai-chat" });
      expect(loadConfig().providers.xai?.modelAdapters).toEqual({ "other-model": "openai-chat" });
    } finally {
      destinationProbe.mockRestore();
    }
  });

  test("provider PATCH field-mask edits non-reserved providers and rejects unsafe fields (WP040)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        extra: { adapter: "openai-chat", baseUrl: "https://extra.example.test/v1", apiKey: "sk-existing", note: "old note" },
        gateway: { adapter: "anthropic", baseUrl: "https://gateway.example.test/v1", apiKey: "sk-gateway" },
        nvidia: { adapter: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "sk-nvidia" },
        ollama: { adapter: "openai-chat", baseUrl: "http://localhost:11434/v1" },
      },
    };
    saveConfig(liveConfig);
    let catalogRefreshes = 0;
    const patch = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(() => { catalogRefreshes += 1; }),
      });
    };

    // Editor happy path: multiple fields in one call; validation runs on the MERGED provider.
    const edit = await patch("extra", { defaultModel: "m-1", note: "fresh note", baseUrl: "https://extra2.example.test/v1" });
    expect(edit?.status).toBe(200);
    expect(await edit?.json()).toMatchObject({ success: true, name: "extra", hasApiKey: true });
    expect(liveConfig.providers.extra).toMatchObject({
      baseUrl: "https://extra2.example.test/v1",
      defaultModel: "m-1",
      note: "fresh note",
      apiKey: "sk-existing", // untouched — keys are not writable through PATCH
    });
    expect(catalogRefreshes).toBe(1);

    // Empty defaultModel/note clear the fields.
    const clear = await patch("extra", { defaultModel: "", note: "" });
    expect(clear?.status).toBe(200);
    expect(liveConfig.providers.extra.defaultModel).toBeUndefined();
    expect(liveConfig.providers.extra.note).toBeUndefined();

    // apiKey is hard-rejected toward the key endpoints.
    const keyWrite = await patch("extra", { apiKey: "sk-new" });
    expect(keyWrite?.status).toBe(400);
    expect(await keyWrite?.json()).toMatchObject({ error: expect.stringContaining("API-key endpoints") });
    expect(liveConfig.providers.extra.apiKey).toBe("sk-existing");

    // Key-auth Anthropic gateways can select bearer; other adapters and auth modes cannot.
    const bearer = await patch("gateway", { apiKeyTransport: "bearer" });
    expect(bearer?.status).toBe(200);
    expect(liveConfig.providers.gateway.apiKeyTransport).toBe("bearer");
    expect((await patch("gateway", { apiKeyTransport: "invalid" }))?.status).toBe(400);
    expect((await patch("extra", { apiKeyTransport: "bearer" }))?.status).toBe(400);
    expect((await patch("gateway", { authMode: "oauth" }))?.status).toBe(400);
    const clearTransport = await patch("gateway", { apiKeyTransport: "" });
    expect(clearTransport?.status).toBe(200);
    expect(liveConfig.providers.gateway.apiKeyTransport).toBeUndefined();

    // authMode local is guarded by the registry: nvidia (key) → 400; ollama (local) → ok.
    const nvidiaLocal = await patch("nvidia", { authMode: "local" });
    expect(nvidiaLocal?.status).toBe(400);
    expect(await nvidiaLocal?.json()).toMatchObject({ error: expect.stringContaining("local") });
    const ollamaLocal = await patch("ollama", { authMode: "local" });
    expect(ollamaLocal?.status).toBe(200);
    expect(liveConfig.providers.ollama.authMode).toBe("local");

    // codexAccountMode cannot be combined with editor fields (side-effect path stays isolated).
    const combined = await patch("openai", { codexAccountMode: "pool", note: "x" });
    expect(combined?.status).toBe(400);

    // Editing the canonical openai shape fails the seed guard.
    const openaiEdit = await patch("openai", { baseUrl: "https://evil.example.test" });
    expect(openaiEdit?.status).toBe(400);
    expect(await openaiEdit?.json()).toMatchObject({ error: expect.stringContaining("canonical") });

    // Unknown-only bodies are rejected.
    expect((await patch("extra", { bogus: 1 }))?.status).toBe(400);
  });

  test("provider management exposes and persists context-window hints for Models GUI (#1073)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        relay: {
          adapter: "openai-chat",
          baseUrl: "https://relay.example.test/v1",
          apiKey: "sk-existing",
          allowPrivateNetwork: true,
          models: ["wide", "narrow"],
          contextWindow: 256_000,
          modelContextWindows: { narrow: 64_000 },
          modelSupportsServiceTier: { narrow: false },
        },
      },
    };
    saveConfig(liveConfig);

    const request = async (method: "GET" | "PATCH", body?: unknown) => {
      const req = new Request("http://127.0.0.1/api/providers?name=relay", {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
      });
    };

    const listed = await request("GET");
    expect(listed?.status).toBe(200);
    const rows = await listed!.json() as Array<{
      name: string;
      contextWindow?: number;
      modelContextWindows?: Record<string, number>;
    }>;
    expect(rows.find(row => row.name === "relay")).toMatchObject({
      contextWindow: 256_000,
      modelContextWindows: { narrow: 64_000 },
      modelSupportsServiceTier: { narrow: false },
    });

    const updated = await request("PATCH", {
      contextWindow: 350_000,
      modelContextWindows: { wide: 350_000 },
      modelSupportsServiceTier: { wide: true },
    });
    expect(updated?.status).toBe(200);
    expect(liveConfig.providers.relay).toMatchObject({
      contextWindow: 350_000,
      modelContextWindows: { wide: 350_000, narrow: 64_000 },
      modelSupportsServiceTier: { wide: true, narrow: false },
    });
    expect(loadConfig().providers.relay).toMatchObject({
      contextWindow: 350_000,
      modelContextWindows: { wide: 350_000, narrow: 64_000 },
      modelSupportsServiceTier: { wide: true, narrow: false },
    });

    for (const invalid of [
      { contextWindow: 0 },
      { contextWindow: 1.5 },
      // `Number.isInteger(1e100)` is true, so an integer check alone lets this through. It
      // would then serialize into the catalog as an enormous number and can make Codex reject
      // the whole file — the failure surfaces far from the PATCH that caused it.
      { contextWindow: 1e100 },
      { modelContextWindows: { wide: 1e100 } },
      { modelContextWindows: { "": 100_000 } },
      { modelContextWindows: { wide: -1 } },
      { modelSupportsServiceTier: { wide: "yes" } },
      { modelSupportsServiceTier: { "": true } },
    ]) {
      expect((await request("PATCH", invalid))?.status).toBe(400);
    }
    expect(liveConfig.providers.relay).toMatchObject({
      contextWindow: 350_000,
      modelContextWindows: { wide: 350_000, narrow: 64_000 },
      modelSupportsServiceTier: { wide: true, narrow: false },
    });

    expect((await request("PATCH", { modelContextWindows: { wide: null } }))?.status).toBe(200);
    expect(liveConfig.providers.relay.modelContextWindows).toEqual({ narrow: 64_000 });

    expect((await request("PATCH", { modelSupportsServiceTier: { wide: null } }))?.status).toBe(200);
    expect(liveConfig.providers.relay.modelSupportsServiceTier).toEqual({ narrow: false });

    const cleared = await request("PATCH", {
      contextWindow: null,
      modelContextWindows: null,
      modelSupportsServiceTier: null,
    });
    expect(cleared?.status).toBe(200);
    expect(liveConfig.providers.relay.contextWindow).toBeUndefined();
    expect(liveConfig.providers.relay.modelContextWindows).toBeUndefined();
    expect(liveConfig.providers.relay.modelSupportsServiceTier).toBeUndefined();
  });

  test("provider PATCH manages custom headers with merge and clear semantics", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        agw: { adapter: "openai-chat", baseUrl: "https://agw.example.test/v1", apiKey: "sk-agw" },
      },
    };
    saveConfig(liveConfig);
    let catalogRefreshes = 0;
    const patch = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        // This branch replaced the best-effort `refreshCodexCatalog` dep with the
        // convergence entry point; every other test in this file already wires it
        // that way, and this one arrived from dev still using the old shape.
        createManagementConvergeCodex: catalogConvergenceFactory(() => { catalogRefreshes += 1; }),
      });
    };

    // Set a fresh headers block.
    const set = await patch("agw", { headers: { "X-Custom": "v1", "anthropic-version": "2023-06-01" } });
    expect(set?.status).toBe(200);
    expect(liveConfig.providers.agw.headers).toEqual({ "X-Custom": "v1", "anthropic-version": "2023-06-01" });

    // Later patches merge, so adding one fingerprint header never drops the rest.
    const merge = await patch("agw", { headers: { "x-app": "cli" } });
    expect(merge?.status).toBe(200);
    expect(liveConfig.providers.agw.headers).toEqual({
      "X-Custom": "v1",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
    });

    // null and empty object both clear the whole block.
    expect((await patch("agw", { headers: null }))?.status).toBe(200);
    expect(liveConfig.providers.agw.headers).toBeUndefined();
    expect((await patch("agw", { headers: { "X-A": "b" } }))?.status).toBe(200);
    expect((await patch("agw", { headers: {} }))?.status).toBe(200);
    expect(liveConfig.providers.agw.headers).toBeUndefined();

    // Invalid shapes, sensitive headers, CRLF values, and non-string values are rejected.
    for (const invalid of [
      "nope",
      [],
      { Authorization: "Bearer sk" },
      { "X-Bad": "a\r\nb" },
      { "bad name": "v" },
      { "X-N": 42 },
    ]) {
      const rejected = await patch("agw", { headers: invalid });
      expect(rejected?.status).toBe(400);
    }
    expect(liveConfig.providers.agw.headers).toBeUndefined();
    expect(catalogRefreshes).toBeGreaterThan(0);
  });

  test("GET /api/providers exposes hasHeaders but never header names or values (#959)", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const sentinelName = "x-fingerprint-sentinel";
    const sentinelValue = "sentinel-secret-header-value";
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        hdr: {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:9/v1",
          allowPrivateNetwork: true,
          headers: { [sentinelName]: sentinelValue },
        },
      },
    };
    saveConfig(liveConfig);
    const req = new Request("http://127.0.0.1/api/providers", { method: "GET" });
    const res = await handleManagementAPI(req, new URL(req.url), liveConfig, {});
    expect(res?.status).toBe(200);
    const raw = await res!.text();
    const rows = JSON.parse(raw) as { name: string; hasHeaders?: boolean }[];
    expect(rows.find(row => row.name === "hdr")?.hasHeaders).toBe(true);
    expect(rows.find(row => row.name === "openai")?.hasHeaders).toBe(false);
    expect(raw).not.toContain(sentinelName);
    expect(raw).not.toContain(sentinelValue);
  });
  test("provider PATCH merges headers case-insensitively", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        hdr: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true },
      },
    };
    saveConfig(liveConfig);
    const patch = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        refreshCodexCatalog: async () => {},
      });
    };

    expect((await patch("hdr", { headers: { "X-Foo": "old" } }))?.status).toBe(200);
    expect(liveConfig.providers.hdr.headers).toEqual({ "X-Foo": "old" });
    // A casing-only update must replace the existing key, not leave both behind for
    // Headers normalization to combine into "x-foo: old, new".
    expect((await patch("hdr", { headers: { "x-foo": "new" } }))?.status).toBe(200);
    expect(liveConfig.providers.hdr.headers).toEqual({ "x-foo": "new" });
    expect(Object.keys(liveConfig.providers.hdr.headers!)).toHaveLength(1);
  });
  test("provider PATCH clear keeps registry static headers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        "opencode-free": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/v1",
          authMode: "key",
          allowPrivateNetwork: true,
          headers: { "x-opencode-client": "desktop", "X-User": "v1" },
        },
      },
    };
    saveConfig(liveConfig);
    const patch = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        refreshCodexCatalog: async () => {},
      });
    };

    // Clearing user-managed headers must not delete the registry-owned static
    // metadata (opencode-free's User-Agent and x-opencode-client markers) the transport
    // relies on.
    expect((await patch("opencode-free", { headers: null }))?.status).toBe(200);
    expect(liveConfig.providers["opencode-free"].headers).toEqual({
      "User-Agent": "opencode",
      "x-opencode-client": "desktop",
    });
    const saved = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf8")) as OcxConfig;
    expect(saved.providers["opencode-free"]?.headers).toEqual({
      "User-Agent": "opencode",
      "x-opencode-client": "desktop",
    });
  });
  test("concurrent provider PATCHes merge different headers", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig: OcxConfig = {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "openai",
      openaiProviderTierVersion: 2,
      providers: {
        openai: { ...canonicalDirect },
        hdr: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true },
      },
    };
    saveConfig(liveConfig);
    const patch = async (name: string, body: unknown) => {
      const req = new Request(`http://127.0.0.1/api/providers?name=${name}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return handleManagementAPI(req, new URL(req.url), liveConfig, {
        refreshCodexCatalog: async () => {},
      });
    };

    // Both requests snapshot the same provider before either saves; the lock-scoped
    // re-apply must merge them instead of letting the later save erase the first.
    const [first, second] = await Promise.all([
      patch("hdr", { headers: { "X-A": "a" } }),
      patch("hdr", { headers: { "X-B": "b" } }),
    ]);
    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(liveConfig.providers.hdr.headers).toEqual({ "X-A": "a", "X-B": "b" });
  });
  test("provider context-cap API persists toggles and annotates model rows", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    saveConfig({
      port: 0,
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
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
        body: JSON.stringify({ provider: "test-openai", enabled: true }),
      });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ ok: true, caps: { "test-openai": 350_000 } });

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
        body: JSON.stringify({ provider: "test-openai", enabled: false }),
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
      defaultProvider: "test-openai",
      providers: {
        "test-openai": {
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

      // Enable one provider, then change the global value WITHOUT setAll: the enabled provider
      // keeps its own value and only the shared default changes.
      await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: true }),
      });
      const valued = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 500_000 }),
      });
      expect(valued.status).toBe(200);
      expect(await valued.json()).toMatchObject({ ok: true, value: 500_000, caps: { "test-openai": 350_000 } });

      // Enabling another provider now uses the current global value, not the constant.
      const enabledAfter = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "other", enabled: true }),
      });
      expect(await enabledAfter.json()).toMatchObject({ caps: { "test-openai": 350_000, other: 500_000 } });

      // Catalog reflects each provider's own cap, not the shared default.
      const models = await fetch(new URL("/api/models", server.url));
      const body = await models.json() as Array<{ id: string; contextWindow?: number; contextCap?: number }>;
      expect(body.find(m => m.id === "wide-model")).toMatchObject({ contextWindow: 350_000, contextCap: 350_000 });

      // Changing the global value WITH setAll re-points every enabled provider.
      const valuedAll = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 600_000, setAll: true }),
      });
      expect(await valuedAll.json()).toMatchObject({ ok: true, value: 600_000, caps: { "test-openai": 600_000, other: 600_000 } });

      // Set-all off clears every cap.
      const cleared = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setAll: false }),
      });
      expect(await cleared.json()).toMatchObject({ ok: true, value: 600_000, caps: {} });

      // Set-all on caps every provider at the current value.
      const all = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setAll: true }),
      });
      expect(await all.json()).toMatchObject({ ok: true, caps: { "test-openai": 600_000, other: 600_000 } });

      // Per-provider PUT with an explicit value touches only that provider.
      const perProvider = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: true, value: 250_000 }),
      });
      expect(await perProvider.json()).toMatchObject({ ok: true, caps: { "test-openai": 250_000, other: 600_000 } });

      // Enabling a provider with an explicit value uses that value, not the global default.
      const perProviderDisable = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: false }),
      });
      expect(await perProviderDisable.json()).toMatchObject({ ok: true, caps: { other: 600_000 } });
      const perProviderEnableValue = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: true, value: 128_000 }),
      });
      expect(await perProviderEnableValue.json()).toMatchObject({ ok: true, caps: { "test-openai": 128_000, other: 600_000 } });

      // Invalid global value is rejected.
      const bad = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 0 }),
      });
      expect(bad.status).toBe(400);

      // Invalid per-provider value is rejected before mutating config: the provider cap
      // must not fall back to the global default.
      const badPerProvider = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: true, value: 0 }),
      });
      expect(badPerProvider.status).toBe(400);
      const afterBadPerProvider = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterBadPerProvider.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });

      // A non-boolean setAll accompanying a global value is rejected before mutating config.
      const badSetAll = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 700_000, setAll: "yes" }),
      });
      expect(badSetAll.status).toBe(400);
      const afterBadSetAll = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterBadSetAll.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });

      // A provider field with a wrongly-typed enabled must not fall through to the global
      // value branch and change the global default.
      const badEnabled = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: "yes", value: 700_000 }),
      });
      expect(badEnabled.status).toBe(400);
      const afterBadEnabled = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterBadEnabled.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });

      // A provider update combined with setAll is rejected instead of silently ignoring setAll.
      const mixedPayload = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: true, setAll: true }),
      });
      expect(mixedPayload.status).toBe(400);
      const afterMixedPayload = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterMixedPayload.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });

      // A per-provider value that floors to zero (0.5) is rejected without mutating config:
      // it must not silently fall back to the global default.
      const floorZeroPerProvider = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "test-openai", enabled: true, value: 0.5 }),
      });
      expect(floorZeroPerProvider.status).toBe(400);
      const afterFloorZeroPerProvider = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterFloorZeroPerProvider.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });

      // A global value that floors to zero is rejected the same way.
      const floorZeroGlobal = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 0.5 }),
      });
      expect(floorZeroGlobal.status).toBe(400);
      const afterFloorZeroGlobal = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterFloorZeroGlobal.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });

      // A non-object body (valid JSON) is rejected with 400 instead of crashing on
      // property access.
      const nonObject = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([1, 2, 3]),
      });
      expect(nonObject.status).toBe(400);
      const afterNonObject = await fetch(new URL("/api/provider-context-caps", server.url));
      expect(await afterNonObject.json()).toMatchObject({ value: 600_000, caps: { "test-openai": 128_000, other: 600_000 } });
    } finally {
      await server.stop(true);
    }
  });
});

describe("provider upstreamHttpVersion management contract (#1668)", () => {
  function makeConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "nvidia",
      providers: {
        nvidia: {
          adapter: "openai-chat",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "sk-nvidia",
        },
      },
    };
  }

  // Direct handleManagementAPI calls (no startServer) keep the whole contract in one
  // synchronous authority, matching the request-pacing PATCH tests above.
  async function withRequest(liveConfig: OcxConfig, run: (request: (path: string, init?: RequestInit) => Promise<Response | null>) => Promise<void>): Promise<void> {
    const resolvedError = spyOn(destinationPolicy, "providerDestinationResolvedError")
      .mockResolvedValue(null);
    try {
      const request = async (path: string, init?: RequestInit) => {
        const req = new Request(`http://127.0.0.1${path}`, init);
        return handleManagementAPI(req, new URL(req.url), liveConfig, {
          createManagementConvergeCodex: catalogConvergenceFactory(),
        });
      };
      await run(request);
    } finally {
      resolvedError.mockRestore();
    }
  }

  test("POST accepts a valid upstreamHttpVersion and persists it; GET exposes it", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig = makeConfig();
    saveConfig(liveConfig);
    await withRequest(liveConfig, async (request) => {
      const created = await request("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "h1-provider",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            upstreamHttpVersion: "http1.1",
          },
        }),
      });
      expect(created?.status).toBe(200);
      // Live config, disk reload, and the public GET row must all carry the pin.
      expect(liveConfig.providers["h1-provider"]?.upstreamHttpVersion).toBe("http1.1");
      expect(loadConfig().providers["h1-provider"]?.upstreamHttpVersion).toBe("http1.1");
      const list = await request("/api/providers");
      expect(await list?.json()).toContainEqual(expect.objectContaining({
        name: "h1-provider",
        upstreamHttpVersion: "http1.1",
      }));
    });
  });


  test("POST with upstreamHttpVersion: null persists nothing and survives a reload", async () => {
    // The management validator accepts null as "clear this", but POST persisted the body as
    // submitted while the loader schema rejected null. The provider then failed to parse on the
    // next start and the operator landed in invalid-config recovery for a value the API accepted.
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig = makeConfig();
    saveConfig(liveConfig);
    await withRequest(liveConfig, async (request) => {
      const created = await request("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "null-provider",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            upstreamHttpVersion: null,
          },
        }),
      });
      expect(created?.status).toBe(200);

      // Absent, not null: live, on disk, and after a full reload.
      expect(liveConfig.providers["null-provider"]).toBeDefined();
      expect(Object.hasOwn(liveConfig.providers["null-provider"]!, "upstreamHttpVersion")).toBe(false);

      const onDisk = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf-8")) as any;
      expect(onDisk.providers["null-provider"].upstreamHttpVersion).toBeUndefined();

      const reloaded = loadConfig();
      expect(reloaded.providers["null-provider"]).toBeDefined();
      expect(reloaded.providers["null-provider"]?.upstreamHttpVersion).toBeUndefined();
      // The other providers survived, i.e. the reload did not fall into recovery.
      expect(Object.keys(reloaded.providers).length).toBeGreaterThan(1);

      const list = await request("/api/providers");
      const rows = await list?.json() as any[];
      const row = rows.find(r => r.name === "null-provider");
      expect(row).toBeDefined();
      expect(row.upstreamHttpVersion).toBeUndefined();
    });
  });

  test("a config already holding upstreamHttpVersion: null still loads", async () => {
    // Compatibility for anything the old POST path already wrote to disk.
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig = makeConfig();
    saveConfig(liveConfig);
    const raw = JSON.parse(readFileSync(join(TEST_DIR, "config.json"), "utf-8")) as any;
    const firstProvider = Object.keys(raw.providers)[0]!;
    raw.providers[firstProvider].upstreamHttpVersion = null;
    writeFileSync(join(TEST_DIR, "config.json"), JSON.stringify(raw, null, 2));

    const reloaded = loadConfig();
    expect(reloaded.providers[firstProvider]).toBeDefined();
    expect(reloaded.providers[firstProvider]?.upstreamHttpVersion).toBeUndefined();
    expect(Object.keys(reloaded.providers).length).toBe(Object.keys(raw.providers).length);
  });
  test("POST rejects an invalid upstreamHttpVersion at the write boundary without persisting", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig = makeConfig();
    saveConfig(liveConfig);
    await withRequest(liveConfig, async (request) => {
      const rejected = await request("/api/providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "bad-version",
          provider: {
            adapter: "openai-chat",
            baseUrl: "https://api.example.test/v1",
            upstreamHttpVersion: "http3",
          },
        }),
      });
      expect(rejected?.status).toBe(400);
      expect(await rejected?.json()).toMatchObject({
        error: expect.stringContaining("upstreamHttpVersion"),
      });
      expect(loadConfig().providers["bad-version"]).toBeUndefined();
    });
  });

  test("PATCH sets, then clears upstreamHttpVersion with live + disk persistence", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig = makeConfig();
    saveConfig(liveConfig);
    await withRequest(liveConfig, async (request) => {
      const set = await request("/api/providers?name=nvidia", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upstreamHttpVersion: "http1.1" }),
      });
      expect(set?.status).toBe(200);
      expect(liveConfig.providers.nvidia?.upstreamHttpVersion).toBe("http1.1");
      expect(loadConfig().providers.nvidia?.upstreamHttpVersion).toBe("http1.1");

      const invalid = await request("/api/providers?name=nvidia", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upstreamHttpVersion: "h3" }),
      });
      expect(invalid?.status).toBe(400);
      expect(liveConfig.providers.nvidia?.upstreamHttpVersion).toBe("http1.1");

      const clear = await request("/api/providers?name=nvidia", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upstreamHttpVersion: null }),
      });
      expect(clear?.status).toBe(200);
      expect(liveConfig.providers.nvidia?.upstreamHttpVersion).toBeUndefined();
      expect(loadConfig().providers.nvidia?.upstreamHttpVersion).toBeUndefined();
    });
  });

  test("safeConfigDTO exposes upstreamHttpVersion without leaking it into the live row", async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    process.env.OPENCODEX_HOME = TEST_DIR;
    const liveConfig = makeConfig();
    liveConfig.providers.nvidia = {
      ...liveConfig.providers.nvidia!,
      upstreamHttpVersion: "http1.1",
    };
    saveConfig(liveConfig);
    const dto = safeConfigDTO(loadConfig()) as {
      providers?: Record<string, Record<string, unknown>>;
    };
    expect(dto.providers?.nvidia?.upstreamHttpVersion).toBe("http1.1");
  });

  test("providerManagementConfigError rejects invalid upstreamHttpVersion values", () => {
    expect(providerManagementConfigError("x", {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      upstreamHttpVersion: "http3",
    })).toContain("upstreamHttpVersion");
    expect(providerManagementConfigError("x", {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      upstreamHttpVersion: "http1.1",
    })).toBeNull();
    expect(providerManagementConfigError("x", {
      adapter: "openai-chat",
      baseUrl: "https://api.example.test/v1",
      upstreamHttpVersion: 42,
    })).toContain("upstreamHttpVersion");
  });
});
