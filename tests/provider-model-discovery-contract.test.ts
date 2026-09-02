import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gatherRoutedModels } from "../src/codex/catalog";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";
import { clearModelCache, getFreshCached, setCached } from "../src/codex/model-cache";
import { buildModelsRequest } from "../src/oauth";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../src/oauth/key-providers";
import { deriveKeyLoginMap, providerConfigSeed } from "../src/providers/derive";
import {
  extractProviderModelItems,
  providerModelDiscoverySpecError,
  readBoundedDiscoveryJson,
  resolveProviderModelDiscovery,
  resolveProviderModelDiscoveryUrl,
} from "../src/providers/model-discovery";
import {
  PROVIDER_REGISTRY,
  registryEntryForProviderDestination,
  type ProviderModelDiscoverySpec,
} from "../src/providers/registry";
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
    for (const path of [
      "../../internal/models",
      "models/../internal",
      "models/%2e%2e/internal",
      "models/.%2E/internal",
      "models/%2e./internal",
    ]) {
      expect(providerModelDiscoverySpecError({ path })).toContain("parent-directory");
    }
    expect(providerModelDiscoverySpecError({ path: "../models/search" })).toBeNull();
    expect(providerModelDiscoverySpecError({ path: String.raw`models\..\internal` }))
      .toContain("forward slashes");
    expect(providerModelDiscoverySpecError({ path: "models/model..variant" })).toBeNull();
    expect(providerModelDiscoverySpecError({
      url: "https://api.example.test/models",
      path: "models",
    } as unknown as ProviderModelDiscoverySpec)).toContain("mutually exclusive");
    expect(providerModelDiscoverySpecError({ maxModels: 25 })).toBeNull();
  });

  test("clears cached rows before applying a temporary registry discovery policy", async () => {
    setCached("together", []);
    expect(getFreshCached("together", 60_000)).toEqual([]);

    await withTogetherDiscovery({ maxModels: 25 }, () => {
      expect(getFreshCached("together", 60_000)).toBeNull();
    });
  });

  test("limits collision preservation to fixed API-key destinations", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (entry.preserveCustomDestination !== true) continue;
      expect(entry.authKind).toBe("key");
      expect(entry.allowBaseUrlOverride).not.toBe(true);
      expect(entry.baseUrl).not.toMatch(/\{[^}]*\}/);
    }
  });

  test("keeps discovery-bearing fixed key destinations unambiguous for renamed presets", () => {
    for (const entry of PROVIDER_REGISTRY) {
      if (!entry.modelDiscovery || entry.authKind !== "key") continue;
      if (entry.allowBaseUrlOverride || /\{[^}]*\}/.test(entry.baseUrl)) continue;
      expect(registryEntryForProviderDestination({
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
        authMode: "key",
      })?.id).toBe(entry.id);
    }
  });

  test("derives an alternate path and query only for the canonical destination", async () => {
    await withTogetherDiscovery({
      path: "catalog",
      query: { capability: "chat", limit: "100" },
    }, () => {
      const canonical = buildModelsRequest(togetherConfig().providers.together!, "secret", "together");
      expect(canonical.url).toBe("https://api.together.xyz/v1/catalog?capability=chat&limit=100");

      const renamedCanonical = buildModelsRequest(
        togetherConfig().providers.together!,
        "secret",
        "together-team",
      );
      expect(renamedCanonical.url)
        .toBe("https://api.together.xyz/v1/catalog?capability=chat&limit=100");

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

    await withRegistryDiscovery("kimi", { path: "catalog" }, () => {
      const relative = buildModelsRequest(staleConfig, "oauth-token", "kimi");
      expect(relative.url).toBe("https://api.kimi.com/coding/v1/catalog");
      expect(relative.headers.Authorization).toBe("Bearer oauth-token");
    });

    await withRegistryDiscovery("kimi", { maxModels: 25 }, () => {
      const defaultEndpoint = buildModelsRequest(staleConfig, "oauth-token", "kimi");
      expect(defaultEndpoint.url).toBe("https://api.kimi.com/coding/v1/models");
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
      id: "valid-output",
      capabilities: { max_output_tokens: 8192 },
    })).toEqual({ maxOutputTokens: 8192 });

    expect(catalogHintsFromModelsApiItem("example", {
      id: "fractional",
      context_size: 1_000,
      max_input_tokens: 0.5,
      capabilities: { max_output_tokens: 0.5 },
    })).toEqual({ contextWindow: 1_000 });

    expect(catalogHintsFromModelsApiItem("example", {
      id: "unsafe",
      context_size: Number.MAX_SAFE_INTEGER + 1,
      max_input_tokens: Number.MAX_SAFE_INTEGER + 1,
      max_output_tokens: Number.MAX_SAFE_INTEGER + 1,
    })).toEqual({});
  });

  test("infers Codex-safe input modalities from bounded architecture metadata", () => {
    expect(catalogHintsFromModelsApiItem("example", {
      id: "vision-chat",
      architecture: { modality: "text+image->text" },
    })).toEqual({ inputModalities: ["text", "image"] });

    expect(catalogHintsFromModelsApiItem("example", {
      id: "unknown-input",
      architecture: { modality: "text+video->text" },
    })).toEqual({ inputModalities: ["text"] });

    expect(catalogHintsFromModelsApiItem("example", {
      id: "controlled",
      architecture: { modality: "text+im\u0000age->text" },
    })).toEqual({});
  });

  test("reads explicit nested vision support from Copilot-style capabilities", () => {
    expect(catalogHintsFromModelsApiItem("github-copilot", {
      id: "vision-model",
      capabilities: { supports: { vision: true } },
    })).toEqual({ inputModalities: ["text", "image"] });

    expect(catalogHintsFromModelsApiItem("github-copilot", {
      id: "text-only-model",
      capabilities: { supports: { vision: false } },
    })).toEqual({ inputModalities: ["text"] });

    expect(catalogHintsFromModelsApiItem("github-copilot", {
      id: "unknown-model",
      capabilities: { supports: { vision: "true" } },
    })).toEqual({});
  });

  test("a flat vision boolean outranks a disagreeing nested one (#2941)", () => {
    // Precedence is by specificity, NOT deny-wins. A deny-wins rule across both levels would flip
    // this shape from image-capable to text-only, silently changing behaviour that predates Copilot
    // support — the flat `true` alone already meant image input. Pinned so it cannot regress.
    expect(catalogHintsFromModelsApiItem("example", {
      id: "flat-true-nested-false",
      capabilities: { vision: true, supports: { vision: false } },
    })).toEqual({ inputModalities: ["text", "image"], capabilities: ["vision"] });

    // The mirror image: a flat denial is authoritative over a nested claim.
    expect(catalogHintsFromModelsApiItem("example", {
      id: "flat-false-nested-true",
      capabilities: { vision: false, supports: { vision: true } },
    })).toEqual({ inputModalities: ["text"] });
  });

  test("the reporter's full Copilot payload is read despite the limits.vision sibling (#2941)", () => {
    // `capabilities` carries a SECOND vision key under `limits` holding an image count. Anything
    // that searched loosely for a vision-ish key would find that object and treat it as a signal.
    expect(catalogHintsFromModelsApiItem("github-copilot", {
      id: "claude-opus-4.6",
      capabilities: {
        supports: { vision: true },
        limits: { vision: { max_prompt_images: 20 } },
      },
    })).toEqual({ inputModalities: ["text", "image"] });
  });

  test("an explicit nested denial outranks a loose capability-array claim, exactly as a flat one does (#2941)", () => {
    // A boolean capability field is a specific statement; a "vision" string in a capability array is
    // a loose one. Flat `false` has always won that contest, and the internal contradiction it
    // produces -- text-only modalities reported next to capabilities: ["vision"] -- predates the
    // nested read. These two shapes must agree, or the nested field would mean something subtly
    // different from the flat field it stands in for.
    const nested = catalogHintsFromModelsApiItem("example", {
      id: "nested-denial-vs-array",
      metadata: { capabilities: { supports: { vision: false } } },
      capabilities: ["vision"],
    });
    const flat = catalogHintsFromModelsApiItem("example", {
      id: "flat-denial-vs-array",
      metadata: { capabilities: { vision: false } },
      capabilities: ["vision"],
    });
    expect(nested).toEqual({ inputModalities: ["text"], capabilities: ["vision"] });
    expect(nested).toEqual(flat);
  });

  test("a non-record supports container decides nothing and leaves the fallback chain intact (#2941)", () => {
    // It must not collapse into a denial either — the `features` signal further down still decides.
    expect(catalogHintsFromModelsApiItem("github-copilot", {
      id: "malformed-container",
      capabilities: { supports: 5 },
      features: ["vision"],
    })).toEqual({
      inputModalities: ["text", "image"],
      capabilities: ["vision"],
    });
  });

  test("explicit item input modalities still outrank a nested Copilot vision claim (#2941)", () => {
    expect(catalogHintsFromModelsApiItem("github-copilot", {
      id: "explicit-audio-model",
      input_modalities: ["audio"],
      capabilities: { supports: { vision: true } },
    })).toEqual({ inputModalities: ["audio"] });
  });

  test("preserves nested reasoning_parameters effort ladders from OpenAI-compatible catalogs", () => {
    expect(catalogHintsFromModelsApiItem("example", {
      id: "reasoning-model",
      reasoning_parameters: { efforts: ["low", "high", "max"] },
    })).toEqual({ reasoningEfforts: ["low", "high", "max"] });
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

  test("cloudflare-workers-ai resolves official search from the /ai/v1 base", () => {
    const url = resolveProviderModelDiscoveryUrl(
      "cloudflare-workers-ai",
      {
        adapter: "openai-chat",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
      },
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/models",
    );
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/ai/models/search?format=openrouter&per_page=1000",
    );
  });

  test("strips workers-ai/ openrouter ids and skips empty remainders for cloudflare-workers-ai", () => {
    const discovery = resolveProviderModelDiscovery("cloudflare-workers-ai", {
      adapter: "openai-chat",
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1",
    });

    const stripped = extractProviderModelItems({
      data: [{ id: "workers-ai/@cf/openai/gpt-oss-120b" }],
    }, discovery);
    expect(stripped).toEqual({
      ok: true,
      rawCount: 1,
      items: [{ id: "@cf/openai/gpt-oss-120b" }],
    });

    const native = extractProviderModelItems({
      result: [{ id: "uuid", name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }],
    }, discovery);
    expect(native).toEqual({ ok: false, reason: "invalid_shape" });

    const mixed = extractProviderModelItems({
      data: [
        { id: "workers-ai/" },
        { id: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
      ],
    }, discovery);
    expect(mixed).toEqual({
      ok: true,
      rawCount: 2,
      items: [{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }],
    });
  });

  test("cloudflare-workers-ai registry owns openrouter search discovery", () => {
    const workers = PROVIDER_REGISTRY.find(row => row.id === "cloudflare-workers-ai");
    const gateway = PROVIDER_REGISTRY.find(row => row.id === "cloudflare-ai-gateway");
    if (!workers || !gateway) throw new Error("missing cloudflare registry entries");

    expect(workers.liveModels).toBe(true);
    expect(workers.modelDiscovery).toEqual({
      path: "../models/search",
      query: { format: "openrouter", per_page: "1000" },
      stripIdPrefix: "workers-ai/",
      maxModels: 256,
    });
    expect(workers.models).toEqual([
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/qwen/qwq-32b",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai-org/glm-5.3",
      "@cf/zai-org/glm-5.3-flash",
      "@cf/zai-org/glm-5.2",
      "@cf/mistralai/mistral-small-3.1-24b-instruct",
    ]);
    expect(gateway.modelDiscovery).toBeUndefined();
    expect(gateway.liveModels).toBeUndefined();
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

  // The destination fallback added with the SambaNova/Nebius batch lets a canonical preset saved
  // under an unknown name recover its registry-owned discovery policy by transport. These tests
  // pin both halves of that boundary: what it must recover, and what it must refuse. Without the
  // negative cases a widened matcher would look green while silently handing one provider's
  // discovery contract to another row.
  describe("renamed-preset destination fallback", () => {
    const nebiusEntry = () => {
      const entry = PROVIDER_REGISTRY.find(row => row.id === "nebius");
      if (!entry) throw new Error("missing nebius registry entry");
      return entry;
    };

    test("recovers path, query AND filter for an unknown-name canonical destination", () => {
      const entry = nebiusEntry();
      const resolved = resolveProviderModelDiscovery("nebius-team", {
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
        authMode: "key",
      });

      // Literal expectations, not a re-read of the same registry row. Comparing the resolved spec
      // against `entry.modelDiscovery` would pass even if both sides changed together, which makes
      // the assertion vacuous: a sabotaged filter stayed green under that formulation.
      expect(resolved.spec?.path).toBe("models");
      expect(resolved.spec?.query).toEqual({ verbose: "true" });
      // The filter is the half the pre-existing renamed-preset test never asserted. A recovered
      // spec without it would admit embedding and image-generation rows into the Codex catalog.
      expect(resolved.spec?.filter).toEqual({
        allOf: [{ path: ["architecture", "modality"], containsAny: ["->text"] }],
      });
      expect(resolved.maxResponseBytes).toBe(512 * 1024);
      expect(resolved.maxModels).toBe(512);
    });

    test("refuses a name that matches a registry entry whose transport does not", () => {
      // A named row is resolved by name or not at all; it must never silently fall through to a
      // destination lookup and acquire some other provider's discovery policy.
      const resolved = resolveProviderModelDiscovery("nebius", {
        adapter: "openai-chat",
        baseUrl: "https://untrusted.example/v9",
        authMode: "key",
      });

      expect(resolved.spec).toBeUndefined();
    });

    test("refuses OAuth destinations reached by an unknown name", () => {
      const oauthEntry = PROVIDER_REGISTRY.find(row => row.authKind === "oauth" && row.modelDiscovery);
      expect(oauthEntry).toBeDefined();

      expect(registryEntryForProviderDestination({
        adapter: oauthEntry!.adapter,
        baseUrl: oauthEntry!.baseUrl,
        authMode: "key",
      })?.id).not.toBe(oauthEntry!.id);

      expect(resolveProviderModelDiscovery("renamed-oauth-row", {
        adapter: oauthEntry!.adapter,
        baseUrl: oauthEntry!.baseUrl,
        authMode: "oauth",
      }).spec).toBeUndefined();
    });

    test("refuses non-key auth modes, templated base URLs, and overridable destinations", () => {
      const entry = nebiusEntry();

      // Non-key auth mode on an otherwise exact destination match.
      expect(registryEntryForProviderDestination({
        adapter: entry.adapter,
        baseUrl: entry.baseUrl,
        authMode: "oauth",
      })).toBeUndefined();

      for (const row of PROVIDER_REGISTRY) {
        const templated = /\{[^}]*\}/.test(row.baseUrl);
        if (!templated && row.allowBaseUrlOverride !== true) continue;
        // Neither class identifies a single vendor route, so neither may be recovered by
        // destination: a templated URL is not a real endpoint, and an overridable one is
        // whatever the user pointed it at.
        const match = registryEntryForProviderDestination({
          adapter: row.adapter,
          baseUrl: row.baseUrl,
          authMode: "key",
        });
        expect(match?.id).not.toBe(row.id);
      }
    });

    test("keeps every fallback-eligible absolute discovery URL same-origin with its own base URL", () => {
      // An absolute spec.url overrides the configured base URL, so a cross-origin one on a
      // fallback-eligible row would send a user's key to an origin they never configured.
      // DeepInfra is the current instance: base /v1/openai, discovery /v1/models, same origin.
      const checked: string[] = [];

      for (const entry of PROVIDER_REGISTRY) {
        const url = entry.modelDiscovery?.url;
        if (!url) continue;
        const eligible = entry.authKind === "key"
          && entry.allowBaseUrlOverride !== true
          && !/\{[^}]*\}/.test(entry.baseUrl);
        if (!eligible) continue;

        expect(new URL(url).origin).toBe(new URL(entry.baseUrl).origin);
        checked.push(entry.id);
      }

      expect(checked).toContain("deepinfra");
    });
  });
});
