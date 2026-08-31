import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels, resetCatalogRuntimeStateForTests, resetOpenAiApiCatalogWarningStateForTests } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";

afterEach(() => {
  // The provider-model cache is keyed by provider name; without this, one test's gather would
  // satisfy the next test's discovery without any outbound call at all.
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetOpenAiApiCatalogWarningStateForTests();
  resetCatalogRuntimeStateForTests();
});

const originalFetch = globalThis.fetch;
import { ollamaShowMetadataFromPayload } from "../src/providers/ollama-show";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import type { OcxConfig } from "../src/types";

/**
 * Bounded /api/show metadata enrichment for Ollama Cloud live discovery.
 * Every test drives the REAL discovery path (gatherRoutedModels) through a stubbed fetch,
 * asserting the resulting CatalogModel rows — never internal call graphs alone.
 */

interface Probe {
  calls: Array<{ url: string; method: string; body: string }>;
}

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string, body: string) => Response,
): { probe: { calls: Array<{ url: string; body: string }>; maxShowActive: () => number }; uninstall: () => void } {
  const calls: Array<{ url: string; body: string }> = [];
  let active = 0;
  let maxActive = 0;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    active += 1;
    maxActive = Math.max(maxActive, active);
    const res = handler(url, body);
    return Promise.resolve(res).finally(() => { active -= 1; });
  }) as typeof fetch;
  return {
    probe: { calls, maxShowActive: () => maxActive },
    uninstall: () => { globalThis.fetch = original; },
  };
}

function ollamaShow(id: string, contextLength: number, capabilities: string[]): Response {
  return jsonRes({
    model_info: {
      "general.architecture": "testarch",
      "testarch.context_length": contextLength,
    },
    capabilities,
  });
}

function config(overrides: Record<string, unknown> = {}): OcxConfig {
  return {
    port: 10114,
    defaultProvider: "ollama-cloud",
    providers: {
      "ollama-cloud": {
        adapter: "ollama-native",
        baseUrl: "https://ollama.com/v1",
        authMode: "key",
        apiKey: "test-key-not-a-real-credential",
        liveModels: true,
        models: [],
      },
      ...overrides,
    },
  } as never as OcxConfig;
}

function row(models: Array<{ provider: string; id: string; contextWindow?: number; inputModalities?: string[] }>, id: string) {
  return models.find(m => m.provider === "ollama-cloud" && m.id === id);
}

function discoveryStub(ids: string[], showFor: (id: string) => Response) {
  return stubFetch((url, body) => {
    if (url.endsWith("/v1/models")) {
      return jsonRes({ object: "list", data: ids.map(id => ({ id, object: "model" })) });
    }
    if (url.endsWith("/api/show")) {
      const parsed = JSON.parse(body || "{}") as { model?: string };
      return showFor(parsed.model ?? "");
    }
    return new Response("nf", { status: 404 });
  });
}

describe("ollama /api/show — context enrichment", () => {
  test("A: discovered glm-5.3 uses /api/show context_length (1,048,576) before any cap", async () => {
    const stub = discoveryStub(["glm-5.3"], () => ollamaShow("glm-5.3", 1_048_576, ["completion", "thinking", "tools"]));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      const glm = row(models, "glm-5.3");
      expect(glm).toBeDefined();
      expect(glm?.contextWindow).toBe(1_048_576);
      const shows = stub.probe.calls.filter(c => c.url.endsWith("/api/show"));
      expect(shows).toHaveLength(1);
      expect(JSON.parse(shows[0].body)).toEqual({ model: "glm-5.3" });
      // /v1/models remains the roster call
      expect(stub.probe.calls.some(c => c.url.endsWith("/v1/models"))).toBe(true);
    } finally {
      stub.uninstall();
    }
  });

  test("B: a configured context cap below the discovered window still wins", async () => {
    const stub = discoveryStub(["glm-5.3"], () => ollamaShow("glm-5.3", 1_048_576, ["completion", "thinking", "tools"]));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch({
        port: 10114,
        defaultProvider: "ollama-cloud",
        providerContextCaps: { "ollama-cloud": 200000 },
        providers: {
          "ollama-cloud": {
            adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
            apiKey: "test-key-not-a-real-credential", liveModels: true, models: [],
          },
        },
      } as never));
      expect(row(models, "glm-5.3")?.contextWindow).toBe(200000);
    } finally {
      stub.uninstall();
    }
  });
});

