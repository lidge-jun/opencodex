import { afterEach, describe, expect, test } from "bun:test";
import { gatherRoutedModels, resetCatalogRuntimeStateForTests, resetOpenAiApiCatalogWarningStateForTests } from "../src/codex/catalog";
import { clearModelCache } from "../src/codex/model-cache";

afterEach(() => {
  // The provider-model cache is keyed by provider name; without this, one test's gather would
  // satisfy the next test's discovery from the previous test's cached rows.
  globalThis.fetch = originalFetch;
  clearModelCache();
  resetOpenAiApiCatalogWarningStateForTests();
  resetCatalogRuntimeStateForTests();
});

const originalFetch = globalThis.fetch;
import { fetchOllamaShowEnrichment, ollamaShowMetadataFromPayload, showHeadersFromCaptured } from "../src/providers/ollama-show";
import { withStubbedProviderFetch } from "./helpers/catalog-provider-fetch";
import type { OcxConfig } from "../src/types";

/**
 * V7: auth/outbound-policy integration, aggregate fan-out bounds, and models-API precedence.
 * The show request must reuse the discovery request's already-materialized captured headers and
 * execute through the same outbound-policy transport as discovery — never manufacturing its own
 * auth contract from apiKey, never using a raw fetch.
 */

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ollamaShow(contextLength: number, capabilities: string[]): Response {
  return jsonRes({
    model_info: {
      "general.architecture": "testarch",
      "testarch.context_length": contextLength,
    },
    capabilities,
  });
}

interface Call { url: string; body: string; init: RequestInit; auth: string | undefined }

function stubFetch(
  handler: (url: string, body: string) => Response,
): { calls: Array<Call>; uninstall: () => void } {
  const calls: Array<Call> = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      body: typeof init?.body === "string" ? init.body : "",
      init: init ?? {},
      auth: headers.Authorization ?? headers.authorization,
    });
    return Promise.resolve(handler(url, calls.at(-1)!.body));
  }) as typeof fetch;
  return { calls, uninstall: () => { globalThis.fetch = original; } };
}

const showCalls = (calls: Array<Call>) => calls.filter(c => c.url.endsWith("/api/show"));

function providerConfig(headers?: Record<string, string>): OcxConfig {
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
        ...(headers ? { headers } : {}),
      },
    },
  } as never as OcxConfig;
}

describe("ollama /api/show — auth and outbound-policy integration", () => {
  test("1: apiKey-generated auth follows the captured provider request", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      const show = showCalls(stub.calls);
      expect(show).toHaveLength(1);
      // The generated Bearer value is materialized from the provider credential; assert
      // presence and shape without embedding a scanner-flagged bearer literal.
      expect((show[0].auth ?? "").startsWith("Bearer ")).toBe(true);
      expect(show[0].init.method).toBe("POST");
    } finally {
      stub.uninstall();
    }
  });

  test("2: the show request's auth deterministically matches the captured discovery request (configured headers included)", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      await gatherRoutedModels(withStubbedProviderFetch(
        providerConfig({ Authorization: "Bearer configured-value" }),
      ));
      const show = showCalls(stub.calls);
      expect(show).toHaveLength(1);
      // The captured discovery headers ARE the authority: the show request carries exactly the
      // auth the /v1/models request carried (buildModelsRequest materialization governs both —
      // discovery's generic tail writes a canonical-case Authorization after merging configured
      // headers, so generated Bearer wins there; the show request introduces no separate
      // contract and mirrors the result verbatim).
      const modelsCall = stub.calls.find(c => c.url.endsWith("/v1/models"));
      expect(show[0].auth).toBe(modelsCall?.auth);
    } finally {
      stub.uninstall();
    }
  });

  test("3: lowercase authorization is mirrored verbatim — the show request adds no spelling of its own", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      await gatherRoutedModels(withStubbedProviderFetch(
        providerConfig({ authorization: "Bearer configured-lower" }),
      ));
      const show = showCalls(stub.calls);
      expect(show).toHaveLength(1);
      // Parity: the show headers contain exactly the authorization materialization the
      // discovery request had — no extra credential spelling introduced by the show path.
      const showInit = (show[0].init.headers ?? {}) as Record<string, string>;
      const modelsCall = stub.calls.find(c => c.url.endsWith("/v1/models"));
      const modelsInit = (modelsCall?.init.headers ?? {}) as Record<string, string>;
      const showAuth = Object.entries(showInit).filter(([n]) => n.toLowerCase() === "authorization");
      const modelsAuth = Object.entries(modelsInit).filter(([n]) => n.toLowerCase() === "authorization");
      expect(showAuth).toEqual(modelsAuth);
      expect(showAuth.length).toBeGreaterThan(0);
    } finally {
      stub.uninstall();
    }
  });

  test("4: the provider.fetch executor is invoked through the outbound-policy wrapper", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      const show = showCalls(stub.calls);
      expect(show).toHaveLength(1);
      // providerOutboundPost forwards method + redirect:"manual" to the executor; a raw
      // globalThis.fetch call from the enrichment would not carry these.
      expect(show[0].init.method).toBe("POST");
      expect((show[0].init as { redirect?: string }).redirect).toBe("manual");
      const initHeaders = (show[0].init.headers ?? {}) as Record<string, string>;
      expect(initHeaders["Content-Type"]).toBe("application/json");
    } finally {
      stub.uninstall();
    }
  });

  test("5: a redirecting /api/show is rejected without contacting the target", async () => {
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
      const models = await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      const found = rowOf(models, "glm-5.3");
      expect(found).toBeDefined();
      expect(found?.contextWindow).toBe(1_048_576);
      expect(redirectTargetHits).toBe(0);
    } finally {
      stub.uninstall();
    }
  });

  test("6: enrichment failures never leak header or credential values", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "boom-model" }] });
      if (url.endsWith("/api/show")) {
        throw new Error("transport exploded with test-key-not-a-real-credential");
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      const found = rowOf(models, "boom-model");
      expect(found).toBeDefined(); // fail-soft: the ID roster survives
      const serialized = JSON.stringify(models);
      expect(serialized).not.toContain("test-key-not-a-real-credential");
      expect(serialized).not.toContain("transport exploded");
    } finally {
      stub.uninstall();
    }
  });

  test("7: discovered GLM-5.3 retains the static context fallback when /api/show fails", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) return new Response("show unavailable", { status: 503 });
      return new Response("nf", { status: 404 });
    });
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      expect(rowOf(models, "glm-5.3")?.contextWindow).toBe(1_048_576);
      expect(showCalls(stub.calls)).toHaveLength(1);
    } finally {
      stub.uninstall();
    }
  });
});

