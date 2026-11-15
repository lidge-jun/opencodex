import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { accountCacheKey, accountQuotaCache, clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota/account-cache";
import { getAccountSet, saveCredential } from "../../src/oauth/store";
import { clearAccountQuota, updateAccountQuota } from "../../src/codex/quota";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";

const KEY = "windows-client-A";
const SCOPED_KEY = "windows-client-scoped";
const envKeys = ["OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let home: string;
let codex: IsolatedCodexHome;
let server: ReturnType<typeof startServer> | undefined;

const PROVIDER = { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" } as const;

function config(overrides: Partial<Pick<OcxConfig, "runtimeRole" | "providers">> = {}): OcxConfig {
  return {
    ...getDefaultConfig(), port: 0, hostname: "127.0.0.1", runtimeRole: "hub",
    providers: {
      fixture: { ...PROVIDER },
      cursor: { ...PROVIDER },
      "off-line": { ...PROVIDER, disabled: true },
      ...(overrides.providers ?? {}),
    } as OcxConfig["providers"],
    ...(overrides.runtimeRole === undefined ? {} : { runtimeRole: overrides.runtimeRole }),
    apiKeys: [
      { id: "client-0", name: "Client 0", key: KEY, createdAt: "2026-01-01" },
      { id: "client-scoped", name: "Scoped", key: SCOPED_KEY, createdAt: "2026-01-01", allowedProviders: ["cursor"] },
    ],
  };
}

// The route reads through getAccountSet + getCachedProviderAccountQuota, so a test needs a
// live account row in the auth store, not just a cache key the route never visits. Login goes
// before boot (the boot reconcile keeps rows for live accounts); quota seeding goes AFTER
// boot, because a boot with no configured accounts reconciles disk quota rows away and the
// cache written after boot is what a running hub actually holds at request time.
async function login(provider: string, email: string): Promise<string> {
  await saveCredential(provider, { access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000, email } as never);
  return getAccountSet(provider)!.accounts.at(-1)!.id;
}

function seedQuota(provider: string, accountId: string, quota: Record<string, unknown>): void {
  setCachedProviderAccountQuotaForTests(provider, accountId, quota as never);
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

test("authenticated window reads carry percentages and reset times, under either admitted header", async () => {
  const now = Date.now();
  const fixture = await login("fixture", "one@example.test");
  const cursor = await login("cursor", "two@example.test");
  server = startServer(0);
  seedQuota("fixture", fixture, { updatedAt: now, fiveHourPercent: 42.5, fiveHourResetAt: now + 2 * 3_600_000,
    weeklyPercent: 18, weeklyResetAt: now + 3 * 86_400_000 });
  seedQuota("cursor", cursor, { updatedAt: now, monthlyPercent: 1.2, monthlyResetAt: now + 20 * 86_400_000,
    customWindows: [{ label: "First-party models", percent: 1.3, resetAt: now + 20 * 86_400_000 }] });
  for (const headers of [{ "x-opencodex-api-key": KEY }, { Authorization: `Bearer ${KEY}` }, { Authorization: "Bearer windows-environment-key" }]) {
    const response = await fetch(new URL("/v1/usage/windows", server.url), { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ windows: [
      { label: "Fixture 5-hour", provider: "Fixture", percent: 42.5, limited: false },
      { label: "Fixture Weekly", provider: "Fixture", percent: 18, limited: false },
      { label: "Cursor Monthly", provider: "Cursor", percent: 1.2, limited: false },
      { label: "Cursor First-party models", provider: "Cursor", percent: 1.3, limited: false },
    ] });
    expect(body.windows.every((row: { resetsAt: number }) => row.resetsAt > Date.now())).toBe(true);
    // Account ids and credential store internals never appear in the body.
    expect(JSON.stringify(body)).not.toContain("example.test");
    expect(JSON.stringify(body)).not.toContain(fixture);
  }
});

test("absent, unknown and x-api-key-presented credentials are refused", async () => {
  server = startServer(0);
  // A VALID key carried in `x-api-key` is refused on purpose: the route admits the dedicated
  // header and the bearer, exactly the two kinds the chat routes admit, and the AUTH_MATRIX
  // row says xApiKey rejected. CodeRabbit asked to widen this; the maintainer's matrix keeps it.
  for (const headers of [{}, { "x-opencodex-api-key": "bad-key" }, { Authorization: "Bearer bad-key" }, { "x-api-key": KEY }]) {
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
    headers: { "x-opencodex-api-key": KEY, origin: "https://attacker.test" },
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "origin_rejected" } });
});

test("a host that is not a hub serves no windows, under its own 404 code", async () => {
  saveConfig(config({ runtimeRole: "standalone" }));
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
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
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows.map((row: { label: string }) => row.label)).toEqual(["Fixture Monthly"]);
});

test("the fullest account per slot reports, and an exhausted account marks the window limited", async () => {
  const now = Date.now();
  const a = await login("fixture", "a@example.test");
  const b = await login("fixture", "b@example.test");
  server = startServer(0);
  seedQuota("fixture", a, { updatedAt: now, fiveHourPercent: 10, fiveHourResetAt: now + 2 * 3_600_000 });
  seedQuota("fixture", b, { updatedAt: now, fiveHourPercent: 100, fiveHourResetAt: now + 3 * 3_600_000 });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows).toMatchObject([{ label: "Fixture 5-hour", percent: 100, limited: true }]);
  expect(body.windows).toHaveLength(1);
});

