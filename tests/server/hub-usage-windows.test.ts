import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { accountCacheKey, accountQuotaCache, clearAccountQuotaCache,
  getCachedProviderAccountQuota, persistAccountQuotaCache } from "../../src/providers/quota/account-cache";
import { settleAccountQuotaPersistForTests, readPersistedAccountQuotas } from "../../src/providers/account-quota-disk";
import { fetchProviderAccountQuotas } from "../../src/providers/quota";
import { credentialGeneration, getAccountCredential, getAccountSet, saveCredential } from "../../src/oauth/store";
import { capturePoolQuotaWriter, readCodexAccountRecord, saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountQuota, setAccountQuotaFromParsed, updateAccountQuota } from "../../src/codex/quota";
import { linkRouteAllowed } from "../../src/link/routes";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";

const KEY = "windows-client-A";
const SCOPED_KEY = "windows-client-scoped";
const FIXTURE_KEY = "windows-client-fixture";
const OPENAI_KEY = "windows-client-openai";
const DISABLED_KEY = "windows-client-disabled";
const MODEL_KEY = "windows-client-model";
const MULTI_PROVIDER_KEY = "windows-client-multi-provider";
const envKeys = ["OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let home: string;
let codex: IsolatedCodexHome;
let server: ReturnType<typeof startServer> | undefined;

const OPENAI_PROVIDER = getDefaultConfig().providers.openai!;
const PROVIDER = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" } as const;

function config(overrides: Partial<Pick<OcxConfig, "runtimeRole" | "providers" | "codexAccounts">> = {}): OcxConfig {
  return {
    ...getDefaultConfig(), port: 0, hostname: "127.0.0.1", runtimeRole: "hub",
    providers: {
      fixture: { ...PROVIDER },
      cursor: { ...PROVIDER },
      openai: OPENAI_PROVIDER,
      "off-line": { ...PROVIDER, disabled: true },
      ...(overrides.providers ?? {}),
    } as OcxConfig["providers"],
    ...(overrides.runtimeRole === undefined ? {} : { runtimeRole: overrides.runtimeRole }),
    codexAccounts: overrides.codexAccounts,
    apiKeys: [
      { id: "client-0", name: "Client 0", key: KEY, createdAt: "2026-01-01" },
      { id: "client-scoped", name: "Scoped", key: SCOPED_KEY, createdAt: "2026-01-01", allowedProviders: ["cursor"] },
      { id: "client-fixture", name: "Fixture", key: FIXTURE_KEY, createdAt: "2026-01-01", allowedProviders: ["fixture"] },
      { id: "client-openai", name: "OpenAI", key: OPENAI_KEY, createdAt: "2026-01-01", allowedProviders: ["openai"] },
      { id: "client-disabled", name: "Disabled", key: DISABLED_KEY, createdAt: "2026-01-01", allowedProviders: ["off-line"] },
      { id: "client-model", name: "Model", key: MODEL_KEY, createdAt: "2026-01-01", allowedProviders: ["cursor"], allowedModels: ["fixture-model"] },
      { id: "client-multi-provider", name: "Multiple", key: MULTI_PROVIDER_KEY, createdAt: "2026-01-01", allowedProviders: ["cursor", "fixture"] },
    ],
  };
}

// The route reads through the account set and its credential-owned quota, so a test needs a
// live account row in the auth store, not just a cache key the route never visits. Login goes
// before boot (the boot reconcile keeps rows for live accounts); quota seeding goes AFTER
// boot, because a boot with no configured accounts reconciles disk quota rows away and the
// cache written after boot is what a running hub actually holds at request time.
async function login(provider: string, email: string): Promise<string> {
  await saveCredential(provider, { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000, email } as never);
  return getAccountSet(provider)!.accounts.at(-1)!.id;
}

function seedQuota(provider: string, accountId: string, quota: Record<string, unknown>): void {
  const generation = credentialGeneration(getAccountCredential(provider, accountId)!);
  accountQuotaCache.set(accountCacheKey(provider, accountId), {
    ts: Date.now(), quota: quota as never,
    quotaOwnerIsCurrent: () => {
      const credential = getAccountCredential(provider, accountId);
      return !!credential && credentialGeneration(credential) === generation;
    },
  });
}

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), "ocx-usage-windows-"));
  codex = installIsolatedCodexHome();
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = "windows-environment-key";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = `ocx_admin_${"b".repeat(43)}`;
  saveConfig(config());
  clearAccountQuotaCache();
  clearAccountQuota();
});

