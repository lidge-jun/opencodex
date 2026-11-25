/**
 * An explicit provider HTTP(S) proxy stays authoritative over the process NO_PROXY.
 *
 * Bun's fetch connects directly to a destination the process NO_PROXY exempts, even when the
 * request names a proxy. These cases use a real transport (two loopback listeners) because a
 * mocked fetch only sees the option, not the route the request actually takes.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  configuredOutboundFetch,
  ExplicitProxyExemptedError,
  processNoProxyExempts,
  type ProxyCapableRequestInit,
} from "../../src/lib/proxy-env";
import { providerEgressFetchInit, resolveProviderEgress } from "../../src/lib/provider-egress";

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