describe("ollama /api/show — capability mapping", () => {
  test("C: /api/show vision surfaces native image input for a newly discovered VLM", async () => {
    const stub = discoveryStub(["brand-new-vlm"], () => ollamaShow("brand-new-vlm", 262_144, ["completion", "thinking", "tools", "vision"]));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      expect(row(models, "brand-new-vlm")?.inputModalities).toEqual(["text", "image"]);
    } finally {
      stub.uninstall();
    }
  });

  test("D: /api/show no-vision for a noVisionModels id keeps the sidecar image contract", async () => {
    const stub = discoveryStub(["glm-5.3"], () => ollamaShow("glm-5.3", 1_048_576, ["completion", "thinking", "tools"]));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch({
        port: 10114,
        defaultProvider: "ollama-cloud",
        providers: {
          "ollama-cloud": {
            adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
            apiKey: "test-key-not-a-real-credential", liveModels: true, models: [],
            noVisionModels: ["glm-5.3"],
          },
        },
      } as never));
      // Sidecar contract intact: the noVision row still advertises image input so Codex
      // permits attachments and the sidecar can describe them before the model sees the turn.
      expect(row(models, "glm-5.3")?.inputModalities).toEqual(["text", "image"]);
    } finally {
      stub.uninstall();
    }
  });
});

describe("ollama /api/show — failure behavior", () => {
  test("E: missing/malformed context_length falls back safely; discovery still succeeds", async () => {
    const stub = discoveryStub(["odd-model"], () => jsonRes({
      model_info: { "general.architecture": "weird", "weird.context_length": "not-a-number" },
      capabilities: ["completion"],
    }));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      const found = row(models, "odd-model");
      expect(found).toBeDefined(); // the ID roster survives
      expect(found?.contextWindow).toBeUndefined(); // no fabricated context
    } finally {
      stub.uninstall();
    }
  });

  test("F: one /api/show non-2xx degrades only that model; other rows stay enriched", async () => {
    const stub = discoveryStub(["bad-model", "good-model"], id =>
      id === "bad-model"
        ? new Response("nope", { status: 500 })
        : ollamaShow(id, 131_072, ["completion"]));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      expect(row(models, "bad-model")?.contextWindow).toBeUndefined();
      expect(row(models, "good-model")?.contextWindow).toBe(131_072);
      expect(row(models, "bad-model")).toBeDefined();
    } finally {
      stub.uninstall();
    }
  });

  test("G: oversized /api/show response is bounded fail-soft", async () => {
    const stub = stubFetch((url, _body) => {
      if (url.endsWith("/v1/models")) {
        return jsonRes({ object: "list", data: [{ id: "big-model" }] });
      }
      if (url.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            model_info: { "general.architecture": "arch", "arch.context_length": 1_048_576 },
            padding: "p".repeat(600 * 1024),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      const found = row(models, "big-model");
      expect(found).toBeDefined();
      // Bounded reader discarded the oversized payload: no fabricated context window.
      expect(found?.contextWindow).toBeUndefined();
    } finally {
      stub.uninstall();
    }
  });
});

