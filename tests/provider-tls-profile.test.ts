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
import { PROXY_ENV_KEYS } from "../src/lib/proxy-env";
import { providerFetch } from "../src/server/responses/fetch-helpers";

const canonicalProvider = {
  adapter: "google",
  authMode: "oauth",
  googleMode: "cloud-code-assist",
  baseUrl: "https://daily-cloudcode-pa.googleapis.com",
  tlsProfile: "antigravity-browser" as const,
};
const userInfoUrl = new URL("https://daily-cloudcode-pa.googleapis.com/v1internal");
userInfoUrl.username = "user";
userInfoUrl.password = "secret";
const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]).map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of Object.keys(originalProxyEnv)) {
    const previous = originalProxyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
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
    expect(providerTlsProfileConfigError("google-antigravity", {
      ...canonicalProvider,
      baseUrl: userInfoUrl.toString(),
    })).toContain("canonical");
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
  test("does not expose active or fallback state for a replaced provider contract", async () => {
    const statusFor = (provider: typeof canonicalProvider) => getProviderTlsProfileStatus("google-antigravity", provider);
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => new Response("ok"),
      }),
    });
    await providerTlsFetch("google-antigravity", canonicalProvider, globalThis.fetch)(
      "https://daily-cloudcode-pa.googleapis.com/v1internal",
    );
    expect(statusFor(canonicalProvider)).toBe("active");
    expect(statusFor({ ...canonicalProvider, baseUrl: "https://cloudcode-pa.googleapis.com" })).toBe("disabled");

    resetProviderTlsProfileForTests();
    setProviderTlsRuntimeForTest({ importWreq: async () => { throw new Error("native unavailable"); } });
    const bunFallback = (async () => new Response("bun")) as typeof globalThis.fetch;
    await providerTlsFetch("google-antigravity", canonicalProvider, bunFallback)(
      "https://daily-cloudcode-pa.googleapis.com/v1internal",
    );
    expect(statusFor(canonicalProvider)).toBe("fallback");
    expect(statusFor({ ...canonicalProvider, authMode: "key" as never })).toBe("disabled");
  });

  test("recognizes only HTTPS canonical hosts", () => {
    expect(ANTIGRAVITY_TLS_HOSTS).toEqual(new Set([
      "daily-cloudcode-pa.googleapis.com",
      "cloudcode-pa.googleapis.com",
    ]));
    expect(isCanonicalAntigravityUrl("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent")).toBe(true);
    expect(isCanonicalAntigravityUrl("https://cloudcode-pa.googleapis.com:443/v1internal")).toBe(true);
    expect(isCanonicalAntigravityUrl(userInfoUrl)).toBe(false);
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
        redirect: "follow",
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
    expect(getProviderTlsProfileStatus("google-antigravity", canonicalProvider)).toBe("active");
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

  test("requires the configured provider base URL to be canonical", async () => {
    let wreqCalls = 0;
    let bunCalls = 0;
    const bunFetch = mock(async () => {
      bunCalls += 1;
      return new Response("bun");
    }) as typeof globalThis.fetch;
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          wreqCalls += 1;
          return new Response("wreq");
        },
      }),
    });
    const executor = providerTlsFetch("google-antigravity", {
      ...canonicalProvider,
      baseUrl: "https://attacker.example",
    }, bunFetch);
    await executor("https://daily-cloudcode-pa.googleapis.com/v1internal");
    await executor(userInfoUrl);
    expect(wreqCalls).toBe(0);
    expect(bunCalls).toBe(2);
  });

  test("keeps OAuth token destinations on Bun fetch", async () => {
    let wreqCalls = 0;
    let bunCalls = 0;
    const bunFetch = mock(async () => {
      bunCalls += 1;
      return new Response("bun");
    }) as typeof globalThis.fetch;
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          wreqCalls += 1;
          return new Response("wreq");
        },
      }),
    });
    const executor = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
    await executor("https://oauth2.googleapis.com/token", { method: "POST" });
    expect(bunCalls).toBe(1);
    expect(wreqCalls).toBe(0);
  });

  test("caches one successful module initialization and falls back if a later import would fail", async () => {
    let importCalls = 0;
    let bunCalls = 0;
    const bunFetch = mock(async () => {
      bunCalls += 1;
      return new Response("bun");
    }) as typeof globalThis.fetch;
    const partialTransport = { close: mock(async () => undefined) };
    setProviderTlsRuntimeForTest({
      importWreq: async () => {
        importCalls += 1;
        if (importCalls > 1) throw new Error("hypothetical second import failure");
        return {
          createTransport: async () => partialTransport,
          fetch: async () => new Response("wreq"),
        };
      },
    });
    const executor = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
    await expect(executor("https://daily-cloudcode-pa.googleapis.com/v1internal")).resolves.toEqual(expect.any(Response));
    expect(importCalls).toBe(1);
    expect(bunCalls).toBe(0);
    expect(partialTransport.close).not.toHaveBeenCalled();
  });

  test("falls back once when import or construction fails and never replays post-dispatch errors", async () => {
    let bunCalls = 0;
    const fallbackInits: RequestInit[] = [];
    const bunFetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      bunCalls += 1;
      if (init) fallbackInits.push(init);
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
    expect(fallbackInits).toHaveLength(2);
    expect(fallbackInits.every(init => init.redirect === "manual")).toBe(true);
    expect(getProviderTlsProfileStatus("google-antigravity", canonicalProvider)).toBe("fallback");

    resetProviderTlsProfileForTests();
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => { throw new Error("post-dispatch failure at http://proxy-user:proxy-secret@example.test:8080/path?access_token=BearerSecret"); },
      }),
    });
    const noReplay = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
    await expect(noReplay("https://daily-cloudcode-pa.googleapis.com/v1internal")).rejects.toThrow("post-dispatch failure");
    await expect(noReplay("https://daily-cloudcode-pa.googleapis.com/v1internal")).rejects.not.toThrow(/proxy-user|proxy-secret|BearerSecret|access_token/);
    expect(bunCalls).toBe(2);
  });

  test("preserves only safe cancellation identity while redacting native details", async () => {
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          const timeout = new Error("timeout at http://proxy-user:proxy-secret@example.test:8080/?access_token=secret-token");
          timeout.name = "TimeoutError";
          Object.assign(timeout, { code: "ETIMEDOUT", cause: new Error("secret cause") });
          throw timeout;
        },
      }),
    });
    const executor = providerTlsFetch("google-antigravity", canonicalProvider, globalThis.fetch);
    let caught: unknown;
    try {
      await executor("https://daily-cloudcode-pa.googleapis.com/v1internal");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ name: "TimeoutError", code: "ETIMEDOUT" });
    expect((caught as Error).message).not.toMatch(/proxy-user|proxy-secret|secret-token|access_token/);
    expect((caught as { cause?: unknown }).cause).toBeUndefined();
    expect((caught as Error).stack).not.toContain("secret-token");
  });

  test("preserves AbortError without replaying through Bun", async () => {
    let bunCalls = 0;
    const bunFetch = mock(async () => {
      bunCalls += 1;
      return new Response("bun");
    }) as typeof globalThis.fetch;
    setProviderTlsRuntimeForTest({
      importWreq: async () => ({
        createTransport: async () => ({ close: async () => undefined }),
        fetch: async () => {
          const abort = new Error("aborted at http://proxy-user:proxy-secret@example.test");
          abort.name = "AbortError";
          throw abort;
        },
      }),
    });
    const executor = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
    await expect(executor("https://daily-cloudcode-pa.googleapis.com/v1internal")).rejects.toMatchObject({ name: "AbortError" });
    expect(bunCalls).toBe(0);
  });

  test("rejects private and metadata DNS answers before native dispatch", async () => {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
    process.env.NO_PROXY = "";
    process.env.no_proxy = "";
    for (const detail of ["private-network address", "blocked metadata endpoint"]) {
      let nativeCalls = 0;
      let bunCalls = 0;
      setProviderTlsRuntimeForTest({
        resolveDestination: async () => { throw new Error(`Antigravity profile URL targets ${detail}`); },
        importWreq: async () => ({
          createTransport: async () => ({ close: async () => undefined }),
          fetch: async () => { nativeCalls += 1; return new Response("must not send"); },
        }),
      });
      const bunFetch = mock(async () => { bunCalls += 1; return new Response("bun"); }) as typeof globalThis.fetch;
      const executor = providerTlsFetch("google-antigravity", canonicalProvider, bunFetch);
      await expect(executor("https://daily-cloudcode-pa.googleapis.com/v1internal", {
        method: "POST",
        headers: { authorization: "Bearer should-not-send" },
        body: "{}",
      })).rejects.toThrow(detail);
      expect(nativeCalls).toBe(0);
      expect(bunCalls).toBe(0);
      resetProviderTlsProfileForTests();
    }
  });

  test("does not locally resolve proxied destinations", async () => {
    process.env.HTTPS_PROXY = "http://proxy-user:proxy-secret@example.test:8080";
    delete process.env.https_proxy;
    process.env.NO_PROXY = "";
    delete process.env.no_proxy;
    let resolverCalls = 0;
    let nativeCalls = 0;
    let transportProxy: string | undefined;
    setProviderTlsRuntimeForTest({
      resolveDestination: async () => { resolverCalls += 1; throw new Error("must not resolve through proxy"); },
      importWreq: async () => ({
        createTransport: async options => {
          transportProxy = options.proxy;
          return { close: async () => undefined };
        },
        fetch: async () => { nativeCalls += 1; return new Response("ok"); },
      }),
    });
    await providerTlsFetch("google-antigravity", canonicalProvider, globalThis.fetch)("https://daily-cloudcode-pa.googleapis.com/v1internal");
    expect(resolverCalls).toBe(0);
    expect(nativeCalls).toBe(1);
    expect(transportProxy).toContain("proxy-user");
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
