/**
 * A Codex pool account's background and login sends carry its credential, so they leave by its
 * route (catch-up G-012): token-guardian and quota auto-refresh warmups, the reauthentication usage
 * read and warmup, and a new login (no row yet) by the provider's route. A pool account removed while
 * its credential is in hand, and a server whose config could not be read, refuse instead.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindCodexAccountEgressConfig,
  codexAccountFetch,
  CodexAccountRouteUnavailableError,
  resetCodexAccountEgressConfigForTests,
  unbindCodexAccountEgressConfig,
} from "../../src/codex/account-egress-runtime";
import { forceRefreshCodexPoolToken, getCodexAccountCredential, markCodexAccountValidated, readCodexAccountRecord, removeCodexAccountCredential, saveCodexAccountCredential } from "../../src/codex/account-store";
import { handleCodexAuthLoginStart } from "../../src/codex/auth-api/login-flow";
import { CODEX_LOGIN_TERMINAL_TTL_MS, codexAuthLoginState } from "../../src/codex/auth-api/login-state";
import { inspectResetCredits } from "../../src/codex/auth-api/reset-credit-service";
import { clearAccountQuota } from "../../src/codex/quota";
import { resetCodexQuotaAutoRefreshForTests, runCodexQuotaAutoRefresh } from "../../src/codex/quota-auto-refresh";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { flushConfigDirHardening } from "../../src/config/paths";
import { clearLoginState, OAUTH_PROVIDERS, waitForLoginSettled } from "../../src/oauth";
import { __resetGuardianState, guardianSweep } from "../../src/oauth/token-guardian";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../../src/codex/catalog/native-models";
import { isDirectCallerEntitledToCodexModel, resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { acquireServerBackgroundLifecycle } from "../../src/server/background-lifecycle";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const PROVIDER_PROXY = "http://127.0.0.1:7/";
const UNLISTED_FIXTURE_SEAM = Symbol.for("opencodex.codex-account-egress.unlisted-fixture-seam");
const ACCOUNT_PROXY = "http://127.0.0.1:9/";
const PROXY_ENV = ["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] as const;
const savedEnv = new Map<string, string | undefined>();
const homeKeys = ["OPENCODEX_HOME", "CODEX_HOME"] as const;
const realFetch = globalThis.fetch;
let previousHomes: Array<string | undefined> = [];
let home = "";
let calls: Array<{ url: string; proxy: unknown }> = [];

function config(extra: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0, defaultProvider: "openai",
    providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward",
      codexAccountMode: "pool", refreshPolicy: "proactive", proxy: PROVIDER_PROXY } },
    codexAccounts: [{ id: "routed", email: "routed@example.test", plan: "plus", isMain: false, egress: { proxy: ACCOUNT_PROXY } }],
    ...extra,
  } as OcxConfig;
}

const completed = () => new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
  status: 200, headers: { "content-type": "text/event-stream" },
});

beforeEach(() => {
  (globalThis as Record<symbol, unknown>)[UNLISTED_FIXTURE_SEAM] = false;
  for (const key of PROXY_ENV) { savedEnv.set(key, process.env[key]); delete process.env[key]; }
  previousHomes = homeKeys.map(name => process.env[name]);
  home = mkdtempSync(join(tmpdir(), "ocx-account-egress-bg-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = join(home, "codex");
  mkdirSync(join(home, "codex"), { recursive: true });
  calls = [];
  clearAccountQuota();
  __resetGuardianState();
  resetCodexQuotaAutoRefreshForTests();
  resetCodexAccountEgressConfigForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, proxy: (init as { proxy?: unknown } | undefined)?.proxy });
    if (url.endsWith("/codex/responses")) return completed();
    if (url.includes("/wham/usage")) return Response.json({ plan_type: "plus", email: "routed@example.test",
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 }, secondary_window: { used_percent: 10, limit_window_seconds: 604800 } } });
    if (url.endsWith("/rate-limit-reset-credits")) return Response.json({ credits: [] });
    return new Response("unexpected", { status: 599 });
  }) as typeof fetch;
  saveCodexAccountCredential("routed", { accessToken: "routed-access", refreshToken: "routed-grant", expiresAt: Date.now() + 3_600_000, chatgptAccountId: "acc-routed" });
});

afterEach(async () => {
  (globalThis as Record<symbol, unknown>)[UNLISTED_FIXTURE_SEAM] = true;
  globalThis.fetch = realFetch;
  resetCodexAccountEgressConfigForTests();
  clearAccountQuota();
  __resetGuardianState();
  resetCodexQuotaAutoRefreshForTests();
  for (const key of PROXY_ENV) { const value = savedEnv.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  homeKeys.forEach((name, index) => { const value = previousHomes[index]; if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  await flushConfigDirHardening(home);
  removeTreeWithRetry(home);
});

const proxiesFor = (suffix: string) => calls.filter(call => call.url.endsWith(suffix) || call.url.includes(suffix)).map(call => call.proxy);

test("token-guardian warmup of a pool account leaves by the account route", async () => {
  saveConfig(config({ tokenGuardian: { enabled: true, tickSeconds: 60, leadSeconds: 60, codexWarmupEnabled: true, codexWarmupMaxAgeSeconds: 60 } }));
  markCodexAccountValidated("routed", Date.now() - 120_000);
  const result = await guardianSweep(Date.now());
  expect(result.warmed).toContain("codex:routed");
  expect(proxiesFor("/codex/responses")).toEqual([ACCOUNT_PROXY]);
});

test("quota auto-refresh warmup of a pool account leaves by the account route", async () => {
  const cfg = config({ codexQuotaAutoRefresh: { routed: { fiveHour: true, weekly: true } } });
  bindCodexAccountEgressConfig(cfg);
  const now = Date.now();
  await runCodexQuotaAutoRefresh(cfg, now, {
    getQuota: () => ({ shortWindowSeconds: 18_000, shortResetAt: now / 1000 - 60, weeklyResetAt: now / 1000 - 60, updatedAt: now - 120_000 }),
    persistCompleted: () => true,
    refreshQuota: async () => undefined,
  } as never);
  expect(proxiesFor("/codex/responses")).toEqual([ACCOUNT_PROXY]);
});

async function runPoolLogin(body: Record<string, unknown>, cfg: OcxConfig, accountId: string): Promise<void> {
  const originalLogin = OAUTH_PROVIDERS.chatgpt.login;
  const originalSetTimeout = globalThis.setTimeout;
  let poll: (() => void) | undefined;
  const stopped = Promise.withResolvers<void>();
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    if (delay === 2_000) poll = () => callback(...args);
    else if (delay === CODEX_LOGIN_TERMINAL_TTL_MS) stopped.resolve();
    else if (delay !== 30_000) return originalSetTimeout(callback, delay, ...args);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  OAUTH_PROVIDERS.chatgpt.login = async controller => {
    controller.onAuth({ url: "https://example.test/oauth" });
    return { access: "fresh-access", refresh: "fresh-grant", expires: Date.now() + 3_600_000, accountId, email: "routed@example.test" };
  };
  let flowId: string | undefined;
  try {
    const response = await handleCodexAuthLoginStart(new Request("http://127.0.0.1/api/codex-auth/login", {
      method: "POST", body: JSON.stringify({ ...body, openBrowser: false }),
    }), cfg);
    expect(response.status).toBe(200);
    flowId = (await response.json() as { flowId: string }).flowId;
    expect(await waitForLoginSettled("chatgpt", 1_000, flowId)).toBe(true);
    poll?.();
    await Promise.race([stopped.promise, new Promise<never>((_, reject) => originalSetTimeout(() => reject(new Error("login poller did not settle")), 5_000))]);
    expect(codexAuthLoginState.get(flowId)).toMatchObject({ status: "done" });
  } finally {
    clearLoginState("chatgpt");
    if (flowId) codexAuthLoginState.delete(flowId);
    timer.mockRestore();
    OAUTH_PROVIDERS.chatgpt.login = originalLogin;
  }
}

test("reauthentication reads usage and warms up by the account route", async () => {
  const cfg = config();
  saveConfig(cfg);
  bindCodexAccountEgressConfig(cfg);
  await runPoolLogin({ id: "routed", reauth: true }, cfg, "acc-routed");
  expect(getCodexAccountCredential("routed")?.accessToken).toBe("fresh-access");
  expect(proxiesFor("/wham/usage")).toEqual([ACCOUNT_PROXY]);
  expect(proxiesFor("/codex/responses")).toEqual([ACCOUNT_PROXY]);
});

test("a new login, which has no pool row yet, takes the provider's route", async () => {
  const cfg = config();
  saveConfig(cfg);
  bindCodexAccountEgressConfig(cfg);
  await runPoolLogin({ id: "newcomer" }, cfg, "acc-newcomer");
  expect(proxiesFor("/wham/usage")).toEqual([PROVIDER_PROXY]);
  expect(proxiesFor("/codex/responses")).toEqual([PROVIDER_PROXY]);
});

test("a stored credential the config does not list is refused; only a new login takes the provider's route", async () => {
  const cfg = config();
  bindCodexAccountEgressConfig(cfg);
  cfg.codexAccounts = [];
  await expect(codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage")).rejects.toBeInstanceOf(CodexAccountRouteUnavailableError);
  expect(calls).toEqual([]);
  await codexAccountFetch("routed", { newLogin: true })("https://chatgpt.com/backend-api/wham/usage");
  expect(proxiesFor("/wham/usage")).toEqual([PROVIDER_PROXY]);
});

test("a pool account removed while its credential is in hand is refused, even when credential cleanup failed", async () => {
  const cfg = config();
  bindCodexAccountEgressConfig(cfg);
  cfg.codexAccounts = []; // the row removal committed; the credential was not tombstoned
  await expect(codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage")).rejects.toBeInstanceOf(CodexAccountRouteUnavailableError);
  expect(calls).toEqual([]);
  const live = config();
  bindCodexAccountEgressConfig(live);
  // An expired token makes the reset-credit call refresh first; the account is removed while that
  // refresh is in flight, after the call already checked it.
  saveCodexAccountCredential("routed", { accessToken: "stale", refreshToken: "routed-grant", expiresAt: Date.now() - 1_000, chatgptAccountId: "acc-routed" });
  const recording = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://auth.openai.com/")) {
      calls.push({ url: String(input), proxy: (init as { proxy?: unknown } | undefined)?.proxy });
      live.codexAccounts = [];
      removeCodexAccountCredential("routed");
      return Response.json({ access_token: "fresh-access", refresh_token: "fresh-grant", expires_in: 3600 });
    }
    return recording(input, init);
  }) as typeof fetch;
  const outcome = await inspectResetCredits(live, "routed", new AbortController().signal).then(r => r, (error: unknown) => error);
  expect(calls.map(call => call.url.startsWith("https://auth.openai.com/"))).toEqual([true]);
  expect(calls[0]!.proxy).toBe(ACCOUNT_PROXY);
  expect(calls.filter(call => call.url.includes("/rate-limit-reset-credits"))).toEqual([]);
  expect(outcome instanceof Response ? outcome.status : (outcome as Error).name).not.toBe(200);
});

test("a server that started on an unreadable config refuses pool sends, and its binding ends with the lifecycle", async () => {
  writeFileSync(getConfigPath(), "{ not json");
  const degraded = loadConfig();
  degraded.codexAccounts = config().codexAccounts;
  bindCodexAccountEgressConfig(degraded);
  await expect(codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage")).rejects.toBeInstanceOf(CodexAccountRouteUnavailableError);
  unbindCodexAccountEgressConfig(degraded);
  saveConfig(config());
  await codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage");
  expect(proxiesFor("/wham/usage")).toEqual([ACCOUNT_PROXY]);
  // A binding for one config home does not answer for another: this home has no config at all.
  const other = config();
  other.codexAccounts![0]!.egress = { proxy: "http://127.0.0.1:13/" };
  bindCodexAccountEgressConfig(other);
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-account-egress-bg-other-"));
  process.env.OPENCODEX_HOME = otherHome;
  try {
    calls = [];
    await expect(codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage")).rejects.toBeInstanceOf(CodexAccountRouteUnavailableError);
    expect(calls).toEqual([]);
  } finally {
    process.env.OPENCODEX_HOME = home;
    await flushConfigDirHardening(otherHome);
    removeTreeWithRetry(otherHome);
  }
});

test("overlapping server lifecycles: the newest owner's routes apply, and its release restores the survivor's", async () => {
  const first = config({ clientIntegrations: { codex: false } } as Partial<OcxConfig>);
  first.codexAccounts![0]!.egress = { proxy: "http://127.0.0.1:21/" };
  const second = config({ clientIntegrations: { codex: false } } as Partial<OcxConfig>);
  second.codexAccounts![0]!.egress = { proxy: "http://127.0.0.1:23/" };
  saveConfig(first);
  const firstLease = acquireServerBackgroundLifecycle(() => {}, first);
  try {
    const secondLease = acquireServerBackgroundLifecycle(() => {}, second);
    await codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage");
    await secondLease.release();
    await codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage");
  } finally {
    await firstLease.release();
  }
  expect(proxiesFor("/wham/usage")).toEqual(["http://127.0.0.1:23/", "http://127.0.0.1:21/"]);
});

test("a direct caller's own bearer keeps the process-wide route under a provider proxy", async () => {
  resetCodexModelEntitlementCacheForTests();
  bindCodexAccountEgressConfig(config());
  const model = [...ACCOUNT_GATED_NATIVE_OPENAI_MODELS][0]!;
  const seen: unknown[] = [];
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push((init as { proxy?: unknown } | undefined)?.proxy);
    return Response.json({ models: [{ slug: model }] });
  }) as typeof fetch;
  await isDirectCallerEntitledToCodexModel(new Headers({ authorization: "Bearer direct-token", "chatgpt-account-id": "acc-direct" }), model, { fetcher });
  resetCodexModelEntitlementCacheForTests();
  expect(seen).toEqual([undefined]);
});

test("a stored credential whose config was deleted is refused, never sent without its former route", async () => {
  saveConfig(config());
  await codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage");
  expect(proxiesFor("/wham/usage")).toEqual([ACCOUNT_PROXY]);
  unlinkSync(getConfigPath());
  calls = [];
  const generation = readCodexAccountRecord("routed")!.generation;
  await expect(forceRefreshCodexPoolToken("routed", { rejectedGeneration: generation, rejectedAccessToken: "routed-access" }))
    .rejects.toBeInstanceOf(CodexAccountRouteUnavailableError);
  await expect(codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage")).rejects.toBeInstanceOf(CodexAccountRouteUnavailableError);
  expect(calls).toEqual([]);
});

test("restoring a surviving lifecycle owner keeps its own config home", async () => {
  const homeA = home;
  const first = config({ clientIntegrations: { codex: false } } as Partial<OcxConfig>);
  first.codexAccounts![0]!.egress = { proxy: "http://127.0.0.1:21/" };
  saveConfig(first);
  const firstLease = acquireServerBackgroundLifecycle(() => {}, first);
  const homeB = mkdtempSync(join(tmpdir(), "ocx-account-egress-bg-b-"));
  try {
    process.env.OPENCODEX_HOME = homeB;
    const second = config({ clientIntegrations: { codex: false } } as Partial<OcxConfig>);
    second.codexAccounts![0]!.egress = { proxy: "http://127.0.0.1:23/" };
    saveConfig(second);
    const secondLease = acquireServerBackgroundLifecycle(() => {}, second);
    await secondLease.release();
    // Home B is current; the survivor's binding belongs to home A, so B's own file answers.
    await codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage");
    process.env.OPENCODEX_HOME = homeA;
    await codexAccountFetch("routed")("https://chatgpt.com/backend-api/wham/usage");
  } finally {
    process.env.OPENCODEX_HOME = homeA;
    await firstLease.release();
    await flushConfigDirHardening(homeB);
    removeTreeWithRetry(homeB);
  }
  expect(proxiesFor("/wham/usage")).toEqual(["http://127.0.0.1:23/", "http://127.0.0.1:21/"]);
});
