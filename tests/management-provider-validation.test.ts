import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { clearModelCache, markProviderDiscoveryFailed } from "../src/codex/model-cache";
import type { OcxConfig } from "../src/types";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

// Full-suite Windows load: startServer + multi-step provider PATCH/GET flows exceed the
// default 5s per-test budget (same flake class as 810fa115 / claude-management-api).
setDefaultTimeout(30_000);

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousOpencodexHome = process.env.OPENCODEX_HOME;
const originalGlobalFetch = globalThis.fetch;
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
  test("provider discovery status is additive and omitted before an attempt", async () => {
    markProviderDiscoveryFailed("auth-broken", { reason: "http", httpStatus: 401 });
    try {
      const requestUrl = new URL("http://127.0.0.1/api/providers");
      const response = await handleManagementAPI(
        new Request(requestUrl),
        requestUrl,
        {
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
        ["map", { ...canonicalDirect, modelContextWindows: { "gpt-5.6": 1 } }],
        ["header", { ...canonicalDirect, headers: { "x-forged": "value" } }],
        ["capability", { ...canonicalDirect, noVisionModels: ["gpt-5.6"] }],
      ] as const) {
        const response = await fetch(new URL("/api/providers", server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "openai", provider }),
        });
        expect(response.status).toBe(400);
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
      refreshCodexCatalog: async () => { catalogRefreshes += 1; },
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
        refreshCodexCatalog: async () => { catalogRefreshes += 1; },
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

      // Enable one provider, then change the global value: the enabled provider re-points.
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
      expect(await valued.json()).toMatchObject({ ok: true, value: 500_000, caps: { "test-openai": 500_000 } });

      // Enabling another provider now uses the current global value, not the constant.
      const enabledAfter = await fetch(new URL("/api/provider-context-caps", server.url), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "other", enabled: true }),
      });
      expect(await enabledAfter.json()).toMatchObject({ caps: { "test-openai": 500_000, other: 500_000 } });

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
      expect(await all.json()).toMatchObject({ ok: true, caps: { "test-openai": 500_000, other: 500_000 } });

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
});
