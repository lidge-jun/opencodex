import { describe, expect, test } from "bun:test";
import { providerFetch, withUpstreamHttpVersion } from "../src/server/responses/fetch-helpers";
import { UpstreamHttpVersionTargetError } from "../src/lib/upstream-http-version";
import type { OcxProviderConfig } from "../src/types";

const HTTPS_URL = "https://opencode.ai/zen/go/v1/chat/completions";
const HTTP_URL = "http://127.0.0.1:10900/zen/go/v1/chat/completions";

// OcxProviderConfig has no fetch member; the stub fetch used by the propagation
// tests is a test-only transport override, so the helper needs an intersection.
type TestProvider = OcxProviderConfig & { fetch?: typeof globalThis.fetch };

function provider(overrides: Partial<TestProvider> = {}): TestProvider {
  return {
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    ...overrides,
  };
}

describe("withUpstreamHttpVersion", () => {
  test("absent upstreamHttpVersion keeps the init untouched", () => {
    const init = { method: "POST", headers: {} };
    expect(withUpstreamHttpVersion(HTTPS_URL, init, provider())).toBe(init);
  });

  test("auto keeps the init untouched (default negotiation)", () => {
    const init = { method: "POST", headers: {} };
    expect(withUpstreamHttpVersion(HTTPS_URL, init, provider({ upstreamHttpVersion: "auto" }))).toBe(init);
  });

  test("undefined init without a pin stays undefined", () => {
    expect(withUpstreamHttpVersion(HTTPS_URL, undefined, provider())).toBeUndefined();
    expect(withUpstreamHttpVersion(HTTPS_URL, undefined, provider({ upstreamHttpVersion: "auto" }))).toBeUndefined();
  });

  test("absent and auto pins leave plaintext and unparseable targets untouched", () => {
    const init = { method: "POST", headers: {} };
    expect(withUpstreamHttpVersion(HTTP_URL, init, provider())).toBe(init);
    expect(withUpstreamHttpVersion(HTTP_URL, init, provider({ upstreamHttpVersion: "auto" }))).toBe(init);
    expect(withUpstreamHttpVersion("not a url", init, provider())).toBe(init);
    expect(withUpstreamHttpVersion("not a url", init, provider({ upstreamHttpVersion: "auto" }))).toBe(init);
  });

  test("http1.1 pins the protocol on https targets", () => {
    const init = { method: "POST", headers: {} };
    const out = withUpstreamHttpVersion(HTTPS_URL, init, provider({ upstreamHttpVersion: "http1.1" }))!;
    expect(out).not.toBe(init);
    expect((out as RequestInit & { protocol?: string }).protocol).toBe("http1.1");
  });

  test("h1/h2/http2 map through to Bun protocol values", () => {
    for (const [version, expected] of [
      ["h1", "h1"],
      ["http2", "http2"],
      ["h2", "h2"],
    ] as const) {
      const out = withUpstreamHttpVersion(
        HTTPS_URL,
        { method: "POST" },
        provider({ upstreamHttpVersion: version }),
      )!;
      expect((out as RequestInit & { protocol?: string }).protocol).toBe(expected);
    }
  });

  test("plain-http targets fail clearly when an explicit pin cannot be honored", () => {
    const init = { method: "POST", headers: {} };
    let failure: unknown;
    try {
      withUpstreamHttpVersion(HTTP_URL, init, provider({ upstreamHttpVersion: "http1.1" }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UpstreamHttpVersionTargetError);
    expect((failure as UpstreamHttpVersionTargetError).observedProtocol).toBe("http:");
    expect((failure as Error).message).toContain("received http:");
  });

  test("Request objects resolve their url for the https guard", () => {
    const request = new Request(HTTPS_URL);
    const init = { method: "POST" };
    const out = withUpstreamHttpVersion(request, init, provider({ upstreamHttpVersion: "http1.1" }))!;
    expect((out as RequestInit & { protocol?: string }).protocol).toBe("http1.1");
  });

  test("unparseable targets fail clearly when a pin is configured", () => {
    const init = { method: "POST" };
    let failure: unknown;
    try {
      withUpstreamHttpVersion("not a url", init, provider({ upstreamHttpVersion: "http1.1" }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UpstreamHttpVersionTargetError);
    expect((failure as UpstreamHttpVersionTargetError).observedProtocol).toBe("unparseable");
  });

  test("absent init still applies the pin (providerFetch without init)", () => {
    const out = withUpstreamHttpVersion(HTTPS_URL, undefined, provider({ upstreamHttpVersion: "http1.1" }))!;
    expect(out).toEqual({ protocol: "http1.1" });
    const untouched = withUpstreamHttpVersion(HTTPS_URL, undefined, provider());
    expect(untouched).toBeUndefined();
  });
});

describe("providerFetch upstreamHttpVersion propagation", () => {
  type FetchOverride = typeof globalThis.fetch;

  function stubFetch(seen: { init?: RequestInit }): FetchOverride {
    return async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.init = init;
      return new Response("ok");
    };
  }

  test("a provider-pinned version reaches the underlying fetch call", async () => {
    const seen: { init?: RequestInit } = {};
    const fetcher = providerFetch(provider({
      upstreamHttpVersion: "http1.1",
      fetch: stubFetch(seen),
    }));
    await fetcher(HTTPS_URL, { method: "POST", body: "{}" });
    expect((seen.init as RequestInit & { protocol?: string })?.protocol).toBe("http1.1");
  });

  test("no pin keeps the caller init verbatim", async () => {
    const seen: { init?: RequestInit } = {};
    const fetcher = providerFetch(provider({ fetch: stubFetch(seen) }));
    await fetcher(HTTPS_URL, { method: "POST", body: "{}" });
    // The caller's fields survive untouched and no protocol pin is invented. `timeout: 0` is
    // added unconditionally (#2567) to disable Bun's per-request socket idle timer, so assert
    // the caller's fields and the absence of a pin rather than exact object equality.
    expect(seen.init).toMatchObject({ method: "POST", body: "{}" });
    expect((seen.init as RequestInit & { protocol?: string })?.protocol).toBeUndefined();
  });

  test("no init still applies a pinned version to the fetch call", async () => {
    const seen: { init?: RequestInit } = {};
    const fetcher = providerFetch(provider({
      upstreamHttpVersion: "http1.1",
      fetch: stubFetch(seen),
    }));
    await fetcher(HTTPS_URL);
    expect((seen.init as RequestInit & { protocol?: string })?.protocol).toBe("http1.1");
  });

  test("Google AI Studio providerFetch attaches pinned protocol to all attempts", async () => {
    const seen: RequestInit[] = [];
    const fetcher = providerFetch({
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "ai-key",
      upstreamHttpVersion: "http1.1",
      fetch: (async (_url, init) => {
        seen.push(init ?? {});
        return new Response("ok");
      }) as typeof fetch,
    });

    await fetcher("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(seen).toHaveLength(1);
    expect((seen[0] as RequestInit & { protocol?: string }).protocol).toBe("http1.1");
  });

  test("a plaintext target with an explicit pin fails before the provider fetch runs", async () => {
    let fetchCalls = 0;
    const fetcher = providerFetch(provider({
      upstreamHttpVersion: "http1.1",
      fetch: (async () => {
        fetchCalls += 1;
        return new Response("must not run");
      }) as typeof fetch,
    }));

    await expect(fetcher(HTTP_URL, { method: "POST" }))
      .rejects.toThrow("upstream HTTP version pin requires an HTTPS target");
    expect(fetchCalls).toBe(0);
  });
});
