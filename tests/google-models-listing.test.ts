import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntries, gatherRoutedModels as gatherRoutedModelsDirect } from "../src/codex/catalog";
import { buildModelsRequest } from "../src/oauth";
import { captureModelCacheGeneration, clearModelCache, getStaleCached } from "../src/codex/model-cache";
import { registerAntigravityDiscoveredWireModels, resolveAntigravityWireModelId } from "../src/providers/antigravity-models";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/** Discovery runs on the pinned transport; hand it back the stubbed global. */
const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

const originalFetch = globalThis.fetch;
const originalOpencodexHome = process.env.OPENCODEX_HOME;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  if (originalOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpencodexHome;
});

function configWith(name: string, prov: Partial<OcxProviderConfig>): OcxConfig {
  return {
    providers: { [name]: prov },
  } as unknown as OcxConfig;
}

describe("buildModelsRequest google routing", () => {
  test("ai-studio google uses x-goog-api-key + /v1beta/models", () => {
    const prov = { adapter: "google", authMode: "key", baseUrl: "https://generativelanguage.googleapis.com" } as OcxProviderConfig;
    const { url, headers } = buildModelsRequest(prov, "gk-123", "google");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    expect(headers["x-goog-api-key"]).toBe("gk-123");
    expect(headers["Authorization"]).toBeUndefined();
  });

  test("custom google-adapter provider without googleMode defaults to ai-studio", () => {
    const prov = { adapter: "google", authMode: "key", baseUrl: "https://example.com" } as OcxProviderConfig;
    const { url, headers } = buildModelsRequest(prov, "gk-123", "my-gemini");
    expect(url).toBe("https://example.com/v1beta/models?pageSize=1000");
    expect(headers["x-goog-api-key"]).toBe("gk-123");
  });

  test("Antigravity uses its authenticated CCA model-discovery RPC", () => {
    // A saved config may omit googleMode — the registry's cloud-code-assist mode must win.
    const prov = { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com", liveModels: true } as OcxProviderConfig;
    const { method, url, headers } = buildModelsRequest(prov, "oauth-token", "google-antigravity");
    expect(method).toBe("POST");
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
    expect(headers["Authorization"]).toBe("Bearer oauth-token");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Accept).toBe("application/json");
    expect(headers["x-goog-api-key"]).toBeUndefined();
  });

  test("google-vertex without googleMode resolves vertex via registry, not ai-studio", () => {
    const prov = { adapter: "google", authMode: "key", baseUrl: "https://aiplatform.googleapis.com" } as OcxProviderConfig;
    const { url } = buildModelsRequest(prov, "gk-123", "google-vertex");
    expect(url).toBe("https://aiplatform.googleapis.com/models");
  });
});

