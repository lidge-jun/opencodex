/**
 * Per-account egress for a Codex pool account's credentialed calls outside inference (catch-up
 * G-012): token refresh, usage probes (initial and 401 replay), model discovery and reset credits
 * leave by the account's route over the \`openai\` provider's, and refuse rather than drop a route.
 *
 * These use a fake transport and assert the route each physical call receives; real loopback
 * proxies for inference are in provider-egress-account.test.ts.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindCodexAccountEgressConfig,
  codexAccountRouting,
  CodexAccountRouteUnavailableError,
  resetCodexAccountEgressConfigForTests,
} from "../../src/codex/account-egress-runtime";
import { forceRefreshCodexPoolToken, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { fetchFreshPoolAccountQuota, recoverPoolQuotaFrom401 } from "../../src/codex/auth-api/pool-quota-probe";
import { consumeResetCredits, createResetCreditWhamClient, inspectResetCredits } from "../../src/codex/auth-api/reset-credit-service";
import { discoverCodexNativeRoster, resetCodexNativeRosterDiscoveryForTests } from "../../src/codex/model-entitlements";
import { clearAccountQuota } from "../../src/codex/quota";
import { getConfigPath, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { ExplicitProxyExemptedError } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROVIDER_PROXY = "http://127.0.0.1:7/";
const ACCOUNT_PROXY = "http://127.0.0.1:9/";
const PROXY_ENV = ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;
const homeKeys = ["OPENCODEX_HOME", "CODEX_HOME"] as const;
let previousHomes: Array<string | undefined> = [];
let home = "";
let calls: Array<{ url: string; proxy: unknown }> = [];

function poolConfig(): OcxConfig {
  return {
    port: 0, defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
      codexAccountMode: "pool", proxy: PROVIDER_PROXY } },
    codexAccounts: [
      { id: "routed", email: "", isMain: false, egress: { proxy: ACCOUNT_PROXY } },
      { id: "bypass", email: "", isMain: false, egress: { noProxy: "example.invalid" } },
      { id: "plain", email: "", isMain: false },
    ],
  } as unknown as OcxConfig;
}

function respond(url: string): Response {
  if (url.startsWith("https://auth.openai.com/")) return Response.json({ access_token: "fresh-access", refresh_token: "fresh-grant", expires_in: 3600 });
  if (url.includes("/wham/usage")) return Response.json({ rate_limit: { primary_window: { used_percent: 10 } } });
  if (url.endsWith("/rate-limit-reset-credits/consume")) return Response.json({ code: "ok" });
  if (url.endsWith("/rate-limit-reset-credits")) return Response.json({ credits: [] });
  if (url.includes("/models")) return Response.json({ models: [] });
  return new Response("unexpected", { status: 599 });
}

beforeEach(() => {
  for (const key of PROXY_ENV) { savedEnv.set(key, process.env[key]); delete process.env[key]; }
  previousHomes = homeKeys.map(name => process.env[name]);
  home = mkdtempSync(join(tmpdir(), "ocx-account-egress-calls-"));
  for (const name of homeKeys) process.env[name] = home;
  calls = [];
  clearAccountQuota();
  resetCodexAccountEgressConfigForTests();
  resetCodexNativeRosterDiscoveryForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, proxy: (init as { proxy?: unknown } | undefined)?.proxy });
    return respond(url);
  }) as typeof fetch;
  for (const id of ["routed", "bypass", "plain"]) {
    saveCodexAccountCredential(id, { accessToken: `${id}-access`, refreshToken: `${id}-grant`, expiresAt: Date.now() + 3_600_000, chatgptAccountId: `acc-${id}` });
  }
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  resetCodexAccountEgressConfigForTests();
  clearAccountQuota();
  for (const key of PROXY_ENV) { const value = savedEnv.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  homeKeys.forEach((name, index) => { const value = previousHomes[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  await flushConfigDirHardeningForTests();
  removeTreeWithRetry(home);
});

test("a pool account inherits the openai provider's route unless it names its own proxy", () => {
  const config = poolConfig();
  config.codexAccounts!.push({ id: "__main__", email: "", isMain: true, egress: { proxy: ACCOUNT_PROXY } } as never);
  expect(codexAccountRouting("routed", config)).toMatchObject({ provider: { proxy: PROVIDER_PROXY }, account: { egress: { proxy: ACCOUNT_PROXY } } });
  expect(codexAccountRouting("bypass", config)).toMatchObject({ provider: { proxy: PROVIDER_PROXY }, account: { egress: { noProxy: "example.invalid" } } });
  expect(codexAccountRouting("plain", config)).toEqual({ provider: { proxy: PROVIDER_PROXY, noProxy: undefined } });
  expect(codexAccountRouting("__main__", config)).toBeUndefined();
  expect(codexAccountRouting("unknown", config)).toBeUndefined();
  delete config.providers.openai!.proxy;
  expect(codexAccountRouting("plain", config)).toBeUndefined(); // nothing configured: the process-wide route, unchanged
});

test("token refresh follows the account route, inheriting the provider's when the account names none", async () => {
  saveConfig(poolConfig());
  for (const id of ["routed", "bypass", "plain"]) {
    const generation = readCodexAccountRecord(id)!.generation;
    await forceRefreshCodexPoolToken(id, { rejectedGeneration: generation, rejectedAccessToken: `${id}-access` });
  }
  expect(calls.map(call => [call.url.startsWith("https://auth.openai.com/"), call.proxy]))
    .toEqual([[true, ACCOUNT_PROXY], [true, PROVIDER_PROXY], [true, PROVIDER_PROXY]]);
});

test("a refresh whose explicit proxy the process NO_PROXY exempts is refused before any send", async () => {
  saveConfig(poolConfig());
  process.env.NO_PROXY = "auth.openai.com";
  const generation = readCodexAccountRecord("routed")!.generation;
  const error = await forceRefreshCodexPoolToken("routed", { rejectedGeneration: generation, rejectedAccessToken: "routed-access" })
    .then(() => null, (thrown: unknown) => thrown);
  expect(calls).toEqual([]);
  expect(error).toBeInstanceOf(ExplicitProxyExemptedError);
  expect((error as Error).message).not.toContain("routed-grant");
});

test("an unreadable config refuses the refresh rather than sending without the configured route", async () => {
  writeFileSync(getConfigPath(), "{ not json");
  const generation = readCodexAccountRecord("routed")!.generation;
  const error = await forceRefreshCodexPoolToken("routed", { rejectedGeneration: generation, rejectedAccessToken: "routed-access" })
    .then(() => null, (thrown: unknown) => thrown);
  expect(calls).toEqual([]);
  expect(error).toBeInstanceOf(CodexAccountRouteUnavailableError);
});

test("usage probes, initial and after a 401 refresh, leave by the account route", async () => {
  bindCodexAccountEgressConfig(poolConfig());
  await fetchFreshPoolAccountQuota("routed", null, undefined, undefined,
    async () => ({ accessToken: "routed-access", chatgptAccountId: "acc-routed", generation: readCodexAccountRecord("routed")!.generation }) as never);
  await recoverPoolQuotaFrom401({
    accountId: "bypass", existing: null, configuredPlan: undefined, rejectedAccessToken: "bypass-access",
    rejectedGeneration: readCodexAccountRecord("bypass")!.generation, resp: new Response("", { status: 401 }), quotaProbeEvidence: {},
  });
  const usage = calls.filter(call => call.url.includes("/wham/usage"));
  const refresh = calls.filter(call => call.url.startsWith("https://auth.openai.com/"));
  expect(usage.map(call => call.proxy)).toEqual([ACCOUNT_PROXY, PROVIDER_PROXY]);
  expect(refresh.map(call => call.proxy)).toEqual([PROVIDER_PROXY]);
});

test("model discovery sends each account's credential by that account's route", async () => {
  bindCodexAccountEgressConfig(poolConfig());
  const fetcher = globalThis.fetch;
  await discoverCodexNativeRoster(poolConfig(), { fetcher, credentials: [
    { accountId: "routed", accessToken: "routed-access", chatgptAccountId: "acc-routed", credentialIdentity: "routed:1" },
  ] });
  const models = calls.filter(call => call.url.includes("/models"));
  expect(models.length).toBeGreaterThan(0);
  expect(models.every(call => call.proxy === ACCOUNT_PROXY)).toBe(true);
});

test("reset-credit inspection and consumption, manual and background, leave by the account route", async () => {
  const config = poolConfig();
  bindCodexAccountEgressConfig(config);
  await (await inspectResetCredits(config, "routed", new AbortController().signal)).text();
  await (await consumeResetCredits(config, "routed", undefined)).text();
  const client = createResetCreditWhamClient(config, "plain");
  await client.inspect();
  await client.consume("redeem-1");
  const credits = calls.filter(call => call.url.includes("/rate-limit-reset-credits"));
  expect(credits.map(call => [call.url.endsWith("/consume"), call.proxy])).toEqual([
    [false, ACCOUNT_PROXY], [true, ACCOUNT_PROXY], [false, PROVIDER_PROXY], [true, PROVIDER_PROXY],
  ]);
});