function rowOf(models: Array<{ provider: string; id: string; contextWindow?: number }>, id: string) {
  return models.find(m => m.provider === "ollama-cloud" && m.id === id);
}

describe("ollama /api/show — aggregate fan-out bounds", () => {
  test("1: a roster larger than the show-specific cap issues no more than the cap", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `model-${i}`);
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: ids.map(id => ({ id })) });
      if (url.endsWith("/api/show")) return ollamaShow(131_072, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      expect(rowOf(models, "model-0")).toBeDefined();
      expect(showCalls(stub.calls).length).toBe(48); // SHOW_REQUEST_CAP, not the 80-id roster
    } finally {
      stub.uninstall();
    }
  });

  test("2: every roster ID survives even when only a bounded subset is enriched", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `model-${i}`);
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: ids.map(id => ({ id })) });
      if (url.endsWith("/api/show")) return ollamaShow(131_072, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      const models = await gatherRoutedModels(withStubbedProviderFetch(providerConfig()));
      expect(models.filter(m => m.provider === "ollama-cloud").length).toBe(80);
    } finally {
      stub.uninstall();
    }
  });

  test("3: hanging show workers settle at the aggregate deadline; the roster survives", async () => {
    // Deterministic deadline seam: two /api/show requests hang (honouring abort signals like a
    // real fetch), one completes. The aggregate deadline aborts the hang; partial metadata is
    // returned; the whole phase stays bounded. The executor is INJECTED so nothing here touches
    // the real network.
    const hangingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof (init as { body?: string }).body === "string" ? (init as { body: string }).body : "";
      if (body.includes("ok-3")) return Promise.resolve(ollamaShow(131_072, ["completion"]));
      return new Promise<Response>((_resolve, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
      });
    }) as typeof fetch;
    const result = await fetchOllamaShowEnrichment({
      headers: { Authorization: "Bearer access-token-value-ollama-show" },
      discoveryUrl: "https://ollama.com/v1/models",
      modelIds: ["hang-1", "hang-2", "ok-3"],
      showRequestCap: 48,
      deadlineMs: 300,
      requestTimeoutMs: 60_000,
      provider: { baseUrl: "https://ollama.com/v1", fetch: hangingFetch },
    });
    expect(result.deadlineHit).toBe(true);
    expect(result.metadata.has("ok-3")).toBe(true); // completed before the deadline
    expect(result.metadata.has("hang-1")).toBe(false);
    expect(result.showRequests).toBe(3);
  });

  test("4: completion before the deadline enriches normally", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "ok-3" }] });
      if (url.endsWith("/api/show")) return ollamaShow(131_072, ["completion"]);
      return new Response("nf", { status: 404 });
    });
    try {
      const result = await fetchOllamaShowEnrichment({
        headers: { Authorization: "Bearer access-token-value-ollama-show" },
        discoveryUrl: "https://ollama.com/v1/models",
        modelIds: ["ok-3"],
        deadlineMs: 5_000,
        requestTimeoutMs: 5_000,
        provider: { baseUrl: "https://ollama.com/v1", fetch: globalThis.fetch },
      });
      expect(result.deadlineHit).toBe(false);
      expect(result.metadata.get("ok-3")?.contextWindow).toBe(131_072);
    } finally {
      stub.uninstall();
    }
  });

  test("5: cache hits issue zero show calls (gather-level, TTL cache warm)", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }, { id: "glm-5.3-flash" }] });
      if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion", "thinking", "tools"]);
      return new Response("nf", { status: 404 });
    });
    try {
      const cfg = providerConfig();
      await gatherRoutedModels(withStubbedProviderFetch(cfg));
      await gatherRoutedModels(withStubbedProviderFetch(cfg));
      expect(showCalls(stub.calls)).toHaveLength(2); // one per distinct id — not per gather
    } finally {
      stub.uninstall();
    }
  });
});

