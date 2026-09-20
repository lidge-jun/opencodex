import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  InvalidProviderEgressError,
  PROVIDER_EGRESS_DIRECT,
  describeProviderEgressForLog,
  providerEgressConfigError,
  providerEgressFetchInit,
  providerEgressIsExplicit,
  resolveProviderEgress,
  sanitizeProxyUrlForLog,
} from "../../src/lib/provider-egress";
import { PROXY_ENV_KEYS, configuredOutboundFetch } from "../../src/lib/proxy-env";

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of proxyKeys) {
    const previous = originalProxyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

const TARGET = "https://api.provider.example/v1/responses";

function resolve(provider: { proxy?: string | null; noProxy?: string | string[] }, url = TARGET) {
  return resolveProviderEgress({ providerName: "vendor", provider, url });
}

describe("provider egress resolution", () => {
  test("an absent field inherits the global decision rather than choosing a route", () => {
    const egress = resolve({});
    expect(egress).toEqual({ kind: "inherit" });
    expect(providerEgressIsExplicit(egress)).toBe(false);
    // Inheriting must contribute no request option at all: a provider that says nothing has to
    // leave the global proxy decision byte-identical to what it was before this field existed.
    expect(providerEgressFetchInit(egress)).toEqual({});
  });

  test("the direct keyword and null both refuse the global proxy", () => {
    for (const value of [PROVIDER_EGRESS_DIRECT, PROVIDER_EGRESS_DIRECT.toUpperCase(), null] as const) {
      const egress = resolve({ proxy: value });
      expect(egress).toEqual({ kind: "direct", reason: "configured" });
      expect(providerEgressIsExplicit(egress)).toBe(true);
    }
  });

  test("an http(s) URL routes this provider through its own proxy", () => {
    expect(resolve({ proxy: "http://egress.example:3128" })).toEqual({
      kind: "proxy", proxyUrl: "http://egress.example:3128/", transport: "http",
    });
    // An https proxy is still the HTTP(S) CONNECT transport; `transport` names the transport
    // family the request is handed to, not the proxy's own scheme.
    expect(resolve({ proxy: "https://egress.example:3129" })).toEqual({
      kind: "proxy", proxyUrl: "https://egress.example:3129/", transport: "http",
    });
  });

  test("a socks5 URL is carried verbatim so the SOCKS transport can parse it", () => {
    // Not normalized through URL.toString(): the SOCKS transport validates the original value,
    // including credentials and the socks5h variant, and a reserialized URL is not guaranteed
    // to round-trip the userinfo it was given.
    for (const value of ["socks5://127.0.0.1:1080", "socks5h://127.0.0.1:1080"]) {
      expect(resolve({ proxy: value })).toEqual({ kind: "proxy", proxyUrl: value, transport: "socks5" });
    }
  });

  test("a provider noProxy match forces direct egress out of the provider's own proxy", () => {
    const provider = { proxy: "http://egress.example:3128", noProxy: "internal.example" };
    expect(resolve(provider, "https://internal.example/v1/models"))
      .toEqual({ kind: "direct", reason: "noProxy" });
    // A destination the list does not name still takes the provider's proxy.
    expect(resolve(provider).kind).toBe("proxy");
  });

  test("a provider noProxy match also carves an exemption out of an inherited global proxy", () => {
    // This is the case a provider-level proxy cannot express: the provider owns no route of its
    // own and only needs one destination kept off the global one.
    expect(resolve({ noProxy: ["internal.example", "10.0.0.1"] }, "https://internal.example/v1/models"))
      .toEqual({ kind: "direct", reason: "noProxy" });
    expect(resolve({ noProxy: ["internal.example"] })).toEqual({ kind: "inherit" });
  });

  test("an empty value is refused instead of being read as either neighbour", () => {
    // The failure this prevents: a cleared dashboard field silently switching a provider from
    // "inherit the global proxy" to "never use it", or the reverse. Both read as success.
    for (const value of ["", "   "]) {
      expect(() => resolve({ proxy: value })).toThrow(InvalidProviderEgressError);
    }
    const message = providerEgressConfigError({ proxy: "" });
    expect(message).toContain(PROVIDER_EGRESS_DIRECT);
  });

  test("a malformed or unsupported value throws rather than degrading to a working route", () => {
    for (const value of ["not a url", "ftp://egress.example", "://", "socks4://127.0.0.1:1080"]) {
      expect(() => resolve({ proxy: value })).toThrow(InvalidProviderEgressError);
      expect(providerEgressConfigError({ proxy: value })).not.toBeNull();
    }
    expect(() => resolve({ proxy: 42 as unknown as string })).toThrow(InvalidProviderEgressError);
    expect(providerEgressConfigError({ noProxy: [7 as unknown as string] })).not.toBeNull();
  });

  test("configuration and request time share one definition of a valid value", () => {
    // Two definitions would drift, and nothing would compare them. A value the loader accepts
    // has to be one a request can actually leave by.
    for (const value of [PROVIDER_EGRESS_DIRECT, "http://egress.example:3128", "socks5://127.0.0.1:1080"]) {
      expect(providerEgressConfigError({ proxy: value })).toBeNull();
      expect(() => resolve({ proxy: value })).not.toThrow();
    }
    expect(providerEgressConfigError({})).toBeNull();
  });
});

describe("provider egress never reproduces a proxy credential", () => {
  test("log output keeps scheme, host and port and drops everything else", () => {
    // A `.test` host, because a credentialed proxy URL reads as `password@host` to the privacy
    // scanner and that domain is on its allowed list for fixtures.
    const secret = "http://operator:hunter2@egress.test:3128/path?token=abc";
    const label = sanitizeProxyUrlForLog(secret);
    expect(label).toBe("http://egress.test:3128");
    for (const fragment of ["operator", "hunter2", "token", "abc"]) {
      expect(label).not.toContain(fragment);
    }
  });

  test("the described route carries no digest of the credential either", () => {
    // A short hash over a known host is a guessable stand-in for the secret and a durable
    // correlation key for the account behind it, so the description derives nothing from it.
    const described = describeProviderEgressForLog(resolve({ proxy: "http://operator:hunter2@egress.test:3128" }));
    expect(described).toBe("http(http://egress.test:3128)");
    expect(described).not.toContain("hunter2");
    expect(describeProviderEgressForLog({ kind: "inherit" })).toBe("inherit");
    expect(describeProviderEgressForLog({ kind: "direct", reason: "noProxy" })).toBe("direct(noProxy)");
  });

  test("an unparseable value is labelled without being echoed", () => {
    const label = sanitizeProxyUrlForLog("operator hunter2 not a url");
    expect(label).toBe("<unparseable-proxy-url>");
    expect(label).not.toContain("hunter2");
  });
});

describe("direct egress overrides the installed SOCKS transport", () => {
  test("a request pinned to direct is not sent through the global SOCKS proxy", async () => {
    // The regression: `proxy: false` is not a string, so reading it as "no explicit proxy was
    // supplied" fell through to ALL_PROXY and sent a request the caller pinned to direct egress
    // through the global SOCKS proxy instead. The request would have succeeded, by the wrong exit.
    for (const key of proxyKeys) delete process.env[key];
    process.env.ALL_PROXY = "socks5://127.0.0.1:1";
    const base = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(JSON.stringify({ proxy: (init as { proxy?: unknown }).proxy ?? null }), { status: 200 });
    });
    const response = await configuredOutboundFetch(
      TARGET,
      providerEgressFetchInit(resolve({ proxy: PROVIDER_EGRESS_DIRECT })) as RequestInit,
      base as unknown as typeof globalThis.fetch,
    );
    expect(base).toHaveBeenCalledTimes(1);
    // Bun reads `false` as "connect directly", overriding HTTP_PROXY, HTTPS_PROXY, ALL_PROXY
    // and NO_PROXY alike. `undefined`, `null` and `""` all mean "no option" and fall back to
    // the environment, so none of them can express this.
    expect(await response.json()).toEqual({ proxy: false });
  });

  test("an inheriting provider still reaches the global SOCKS transport unchanged", async () => {
    for (const key of proxyKeys) delete process.env[key];
    // Port 0 is rejected by the SOCKS transport's own validation before any socket is opened,
    // so the outcome does not depend on what happens to be listening on the test host. What is
    // asserted is which transport took the request, not that it succeeded.
    process.env.ALL_PROXY = "socks5://127.0.0.1:0";
    const base = mock(async () => new Response(null, { status: 200 }));
    // With no explicit option the SOCKS wrapper owns the request, so the base fetch below is
    // never reached. Asserting that keeps this change from quietly disabling global SOCKS.
    const outcome = await configuredOutboundFetch(
      TARGET,
      providerEgressFetchInit(resolve({})) as RequestInit,
      base as unknown as typeof globalThis.fetch,
    ).then(() => "base-fetch-used", () => "socks-transport-owned-the-request");
    expect(outcome).toBe("socks-transport-owned-the-request");
    expect(base).not.toHaveBeenCalled();
  });
});
