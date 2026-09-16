import { afterEach, describe, expect, mock, test } from "bun:test";
import { InvalidProviderEgressError } from "../../src/lib/provider-egress";
import type { ProviderOutboundDependencies } from "../../src/lib/provider-outbound";
import { providerOutboundGet, providerOutboundPost, ProviderOutboundPolicyError } from "../../src/lib/provider-outbound";

const PROXY_B = "http://127.0.0.1:7897";
const PROXY_B_URL = new URL(PROXY_B).toString();
const DISCOVERY_URL = "https://provider.example/v1/models";

const ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
let savedEnv: Record<string, string | undefined>;
const realFetch = globalThis.fetch;

function clearProxyEnv(): void {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  if (!savedEnv) return;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function publicDependencies(captured?: { benchmark?: boolean }): { dependencies: ProviderOutboundDependencies; resolveAddresses: ReturnType<typeof mock> } {
  const resolveAddresses = mock(async (_url: string, options?: { allowBenchmarkAddresses?: boolean }) => {
    if (captured) captured.benchmark = options?.allowBenchmarkAddresses;
    return { hostname: "provider.example", addresses: [{ address: "93.184.216.34", family: 4 }], privateNetwork: false };
  });
  return { resolveAddresses, dependencies: { resolveAddresses: resolveAddresses as unknown as ProviderOutboundDependencies["resolveAddresses"] } };
}

function stubGlobalFetch(): { seen: Array<{ url: unknown; init?: RequestInit }>; spy: ReturnType<typeof mock> } {
  const seen: Array<{ url: unknown; init?: RequestInit }> = [];
  const spy = mock(async (url: unknown, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response("{}");
  });
  globalThis.fetch = spy as unknown as typeof globalThis.fetch;
  return { seen, spy };
}

describe("providerOutbound egress wiring", () => {
  test("explicit custom proxy pins discovery GET request-scoped", async () => {
    clearProxyEnv();
    const { seen } = stubGlobalFetch();
    const { dependencies } = publicDependencies();
    const response = await providerOutboundGet("acme", { baseUrl: "https://provider.example", proxy: PROXY_B }, DISCOVERY_URL, {}, dependencies);
    expect(await response.text()).toBe("{}");
    expect(seen.length).toBe(1);
    expect(seen[0]?.url).toBe(DISCOVERY_URL);
    const init = seen[0]?.init as Record<string, unknown>;
    expect(init?.proxy).toBe(PROXY_B_URL);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
  });

  test("explicit custom proxy wins over a global NO_PROXY hit", async () => {
    clearProxyEnv();
    process.env.NO_PROXY = "provider.example";
    process.env.no_proxy = "provider.example";
    const captured: { benchmark?: boolean } = {};
    const { seen } = stubGlobalFetch();
    const { dependencies } = publicDependencies(captured);
    await providerOutboundGet("acme", { baseUrl: "https://provider.example", proxy: PROXY_B }, DISCOVERY_URL, {}, dependencies);
    expect(seen.length).toBe(1);
    expect((seen[0]?.init as Record<string, unknown>)?.proxy).toBe(PROXY_B_URL);
    expect(captured.benchmark).toBe(true);
  });

  test("explicit custom proxy pins management POST with manual redirect", async () => {
    clearProxyEnv();
    const { seen } = stubGlobalFetch();
    const { dependencies } = publicDependencies();
    await providerOutboundPost("acme", { baseUrl: "https://provider.example", proxy: PROXY_B }, "https://provider.example/v1/usage", { body: "{}" }, dependencies);
    expect(seen.length).toBe(1);
    const init = seen[0]?.init as Record<string, unknown>;
    expect(init?.proxy).toBe(PROXY_B_URL);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
  });

  test("invalid proxy fails closed before DNS or transport", async () => {
    clearProxyEnv();
    const { spy } = stubGlobalFetch();
    const { dependencies, resolveAddresses } = publicDependencies();
    await expect(providerOutboundGet("acme", { baseUrl: "https://provider.example", proxy: "direct" }, DISCOVERY_URL, {}, dependencies)).rejects.toBeInstanceOf(InvalidProviderEgressError);
    expect(resolveAddresses.mock.calls.length).toBe(0);
    expect(spy.mock.calls.length).toBe(0);
  });

  test("destination policy still blocks metadata targets under explicit proxy", async () => {
    clearProxyEnv();
    const { spy } = stubGlobalFetch();
    // Real resolver: a literal metadata IP is rejected without any DNS lookup.
    await expect(providerOutboundGet("acme", { baseUrl: "https://provider.example", proxy: PROXY_B }, "https://169.254.169.254/latest", {}, {})).rejects.toBeInstanceOf(ProviderOutboundPolicyError);
    expect(spy.mock.calls.length).toBe(0);
  });

  test("inherit without proxy env keeps the pinned direct path (legacy)", async () => {
    clearProxyEnv();
    const { spy } = stubGlobalFetch();
    let pinnedCalled = 0;
    const dependencies: ProviderOutboundDependencies = {
      resolveAddresses: (async () => ({ hostname: "provider.example", addresses: [{ address: "93.184.216.34", family: 4 }], privateNetwork: false })) as unknown as ProviderOutboundDependencies["resolveAddresses"],
      pinnedGet: (async () => { pinnedCalled++; return new Response("pinned"); }) as unknown as ProviderOutboundDependencies["pinnedGet"],
    };
    const response = await providerOutboundGet("acme", { baseUrl: "https://provider.example" }, DISCOVERY_URL, {}, dependencies);
    expect(await response.text()).toBe("pinned");
    expect(pinnedCalled).toBe(1);
    expect(spy.mock.calls.length).toBe(0);
  });
});
