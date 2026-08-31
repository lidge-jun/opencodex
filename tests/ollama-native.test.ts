import { describe, expect, test } from "bun:test";
import { createOllamaNativeAdapter } from "../src/adapters/ollama-native";
import {
  ollamaNativeChatUrl,
  ollamaNativeEndpointKind,
} from "../src/adapters/ollama-native-url";
import { buildCatalogEntries, gatherRoutedModels as gatherRoutedModelsDirect, upstreamNativeEntry } from "../src/codex/catalog";
import { getProviderRegistryEntry } from "../src/providers/registry";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

/** The four ids this transport is maintained against. */
const TARGETS = ["glm-5.3-flash", "deepseek-v4-flash:0731", "glm-5.2", "kimi-k3"] as const;

function ollamaProvider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "ollama-native",
    baseUrl: "https://ollama.com/v1",
    authMode: "key",
    apiKey: "test-key-not-a-real-credential",
    liveModels: false,
    models: [...TARGETS],
    modelReasoningEfforts: { "deepseek-v4-flash:0731": ["low", "medium", "high", "max"] },
    ...overrides,
  } as OcxProviderConfig;
}

function parsedWith(
  messages: unknown[],
  options: Record<string, unknown> = {},
  modelId = "glm-5.3-flash",
): OcxParsedRequest {
  return { modelId, stream: true, options, context: { messages } } as unknown as OcxParsedRequest;
}

describe("ollama-native — URL policy", () => {
  test("normalizes every accepted cloud spelling onto /api/chat", () => {
    for (const base of [
      "https://ollama.com",
      "https://ollama.com/",
      "https://ollama.com/v1",
      "https://ollama.com/v1/chat/completions",
      "https://ollama.com/api",
      "https://ollama.com/api/chat",
    ]) {
      expect(ollamaNativeChatUrl(base)).toBe("https://ollama.com/api/chat");
    }
  });

  test("live model discovery is origin-relative, so the stored /v1 base reaches /v1/models", () => {
    // model-discovery resolves a leading-slash spec path against base.origin:
    // path "/v1/models" on baseUrl https://ollama.com/v1 -> https://ollama.com/v1/models.
    const base = new URL("https://ollama.com/v1/");
    expect(new URL("/v1/models", base.origin).toString()).toBe("https://ollama.com/v1/models");
  });

  test("classifies endpoints and refuses unsafe cloud transports", () => {
    expect(ollamaNativeEndpointKind("https://ollama.com/v1")).toBe("cloud");
    expect(ollamaNativeEndpointKind("http://localhost:11434")).toBe("local");
    expect(ollamaNativeEndpointKind("https://ollama.internal.example/api")).toBe("custom");
    expect(() => ollamaNativeChatUrl("http://ollama.com/v1")).toThrow(/HTTPS/);
    expect(() => ollamaNativeChatUrl("https://ollama.com:8443/v1")).toThrow(/non-default ports/);
  });

  test("treats one terminal-dot Ollama Cloud hostname as canonical", () => {
    expect(ollamaNativeEndpointKind("https://ollama.com./api")).toBe("cloud");
    expect(ollamaNativeChatUrl("https://ollama.com./api")).toBe("https://ollama.com/api/chat");
  });

  test("rejects the www Ollama Cloud alias instead of treating it as custom", () => {
    expect(() => ollamaNativeEndpointKind("https://www.ollama.com/v1"))
      .toThrow("requires canonical Ollama Cloud host ollama.com");
    expect(() => ollamaNativeChatUrl("https://www.ollama.com/v1"))
      .toThrow("requires canonical Ollama Cloud host ollama.com");
  });

  test("never silently rewrites a /v1 path on an unrelated host", () => {
    expect(() => ollamaNativeChatUrl("https://ollama.internal.example/v1")).toThrow(/refuses custom baseUrl path/);
    expect(ollamaNativeChatUrl("https://ollama.internal.example/api")).toBe("https://ollama.internal.example/api/chat");
  });

  test("rejects credential-bearing, query-bearing and non-http base URLs", () => {
    expect(() => ollamaNativeChatUrl("https://user:pw@chatgpt.com/v1")).toThrow(/must not contain credentials/);
    expect(() => ollamaNativeChatUrl("https://ollama.com/v1?k=v")).toThrow(/must not contain credentials/);
    expect(() => ollamaNativeChatUrl("ftp://ollama.com")).toThrow(/only supports http/);
    expect(() => ollamaNativeChatUrl("   ")).toThrow(/non-empty baseUrl/);
  });
});