afterEach(async () => {
  await server?.stop(true); server = undefined;
  clearAccountQuotaCache();
  clearAccountQuota();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  codex.restore(); removeTreeWithRetry(home);
});

test("a scoped key reads one account's windows under either admitted header", async () => {
  const now = Date.now();
  const cursor = await login("cursor", "cursor@example.test");
  server = startServer(0);
  seedQuota("cursor", cursor, { updatedAt: now, fiveHourPercent: 42.5, fiveHourResetAt: now + 3_600_000,
    weeklyPercent: 18, weeklyResetAt: now + 3 * 86_400_000, monthlyPercent: 1.2, monthlyResetAt: now + 20 * 86_400_000,
    customWindows: [{ label: "First-party models", percent: 1.3, resetAt: now + 20 * 86_400_000 }] });
  for (const headers of [{ "x-opencodex-api-key": SCOPED_KEY }, { Authorization: `Bearer ${SCOPED_KEY}` }]) {
    const response = await fetch(new URL("/v1/usage/windows", server.url), { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.windows).toMatchObject([
      { label: "Cursor 5-hour", provider: "Cursor", percent: 42.5, limited: false },
      { label: "Cursor Weekly", provider: "Cursor", percent: 18, limited: false },
      { label: "Cursor Monthly", provider: "Cursor", percent: 1.2, limited: false },
      { label: "Cursor First-party models", provider: "Cursor", percent: 1.3, limited: false },
    ]);
    expect(body.windows.every((row: { resetsAt: number }) => row.resetsAt > Date.now())).toBe(true);
    expect(JSON.stringify(body)).not.toContain("example.test");
    expect(JSON.stringify(body)).not.toContain(cursor);
  }
});

test.each([KEY, "windows-environment-key", MODEL_KEY, MULTI_PROVIDER_KEY])(
  "a key without exactly one provider and full model scope is denied (%s)",
  async key => {
    server = startServer(0);
    for (const headers of [{ Authorization: `Bearer ${key}` }, { "x-opencodex-api-key": key }]) {
      const response = await fetch(new URL("/v1/usage/windows", server.url), { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "usage_windows_unauthorized" } });
    }
  },
);

test("provider resolution preserves the configured name under normalized scope matching", async () => {
  await login("Team-Provider", "team@example.test");
  const now = Date.now();
  const scoped = config({ providers: { "Team-Provider": { ...PROVIDER } } });
  scoped.apiKeys![1]!.allowedProviders = ["team-provider"];
  saveConfig(scoped);
  server = startServer(0);
  const account = getAccountSet("Team-Provider")!.accounts[0]!;
  seedQuota("Team-Provider", account.id, { updatedAt: now, weeklyPercent: 5, weeklyResetAt: now + 86_400_000 });
  const response = await fetch(new URL("/v1/usage/windows", server.url), {
    headers: { "x-opencodex-api-key": SCOPED_KEY },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [
    { label: "Team-Provider Weekly", provider: "Team-Provider", percent: 5, limited: false, resetsAt: now + 86_400_000 },
  ] });
});

