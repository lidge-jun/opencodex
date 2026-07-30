import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatherRoutedModels } from "../src/codex/catalog";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";
import { clearModelCache } from "../src/codex/model-cache";
import { buildModelsRequest } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../src/oauth/key-providers";
import { deriveKeyLoginMap, providerConfigSeed } from "../src/providers/derive";
import {
  extractProviderModelItems,
  providerModelDiscoverySpecError,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
} from "../src/providers/model-discovery";
import { PROVIDER_REGISTRY, type ProviderModelDiscoverySpec } from "../src/providers/registry";
import { routeModel } from "../src/router";
import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import { withRegistryDiscovery } from "./helpers/provider-registry-discovery";

const FIXTURE = readFileSync(join(import.meta.dir, "fixtures/provider-model-discovery.json"), "utf8");
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache("together");
});

function togetherEntry() {
  const entry = PROVIDER_REGISTRY.find(row => row.id === "together");
  if (!entry) throw new Error("missing together registry entry");
  return entry;
}

async function withTogetherDiscovery<T>(
  spec: ProviderModelDiscoverySpec,
  run: () => Promise<T> | T,
): Promise<T> {
  return withRegistryDiscovery("together", spec, run, { preserveCustomDestination: true });
}

function togetherConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  const config: OcxConfig = {
    port: 10100,
    defaultProvider: "together",
    providers: {
      together: {
        adapter: "openai-chat",
        baseUrl: "https://api.together.xyz/v1",
        authMode: "key",
        apiKey: "together-test-key",
        ...overrides,
      },
    },
  };
  return withStubbedProviderFetch(config);
}