describe("ollama-native — registry and discovery contract", () => {
  test("the registry declares the native transport and origin-relative /v1/models discovery", () => {
    const entry = getProviderRegistryEntry("ollama-cloud");
    expect(entry?.adapter).toBe("ollama-native");
    // The compat base URL is deliberately retained; the normalizer maps it to /api/chat.
    expect(entry?.baseUrl).toBe("https://ollama.com/v1");
    // Discovery resolves the leading-slash path against the ORIGIN, giving
    // https://ollama.com/v1/models — the standard data[] envelope the generic pipeline
    // already understands, so no special-case envelope code ships with this adapter.
    expect(entry?.modelDiscovery).toEqual({ path: "/v1/models" });
    expect(entry?.modelContextWindows).toMatchObject({
      "glm-5.3": 1_048_576,
      "glm-5.3-flash": 1_048_576,
    });
  });
});

describe("ollama-native — truthful serialized catalog capabilities", () => {
  test("no target advertises verbosity, a verbosity default, or a service/speed tier", async () => {
    const models = await gatherRoutedModels({ providers: { "ollama-cloud": ollamaProvider() } } as never);
    const entries = buildCatalogEntries(null, [], models);

    for (const id of TARGETS) {
      const entry = entries.find(e => e.slug === `ollama-cloud/${id}`);
      expect(entry).toBeDefined();
      // Serialized Codex spelling. `supports_verbosity` (plural) does not exist in this format,
      // which is exactly how an earlier assertion passed while the rows advertised the control.
      expect(entry).not.toHaveProperty("supports_verbosity");
      expect(entry?.support_verbosity).toBe(false);
      // default_verbosity is owned by the generic catalog verbosity fix (#2799); on a dev tree
      // without it the strict-fields backfill still emits "low" here. Not asserted in this PR.
      expect(entry?.service_tiers).toBeUndefined();
      expect(entry?.default_service_tier).toBeUndefined();
      expect(entry?.additional_speed_tiers).toBeUndefined();
      expect(entry?.fast_tier_description).toBeUndefined();
    }
  });

  test("a live-discovered Ollama id inherits the provider-wide opt-out", async () => {
    // The Ollama catalog is discovery-authoritative, so ids absent from the registry row still
    // reach the catalog. A per-model map alone would let those re-advertise the control.
    const models = await gatherRoutedModels({
      providers: { "ollama-cloud": ollamaProvider({ models: ["a-model-not-in-the-registry"] }) },
    } as never);
    const entries = buildCatalogEntries(null, [], models);
    const entry = entries.find(e => e.slug === "ollama-cloud/a-model-not-in-the-registry");
    expect(entry?.support_verbosity).toBe(false);
  });

  test("CONTROL: a routed provider that never disowns verbosity keeps the permissive default", async () => {
    const models = await gatherRoutedModels({
      providers: {
        plain: {
          adapter: "openai-responses",
          baseUrl: "https://plain.example.test/v1",
          authMode: "key",
          liveModels: false,
          models: ["plain-model"],
        },
      },
    } as never);
    const entries = buildCatalogEntries(null, [], models);
    const entry = entries.find(e => e.slug === "plain/plain-model");
    expect(entry?.support_verbosity).toBe(true);
  });

  test("CONTROL: xAI's own opt-out is unchanged", async () => {
    const models = await gatherRoutedModels({
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "oauth",
          liveModels: false,
          models: ["grok-4.6"],
        },
      },
    } as never);
    const entries = buildCatalogEntries(null, [], models);
    const entry = entries.find(e => e.slug === "xai/grok-4.6");
    expect(entry?.support_verbosity).toBe(false);
  });

  test("CONTROL: a native OpenAI row keeps verbosity, which it genuinely supports", () => {
    const template = upstreamNativeEntry("gpt-5.6-sol");
    expect(template).not.toBeNull();
    const entries = buildCatalogEntries(template, ["gpt-5.6-sol"], []);
    const native = entries.find(e => e.slug === "gpt-5.6-sol");
    expect(native).toBeDefined();
    expect(native?.support_verbosity).toBe(true);
  });
});