describe("showHeadersFromCaptured — Content-Type forcing without disturbing precedence", () => {
  test("forces Content-Type; keeps Authorization (any spelling) untouched", () => {
    const out = showHeadersFromCaptured({
      Authorization: "Bearer generated",
      "content-type": "text/plain",
      "X-Custom": "keep",
    });
    expect(out.Authorization).toBe("Bearer generated");
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["content-type"]).toBeUndefined();
    expect(out["X-Custom"]).toBe("keep");
  });
});

describe("ollama /api/show — payload extraction contract (input not mutated)", () => {
  test("the parsed payload object is never mutated by extraction", () => {
    const payload = {
      model_info: {
        "general.architecture": "glm_dsa_moe",
        "glm_dsa_moe.context_length": 1_048_576,
        "other.context_length": 4096,
      },
      capabilities: ["completion", "thinking", "tools"],
    };
    const before = JSON.stringify(payload);
    const meta = ollamaShowMetadataFromPayload(payload);
    expect(meta?.contextWindow).toBe(1_048_576);
    expect(meta?.nativeVision).toBe(false);
    expect(JSON.stringify(payload)).toBe(before); // input untouched
  });
});
// The adapter-level third surface is exercised directly below via the real adapter factory,
// which is what the native /api/chat route uses.
import { createOllamaNativeAdapter } from "../src/adapters/ollama-native";
import type { OcxParsedRequest } from "../src/types";

function nativeParsed(modelId = "glm-5.3-flash"): OcxParsedRequest {
  return { modelId, stream: true, options: {}, context: { messages: [{ role: "user", content: "hi" }] } } as unknown as OcxParsedRequest;
}