test("restarting after same-slot OAuth replacement withholds hydrated quota until a live probe", async () => {
  const now = Date.now();
  const resetsAt = now + 86_400_000;
  const account = await login("cursor", "replacement@example.test");
  const localFetch = globalThis.fetch;
  const probe = spyOn(globalThis, "fetch").mockResolvedValueOnce(
    Response.json({ planUsage: { totalPercentUsed: 63 }, billingCycleEnd: resetsAt }),
  ).mockResolvedValueOnce(
    Response.json({ planUsage: { totalPercentUsed: 27 }, billingCycleEnd: resetsAt }),
  );
  const headers = { "x-opencodex-api-key": SCOPED_KEY };
  try {
    server = startServer(0);
    const readWindows = async () => {
      const response = await localFetch(new URL("/v1/usage/windows", server!.url), { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    await fetchProviderAccountQuotas("cursor", true);
    expect(await readWindows()).toEqual({ windows: [
      { label: "Cursor Monthly", provider: "Cursor", percent: 63, limited: false, resetsAt },
    ] });

    jest.useFakeTimers();
    try {
      persistAccountQuotaCache();
      jest.advanceTimersByTime(1_000);
    } finally {
      jest.useRealTimers();
    }
    await settleAccountQuotaPersistForTests();
    expect(readPersistedAccountQuotas().get(accountCacheKey("cursor", account))?.monthlyPercent).toBe(63);
    await server.stop(true);
    server = undefined;
    clearAccountQuotaCache();
    await saveCredential("cursor", { access: "fixture-replacement", refresh: "fixture-refresh-new",
      expires: now + 3_600_000 });
    expect(getAccountSet("cursor")?.accounts.map(row => row.id)).toEqual([account]);
    server = startServer(0);

    const restoredWindows = await readWindows();
    expect(getCachedProviderAccountQuota("cursor", account)?.monthlyPercent).toBe(63);
    expect(restoredWindows).toEqual({ windows: [] });
    await fetchProviderAccountQuotas("cursor", true);
    expect(await readWindows()).toEqual({ windows: [
      { label: "Cursor Monthly", provider: "Cursor", percent: 27, limited: false, resetsAt },
    ] });
  } finally {
    probe.mockRestore();
  }
});

test("Remote Link's route allowlist excludes usage windows", () => {
  const req = new Request("https://hub.example.test/v1/usage/windows");
  expect(linkRouteAllowed(new URL(req.url), req)).toBe(false);
});

test("the Authorization fallback requires Bearer and honors dedicated-header precedence", async () => {
  server = startServer(0);
  const url = new URL("/v1/usage/windows", server.url);
  for (const [headers, status] of [
    [{ Authorization: SCOPED_KEY }, 401],
    [{ Authorization: `bEaReR ${SCOPED_KEY}` }, 200],
    [{ Authorization: `Bearer ${SCOPED_KEY}`, "x-opencodex-api-key": "unknown-key" }, 401],
    [{ Authorization: "bare-unknown-key", "x-opencodex-api-key": SCOPED_KEY }, 200],
  ] as const) {
    const response = await fetch(url, { headers });
    expect(response.status).toBe(status);
    await response.body?.cancel();
  }
});

test("absent, unknown and x-api-key-presented credentials are refused", async () => {
  server = startServer(0);
  // A VALID key carried in `x-api-key` is refused on purpose: the route admits the dedicated
  // header and the bearer, exactly the two kinds the chat routes admit, and the AUTH_MATRIX
  // row says xApiKey rejected. CodeRabbit asked to widen this; the maintainer's matrix keeps it.
  for (const headers of [{}, { "x-opencodex-api-key": "bad-key" }, { Authorization: "Bearer bad-key" }, { "x-api-key": SCOPED_KEY }]) {
    const response = await fetch(new URL("/v1/usage/windows", server.url), { headers });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
});

test("an admin token cannot open the windows route", async () => {
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), {
    headers: { Authorization: `Bearer ${process.env.OPENCODEX_ADMIN_AUTH_TOKEN}` },
  });
  expect(response.status).toBe(401);
  await response.body?.cancel();
});

test("a cross-origin browser read is refused even with a valid key", async () => {
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), {
    headers: { "x-opencodex-api-key": SCOPED_KEY, origin: "https://attacker.test" },
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "origin_rejected" } });
});

test.each(["standalone", "client"] as const)("%s serves no windows, under its own 404 code", async runtimeRole => {
  saveConfig(config({ runtimeRole }));
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": SCOPED_KEY } });
  expect(response.status).toBe(404);
  // A distinct code, not the generic not_found: it tells "this host is not a hub" apart from
  // "this build has no such route", and the latter would let the role gate pass vacuously.
  expect(await response.json()).toMatchObject({ error: { code: "usage_windows_not_a_hub" } });
});

test("windows without reset evidence and rolled-over windows are dropped", async () => {
  const now = Date.now();
  const fixture = await login("fixture", "x@example.test");
  server = startServer(0);
  seedQuota("fixture", fixture, { updatedAt: now, fiveHourPercent: 70, weeklyPercent: 9, weeklyResetAt: now - 1,
    monthlyPercent: 3, monthlyResetAt: now + 5 * 86_400_000, customWindows: [{ label: "No reset", percent: 5 }] });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": FIXTURE_KEY } });
  const body = await response.json();
  expect(body.windows.map((row: { label: string }) => row.label)).toEqual(["Fixture Monthly"]);
});

test("a provider with more than one registered account has no single-account projection", async () => {
  await login("fixture", "a@example.test");
  await login("fixture", "b@example.test");
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": FIXTURE_KEY } });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "usage_windows_account_scope_required" } });
});

