/**
 * Per-account egress for Codex pool accounts (catch-up G-012): an account's own proxy / noProxy
 * outranks the provider's, follows the account a request is sent with, and also carries that
 * account's token refresh.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidProviderEgressError,
  poolAccountEgressConfigError,
  resolveProviderEgress,
  type PoolAccountRoute,
} from "../../src/lib/provider-egress";
import { codexAccountEgressRoute } from "../../src/codex/account-egress";
import { providerFetch } from "../../src/server/responses/fetch-helpers";
import { saveConfig } from "../../src/config";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const URL_A = "https://chatgpt.com/backend-api/codex/responses";
const account = (egress: PoolAccountRoute["egress"], id = "acct-a"): PoolAccountRoute => ({ id, scope: `codexAccounts.${id}.egress`, egress });

test("an account proxy outranks the provider's, and an account without one inherits it", () => {
  const provider = { proxy: "http://provider.proxy:8080" };
  expect(resolveProviderEgress({ providerName: "openai", provider, url: URL_A, account: account({ proxy: "http://account.proxy:3128" }) }))
    .toEqual({ kind: "proxy", proxyUrl: "http://account.proxy:3128/", transport: "http" });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: URL_A, account: account({ noProxy: "example.com" }) }))
    .toEqual({ kind: "proxy", proxyUrl: "http://provider.proxy:8080/", transport: "http" });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: URL_A, account: account({ proxy: "direct" }) }))
    .toEqual({ kind: "direct", reason: "configured" });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: URL_A, account: account({ proxy: null }) }))
    .toEqual({ kind: "direct", reason: "configured" });
  expect(resolveProviderEgress({ providerName: "openai", provider: {}, url: URL_A, account: account({ proxy: "socks5h://account.proxy:1080" }) }))
    .toEqual({ kind: "proxy", proxyUrl: "socks5h://account.proxy:1080", transport: "socks5" });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: URL_A })).toMatchObject({ proxyUrl: "http://provider.proxy:8080/" });
});

test("account and provider bypass lists both apply", () => {
  const provider = { proxy: "http://provider.proxy:8080", noProxy: "provider-only.example" };
  const viaAccount = account({ proxy: "http://account.proxy:3128", noProxy: ["chatgpt.com"] });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: URL_A, account: viaAccount })).toEqual({ kind: "direct", reason: "noProxy" });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: "https://provider-only.example/x", account: viaAccount }))
    .toEqual({ kind: "direct", reason: "noProxy" });
  expect(resolveProviderEgress({ providerName: "openai", provider, url: "https://other.example/x", account: viaAccount }))
    .toMatchObject({ proxyUrl: "http://account.proxy:3128/" });
});

test("an invalid account value names the account's field, never the provider's", () => {
  const thrown = (() => {
    try { resolveProviderEgress({ providerName: "openai", provider: {}, url: URL_A, account: account({ proxy: "ftp://x" }) }); }
    catch (error) { return error; }
  })();
  expect(thrown).toBeInstanceOf(InvalidProviderEgressError);
  expect((thrown as Error).message).toStartWith("codexAccounts.acct-a.egress.proxy is invalid:");
  expect(poolAccountEgressConfigError("codexAccounts.a.egress", { proxy: "http://ok.example:1" })).toBeNull();
  expect(poolAccountEgressConfigError("codexAccounts.a.egress", undefined)).toBeNull();
  expect(poolAccountEgressConfigError("codexAccounts.a.egress", { proxy: "" })).toStartWith("codexAccounts.a.egress.proxy is invalid:");
  expect(poolAccountEgressConfigError("codexAccounts.a.egress", { noProxy: [1] })).toStartWith("codexAccounts.a.egress.noProxy is invalid:");
  expect(poolAccountEgressConfigError("codexAccounts.a.egress", { proxy: "http://ok.example:1", weight: 2 })).toBe("codexAccounts.a.egress accepts only proxy and noProxy");
  expect(poolAccountEgressConfigError("codexAccounts.a.egress", "http://x")).toBe("codexAccounts.a.egress must be an object with optional proxy and noProxy");
});

test("only pool accounts that configure a route get one", () => {
  const config = { codexAccounts: [
    { id: "a", email: "", isMain: false, egress: { proxy: "http://a.proxy:1" } },
    { id: "b", email: "", isMain: false },
    { id: "__main__", email: "", isMain: true, egress: { proxy: "http://main.proxy:1" } },
  ] } as Pick<OcxConfig, "codexAccounts">;
  expect(codexAccountEgressRoute(config, "a")).toEqual({ id: "a", scope: "codexAccounts.a.egress", egress: { proxy: "http://a.proxy:1" } });
  expect(codexAccountEgressRoute(config, "b")).toBeUndefined();
  expect(codexAccountEgressRoute(config, "__main__")).toBeUndefined();
  expect(codexAccountEgressRoute(config, null)).toBeUndefined();
});

// Real sockets: two proxies, one destination. Each account's sends leave through its own proxy.
const hits = { dest: 0, a: 0, b: 0 };
let dest: ReturnType<typeof Bun.serve>;
let proxyA: ReturnType<typeof Bun.serve>;
let proxyB: ReturnType<typeof Bun.serve>;
const PROXY_ENV = ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const savedEnv = new Map<string, string | undefined>();
let home = "";
const previousHome = process.env.OPENCODEX_HOME;

beforeAll(() => {
  dest = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits.dest += 1; return new Response("dest"); } });
  proxyA = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits.a += 1; return new Response("via-a"); } });
  proxyB = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits.b += 1; return new Response("via-b"); } });
});
afterAll(() => { dest.stop(true); proxyA.stop(true); proxyB.stop(true); });
beforeEach(() => {
  for (const key of PROXY_ENV) { savedEnv.set(key, process.env[key]); delete process.env[key]; }
  hits.dest = 0; hits.a = 0; hits.b = 0;
  home = mkdtempSync(join(tmpdir(), "ocx-account-egress-"));
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  for (const key of PROXY_ENV) { const value = savedEnv.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

test("two accounts of one provider send through their own proxies, and a moved request follows its account", async () => {
  const provider = { adapter: "openai-chat", baseUrl: `http://127.0.0.1:${dest.port}/v1` } as unknown as OcxProviderConfig;
  const routes: Record<string, PoolAccountRoute> = {
    a: account({ proxy: `http://127.0.0.1:${proxyA.port}` }, "a"),
    b: account({ proxy: `http://127.0.0.1:${proxyB.port}` }, "b"),
  };
  let current = "a";
  const send = providerFetch(provider, undefined, { providerName: "pool", account: () => routes[current] });
  const target = `http://127.0.0.1:${dest.port}/v1/models`;
  expect(await (await send(target)).text()).toBe("via-a");
  current = "b"; // failover moved the request to another pool account
  expect(await (await send(target)).text()).toBe("via-b");
  expect(hits).toEqual({ dest: 0, a: 1, b: 1 });
  const plain = providerFetch(provider, undefined, { providerName: "pool" });
  expect(await (await plain(target)).text()).toBe("dest");
});

test("an account's token refresh leaves through that account's route", async () => {
  saveConfig({
    port: 0, defaultProvider: "openai", providers: {},
    codexAccounts: [
      { id: "routed", email: "", isMain: false, egress: { proxy: "http://127.0.0.1:9" } },
      { id: "plain", email: "", isMain: false },
    ],
  } as unknown as OcxConfig);
  const { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } = await import("../../src/codex/account-store");
  const seen: Array<{ url: string; proxy: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), proxy: (init as { proxy?: unknown } | undefined)?.proxy });
    return new Response(JSON.stringify({ error: "server_error" }), { status: 503 });
  }) as typeof fetch;
  try {
    for (const id of ["routed", "plain"]) {
      saveCodexAccountCredential(id, { accessToken: "rejected", refreshToken: `grant-${id}`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: "acc" });
      const generation = readCodexAccountRecord(id)!.generation;
      await forceRefreshCodexPoolToken(id, { rejectedGeneration: generation, rejectedAccessToken: "rejected" }).catch(() => undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(seen.map(call => call.proxy)).toEqual(["http://127.0.0.1:9/", undefined]);
  expect(seen.every(call => call.url.startsWith("https://auth.openai.com/"))).toBe(true);
});
