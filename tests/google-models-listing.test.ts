import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels } from "../src/codex/catalog";
import { buildModelsRequest } from "../src/oauth";
import { clearModelCache } from "../src/codex/model-cache";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
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

  test("google-antigravity (oauth) keeps Authorization: Bearer via registry backfill", () => {
    // A saved config may omit googleMode — the registry entry (cloud-code-assist) must win.
    const prov = { adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com" } as OcxProviderConfig;
    const { url, headers } = buildModelsRequest(prov, "oauth-token", "google-antigravity");
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/models");
    expect(headers["Authorization"]).toBe("Bearer oauth-token");
    expect(headers["x-goog-api-key"]).toBeUndefined();
  });

  test("google-vertex without googleMode resolves vertex via registry, not ai-studio", () => {
    const prov = { adapter: "google", authMode: "key", baseUrl: "https://aiplatform.googleapis.com" } as OcxProviderConfig;
    const { url } = buildModelsRequest(prov, "gk-123", "google-vertex");
    expect(url).toBe("https://aiplatform.googleapis.com/models");
  });
});

describe("google models listing via catalog", () => {
  test("parses { models } shape, strips models/ prefix, filters non-chat models", async () => {
    clearModelCache("google");
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
    expect(ids).toContain("gemini-3-pro");
    expect(ids).toContain("gemini-3-flash");
    expect(ids).not.toContain("text-embedding-004");
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
