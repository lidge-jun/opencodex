import { describe, expect, test } from "bun:test";
import { mapExaSearchResponse, runExaWebSearch } from "../src/web-search/exa-executor";
import { planWebSearch } from "../src/web-search";
import { parseRequest } from "../src/responses/parser";
import { runWithWebSearch, type WebSearchLoopDeps } from "../src/web-search/loop";
import { MAX_SIDECAR_RESPONSE_BYTES } from "../src/web-search/parse";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import type { AdapterEvent, ProviderAdapter } from "../src/adapters/base";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const routed: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://routed.test/v1", apiKey: "k" };
function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "routed", providers: { routed }, ...overrides };
}
function parsedWithWebSearch() {
  return parseRequest({ model: "routed/model", input: "search", stream: true, tools: [{ type: "web_search" }] });
}

function oversizedResponse(status: number, onCancel: () => void, prefix = ""): Response {
  const bytes = new Uint8Array(MAX_SIDECAR_RESPONSE_BYTES + 1);
  bytes.set(new TextEncoder().encode(prefix).subarray(0, bytes.byteLength));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      onCancel();
    },
  }), { status });
}

describe("mapExaSearchResponse (002 probe shape)", () => {
  test("results -> digest text + deduped sources with titles/dates", () => {
    const out = mapExaSearchResponse({ requestId: "r1", results: [
      { title: "Bun ships 1.4", url: "https://bun.sh/blog", publishedDate: "2026-08-01T00:00:00Z", text: "Bun 1.4 released with..." },
      { title: "dup", url: "https://bun.sh/blog" },
      { url: "https://example.com/no-title" },
    ], costDollars: { total: 0.007 } });
    expect(out.text).toContain("Bun ships 1.4 (2026-08-01): Bun 1.4 released with...");
    expect(out.text).toContain("(no excerpt)");
    expect(out.sources).toEqual([
      { url: "https://bun.sh/blog", title: "Bun ships 1.4" },
      { url: "https://example.com/no-title" },
    ]);
  });

  test("shapeless/empty bodies -> error outcome", () => {
    expect(mapExaSearchResponse(null).error).toBeDefined();
    expect(mapExaSearchResponse({ results: [] }).error).toContain("no results");
  });
});

