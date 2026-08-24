import { afterEach, describe, expect, mock, test } from "bun:test";
import { getDefaultConfig, validateConfigCandidate } from "../src/config";
import {
  ANTIGRAVITY_TLS_HOSTS,
  getProviderTlsProfileStatus,
  isCanonicalAntigravityUrl,
  providerTlsProfileConfigError,
  resetProviderTlsProfileForTests,
  setProviderTlsRuntimeForTest,
  providerTlsFetch,
} from "../src/lib/provider-tls-profile";
import { proxyForUrl } from "../src/lib/proxy-env";
import { providerFetch } from "../src/server/responses/fetch-helpers";

const canonicalProvider = {
  adapter: "google",
  authMode: "oauth",
  googleMode: "cloud-code-assist",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  tlsProfile: "antigravity-browser" as const,
};

afterEach(() => {
  resetProviderTlsProfileForTests();
  setProviderTlsRuntimeForTest(undefined);
});

describe("provider TLS profile validation", () => {
  test("accepts only the canonical Antigravity OAuth CCA profile", () => {
    expect(providerTlsProfileConfigError("google-antigravity", canonicalProvider)).toBeNull();
    expect(providerTlsProfileConfigError("google-antigravity", {
      ...canonicalProvider,
      baseUrl: "https://cloudcode-pa.googleapis.com",
    })).toBeNull();
    expect(providerTlsProfileConfigError("google", canonicalProvider)).toContain("google-antigravity");
    expect(providerTlsProfileConfigError("google-antigravity", {
      ...canonicalProvider,
      authMode: "key",
    })).toContain("OAuth");
    expect(providerTlsProfileConfigError("google-antigravity", {
      ...canonicalProvider,
      googleMode: "ai-studio",
    })).toContain("Cloud Code Assist");
    expect(providerTlsProfileConfigError("google-antigravity", {
      ...canonicalProvider,
      tlsProfile: "raw-ja3" as never,
    })).toContain("antigravity-browser");
  });

  test("config validation rejects a profile on a noncanonical destination", () => {
    const defaults = getDefaultConfig();
    const result = validateConfigCandidate({
      ...defaults,
      providers: {
        ...defaults.providers,
        "google-antigravity": {
          ...defaults.providers["google-antigravity"],
          ...canonicalProvider,
          baseUrl: "https://evil.example",
        },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("canonical");
  });
});

describe("Antigravity TLS transport gate", () => {
  test("recognizes only HTTPS canonical hosts", () => {
    expect(ANTIGRAVITY_TLS_HOSTS).toEqual(new Set([
      "daily-cloudcode-pa.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ]));
    expect(isCanonicalAntigravityUrl("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent")).toBe(true);
    expect(isCanonicalAntigravityUrl("https://cloudcode-pa.googleapis.com:443/v1internal")).toBe(true);
    expect(isCanonicalAntigravityUrl("http://daily-cloudcode-pa.googleapis.com/v1internal")).toBe(false);
    expect(isCanonicalAntigravityUrl("https://evil.example/v1internal")).toBe(false);
    expect(isCanonicalAntigravityUrl("https://daily-cloudcode-pa.googleapis.com:8443/v1internal")).toBe(false);
  });

  test("uses the selected wreq executor and preserves request options", async () => {
    const seen: { input?: unknown; init?: RequestInit } = {};
    const fakeResponse = new Response("event: done\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const transport = { close: mock(async () => undefined) };
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => transport,
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          seen.input = input;
          seen.init = init;
          return fakeResponse;
        },
      }),
    });

    const executor = providerTlsFetch("google-antigravity", canonicalProvider, globalThis.fetch);
    const signal = new AbortController().signal;
    const response = await executor(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent",
      {
        method: "POST",
        headers: { authorization: "Bearer redacted", "content-type": "application/json" },
        body: "{\"request\":1}",
        signal,
        redirect: "manual",
      },
    );

    expect(response).toBe(fakeResponse);
    expect(seen.input).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent");
    expect(seen.init).toMatchObject({
      method: "POST",
      body: "{\"request\":1}",
      signal,
      redirect: "manual",
      disableDefaultHeaders: true,
      cookieMode: "ephemeral",
      transport,
    });
    expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer redacted");
    expect(getProviderTlsProfileStatus("google-antigravity")).toBe("active");
  });

  test("providerFetch routes the opt-in profile while leaving the default executor untouched", async () => {
    let wreqCalls = 0;
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          wreqCalls += 1;
          return new Response("wreq");
        },
      }),
    });
    const configured = providerFetch(canonicalProvider, undefined, { providerName: "google-antigravity" });
    expect(await configured("https://daily-cloudcode-pa.googleapis.com/v1internal")).toEqual(expect.any(Response));
    expect(wreqCalls).toBe(1);

    let bunCalls = 0;
    const bun = mock(async () => {
      bunCalls += 1;
      return new Response("bun");
    }) as typeof globalThis.fetch;
    // The default provider fetch uses global fetch; inject it through the provider-owned seam.
    const explicitDefault = providerFetch({ ...canonicalProvider, tlsProfile: undefined, fetch: bun } as never, undefined, {
      providerName: "google-antigravity",
    });
    await explicitDefault("https://daily-cloudcode-pa.googleapis.com/v1internal");
    expect(bunCalls).toBe(1);
  });

  test("falls back once when import or construction fails and never replays post-dispatch errors", async () => {
    let bunCalls = 0;
    const bunFetch = mock(async () => {
      bunCalls += 1;
      return new Response("bun");
    }) as typeof globalThis.fetch;
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => { throw new Error("missing native prebuild"); },
        fetch: async () => { throw new Error("must not dispatch"); },
      }),
    });
    const executor = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
    expect(await executor("https://daily-cloudcode-pa.googleapis.com/v1internal")).toBeInstanceOf(Response);
    expect(await executor("https://daily-cloudcode-pa.googleapis.com/v1internal")).toBeInstanceOf(Response);
    expect(bunCalls).toBe(2);
    expect(getProviderTlsProfileStatus("google-antigravity")).toBe("fallback");

    resetProviderTlsProfileForTests();
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => { throw new Error("post-dispatch failure"); },
      }),
    });
    const noReplay = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
    await expect(noReplay("https://daily-cloudcode-pa.googleapis.com/v1internal")).rejects.toThrow("post-dispatch failure");
    expect(bunCalls).toBe(2);
  });
});

describe("Antigravity proxy selection", () => {
  test("honors HTTPS/ALL_PROXY precedence and NO_PROXY", () => {
    const env = {
      HTTPS_PROXY: "http://proxy-user:secret@example.test:8080",
      ALL_PROXY: "http://all.example:8080",
      NO_PROXY: "daily-cloudcode-pa.googleapis.com",
    };
    expect(proxyForUrl("https://daily-cloudcode-pa.googleapis.com/v1", env)).toBeUndefined();
    expect(proxyForUrl("https://other.example/v1", env)).toBe("http://proxy-user:secret@example.test:8080");
    expect(proxyForUrl("http://other.example/v1", { ALL_PROXY: "http://all.example:8080" })).toBe("http://all.example:8080");
  });
});