test("limited describes each window's own utilization or refusal", async () => {
  const now = Date.now();
  const cursor = await login("cursor", "limits@example.test");
  server = startServer(0);
  seedQuota("cursor", cursor, { updatedAt: now, fiveHourPercent: 42, fiveHourResetAt: now + 3_600_000,
    monthlyPercent: 100, monthlyResetAt: now + 20 * 86_400_000,
    customWindows: [{ label: "First-party models", percent: 61, rejected: true, resetAt: now + 20 * 86_400_000 }] });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": SCOPED_KEY } });
  expect(response.status).toBe(200);
  expect((await response.json()).windows).toMatchObject([
    { label: "Cursor 5-hour", percent: 42, limited: false },
    { label: "Cursor Monthly", percent: 100, limited: true },
    { label: "Cursor First-party models", percent: 61, limited: true },
  ]);
});

test("no account measurements is an empty list, not an error", async () => {
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": FIXTURE_KEY } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [] });
});

function configurePool(...ids: string[]): void {
  saveConfig(config({ codexAccounts: ids.map(id => ({ id, email: `${id}@example.test`, plan: "team", isMain: false })) }));
  for (const id of ids) {
    saveCodexAccountCredential(id, { accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 3_600_000, chatgptAccountId: id });
  }
}

function seedPoolQuota(id: string, raw: NonNullable<Parameters<typeof setAccountQuotaFromParsed>[1]>): void {
  const record = readCodexAccountRecord(id)!;
  const writer = capturePoolQuotaWriter(id, { ...record.credential!, generation: record.generation })!;
  setAccountQuotaFromParsed(id, raw, undefined, undefined, null, { writer, observedAt: Date.now(), source: "wham", raw });
}

test.each([
  [10_800, "Short window"],
  [undefined, "Short window"],
  [18_000, "5-hour"],
] as const)("ChatGPT labels a short observation with duration %s as %s", async (shortWindowSeconds, label) => {
  configurePool("pool-account");
  server = startServer(0);
  const resetsAt = Date.now() + 3_600_000;
  seedPoolQuota("pool-account", { shortPercent: 31, shortResetAt: resetsAt, shortWindowSeconds });
  const response = await fetch(new URL("/v1/usage/windows", server.url), {
    headers: { "x-opencodex-api-key": OPENAI_KEY },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [
    { label: `ChatGPT ${label}`, provider: "ChatGPT", percent: 31, limited: false, resetsAt },
  ] });
});

test("the scoped OpenAI key reads the sole ChatGPT pool account with per-window limits and millisecond resets", async () => {
  const now = Date.now();
  configurePool("pool-account");
  server = startServer(0);
  const secondsReset = Math.floor((now + 3 * 86_400_000) / 1000);
  const monthlyReset = now + 20 * 86_400_000;
  seedPoolQuota("pool-account", { weeklyPercent: 33, weeklyResetAt: secondsReset, monthlyPercent: 100, monthlyResetAt: monthlyReset });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": OPENAI_KEY } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.windows).toEqual([
    { label: "ChatGPT Weekly", provider: "ChatGPT", percent: 33, limited: false, resetsAt: secondsReset * 1000 },
    { label: "ChatGPT Monthly", provider: "ChatGPT", percent: 100, limited: true, resetsAt: monthlyReset },
  ]);
  expect(JSON.stringify(body)).not.toContain("pool-account");
});

test("an OpenAI pool with more than one account has no single-account projection", async () => {
  configurePool("pool-one", "pool-two");
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": OPENAI_KEY } });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "usage_windows_account_scope_required" } });
});

test.each([false, true])("pool rows require an enabled provider and registered account (disabled=%s)", async disabled => {
  if (disabled) configurePool("cached-only");
  const codexAccounts = disabled ? [{ id: "cached-only", email: "pool@example.test", plan: "team", isMain: false }] : [];
  saveConfig(config({ codexAccounts, providers: { openai: { ...OPENAI_PROVIDER, disabled } } }));
  server = startServer(0);
  const now = Date.now();
  if (disabled) {
    seedPoolQuota("cached-only", { weeklyPercent: 42, weeklyResetAt: now + 86_400_000,
      monthlyPercent: 13, monthlyResetAt: now + 20 * 86_400_000 });
  } else {
    updateAccountQuota("cached-only", 42, now + 86_400_000, 13, now + 20 * 86_400_000);
  }
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": OPENAI_KEY } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [] });
});