describe("registry-owned provider model discovery", () => {
  test("keeps every registry discovery contract inside static safety bounds", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (!entry.modelDiscovery) continue;
      expect(providerModelDiscoverySpecError(entry.modelDiscovery)).toBeNull();
    }
    expect(providerModelDiscoverySpecError({ url: "http://insecure.example/models" }))
      .toContain("https");
    expect(providerModelDiscoverySpecError({ path: "models?unbounded=true" }))
      .toContain("query-free");
    expect(providerModelDiscoverySpecError({ path: "../../internal/models" }))
      .toContain("parent-directory");
    expect(providerModelDiscoverySpecError({ path: "models/../internal" }))
      .toContain("parent-directory");
    expect(providerModelDiscoverySpecError({ path: "models/model..variant" })).toBeNull();
    expect(providerModelDiscoverySpecError({
      url: "https://api.example.test/models",
      path: "models",
    } as unknown as ProviderModelDiscoverySpec)).toContain("mutually exclusive");
    expect(providerModelDiscoverySpecError({ maxModels: 25 })).toBeNull();
  });

  test("limits collision preservation to fixed API-key destinations", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.preserveCustomDestination !== true) continue;
      expect(entry.authKind).toBe("key");
      expect(entry.allowBaseUrlOverride).not.toBe(true);
      expect(entry.baseUrl).not.toMatch(/\{[^}]*\}/);
    }
  });

  test("derives an alternate path and query only for the canonical destination", async () => {
    await withTogetherDiscovery({
      path: "catalog",
      query: { capability: "chat", limit: "100" },
    }, () => {
      const canonical = buildModelsRequest(togetherConfig().providers.together!, "secret", "together");
      expect(canonical.url).toBe("https://api.together.xyz/v1/catalog?capability=chat&limit=100");

      const collidingCustom: OcxProviderConfig = {
        adapter: "openai-chat",
        baseUrl: "https://custom.example/v9",
        authMode: "key",
      };
      const custom = buildModelsRequest(collidingCustom, "secret", "together");
      expect(custom.url).toBe("https://custom.example/v9/models");
      expect(custom.headers.Authorization).toBe("Bearer secret");
    });
  });

  test("uses the registry discovery URL for API-key validation without following redirects", async () => {
    await withTogetherDiscovery({
      path: "catalog",
      query: { capability: "chat", limit: "1" },
    }, async () => {
      globalThis.fetch = (async (input, init) => {
        expect(String(input)).toBe("https://api.together.xyz/v1/catalog?capability=chat&limit=1");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        expect(init?.redirect).toBe("error");
        return Response.json({ data: [] });
      }) as typeof fetch;

      expect(await validateApiKey("together", KEY_LOGIN_PROVIDERS.together!, "secret")).toBe(true);
    });
  });

  test("pins fixed OAuth discovery before resolving relative and default endpoints", async () => {
    const staleConfig: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://untrusted.example/v9",
      authMode: "oauth",
    };

    await withRegistryDiscovery("anthropic", { path: "catalog" }, () => {
      const relative = buildModelsRequest(staleConfig, "oauth-token", "anthropic");
      expect(relative.url).toBe("https://api.anthropic.com/catalog");
      expect(relative.headers.Authorization).toBe("Bearer oauth-token");
    });

    await withRegistryDiscovery("anthropic", { maxModels: 25 }, () => {
      const defaultEndpoint = buildModelsRequest(staleConfig, "oauth-token", "anthropic");
      expect(defaultEndpoint.url).toBe("https://api.anthropic.com/v1/models?limit=1000");
    });
  });

  test("keeps adapter-specific OAuth transport resolution after registry pinning", async () => {
    await withRegistryDiscovery("xai", { path: "catalog" }, () => {
      const request = buildModelsRequest({
        adapter: "openai-chat",
        baseUrl: "https://untrusted.example/v9",
        authMode: "oauth",
      }, "oauth-token", "xai");
      expect(request.url).toBe("https://cli-chat-proxy.grok.com/v1/catalog");
    });
  });

  test("does not persist trusted discovery or collision policy into provider config", async () => {
    await withTogetherDiscovery({ path: "catalog", query: { capability: "chat" } }, () => {
      const entry = togetherEntry();
      expect(providerConfigSeed(entry)).not.toHaveProperty("modelDiscovery");
      expect(providerConfigSeed(entry)).not.toHaveProperty("preserveCustomDestination");
      expect(deriveKeyLoginMap().together).not.toHaveProperty("modelDiscovery");
      expect(deriveKeyLoginMap().together).not.toHaveProperty("preserveCustomDestination");
    });
  });

  test("filters mixed catalogs and retains bounded representative metadata", async () => {
    await withTogetherDiscovery({
      filter: {
        anyOf: [{ path: ["type"], equalsAny: ["chat"], caseInsensitive: true }],
      },
    }, async () => {
      globalThis.fetch = (async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer together-test-key");
        return new Response(FIXTURE, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const models = await gatherRoutedModels(togetherConfig());
      const together = models.filter(model => model.provider === "together");
      expect(together).toHaveLength(1);
      expect(together[0]).toMatchObject({
        id: "acme/chat-pro",
        contextWindow: 262_144,
        maxInputTokens: 250_000,
        inputModalities: ["text", "image"],
        capabilities: ["tools", "reasoning"],
      });
    });
  });

  test("accepts Together-style top-level /models arrays for catalog discovery (#617)", async () => {
    await withTogetherDiscovery({}, async () => {
      globalThis.fetch = (async () => Response.json([
        { id: "meta/llama", type: "chat" },
        { id: "Qwen/Qwen", type: "chat" },
      ])) as typeof fetch;
      const models = await gatherRoutedModels(togetherConfig());
      expect(models.filter(model => model.provider === "together").map(model => model.id))
        .toEqual(["meta/llama", "Qwen/Qwen"]);
    });
  });

  test("accepts only positive safe-integer token limits from live metadata", () => {
    expect(catalogHintsFromModelsApiItem("example", {
      id: "fractional",
      context_size: 1_000,
      max_input_tokens: 0.5,
    })).toEqual({ contextWindow: 1_000 });

    expect(catalogHintsFromModelsApiItem("example", {
      id: "unsafe",
      context_size: Number.MAX_SAFE_INTEGER + 1,
      max_input_tokens: Number.MAX_SAFE_INTEGER + 1,
    })).toEqual({});
  });

  test("drops untrusted metadata tokens containing control characters", () => {
    expect(catalogHintsFromModelsApiItem("example", {
      id: "controlled",
      capabilities: {
        "to\u0000ols": true,
        "\u001b[31mreasoning": true,
        vision: true,
      },
      input_modalities: ["te\u0000xt"],
      reasoning_efforts: ["h\u2028igh", "low"],
    })).toEqual({
      reasoningEfforts: ["low"],
      inputModalities: ["text", "image"],
      capabilities: ["vision"],
    });
  });

  test("rejects an over-limit raw catalog instead of truncating or caching it", async () => {
    await withTogetherDiscovery({ maxModels: 2 }, async () => {
      const warning = spyOn(console, "warn").mockImplementation(() => {});
      globalThis.fetch = (async () => Response.json({
        data: [{ id: "one" }, { id: "two" }, { id: "three" }],
      })) as typeof fetch;
      try {
        const models = await gatherRoutedModels(togetherConfig({ models: ["safe-fallback"] }));
        expect(models.filter(model => model.provider === "together").map(model => model.id))
          .toEqual(["safe-fallback"]);
        expect(warning.mock.calls.flat().join(" ")).toContain("2-row model limit");
      } finally {
        warning.mockRestore();
      }
    });
  });

  test("rejects a missing-or-lying Content-Length body as soon as streamed bytes exceed the cap", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(40));
        controller.enqueue(new Uint8Array(40));
      },
      cancel() {
        cancelled = true;
      },
    }));

    const result = await readBoundedDiscoveryJson(response, 64);
    expect(result).toEqual({ ok: false, reason: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  test("rejects invalid UTF-8 before JSON parsing", async () => {
    const invalidUtf8Json = new Uint8Array([
      0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
    ]);
    expect(await readBoundedDiscoveryJson(new Response(invalidUtf8Json), 64))
      .toEqual({ ok: false, reason: "invalid_json" });
  });

  test("deduplicates eligible rows only after enforcing the raw-row ceiling", () => {
    const discovery = resolveProviderModelDiscovery("unknown-provider", {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
    });
    const result = extractProviderModelItems({
      data: [
        { id: "chat-a", kind: "chat" },
        { id: "chat-a", kind: "chat" },
        { id: "embed-a", kind: "embedding" },
      ],
    }, {
      ...discovery,
      maxModels: 3,
      spec: { filter: { anyOf: [{ path: ["kind"], equalsAny: ["chat"] }] } },
    });
    expect(result).toEqual({
      ok: true,
      rawCount: 3,
      items: [{ id: "chat-a", kind: "chat" }],
    });
  });

  test("rejects control characters and outer whitespace in provider-native model ids", () => {
    const discovery = resolveProviderModelDiscovery("unknown-provider", {
      adapter: "openai-chat",
      baseUrl: "https://example.test/v1",
    });
    for (const id of [" padded/model", "model\nwith-control"]) {
      expect(extractProviderModelItems({ data: [{ id }] }, discovery))
        .toEqual({ ok: false, reason: "invalid_shape" });
    }
  });
});

describe("same-named custom provider preservation", () => {
  test("keeps an opted-in fixed key-provider collision on its configured destination and adapter", async () => {
    await withTogetherDiscovery({}, () => {
      for (const baseUrl of ["https://custom.example/anthropic", "https://api.together.xyz/v1"]) {
        const routed = routeModel({
          port: 10100,
          defaultProvider: "together",
          providers: {
            together: {
              adapter: "anthropic",
              baseUrl,
              authMode: "key",
              apiKey: "custom-key",
            },
          },
        }, "together/custom-model");

        expect(routed.provider).toMatchObject({
          adapter: "anthropic",
          baseUrl,
          authMode: "key",
          apiKey: "custom-key",
        });
      }
    });
  });

  test("continues pinning OAuth credentials to the canonical registry destination", () => {
    const routed = routeModel({
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://custom.example/v1",
          authMode: "oauth",
        },
      },
    }, "xai/grok-4.5");

    expect(routed.provider.baseUrl).toBe("https://api.x.ai/v1");
    expect(routed.provider.authMode).toBe("oauth");
  });
});
