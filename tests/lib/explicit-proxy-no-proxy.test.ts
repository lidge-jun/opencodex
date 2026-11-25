/**
 * An explicit provider HTTP(S) proxy stays authoritative over the process NO_PROXY.
 *
 * Bun's fetch connects directly to a destination the process NO_PROXY exempts, even when the
 * request names a proxy. These cases use a real transport (two loopback listeners) because a
 * mocked fetch only sees the option, not the route the request actually takes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  configuredOutboundFetch,
  ExplicitProxyExemptedError,
  ExplicitProxyRedirectRefusedError,
  processNoProxyExempts,
  type ProxyCapableRequestInit,
} from "../../src/lib/proxy-env";
import { providerEgressFetchInit, resolveProviderEgress } from "../../src/lib/provider-egress";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import type { OcxProviderConfig } from "../../src/types";

const ENV_KEYS = ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const saved = new Map<string, string | undefined>();
const hits = { dest: 0, proxy: 0 };
let dest: ReturnType<typeof Bun.serve>;
let proxy: ReturnType<typeof Bun.serve>;
let destUrl: string;
let proxyUrl: string;

beforeAll(() => {
  dest = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits.dest += 1; return new Response("dest"); } });
  proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits.proxy += 1; return new Response("proxy"); } });
  destUrl = `http://127.0.0.1:${dest.port}/v1/models`;
  proxyUrl = `http://127.0.0.1:${proxy.port}`;
});
afterAll(() => { dest.stop(true); proxy.stop(true); });
beforeEach(() => {
  for (const key of ENV_KEYS) { saved.set(key, process.env[key]); delete process.env[key]; }
  hits.dest = 0;
  hits.proxy = 0;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const send = (init: ProxyCapableRequestInit, target = destUrl) =>
  configuredOutboundFetch(target, { ...init, headers: { authorization: "Bearer synthetic-test-token" } } as RequestInit);

test("without NO_PROXY the explicit proxy carries the request", async () => {
  const response = await send({ proxy: proxyUrl });
  expect(await response.text()).toBe("proxy");
  expect(hits).toEqual({ dest: 0, proxy: 1 });
});

for (const spelling of ["NO_PROXY", "no_proxy"] as const) {
  for (const entry of ["127.0.0.1", "*"]) {
    test(`a process ${spelling}=${entry} never sends an explicit-proxy request directly`, async () => {
      process.env[spelling] = entry;
      const error = await send({ proxy: proxyUrl }).then(() => null, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ExplicitProxyExemptedError);
      expect((error as ExplicitProxyExemptedError).code).toBe("explicit_proxy_exempted");
      expect((error as Error).message).not.toContain("synthetic-test-token");
      expect(hits).toEqual({ dest: 0, proxy: 0 });
    });
  }
}

test("a provider proxy route resolved by the egress authority is refused the same way", async () => {
  process.env.NO_PROXY = "127.0.0.1";
  const egress = resolveProviderEgress({ providerName: "p", provider: { proxy: proxyUrl }, url: destUrl });
  expect(egress.kind).toBe("proxy");
  await expect(send(providerEgressFetchInit(egress))).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
  expect(hits).toEqual({ dest: 0, proxy: 0 });
});

test("the provider's own noProxy remains the way to connect such a host directly", async () => {
  process.env.NO_PROXY = "127.0.0.1";
  const egress = resolveProviderEgress({ providerName: "p", provider: { proxy: proxyUrl, noProxy: "127.0.0.1" }, url: destUrl });
  expect(egress).toEqual({ kind: "direct", reason: "noProxy" });
  expect(await (await send(providerEgressFetchInit(egress))).text()).toBe("dest");
  expect(hits).toEqual({ dest: 1, proxy: 0 });
});

test("an inherited route and proxy:false keep their existing behavior", async () => {
  process.env.NO_PROXY = "127.0.0.1";
  expect(await (await send({})).text()).toBe("dest");
  expect(await (await send({ proxy: false })).text()).toBe("dest");
  expect(hits).toEqual({ dest: 2, proxy: 0 });
});

test("exemption matching covers both spellings, wildcards, domains and WebSocket destinations", () => {
  const url = new URL("wss://chatgpt.com/backend-api/codex/responses");
  expect(processNoProxyExempts(url, {})).toBe(false);
  expect(processNoProxyExempts(url, { NO_PROXY: "example.com" })).toBe(false);
  expect(processNoProxyExempts(url, { NO_PROXY: ".chatgpt.com" })).toBe(true);
  expect(processNoProxyExempts(url, { no_proxy: "chatgpt.com" })).toBe(true);
  expect(processNoProxyExempts(url, { NO_PROXY: "example.com", no_proxy: "*" })).toBe(true);
  expect(processNoProxyExempts(url, { NO_PROXY: " " })).toBe(false);
});

// Bun's own matcher splits on whitespace and lets a bare entry cover subdomains; the guard must too.
for (const spelling of ["NO_PROXY", "no_proxy"] as const) {
  test(`a whitespace-separated ${spelling} entry is honored like Bun honors it`, async () => {
    process.env[spelling] = "example.com localhost";
    await expect(send({ proxy: proxyUrl }, `http://localhost:${dest.port}/v1/models`)).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
    expect(hits).toEqual({ dest: 0, proxy: 0 });
  });
  test(`a bare ${spelling} entry also exempts its subdomains, like Bun`, async () => {
    process.env[spelling] = "localhost";
    await expect(send({ proxy: proxyUrl }, `http://app.localhost:${dest.port}/v1/models`)).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
    expect(hits).toEqual({ dest: 0, proxy: 0 });
  });
}

for (const spelling of ["NO_PROXY", "no_proxy"] as const) {
  test(`a ${spelling} CIDR block covering the destination is honored like Bun honors it`, async () => {
    process.env[spelling] = "10.0.0.0/8 127.0.0.0/8";
    await expect(send({ proxy: proxyUrl })).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
    expect(hits).toEqual({ dest: 0, proxy: 0 });
  });
  test(`a ${spelling} entry with a zero-padded port is compared numerically, like Bun`, async () => {
    process.env[spelling] = `127.0.0.1:00${dest.port}`;
    await expect(send({ proxy: proxyUrl })).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
    expect(hits).toEqual({ dest: 0, proxy: 0 });
  });
}

test("addresses compare canonically and CIDR blocks cover both families", () => {
  const v4 = new URL("http://127.0.0.1:8080/x");
  const v6 = new URL("http://[::1]:8080/x");
  for (const entry of ["127.0.0.1", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "127.0.0.0/8", "::ffff:127.0.0.0/104", "0.0.0.0/0", "127.0.0.1:08080"]) {
    expect(processNoProxyExempts(v4, { NO_PROXY: entry }), entry).toBe(true);
  }
  for (const entry of ["10.0.0.0/8", "127.0.0.2/32", "127.0.0.1:80", "::ffff:127.0.0.0/95"]) {
    expect(processNoProxyExempts(v4, { NO_PROXY: entry }), entry).toBe(false);
  }
  for (const entry of ["::1", "[::1]", "0:0:0:0:0:0:0:1", "0000::1", "::1/128", "::/0", "[::1]:8080", "[::1]:08080"]) {
    expect(processNoProxyExempts(v6, { NO_PROXY: entry }), entry).toBe(true);
  }
  for (const entry of ["fe80::/10", "[::1]:80", "::2"]) {
    expect(processNoProxyExempts(v6, { NO_PROXY: entry }), entry).toBe(false);
  }
});

test("every entry form Bun 1.4.4 treats as a bypass is a bypass here", () => {
  const url = new URL("http://api.example.com/x");
  // Each of these made Bun connect directly to api.example.com despite an explicit proxy.
  for (const entry of ["example.com", ".example.com", "*.example.com", "api.example.com", "api.example.com:80", "EXAMPLE.COM",
    "other.org example.com", "other.org\texample.com", " example.com ", "*", "com", ".com", "example.com.", "other.org,,example.com"]) {
    expect(processNoProxyExempts(url, { NO_PROXY: entry }), entry).toBe(true);
    expect(processNoProxyExempts(url, { no_proxy: entry }), entry).toBe(true);
  }
  // Bun kept the proxy for these, and so does the guard.
  for (const entry of ["ample.com", "xample.com", "api.example", "api.example.com:8080", "[::1]", "example.*"]) {
    expect(processNoProxyExempts(url, { NO_PROXY: entry }), entry).toBe(false);
  }
  expect(processNoProxyExempts(new URL("https://api.example.com/x"), { NO_PROXY: "api.example.com:443" })).toBe(true);
  expect(processNoProxyExempts(new URL("http://[::1]:8080/x"), { NO_PROXY: "[::1]" })).toBe(true);
});

describe("the provider send boundary", () => {
  const provider = () => ({ adapter: "openai-chat", baseUrl: `http://127.0.0.1:${dest.port}/v1`, proxy: proxyUrl }) as unknown as OcxProviderConfig;

  test("an exempted provider proxy route is refused before any dispatch side effect", async () => {
    process.env.NO_PROXY = "127.0.0.1";
    let receipts = 0;
    let checked = 0;
    const send = providerFetch(provider(), undefined, {
      providerName: "p", onPhysicalDispatch: () => { receipts += 1; }, beforeDispatch: () => { checked += 1; },
    });
    await expect(send(destUrl, { method: "POST", body: "synthetic-body" })).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
    expect({ receipts, checked }).toEqual({ receipts: 0, checked: 0 });
    expect(hits).toEqual({ dest: 0, proxy: 0 });
  });

  test("a destination rebuilt by a dispatch override is decided before its dispatch receipt", async () => {
    process.env.NO_PROXY = "localhost";
    let receipts = 0;
    const send = providerFetch(provider(), undefined, {
      providerName: "p", onPhysicalDispatch: () => { receipts += 1; },
      // The queued request is rebuilt against another host at its physical send.
      dispatchOverride: (_input, init, execute) => execute(`http://localhost:${dest.port}/v1/models`, init),
    });
    await expect(send(destUrl, { method: "POST", body: "synthetic-body" })).rejects.toBeInstanceOf(ExplicitProxyExemptedError);
    expect(receipts).toBe(0);
    expect(hits).toEqual({ dest: 0, proxy: 0 });
  });

  test("a route that is not exempted still dispatches once through the proxy", async () => {
    process.env.NO_PROXY = "example.invalid";
    let receipts = 0;
    const send = providerFetch(provider(), undefined, { providerName: "p", onPhysicalDispatch: () => { receipts += 1; } });
    expect(await (await send(destUrl, { method: "POST", body: "synthetic-body" })).text()).toBe("proxy");
    expect(receipts).toBe(1);
    expect(hits).toEqual({ dest: 0, proxy: 1 });
  });
});

describe("redirects of an explicit-proxy request", () => {
  type Seen = { method: string; path: string; body: string };
  const viaProxy: Seen[] = [];
  const atExempt: Seen[] = [];
  let redirectTo = "";
  let redirectStatus = 307;
  let exempt: ReturnType<typeof Bun.serve>;
  let forwardProxy: ReturnType<typeof Bun.serve>;
  const seen = async (req: Request): Promise<Seen> => ({ method: req.method, path: new URL(req.url).pathname, body: await req.text() });

  beforeAll(() => {
    exempt = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => { atExempt.push(await seen(req)); return new Response("exempt"); } });
    // A forward proxy: it answers every proxied request itself, redirecting /start.
    forwardProxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async req => {
      const request = await seen(req);
      viaProxy.push(request);
      if (request.path === "/start") return new Response(null, { status: redirectStatus, headers: { location: redirectTo } });
      return new Response(`landed ${request.method} ${request.body}`);
    } });
  });
  afterAll(() => { exempt.stop(true); forwardProxy.stop(true); });
  beforeEach(() => { viaProxy.length = 0; atExempt.length = 0; redirectStatus = 307; });

  const proxied = (init: RequestInit = {}) => ({ ...init, proxy: `http://127.0.0.1:${forwardProxy.port}` }) as ProxyCapableRequestInit as RequestInit;
  const startUrl = () => `http://127.0.0.1:${dest.port}/start`;
  const post = () => configuredOutboundFetch(startUrl(), proxied({
    method: "POST", body: "synthetic-body", headers: { authorization: "Bearer synthetic-test-token", "x-api-key": "synthetic-test-key" } }));

  for (const spelling of ["NO_PROXY", "no_proxy"] as const) {
    test(`a redirect toward a destination ${spelling} exempts is refused and that destination is never contacted`, async () => {
      process.env[spelling] = `127.0.0.1:${exempt.port}`;
      redirectTo = `http://127.0.0.1:${exempt.port}/landing`;
      await expect(post()).rejects.toBeInstanceOf(ExplicitProxyRedirectRefusedError);
      expect(viaProxy.map(request => request.path)).toEqual(["/start"]);
      expect(atExempt).toEqual([]);
    });
  }

  for (const status of [301, 302, 303, 307, 308]) {
    test(`with a bypass list set, a ${status} is refused after exactly one send`, async () => {
      process.env.NO_PROXY = "example.invalid";
      redirectStatus = status;
      redirectTo = `http://127.0.0.1:${dest.port}/landing`;
      const error = await post().then(() => null, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ExplicitProxyRedirectRefusedError);
      expect((error as ExplicitProxyRedirectRefusedError).code).toBe("explicit_proxy_redirect_refused");
      expect(viaProxy).toEqual([{ method: "POST", path: "/start", body: "synthetic-body" }]);
    });
  }

  test("a Request carrying a streamed body is sent once and its redirect refused", async () => {
    process.env.NO_PROXY = "example.invalid";
    redirectTo = `http://127.0.0.1:${dest.port}/landing`;
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("streamed")); controller.close(); } });
    const request = new Request(startUrl(), { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(configuredOutboundFetch(request, proxied())).rejects.toBeInstanceOf(ExplicitProxyRedirectRefusedError);
    expect(viaProxy).toEqual([{ method: "POST", path: "/start", body: "streamed" }]);
  });

  test("without a bypass list Bun's own redirect handling is unchanged", async () => {
    redirectTo = `http://127.0.0.1:${dest.port}/landing`;
    const response = await post();
    expect(await response.text()).toBe("landed POST synthetic-body");
    expect(response.redirected).toBe(true);
    expect(viaProxy.map(request => request.path)).toEqual(["/start", "/landing"]);
  });

  test("an unredirected response passes through untouched", async () => {
    process.env.NO_PROXY = "example.invalid";
    const response = await configuredOutboundFetch(`http://127.0.0.1:${dest.port}/landing`, proxied());
    expect(response.redirected).toBe(false);
    expect(response.clone().redirected).toBe(false);
    expect(await response.text()).toBe("landed GET ");
  });

  test("a caller's error redirect mode reaches Bun unchanged and makes no second request", async () => {
    process.env.NO_PROXY = "example.invalid";
    redirectTo = `http://127.0.0.1:${dest.port}/landing`;
    const error = await configuredOutboundFetch(startUrl(), proxied({ redirect: "error" })).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ExplicitProxyRedirectRefusedError);
    expect(viaProxy.map(request => request.path)).toEqual(["/start"]);
  });

  test("a caller's manual redirect mode is left to the caller", async () => {
    process.env.NO_PROXY = `127.0.0.1:${exempt.port}`;
    redirectTo = `http://127.0.0.1:${exempt.port}/landing`;
    const response = await configuredOutboundFetch(startUrl(), proxied({ redirect: "manual" }));
    expect(response.status).toBe(307);
    expect(atExempt).toEqual([]);
  });
});