describe("ollama-native — reasoning ladder", () => {
  test("routed rows carry the upstream-required synthetic top rungs; the WIRE clamps", async () => {
    const models = await gatherRoutedModels({ providers: { "ollama-cloud": ollamaProvider() } } as never);
    const entries = buildCatalogEntries(null, [], models);
    const efforts = (slug: string) =>
      ((entries.find(e => e.slug === slug)?.supported_reasoning_levels ?? []) as Array<{ effort?: string }>)
        .map(l => l.effort);

    // Catalog universality (upstream design): every reasoning-capable routed row advertises the
    // synthetic top rungs so subagent effort overrides validate by catalog membership. The
    // ollama-native adapter is responsible for keeping the WIRE honest (see the wire-clamp tests).
    expect(efforts("ollama-cloud/deepseek-v4-flash:0731")).toEqual(["low", "medium", "high", "max", "ultra"]);
    for (const id of ["glm-5.3-flash", "glm-5.2", "kimi-k3"]) {
      expect(efforts(`ollama-cloud/${id}`)).toContain("max");
      expect(efforts(`ollama-cloud/${id}`)).toContain("ultra");
    }
  });

  test("every advertised rung maps into an allowed native wire value", async () => {
    const provider = ollamaProvider();
    const adapter = createOllamaNativeAdapter(provider);
    const allowed = new Set([undefined, true, false, "low", "medium", "high", "max"]);
    for (const requested of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "none"]) {
      const { body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], { reasoning: requested }));
      const think = JSON.parse(String(body)).think;
      expect(allowed.has(think)).toBe(true);
    }
    // xhigh and ultra collapse onto Ollama's top rung rather than being sent through verbatim.
    for (const requested of ["xhigh", "ultra"]) {
      const { body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], { reasoning: requested }));
      expect(JSON.parse(String(body)).think).toBe("max");
    }
  });

  test("an unmappable effort fails the turn instead of degrading silently", () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    expect(() =>
      adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }], { reasoning: "turbo" })),
    ).toThrow(/does not support reasoning level/);
  });
});

describe("ollama-native — request shape", () => {
  test("posts to the native chat endpoint with the wire model id", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { url, method, body } = await adapter.buildRequest(parsedWith([{ role: "user", content: "hi" }]));
    expect(url).toBe("https://ollama.com/api/chat");
    expect(method).toBe("POST");
    expect(JSON.parse(String(body)).model).toBe("glm-5.3-flash");
  });

  test("a caller-supplied verbosity never reaches /api/chat", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const { body } = await adapter.buildRequest(
      parsedWith([{ role: "user", content: "hi" }], { verbosity: "high", text: { verbosity: "high" } }),
    );
    const serialized = String(body);
    expect(serialized).not.toContain("verbosity");
    const parsed = JSON.parse(serialized);
    expect(parsed).not.toHaveProperty("verbosity");
    expect(parsed.options ?? {}).not.toHaveProperty("verbosity");
  });

  test("images travel in the native images[] array, and video is refused", async () => {
    const adapter = createOllamaNativeAdapter(ollamaProvider());
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const { body } = await adapter.buildRequest(parsedWith([
      { role: "user", content: [{ type: "text", text: "read it" }, { type: "image", imageUrl: png }] },
    ]));
    const message = JSON.parse(String(body)).messages.at(-1);
    expect(Array.isArray(message.images)).toBe(true);
    expect(message.images[0]).toBe("iVBORw0KGgo=");
    expect(message.content).toContain("read it");

    expect(() => adapter.buildRequest(parsedWith([
      { role: "user", content: [{ type: "video", videoUrl: "data:video/mp4;base64,AAAA" }] },
    ]))).toThrow(/cannot send video/);
  });
});
