import { afterEach, describe, expect, test } from "bun:test";
import { buildModelsRequest } from "../src/oauth";
import { deriveProviderPresets, enrichProviderFromRegistry } from "../src/providers/derive";
import { FREE_PROVIDER_ACCESS_GROUPS, FREE_PROVIDER_DIRECTORY } from "../src/providers/free-directory";
import { getProviderRegistryEntry, PROVIDER_REGISTRY } from "../src/providers/registry";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "openai",
  providers: {},
};

function discover(presetId: string, provider: OcxProviderConfig): Promise<Response | null> {
  const url = new URL("http://127.0.0.1:10100/api/provider-presets/discover");
  return handleManagementAPI(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ presetId, provider }),
  }), url, config);
}

describe("free provider directory", () => {
  test("encodes the exact four groups, one 81-provider union, and only the declared overlap", () => {
    expect(FREE_PROVIDER_ACCESS_GROUPS["recurring-or-keyless"]).toHaveLength(43);
    expect(FREE_PROVIDER_ACCESS_GROUPS["recurring-uncapped"]).toHaveLength(13);
    expect(FREE_PROVIDER_ACCESS_GROUPS["recurring-credit"]).toHaveLength(2);
    expect(FREE_PROVIDER_ACCESS_GROUPS["signup-credit"]).toHaveLength(24);
    expect(FREE_PROVIDER_DIRECTORY).toHaveLength(81);
    expect(new Set(FREE_PROVIDER_DIRECTORY.map(row => row.id)).size).toBe(81);
    const memberships = FREE_PROVIDER_DIRECTORY.filter(row => row.accessGroups.length > 1);
    expect(memberships.map(row => row.id)).toEqual(["glm-cn"]);
    expect(memberships[0]?.accessGroups).toEqual(["recurring-uncapped", "signup-credit"]);
    expect(FREE_PROVIDER_DIRECTORY.filter(row => row.discovery === "static" && !row.models?.length).map(row => row.id)).toEqual(["kiro"]);
  });

  test("merges requested ids into the registry once and exposes all 81 as presets", () => {
    const requested = new Set(FREE_PROVIDER_DIRECTORY.map(row => row.id));
    expect(PROVIDER_REGISTRY.filter(row => requested.has(row.id))).toHaveLength(81);
    expect(new Set(PROVIDER_REGISTRY.map(row => row.id)).size).toBe(PROVIDER_REGISTRY.length);
    expect(deriveProviderPresets().filter(row => row.accessGroups?.length)).toHaveLength(81);
    expect(PROVIDER_REGISTRY.filter(row => row.accessGroups?.length && row.discovery === "static" && !row.models?.length)).toEqual([]);
    expect(getProviderRegistryEntry("pollinations")?.keyOptional).toBe(true);
    expect(getProviderRegistryEntry("siliconflow")?.baseUrlChoices).toEqual([
      { id: "china-mainland", label: "China mainland", baseUrl: "https://api.siliconflow.cn/v1" },
      { id: "international", label: "International", baseUrl: "https://api.siliconflow.com/v1" },
    ]);
    for (const directory of FREE_PROVIDER_DIRECTORY) {
      const registered = getProviderRegistryEntry(directory.id);
      expect({ adapter: registered?.adapter, baseUrl: registered?.baseUrl, authKind: registered?.authKind })
        .toEqual({ adapter: directory.adapter, baseUrl: directory.baseUrl, authKind: directory.authKind });
    }
  });

  test("buildModelsRequest uses a trusted modelsUrl only for the canonical endpoint", () => {
    const cohere = getProviderRegistryEntry("cohere")!;
    const canonical = buildModelsRequest({ adapter: cohere.adapter, baseUrl: cohere.baseUrl, authMode: "key" }, "secret", "cohere");
    expect(canonical.url).toBe("https://api.cohere.com/compatibility/v1/models");
    const custom = buildModelsRequest({ adapter: cohere.adapter, baseUrl: "https://proxy.example/v1", authMode: "key" }, "secret", "cohere");
    expect(custom.url).toBe("https://proxy.example/v1/models");
  });

  test("registry enrichment preserves the Vertex transport mode used by saved presets", () => {
    const provider: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://aiplatform.googleapis.com",
      authMode: "key",
      apiKey: "secret",
    };
    enrichProviderFromRegistry("vertex", provider);
    expect(provider.googleMode).toBe("vertex");
  });

  test("blocks reference-only presets before any network request", async () => {
    let called = false;
    globalThis.fetch = (() => { called = true; return Promise.reject(new Error("unexpected")); }) as typeof fetch;
    const response = await discover("duckduckgo-web", { adapter: "openai-chat", baseUrl: "https://duckduckgo.com", authMode: "key" });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "reference-only provider presets cannot be connected automatically" });
    expect(called).toBe(false);
  });

  test("only accepts resolved template URLs that stay on the trusted preset path", async () => {
    let called = false;
    globalThis.fetch = (() => { called = true; return Promise.reject(new Error("unexpected")); }) as typeof fetch;
    for (const baseUrl of [
      "https://attacker.example/client/v4/accounts/account/ai/v1",
      "https://api.cloudflare.com/client/v4/accounts/../ai/v1",
      "https://api.cloudflare.com/client/v4/accounts/%2e%2e/ai/v1",
    ]) {
      const response = await discover("cloudflare-ai", {
        adapter: "openai-chat",
        baseUrl,
        authMode: "key",
        apiKey: "secret",
      });
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: "provider baseUrl does not match the trusted preset" });
    }
    expect(called).toBe(false);

    const resolved = await discover("cloudflare-ai", {
      adapter: "openai-chat",
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/account-id/ai/v1",
      authMode: "key",
      apiKey: "secret",
    });
    expect(resolved?.status).toBe(200);
    expect(await resolved?.json()).toMatchObject({ ok: true, source: "static" });
    expect(called).toBe(false);
  });

  test("returns normalized live models without persisting the provider", async () => {
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toBe("https://api.cohere.com/compatibility/v1/models");
      expect(init?.redirect).toBe("error");
      return Response.json({ data: [{ id: "command-a", context_window: 256000 }, { id: "command-a" }] });
    }) as typeof fetch;
    const response = await discover("cohere", { adapter: "openai-chat", baseUrl: "https://api.cohere.com/compatibility/v1", authMode: "key", apiKey: "secret" });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ ok: true, source: "live", models: [{ id: "command-a", contextWindow: 256000 }] });
    expect(config.providers.cohere).toBeUndefined();
  });

  test("accepts only SiliconFlow's two official regional endpoints for discovery", async () => {
    let calls = 0;
    globalThis.fetch = (async input => {
      calls += 1;
      expect(String(input)).toBe("https://api.siliconflow.com/v1/models");
      return Response.json({ data: [{ id: "Qwen/Qwen3-Coder" }] });
    }) as typeof fetch;
    const international = await discover("siliconflow", {
      adapter: "openai-chat",
      baseUrl: "https://api.siliconflow.com/v1",
      authMode: "key",
      apiKey: "secret",
    });
    expect(international?.status).toBe(200);
    expect(await international?.json()).toMatchObject({ ok: true, source: "live", models: [{ id: "Qwen/Qwen3-Coder" }] });

    const arbitrary = await discover("siliconflow", {
      adapter: "openai-chat",
      baseUrl: "https://siliconflow-proxy.example/v1",
      authMode: "key",
      apiKey: "secret",
    });
    expect(arbitrary?.status).toBe(400);
    expect(await arbitrary?.json()).toEqual({ error: "provider baseUrl does not match the trusted preset" });
    expect(calls).toBe(1);
  });

  test("falls back to static models and reports a sanitized live error", async () => {
    globalThis.fetch = (async () => new Response("credential secret should never leak", { status: 503 })) as typeof fetch;
    const response = await discover("openrouter", { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", authMode: "key", apiKey: "secret" });
    const json = await response?.json() as { ok: boolean; source: string; models: unknown[]; error: string };
    expect(json.ok).toBe(true);
    expect(json.source).toBe("static");
    expect(json.models.length).toBeGreaterThan(0);
    expect(json.error).toBe("upstream model discovery returned 503");
    expect(JSON.stringify(json)).not.toContain("secret");
  });
});