describe("Antigravity live model discovery", () => {
  test("uses the CCA agent list and applies CCA metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-discovery-"));
    process.env.OPENCODEX_HOME = home;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "active",
        accounts: [{
          id: "active",
          credential: {
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
            projectId: "project-id",
          },
        }],
      },
    }));
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return Response.json({
        models: {
          "gemini-3.1-pro-low": { maxTokens: 1_048_576, supportsImages: true, supportsThinking: true, thinkingBudget: 1000 },
          "gemini-3.7-flash-tiered": { maxTokens: 1_048_576, supportsImages: true, supportsThinking: true, thinkingBudget: 10000 },
          "future-flash-tiered": { maxTokens: 1_048_576, supportsImages: true, supportsThinking: true, thinkingBudget: 10000 },
          "future-flash-low": { maxTokens: 1_048_576, supportsImages: true, supportsThinking: true, thinkingBudget: 10000 },
          "future-flash-medium": { maxTokens: 1_048_576, supportsImages: true, supportsThinking: true, thinkingBudget: 10000 },
          "future-flash-high": { maxTokens: 1_048_576, supportsImages: true, supportsThinking: true, thinkingBudget: 10000 },
          "future-agent-model": { maxTokens: 333_333, supportsImages: false, supportsThinking: true, thinkingBudget: 7777 },
          "gemini-3.1-flash-image": { maxTokens: 555_555, supportsImages: true },
          "non-agent-command-model": { maxTokens: 222_222 },
          "tab-only-model": { maxTokens: 32_768 },
        },
        agentModelSorts: [{ groups: [{ modelIds: [
          "future-agent-model", "gemini-3.1-pro-low",
          "future-flash-low", "future-flash-medium", "future-flash-high",
        ] }] }],
        tieredModelIds: { flash: ["gemini-3.7-flash-tiered", "future-flash-tiered"] },
        imageGenerationModelIds: ["gemini-3.1-flash-image"],
        tabModelIds: ["tab-only-model"],
        commandModelIds: ["non-agent-command-model"],
      });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels(configWith("google-antigravity", {
        adapter: "google",
        authMode: "oauth",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        project: "configured-project",
        liveModels: true,
        models: ["configured-only"],
      }));
      const live = models.filter(model => model.provider === "google-antigravity");

      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
      expect(seen[0]?.init?.method).toBe("POST");
      expect((seen[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer access-token");
      expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({ project: "configured-project" });
      expect(live.map(model => model.id).sort()).toEqual([
        "future-agent-model",
        "future-flash-high",
        "future-flash-low",
        "future-flash-medium",
        "gemini-3.1-flash-image",
        "gemini-3.1-pro-low",
        "gemini-3.7-flash",
      ]);
      expect(live.find(model => model.id === "gemini-3.1-pro-low")).toMatchObject({
        contextWindow: 1_048_576,
        inputModalities: ["text", "image"],
        reasoningEfforts: [],
      });
      expect(live.find(model => model.id === "future-agent-model")).toMatchObject({
        contextWindow: 333_333,
        inputModalities: ["text"],
        reasoningEfforts: [],
      });
      expect(live.map(model => model.id)).not.toContain("tab-only-model");
      expect(live.map(model => model.id)).not.toContain("non-agent-command-model");

      const catalog = buildCatalogEntries(null, [], live);
      const flashLow = catalog.find(entry => entry.slug === "google-antigravity/gemini-3.1-pro-low");
      const flashHigh = catalog.find(entry => entry.slug === "google-antigravity/gemini-3.7-flash");
      const future = catalog.find(entry => entry.slug === "google-antigravity/future-agent-model");
      expect(flashLow).toMatchObject({
        context_window: 1_048_576,
        max_context_window: 1_048_576,
        auto_compact_token_limit: 943_718,
        input_modalities: ["text", "image"],
      });
      expect(flashLow).not.toHaveProperty("default_reasoning_level");
      expect(flashLow?.supported_reasoning_levels).toEqual([]);
      expect(flashHigh).toBeDefined();
      expect(catalog.map(entry => entry.slug)).not.toContain("google-antigravity/gemini-3.6-flash");
      expect(catalog.map(entry => entry.slug)).not.toContain("google-antigravity/gemini-3.6-flash-medium");
      expect(future).toMatchObject({
        context_window: 333_333,
        max_context_window: 333_333,
        auto_compact_token_limit: 299_999,
        input_modalities: ["text"],
      });
      expect(future).not.toHaveProperty("default_reasoning_level");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("degrades malformed CCA agent IDs to the configured static catalog", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-malformed-discovery-"));
    process.env.OPENCODEX_HOME = home;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "active",
        accounts: [{
          id: "active",
          credential: {
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
            projectId: "project-id",
          },
        }],
      },
    }));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => Response.json({
      models: { "bad\u0000model": { maxTokens: 1_048_576 } },
      agentModelSorts: [{ groups: [{ modelIds: ["bad\u0000model"] }] }],
    })) as typeof fetch;

    try {
      const models = await gatherRoutedModels(configWith("google-antigravity", {
        adapter: "google",
        authMode: "oauth",
        baseUrl: "https://daily-cloudcode-pa.googleapis.com",
        liveModels: true,
        models: ["configured-only"],
      }));

      expect(models.filter(model => model.provider === "google-antigravity").map(model => model.id))
        .toEqual(["configured-only"]);
      expect(getStaleCached("google-antigravity")).toBeNull();
    } finally {
      warning.mockRestore();
      removeTreeWithRetry(home);
    }
  });

  test("does not register wire mappings from a stale CCA discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-stale-discovery-"));
    process.env.OPENCODEX_HOME = home;
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      "google-antigravity": {
        activeAccountId: "active",
        accounts: [{
          id: "active",
          credential: {
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 3_600_000,
            projectId: "project-id",
          },
        }],
      },
    }));
    let releaseResponse!: () => void;
    let markFetchStarted!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    const fetchStarted = new Promise<void>(resolve => { markFetchStarted = resolve; });
    const baseUrl = "https://cca-stale-discovery.example";
    const priorGeneration = captureModelCacheGeneration("google-antigravity");
    registerAntigravityDiscoveredWireModels(baseUrl, [{ id: "stale-model", wireModelId: "old-wire-model" }], {
      provider: "google-antigravity",
      cacheGeneration: priorGeneration,
    });
    expect(resolveAntigravityWireModelId("stale-model", baseUrl)).toBe("old-wire-model");
    globalThis.fetch = (async () => {
      markFetchStarted();
      await responseGate;
      return Response.json({
        models: { "stale-wire-model": { displayName: "Stale Model" } },
        agentModelSorts: [{ groups: [{ modelIds: ["stale-wire-model"] }] }],
      });
    }) as typeof fetch;

    try {
      const pending = gatherRoutedModels(configWith("google-antigravity", {
        adapter: "google",
        authMode: "oauth",
        baseUrl,
        project: "configured-project",
        liveModels: true,
        models: ["configured-only"],
      }));
      await fetchStarted;
      clearModelCache("google-antigravity");
      releaseResponse();

      expect((await pending).filter(model => model.provider === "google-antigravity").map(model => model.id))
        .toEqual(["configured-only"]);
      expect(resolveAntigravityWireModelId("stale-model", baseUrl)).toBe("stale-model");
    } finally {
      removeTreeWithRetry(home);
    }
  });

  test("uses the configured key for a custom CCA provider", async () => {
    const seen: { headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      return Response.json({
        models: { "custom-agent-model": { maxTokens: 1_048_576 } },
        agentModelSorts: [{ groups: [{ modelIds: ["custom-agent-model"] }] }],
      });
    }) as typeof fetch;

    const models = await gatherRoutedModels(configWith("custom-cca", {
      adapter: "google",
      authMode: "key",
      apiKey: "custom-cca-key",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      googleMode: "cloud-code-assist",
      project: "configured-project",
      liveModels: true,
    }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.Authorization).toBe("Bearer custom-cca-key");
    expect(models.filter(model => model.provider === "custom-cca").map(model => model.id))
      .toEqual(["custom-agent-model"]);
  });
});

