import { afterEach, describe, expect, it } from "bun:test";
import {
  KEENABLE_KEYED_SEARCH_URL,
  KEENABLE_PUBLIC_SEARCH_URL,
  mapKeenableSearchResponse,
  runKeenableWebSearch,
} from "../../src/web-search/keenable-executor";
import { resolveSidecarBackend } from "../../src/web-search/sidecar-providers";
import { WEB_SEARCH_BACKENDS } from "../../src/web-search/backends";
import { planWebSearch } from "../../src/web-search/index";
import type { OcxConfig } from "../../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const defaultSettings = {
  model: "gpt-5.6-luna",
  reasoning: "low",
  timeoutMs: 5_000,
  describeImages: false,
};

describe("keenable web-search backend", () => {
  it("uses public endpoint with X-Keenable-Title when keyless", async () => {
    let seenUrl = "";
    let seenHeaders: Headers | undefined;
    let seenBody = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      seenBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          results: [
            { title: "Rust Async", url: "https://example.com/rust", snippet: "Async runtime guide" },
            { title: "Duplicate", url: "https://example.com/rust", snippet: "Ignored duplicate" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const outcome = await runKeenableWebSearch("rust async runtime", undefined, defaultSettings);
    expect(seenUrl).toBe(KEENABLE_PUBLIC_SEARCH_URL);
    expect(seenHeaders?.get("x-keenable-title")).toBe("opencodex");
    expect(seenHeaders?.has("x-api-key")).toBe(false);
    expect(JSON.parse(seenBody)).toEqual({ query: "rust async runtime", max_results: 5 });
    expect(outcome.error).toBeUndefined();
    expect(outcome.sources).toEqual([{ url: "https://example.com/rust", title: "Rust Async" }]);
    expect(outcome.text).toContain("Rust Async: Async runtime guide [https://example.com/rust]");
  });

  it("uses keyed endpoint with X-API-Key and scrubs literal key from errors", async () => {
    let seenUrl = "";
    let seenHeaders: Headers | undefined;
    const secret = "keen-secret-xyz-12345";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return new Response(`bad key ${secret} rejected`, { status: 401 });
    }) as typeof fetch;

    const outcome = await runKeenableWebSearch("test", secret, defaultSettings);
    expect(seenUrl).toBe(KEENABLE_KEYED_SEARCH_URL);
    expect(seenHeaders?.get("x-api-key")).toBe(secret);
    expect(seenHeaders?.has("x-keenable-title")).toBe(false);
    expect(outcome.error).toContain("HTTP 401");
    expect(outcome.error).not.toContain(secret);
    expect(outcome.error).toContain("[redacted-keenable-key]");
  });

  it("handles malformed or empty payloads", () => {
    expect(mapKeenableSearchResponse(null).error).toContain("non-JSON");
    expect(mapKeenableSearchResponse({ results: [] }).error).toContain("no results");
  });

  it("resolves explicit-only backend and plans keyless web search", () => {
    expect(resolveSidecarBackend("keenable")).toBe("keenable");
    expect(resolveSidecarBackend(undefined)).toBe("openai");

    const descriptor = WEB_SEARCH_BACKENDS.find(d => d.backend === "keenable");
    expect(descriptor).toBeDefined();
    expect(descriptor?.eligibleModel({ provider: "openai", model: "gpt-5.6-luna" }, {} as never)).toBe(false);

    const cfg = {
      providers: {},
      webSearchSidecar: { enabled: true, backend: "keenable" },
    } as unknown as OcxConfig;
    expect(descriptor?.isActive({} as never, cfg)).toBe(true);

    const plan = planWebSearch(
      cfg,
      { _webSearch: { type: "web_search" }, options: {} } as never,
      false,
      {} as never,
      "model",
    );
    expect(plan?.backend).toBe("keenable");
  });
});
