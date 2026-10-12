import { afterEach, describe, expect, mock, test } from "bun:test";
import { DestinationDnsResolutionError } from "../../src/lib/destination-policy";
import type { ProviderOutboundDependencies } from "../../src/lib/provider-outbound";
import { InvalidProviderEgressError, PROVIDER_EGRESS_DIRECT } from "../../src/lib/provider-egress";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";

/**
 * Provider discovery and quota probes share one transport chokepoint, `providerOutboundRequest`.
 * Every caller of `providerOutboundGet`/`providerOutboundPost` — provider discovery, the
 * model-catalog gather, the management provider test and the Ollama show probe — reaches the
 * wire through the decision these cases pin.
 *
 * What makes these regressions rather than smoke tests: every one of them would pass if the
 * provider route were ignored entirely, as long as the assertion were only "the request
 * succeeded". Each case therefore asserts WHICH transport carried the request and WHICH proxy
 * value it was pinned to.
 */
const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of proxyKeys) {
    const previous = originalProxyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

const MODELS_URL = "https://provider.example/v1/models";
const GLOBAL_PROXY = "http://global-egress.example:3128";
const PROVIDER_PROXY = "http://provider-egress.example:8080";

function pinnedDependencies(options?: { dnsFails?: boolean }): {
  dependencies: ProviderOutboundDependencies;
  captured: { address?: string };
} {
  const captured: { address?: string } = {};
  return {
    captured,
    dependencies: {
      resolveAddresses: mock(async () => {
        if (options?.dnsFails) throw new DestinationDnsResolutionError("provider.example did not resolve");
        return { hostname: "provider.example", addresses: [{ address: "93.184.216.34", family: 4 }], privateNetwork: false };
      }),
      pinnedGet: mock(async (_url, pinned) => {
        captured.address = pinned.address;
        return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
      }),
      pinnedPost: mock(async (_url, pinned) => {
        captured.address = pinned.address;
        return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
      }),
    },
  };
}

/** Replace the global fetch and record the request-scoped proxy each call was pinned to. */
function captureProxiedFetch(): { calls: Array<unknown>; restore: () => void } {
  const calls: Array<unknown> = [];
  const original = globalThis.fetch;
  const stub = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push((init as { proxy?: unknown } | undefined)?.proxy);
    return new Response('{"data":[]}', { status: 200, headers: { "content-type": "application/json" } });
  });
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("per-provider egress on the discovery and quota transport", () => {
  test("a provider pinned to direct keeps the DNS-pinned transport while a global proxy is set", async () => {
    // The DNS-pinned transport connects to an address this process resolved, through node:http,
    // which never reads the proxy environment. That is what makes direct egress expressible
    // here without asking anything of the runtime's own proxy handling.
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = GLOBAL_PROXY;
    process.env.https_proxy = GLOBAL_PROXY;
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies, captured } = pinnedDependencies();
    const proxied = captureProxiedFetch();
    try {
      const response = await providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: PROVIDER_EGRESS_DIRECT },
        MODELS_URL, {}, dependencies,
      );
      expect(response.status).toBe(200);
      expect(captured.address).toBe("93.184.216.34");
      expect(proxied.calls).toEqual([]);
    } finally {
      proxied.restore();
    }
  });

  test("a provider proxy is pinned onto the request instead of being re-inferred from the environment", async () => {
    // A global proxy is set to a DIFFERENT value on purpose: passing the request to fetch
    // without pinning would let the environment decide, and the request would still succeed
    // through the wrong exit.
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = GLOBAL_PROXY;
    process.env.https_proxy = GLOBAL_PROXY;
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies } = pinnedDependencies();
    const proxied = captureProxiedFetch();
    try {
      await providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: PROVIDER_PROXY },
        MODELS_URL, {}, dependencies,
      );
      expect(proxied.calls).toEqual([`${PROVIDER_PROXY}/`]);
    } finally {
      proxied.restore();
    }
  });

  test("a provider proxy applies where global NO_PROXY exempts the host", async () => {
    // The operator named this proxy for this provider. A global bypass list describes the
    // global route and must not silently cancel the provider's own choice; the exemption that
    // belongs to that choice is providers.<name>.noProxy, asserted below.
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = GLOBAL_PROXY;
    process.env.NO_PROXY = "provider.example";
    process.env.no_proxy = "provider.example";
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies } = pinnedDependencies();
    const proxied = captureProxiedFetch();
    try {
      await providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: PROVIDER_PROXY },
        MODELS_URL, {}, dependencies,
      );
      expect(proxied.calls).toEqual([`${PROVIDER_PROXY}/`]);
    } finally {
      proxied.restore();
    }
  });

  test("a provider noProxy match returns the request to the pinned transport", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies, captured } = pinnedDependencies();
    const proxied = captureProxiedFetch();
    try {
      await providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: PROVIDER_PROXY, noProxy: "provider.example" },
        MODELS_URL, {}, dependencies,
      );
      expect(captured.address).toBe("93.184.216.34");
      expect(proxied.calls).toEqual([]);
    } finally {
      proxied.restore();
    }
  });

  test("a provider that declares nothing leaves the global decision untouched", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = GLOBAL_PROXY;
    process.env.https_proxy = GLOBAL_PROXY;
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies } = pinnedDependencies();
    const proxied = captureProxiedFetch();
    try {
      await providerOutboundGet("vendor", { baseUrl: "https://provider.example" }, MODELS_URL, {}, dependencies);
      // The global decision reaches the wire exactly as it did before this field existed,
      // which is what "inherit" has to mean. That decision already pins the scheme-matched
      // proxy here — the fake-IP admission binds the transport to the value it assumed rather
      // than letting fetch re-infer it — so the assertion is that the pin is the GLOBAL proxy
      // and is unchanged, not that no pin exists.
      expect(proxied.calls).toEqual([GLOBAL_PROXY]);
    } finally {
      proxied.restore();
    }
  });

  test("a DNS failure keeps an explicit provider proxy pinned through the degradation", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies } = pinnedDependencies({ dnsFails: true });
    const proxied = captureProxiedFetch();
    try {
      await providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: PROVIDER_PROXY },
        MODELS_URL, {}, dependencies,
      );
      // Re-inferring the route here would move the request to a different exit at the exact
      // moment local DNS stopped working, which is when the proxy matters most.
      expect(proxied.calls).toEqual([`${PROVIDER_PROXY}/`]);
    } finally {
      proxied.restore();
    }
  });

  test("a DNS failure under direct egress surfaces instead of degrading to an unpinned fetch", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = GLOBAL_PROXY;
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies } = pinnedDependencies({ dnsFails: true });
    const proxied = captureProxiedFetch();
    try {
      await expect(providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: PROVIDER_EGRESS_DIRECT },
        MODELS_URL, {}, dependencies,
      )).rejects.toThrow(DestinationDnsResolutionError);
      expect(proxied.calls).toEqual([]);
    } finally {
      proxied.restore();
    }
  });

  test("a malformed provider egress value refuses the request rather than choosing a route", async () => {
    for (const key of proxyKeys) delete process.env[key];
    process.env.HTTPS_PROXY = GLOBAL_PROXY;
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const { dependencies, captured } = pinnedDependencies();
    const proxied = captureProxiedFetch();
    try {
      await expect(providerOutboundGet(
        "vendor",
        { baseUrl: "https://provider.example", proxy: "ftp://egress.example" },
        MODELS_URL, {}, dependencies,
      )).rejects.toThrow(InvalidProviderEgressError);
      // Neither degradation happened: no proxied send, and no direct send either.
      expect(proxied.calls).toEqual([]);
      expect(captured.address).toBeUndefined();
    } finally {
      proxied.restore();
    }
  });

  test("an explicit route is refused on a caller-supplied executor instead of being dropped", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
    const executor = mock(async () => new Response(null, { status: 200 }));
    await expect(providerOutboundGet(
      "vendor",
      { baseUrl: "https://provider.example", proxy: PROVIDER_PROXY, fetch: executor as unknown as typeof globalThis.fetch },
      MODELS_URL, {}, pinnedDependencies().dependencies,
    )).rejects.toThrow(InvalidProviderEgressError);
    // The executor owns its own routing, so running it would send the request by a route the
    // configuration contradicts.
    expect(executor).not.toHaveBeenCalled();
  });
});