describe("buildModelsRequest anthropic routing", () => {
  test("normalizes a /v1 baseUrl and keeps the Anthropic models path singular", () => {
    const prov = {
      adapter: "anthropic",
      authMode: "key",
      apiKeyTransport: "bearer",
      baseUrl: "https://gateway.example.com/v1",
    } as OcxProviderConfig;
    const { url, headers } = buildModelsRequest(prov, "sk-ant", "gateway");
    expect(url).toBe("https://gateway.example.com/v1/models?limit=1000");
    expect(headers["Authorization"]).toBe("Bearer sk-ant");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("uses x-api-key by default for key-auth Anthropic providers", () => {
    const prov = {
      adapter: "anthropic",
      authMode: "key",
      baseUrl: "https://gateway.example.com",
    } as OcxProviderConfig;
    const { url, headers } = buildModelsRequest(prov, "sk-ant", "gateway");
    expect(url).toBe("https://gateway.example.com/v1/models?limit=1000");
    expect(headers["x-api-key"]).toBe("sk-ant");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("google models listing via catalog", () => {
  test("treats a { models } 2xx shape as malformed and degrades to the static seed", async () => {
    clearModelCache("google");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const seen: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({
        models: [
          { name: "models/gemini-3-pro", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-3-flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent"] },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      const models = await gatherRoutedModels(configWith("google", {
        adapter: "google",
        authMode: "key",
        apiKey: "gk-123",
        baseUrl: "https://generativelanguage.googleapis.com",
      }));

      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
      expect(seen[0].headers["x-goog-api-key"]).toBe("gk-123");
      const ids = models.filter(m => m.provider === "google").map(m => m.id);
      expect(ids).toEqual(["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"]);
      expect(ids).not.toContain("gemini-3-pro");
      expect(ids).not.toContain("gemini-3-flash");
      expect(getStaleCached("google")).toBeNull();
      expect(warning.mock.calls.flat().join(" ")).toContain("google");
    } finally {
      warning.mockRestore();
    }
  });
});

describe("models fetch failure cooldown", () => {
  test("a failed provider fetch is not retried within the cooldown window", async () => {
    clearModelCache("flaky");
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("connect refused");
    }) as typeof fetch;

    const config = configWith("flaky", {
      adapter: "openai-chat",
      authMode: "key",
      apiKey: "k",
      baseUrl: "https://flaky.invalid/v1",
      models: ["alpha"],
    });

    const first = await gatherRoutedModels(config);
    expect(fetchCalls).toBe(1);
    expect(first.map(m => `${m.provider}/${m.id}`)).toContain("flaky/alpha");

    // Second poll inside the cooldown: no new fetch, still serves the configured fallback.
    const second = await gatherRoutedModels(config);
    expect(fetchCalls).toBe(1);
    expect(second.map(m => `${m.provider}/${m.id}`)).toContain("flaky/alpha");

    // clearModelCache resets the cooldown too, forcing a live re-fetch.
    clearModelCache("flaky");
    await gatherRoutedModels(config);
    expect(fetchCalls).toBe(2);
  });
});