describe("runExaWebSearch key hygiene (canary)", () => {
  test("the key never reaches the outcome even when upstream echoes it in an error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("invalid key exa-canary-9876543210 rejected", { status: 401 })) as typeof fetch;
   try {
      const out = await runExaWebSearch("q", "exa-canary-9876543210", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.error).toContain("401");
      expect(JSON.stringify(out)).not.toContain("exa-canary");
    } finally {
      globalThis.fetch = realFetch;
    }
 });

  test("a key straddling the 200-char truncation boundary never leaks a prefix", async () => {
    // Position the key so any post-truncation scrub would leave a literal prefix.
    const key = "exa-canary-boundary-9876543210";
    const body = "x".repeat(195) + key + " rejected";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 401 })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", key, { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.error).toContain("401");
      expect(JSON.stringify(out)).not.toContain("exa-canary");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a fetch rejection carrying the key in its message is scrubbed", async () => {
    const key = "exa-canary-reject-9876543210";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error(`connect refused for x-api-key ${key}`); }) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", key, { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.error).toBeDefined();
      expect(JSON.stringify(out)).not.toContain("exa-canary");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an oversized successful response is rejected and its stream is cancelled", async () => {
    let cancelled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => oversizedResponse(200, () => { cancelled = true; })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out).toEqual({ text: "", sources: [], error: "exa sidecar response exceeded byte bound" });
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a valid successful response at the exact byte bound is accepted", async () => {
    const prefix = '{"results":[{"url":"https://e.com","text":"';
    const suffix = '"}]}';
    const filler = "x".repeat(MAX_SIDECAR_RESPONSE_BYTES - new TextEncoder().encode(prefix + suffix).byteLength);
    const body = new TextEncoder().encode(prefix + filler + suffix);
    expect(body.byteLength).toBe(MAX_SIDECAR_RESPONSE_BYTES);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.error).toBeUndefined();
      expect(out.sources).toEqual([{ url: "https://e.com" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an oversized error response is rejected without retaining its body", async () => {
    let cancelled = false;
    const key = "exa-canary-oversized-9876543210";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => oversizedResponse(401, () => { cancelled = true; }, key)) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", key, { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out).toEqual({ text: "", sources: [], error: "exa sidecar HTTP 401 response exceeded byte bound" });
      expect(cancelled).toBe(true);
      expect(JSON.stringify(out)).not.toContain("exa-canary");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("malformed JSON keeps the stable shapeless outcome", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("not-json", { status: 200 })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.error).toBe("exa sidecar returned a non-JSON or shapeless body");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("malformed UTF-8 preserves response replacement decoding", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode('{"results":[{"url":"https://e.com","title":"');
    const suffix = encoder.encode('"}]}');
    const body = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    body.set(prefix);
    body[prefix.byteLength] = 0xff;
    body.set(suffix, prefix.byteLength + 1);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.sources).toEqual([{ url: "https://e.com", title: "�" }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a body read rejection preserves the HTTP status-only fallback", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body-reset"));
      },
    }), { status: 502 })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(out.error).toBe("exa sidecar HTTP 502: ");
      expect(out.error).not.toContain("body-reset");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("an already-aborted response body is cancelled before reader attachment", async () => {
    const parent = new AbortController();
    let cancelled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const response = new Response(new ReadableStream<Uint8Array>({
        pull() {
          // Stay pending until cancellation owns the body.
        },
        cancel() {
          cancelled = true;
        },
      }), { status: 200 });
      parent.abort(new DOMException("parent stopped", "AbortError"));
      return response;
    }) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false }, parent.signal);
      expect(out.error).toBe("exa sidecar returned a non-JSON or shapeless body");
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a response body timeout keeps the timeout outcome", async () => {
    let cancelled = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull() {
        // Stay pending until the linked deadline expires.
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 })) as typeof fetch;
    try {
      const out = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5, describeImages: false });
      expect(out.error).toBe("Timeout elapsed");
      expect(cancelled).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("request carries x-api-key, manual redirect, pinned url; empty key fails closed with no fetch", async () => {
    const captured: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ results: [{ title: "t", url: "https://e.com" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const none = await runExaWebSearch("q", "", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(none.error).toContain("without an exaApiKey");
      expect(captured).toHaveLength(0);
      const ok = await runExaWebSearch("q", "key-1", { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false });
      expect(ok.sources).toHaveLength(1);
      expect(captured).toHaveLength(1);
      expect(captured[0]!.url).toBe("https://api.exa.ai/search");
      expect(captured[0]!.init.redirect).toBe("manual");
      // Representation-independent: the init may carry a plain record or a Headers instance.
      expect(new Headers(captured[0]!.init.headers).get("x-api-key")).toBe("key-1");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("planWebSearch exa arm (L9)", () => {
  test("explicit exa + key -> plan with presence marker only (key absent from the plan)", () => {
    const cfg = config({ webSearchSidecar: { backend: "exa", exaApiKey: "exa-secret-key-123" } });
    const plan = planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined);
    expect(plan?.backend).toBe("exa");
    expect(plan?.exaConfigured).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("exa-secret-key");
  });

  test("explicit exa without a key fails closed", () => {
    const cfg = config({ webSearchSidecar: { backend: "exa" } });
    expect(planWebSearch(cfg, parsedWithWebSearch(), false, routed, "model", undefined)).toBeUndefined();
  });
});

describe("loop dispatch: exa arm fails closed without a key (L9)", () => {
  test("missing exaApiKey yields the invariant error; no fetch, no pool recording", async () => {
    const firstPass: AdapterEvent[] = [
      { type: "tool_call_start", id: "ws1", name: "web_search" },
      { type: "tool_call_delta", arguments: "{\"query\":\"docs\"}" },
      { type: "tool_call_end" },
      { type: "done" },
    ];
    let pass = 0;
    let sawToolResult = "";
    const adapter: ProviderAdapter = {
      name: "two-pass",
      buildRequest: (parsed) => {
        if (pass > 0) sawToolResult = JSON.stringify(parsed.context.messages ?? parsed);
        return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
      },
      fetchResponse: async () => new Response("wire", { status: 200 }),
      async *parseStream() {
        const events = pass++ === 0 ? firstPass : [{ type: "text_delta", text: "answer" } as AdapterEvent, { type: "done" } as AdapterEvent];
        for (const event of events) yield event;
      },
      async parseResponse() { throw new Error("unreachable"); },
    };
    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => { fetches.push(String(input)); return new Response("{}", { status: 500 }); }) as typeof fetch;
    let poolRecorded = 0;
    try {
      const response = await runWithWebSearch({
        parsed: parseRequest({ model: "routed/model", input: "hi", stream: true, tools: [{ type: "web_search" }] }),
        adapter,
        backend: "exa",
        hostedTool: { type: "web_search" },
        selectedForwardHeaders: new Headers({ authorization: "Bearer forward-secret" }),
        settings: { model: "m", reasoning: "low", timeoutMs: 5000, describeImages: false },
        maxSearches: 1,
        recordSidecarOutcome: () => { poolRecorded += 1; },
        incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
      } satisfies WebSearchLoopDeps);
      await new Response(response.body).text();
      expect(fetches).toEqual([]);
      expect(poolRecorded).toBe(0);
      expect(sawToolResult).toContain("without an exaApiKey");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