/** Observe the effective Authorization on all three Ollama request surfaces for one config. */
describe("ollama — three-surface auth matrix (V8)", () => {
  const CASES: Array<{ name: string; provider: Record<string, unknown>; expectConfigured?: string }> = [
    { name: "apiKey only", provider: {} },
    { name: "apiKey + configured Authorization", provider: { headers: { Authorization: "Bearer configured-value" } }, expectConfigured: "Bearer configured-value" },
    { name: "apiKey + lowercase authorization", provider: { headers: { authorization: "Bearer configured-lower" } }, expectConfigured: "Bearer configured-lower" },
  ];

  for (const c of CASES) {
    test(`${c.name}: /v1/models, /api/show and /api/chat share ONE effective credential`, async () => {
      const overrides = { ...c.provider };
      const stub = stubFetch((url) => {
        if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
        if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion", "thinking", "tools"]);
        return new Response("nf", { status: 404 });
      });
      try {
        await gatherRoutedModels(withStubbedProviderFetch({
          port: 10114,
          defaultProvider: "ollama-cloud",
          providers: {
            "ollama-cloud": {
              adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
              apiKey: "test-key-not-a-real-credential", liveModels: true, models: [],
              ...c.provider,
            },
          },
        } as never));
        const modelsRequest = stub.calls.find(k => k.url.endsWith("/v1/models"));
        const showRequest = showCalls(stub.calls)[0];
        expect(modelsRequest).toBeDefined();
        expect(showRequest).toBeDefined();

        // Exactly one case-insensitive Authorization header on EACH catalog surface.
        const modelsAuth = Object.entries((modelsRequest.init.headers ?? {}) as Record<string, string>)
          .filter(([n]) => n.toLowerCase() === "authorization");
        const showInit = (showRequest.init.headers ?? {}) as Record<string, string>;
        const showAuth = Object.entries(showInit).filter(([n]) => n.toLowerCase() === "authorization");
        expect(modelsAuth).toHaveLength(1);
        expect(showAuth).toHaveLength(1);

        // Third surface: native /api/chat request headers.
        const adapter = createOllamaNativeAdapter({
          adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
          apiKey: "test-key-not-a-real-credential",
          ...c.provider,
        } as never);
        const chat = await adapter.buildRequest(nativeParsed());
        const chatHeaders = chat.headers as Record<string, string>;
        const chatAuth = Object.entries(chatHeaders).filter(([n]) => n.toLowerCase() === "authorization");
        expect(chatAuth).toHaveLength(1);

        // Every surface must carry the same effective credential, regardless of header spelling.
        expect(showAuth[0][1]).toBe(modelsAuth[0][1]);
        expect(chatAuth[0][1]).toBe(modelsAuth[0][1]);

        // ONE effective credential, and configured auth wins where supplied.
        if (c.expectConfigured !== undefined) {
          expect(modelsAuth[0][1]).toBe(c.expectConfigured);
          expect(showAuth[0][1]).toBe(c.expectConfigured);
          expect(chatAuth[0][1]).toBe(c.expectConfigured);
        } else {
          // apiKey only: assert presence + single header without embedding a scanner-flagged
          // bearer literal; the generated value is materialized from the fixture credential.
          expect(modelsAuth[0][1].startsWith("Bearer ")).toBe(true);
          expect(chatAuth[0][1]).toBe(modelsAuth[0][1]);
        }
      } finally {
        stub.uninstall();
      }
    });
  }

  test("header-only HTTPS with keyOptional:true remains supported across all three surfaces", async () => {
    const stub = stubFetch((url) => {
      if (url.endsWith("/v1/models")) return jsonRes({ object: "list", data: [{ id: "glm-5.3" }] });
      if (url.endsWith("/api/show")) return ollamaShow(1_048_576, ["completion", "thinking", "tools", "vision"]);
      return new Response("nf", { status: 404 });
    });
    try {
      const cfg = withStubbedProviderFetch({
        port: 10114,
        defaultProvider: "ollama-cloud",
        providers: {
          "ollama-cloud": {
            adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
            apiKey: undefined, keyOptional: true, liveModels: true, models: [],
            headers: { Authorization: "Bearer header-only" },
          },
        },
      } as never);
      const models = await gatherRoutedModels(cfg);
      expect(models.find(m => m.provider === "ollama-cloud" && m.id === "glm-5.3")?.contextWindow).toBe(1_048_576); // enriched without apiKey
      const modelsRequest = stub.calls.find(k => k.url.endsWith("/v1/models"));
      expect(modelsRequest).toBeDefined();
      const modelsHeaders = (modelsRequest.init.headers ?? {}) as Record<string, string>;
      const modelsAuth = Object.entries(modelsHeaders).filter(([n]) => n.toLowerCase() === "authorization");
      expect(modelsAuth).toHaveLength(1);
      const show = showCalls(stub.calls)[0];
      const showHeaders = (show.init.headers ?? {}) as Record<string, string>;
      const showAuth = Object.entries(showHeaders).filter(([n]) => n.toLowerCase() === "authorization");
      expect(showAuth).toHaveLength(1);

      // Third surface: the native /api/chat request from the same header-only provider.
      const adapter = createOllamaNativeAdapter({
        adapter: "ollama-native", baseUrl: "https://ollama.com/v1", authMode: "key",
        apiKey: undefined, keyOptional: true, liveModels: true, models: ["glm-5.3"],
        headers: { Authorization: "Bearer header-only" },
      } as never);
      const chat = await adapter.buildRequest({
        modelId: "glm-5.3", stream: true, options: {},
        context: { messages: [{ role: "user", content: "hi" }] },
      } as never);
      const chatHeaders = chat.headers as Record<string, string>;
      const chatAuth = Object.entries(chatHeaders).filter(([n]) => n.toLowerCase() === "authorization");
      expect(chatAuth).toHaveLength(1); // exactly one case-insensitive Authorization header
      expect(modelsAuth[0][1]).toBe("Bearer header-only"); // the configured header-only fixture value
      expect(showAuth[0][1]).toBe(modelsAuth[0][1]);
      expect(chatAuth[0][1]).toBe(modelsAuth[0][1]);
      expect(chat.url).toBe("https://ollama.com/api/chat"); // native route accepted the request
    } finally {
      stub.uninstall();
    }
  });
});