test("a replaced pool credential cannot inherit the preceding account's windows", async () => {
  const now = Date.now();
  configurePool("pool-account");
  server = startServer(0);
  seedPoolQuota("pool-account", { weeklyPercent: 33, weeklyResetAt: now + 86_400_000,
    monthlyPercent: 10, monthlyResetAt: now + 20 * 86_400_000 });
  const url = new URL("/v1/usage/windows", server.url);
  const headers = { "x-opencodex-api-key": OPENAI_KEY };
  expect((await (await fetch(url, { headers })).json()).windows).toHaveLength(2);
  saveCodexAccountCredential("pool-account", { accessToken: "fixture-replacement", refreshToken: "fixture-refresh-replacement",
    expiresAt: now + 3_600_000, chatgptAccountId: "replacement-account" });
  expect(await (await fetch(url, { headers })).json()).toEqual({ windows: [] });
  const weeklyResetAt = now + 86_400_000;
  seedPoolQuota("pool-account", { weeklyPercent: 27, weeklyResetAt });
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [
    { label: "ChatGPT Weekly", provider: "ChatGPT", percent: 27, resetsAt: weeklyResetAt, limited: false },
  ] });
});

test("model-scoped custom windows never duplicate their family bar", async () => {
  const now = Date.now();
  const cursor = await login("cursor", "model@example.test");
  server = startServer(0);
  seedQuota("cursor", cursor, { updatedAt: now, customWindows: [
    { label: "First-party models", percent: 40, resetAt: now + 86_400_000 },
    { label: "First-party models", percent: 82, resetAt: now + 86_400_000, modelId: "fixture-model" },
    { label: "First-party models", percent: 55, resetAt: now + 86_400_000, scope: "model" },
  ] });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": SCOPED_KEY } });
  const body = await response.json();
  expect(body.windows).toMatchObject([{ label: "Cursor First-party models", percent: 40 }]);
  expect(body.windows).toHaveLength(1);
});

test("custom projection emits only known local labels after stripping control characters", async () => {
  const now = Date.now();
  const cursor = await login("cursor", "labels@example.test");
  server = startServer(0);
  seedQuota("cursor", cursor, { updatedAt: now, customWindows: [
    { label: "  First-party\u0000 models\n ", percent: 7, resetAt: now + 86_400_000 },
    { label: "Unclassified quota group", percent: 8, resetAt: now + 86_400_000 },
  ] });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": SCOPED_KEY } });
  const body = await response.json();
  expect(body.windows).toHaveLength(1);
  expect(body.windows[0].label).toBe("Cursor First-party models");
});

test("a provider-scoped key sees only its providers, and no ChatGPT pool", async () => {
  const now = Date.now();
  const fixture = await login("fixture", "s@example.test");
  const cursor = await login("cursor", "s2@example.test");
  server = startServer(0);
  seedQuota("fixture", fixture, { updatedAt: now, fiveHourPercent: 30, fiveHourResetAt: now + 2 * 3_600_000 });
  seedQuota("cursor", cursor, { updatedAt: now, monthlyPercent: 6, monthlyResetAt: now + 10 * 86_400_000 });
  updateAccountQuota("pool-account", 21, now + 4 * 86_400_000, 9, now + 25 * 86_400_000);
  const scoped = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": SCOPED_KEY } });
  expect(scoped.status).toBe(200);
  const scopedBody = await scoped.json();
  expect(scopedBody.windows.map((row: { label: string }) => row.label)).toEqual(["Cursor Monthly"]);
});

test("disabled providers and stale cached rows are excluded", async () => {
  const now = Date.now();
  const off = await login("off-line", "off@example.test");
  const cursor = await login("cursor", "stale@example.test");
  server = startServer(0);
  seedQuota("off-line", off, { updatedAt: now, monthlyPercent: 5, monthlyResetAt: now + 9 * 86_400_000 });
  // A row whose isCurrent() says no longer counts: this is the filter the raw cache walk
  // skipped, and getCachedProviderAccountQuota applies for staleness and replaced credentials.
  accountQuotaCache.set(accountCacheKey("cursor", cursor), { ts: Date.now(), quota: {
    updatedAt: now, monthlyPercent: 88, monthlyResetAt: now + 9 * 86_400_000 } as never, isCurrent: () => false });
  for (const key of [SCOPED_KEY, DISABLED_KEY]) {
    const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": key } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ windows: [] });
  }
});
