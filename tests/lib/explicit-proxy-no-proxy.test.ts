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

const send = (init: ProxyCapableRequestInit) =>
  configuredOutboundFetch(destUrl, { ...init, headers: { authorization: "Bearer synthetic-test-token" } } as RequestInit);

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