test("no account measurements is an empty list, not an error", async () => {
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [] });
});

test("chatgpt pool windows report under the ChatGPT provider name", async () => {
  const now = Date.now();
  server = startServer(0);
  // Seconds-form and millisecond-form resets both reach the pool store, and the endpoint
  // must normalize them so the futures filter sees the same instant either way.
  updateAccountQuota("pool-account", 33, Math.floor((now + 3 * 86_400_000) / 1000), 12, now + 20 * 86_400_000);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ windows: [
    { label: "ChatGPT Weekly", provider: "ChatGPT", percent: 33, limited: false },
    { label: "ChatGPT Monthly", provider: "ChatGPT", percent: 12, limited: false },
  ] });
  expect(body.windows.every((row: { resetsAt: number }) => row.resetsAt > Date.now())).toBe(true);
  expect(JSON.stringify(body)).not.toContain("pool-account");
});

test("model-scoped custom windows never duplicate their family bar", async () => {
  const now = Date.now();
  const fixture = await login("fixture", "m@example.test");
  server = startServer(0);
  // `scope: "model"` is the structural per-model evidence; `modelId` is the older spelling.
  // Both spellings and neither-name mismatch must keep a family bar out of the custom list.
  seedQuota("fixture", fixture, { updatedAt: now, customWindows: [
    { label: "Opus", percent: 40, resetAt: now + 86_400_000 },
    { label: "Opus", percent: 12, resetAt: now + 86_400_000, modelId: "claude-opus-5" },
    { label: "Opus", percent: 55, resetAt: now + 86_400_000, scope: "model" },
  ] });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows.map((row: { percent: number }) => row.percent)).toEqual([40]);
});

test("an upstream custom label loses its control characters", async () => {
  const now = Date.now();
  const fixture = await login("fixture", "esc@example.test");
  server = startServer(0);
  // Antigravity names groups by an upstream `group.displayName`; a hostile or broken upstream
  // must not push escape sequences into a terminal or log through a window label.
  seedQuota("fixture", fixture, { updatedAt: now, customWindows: [
    { label: "bad\u001b[31mlabel\u0000\n", percent: 7, resetAt: now + 86_400_000 },
  ] });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows).toHaveLength(1);
  expect(body.windows[0].label).toBe("Fixture bad[31mlabel");
  expect(JSON.stringify(body)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
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
  // Aggregate windows are cross-account by construction; #5049 says a scoped key may not see
  // the providers it cannot spend - and the ChatGPT pool rows follow the same rule.
  expect(scopedBody.windows.map((row: { label: string }) => row.label)).toEqual([
    "Cursor Monthly",
  ]);
  const full = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const fullBody = await full.json();
  expect(fullBody.windows.map((row: { label: string }) => row.label)).toEqual([
    "Fixture 5-hour", "ChatGPT Weekly", "ChatGPT Monthly", "Cursor Monthly",
  ]);
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
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [] });
});