describe("ollama /api/show — scoping, caching, bounds", () => {
  test("H: unrelated providers never issue /api/show", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "plain-model" }] });
      return new Response("nf", { status: 404 });
    });
    try {
      await gatherRoutedModels(withStubbedProviderFetch({
        port: 10114,
        defaultProvider: "plain",
        providers: { plain: { adapter: "openai-responses", baseUrl: "https://plain.example.test/v1", authMode: "key", apiKey: "test-key-not-a-real-credential", liveModels: true, models: [] } },
      } as never));
      expect(stub.probe.calls.filter(c => c.url.endsWith("/api/show"))).toHaveLength(0);
    } finally {
      stub.uninstall();
    }
  });

  test("I: cache hits within TTL do not reissue /api/show per row", async () => {
    const stub = discoveryStub(["glm-5.3", "glm-5.3-flash"], () => ollamaShow("x", 1_048_576, ["completion", "thinking", "tools"]));
    try {
      const cfg = config();
      await gatherRoutedModels(withStubbedProviderFetch(cfg));
      await gatherRoutedModels(withStubbedProviderFetch(cfg));
      const showCalls = stub.probe.calls.filter(c => c.url.endsWith("/api/show"));
      // First gather enriches each id once; the second gather hits the provider-model cache
      // (which already stores the enriched rows) and issues zero further /api/show requests.
      expect(showCalls).toHaveLength(2);
    } finally {
      stub.uninstall();
    }
  });

  test("J: enrichment concurrency and model count are bounded", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `model-${i}`);
    const stub = discoveryStub(ids, () => ollamaShow("x", 131_072, ["completion"]));
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      expect(models.length).toBeGreaterThan(0);
      // The fan-out is capped by the discovered roster itself (one show per id, capped again by
      // discovery.maxModels upstream) — never more show calls than discovered rows.
      expect(stub.probe.calls.filter(c => c.url.endsWith("/api/show")).length).toBeLessThanOrEqual(30);
      // The concurrency bound is the load-bearing proof: at most 4 in flight regardless of roster.
      expect(stub.probe.maxShowActive()).toBeLessThanOrEqual(4);
    } finally {
      stub.uninstall();
    }
  });

  test("K: a redirecting /api/show never sends the credential to another host", async () => {
    let redirectTargetHits = 0;
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) {
        return new Response(null, { status: 301, headers: { Location: "https://evil.example.test/api/show" } });
      }
      if (url.includes("evil.example.test")) {
        redirectTargetHits += 1;
        return jsonRes({ model_info: { "general.architecture": "evil", "evil.context_length": 1 } });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(config()));
      const found = row(models, "glm-5.3");
      expect(found).toBeDefined(); // the ID roster survives the failed enrichment
      expect(found?.contextWindow).toBe(1_048_576);
      // redirect: "manual" plus an explicit providerRedirectError check — the target was never contacted.
      expect(redirectTargetHits).toBe(0);
    } finally {
      stub.uninstall();
    }
  });
});

describe("ollama /api/show — payload extraction contract", () => {
  test("capabilities-only vision produces native vision metadata", () => {
    expect(ollamaShowMetadataFromPayload({ capabilities: ["vision"] }))
      .toEqual({ nativeVision: true });
  });

  test("capabilities-only non-vision produces an explicit negative", () => {
    expect(ollamaShowMetadataFromPayload({ capabilities: ["completion", "tools"] }))
      .toEqual({ nativeVision: false });
  });

  test("valid capabilities remain readable when model_info is absent or malformed", () => {
    for (const payload of [
      { model_info: null, capabilities: ["vision"] },
      { model_info: "malformed", capabilities: ["vision"] },
      { model_info: [], capabilities: ["vision"] },
    ]) {
      expect(ollamaShowMetadataFromPayload(payload)).toEqual({ nativeVision: true });
    }
  });

  test("valid model_info and capabilities retain context and vision metadata", () => {
    expect(ollamaShowMetadataFromPayload({
      model_info: { "general.architecture": "arch", "arch.context_length": 262_144 },
      capabilities: ["completion", "vision"],
    })).toEqual({ contextWindow: 262_144, nativeVision: true });
  });

  test("architecture-named context_length is preferred; ambiguous fallback requires uniqueness", () => {
    expect(ollamaShowMetadataFromPayload({
      model_info: {
        "general.architecture": "glm_dsa_moe",
        "glm_dsa_moe.context_length": 1_048_576,
        "other.context_length": 4096,
      },
    })?.contextWindow).toBe(1_048_576);
    expect(ollamaShowMetadataFromPayload({
      model_info: { "general.architecture": "arch", "arch.context_length": 262_144 },
      capabilities: ["completion", "vision"],
    })?.nativeVision).toBe(true);
    // Ambiguous non-architecture fallback is refused rather than guessed.
    expect(ollamaShowMetadataFromPayload({
      model_info: { "general.architecture": "arch", "a.context_length": 1, "b.context_length": 2 },
    })?.contextWindow).toBeUndefined();
    // Nonsense payloads yield nothing (no fabricated metadata).
    expect(ollamaShowMetadataFromPayload(null)).toBeUndefined();
    expect(ollamaShowMetadataFromPayload("nope")).toBeUndefined();
  });
});
