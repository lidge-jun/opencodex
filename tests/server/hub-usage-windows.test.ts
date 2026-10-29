import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { accountQuotaCache, clearAccountQuotaCache } from "../../src/providers/quota/account-cache";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";

const KEY = "windows-client-A";
const envKeys = ["OPENCODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let saved: Record<string, string | undefined>;
let home: string;
let codex: IsolatedCodexHome;
let server: ReturnType<typeof startServer> | undefined;

function config() {
  return { ...getDefaultConfig(), port: 0, hostname: "127.0.0.1", runtimeRole: "hub" as const,
    providers: {}, apiKeys: [{ id: "client-0", name: "Client 0", key: KEY, createdAt: "2026-01-01" }] };
}

// Seeding goes through the live cache, not the disk snapshot: a boot with no configured
// accounts reconciles every disk row away (state-store-registrations retire quota rows that
// belong to no live account, and persist the empty result). A cache written after boot is
// what a running hub with logged-in accounts actually holds, and it survives to the request.
function seed(rows: Record<string, Record<string, unknown>>) {
  for (const [key, quota] of Object.entries(rows)) accountQuotaCache.set(key, { ts: Date.now(), quota: quota as never });
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
});

afterEach(async () => {
  await server?.stop(true); server = undefined;
  clearAccountQuotaCache();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  codex.restore(); removeTreeWithRetry(home);
});

test("authenticated window reads carry percentages and reset times, under either admitted header", async () => {
  const now = Date.now();
  server = startServer(0);
  seed({
    "anthropic\u0000acc-1": { updatedAt: now, fiveHourPercent: 42.5, fiveHourResetAt: now + 2 * 3_600_000,
      weeklyPercent: 18, weeklyResetAt: now + 3 * 86_400_000 },
    "cursor\u0000acc-2": { updatedAt: now, monthlyPercent: 1.2, monthlyResetAt: now + 20 * 86_400_000,
      customWindows: [{ label: "First-party models", percent: 1.3, resetAt: now + 20 * 86_400_000 }] },
  });
  for (const headers of [{ "x-opencodex-api-key": KEY }, { Authorization: `Bearer ${KEY}` }, { Authorization: "Bearer windows-environment-key" }]) {
    const response = await fetch(new URL("/v1/usage/windows", server.url), { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ windows: [
      { label: "Anthropic 5-hour", provider: "Anthropic", percent: 42.5, limited: false },
      { label: "Anthropic Weekly", provider: "Anthropic", percent: 18, limited: false },
      { label: "Cursor Monthly", provider: "Cursor", percent: 1.2, limited: false },
      { label: "Cursor First-party models", provider: "Cursor", percent: 1.3, limited: false },
    ] });
    expect(body.windows.every((row: { resetsAt: number }) => row.resetsAt > Date.now())).toBe(true);
    expect(JSON.stringify(body)).not.toContain("acc-");
  }
});

test("absent and unknown credentials cannot obtain windows", async () => {
  server = startServer(0);
  for (const headers of [{}, { "x-opencodex-api-key": "bad-key" }, { Authorization: "Bearer bad-key" }]) {
    const response = await fetch(new URL("/v1/usage/windows", server.url), { headers });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
});

test("windows without reset evidence and rolled-over windows are dropped", async () => {
  const now = Date.now();
  server = startServer(0);
  seed({
    "fixture\u0000acc-x": { updatedAt: now, fiveHourPercent: 70, weeklyPercent: 9, weeklyResetAt: now - 1,
      monthlyPercent: 3, monthlyResetAt: now + 5 * 86_400_000, customWindows: [{ label: "No reset", percent: 5 }] },
  });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows.map((row: { label: string }) => row.label)).toEqual(["Fixture Monthly"]);
});

test("the fullest account per slot reports, and an exhausted account marks the window limited", async () => {
  const now = Date.now();
  server = startServer(0);
  seed({
    "anthropic\u0000acc-a": { updatedAt: now, fiveHourPercent: 10, fiveHourResetAt: now + 2 * 3_600_000 },
    "anthropic\u0000acc-b": { updatedAt: now, fiveHourPercent: 100, fiveHourResetAt: now + 3 * 3_600_000 },
  });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows).toMatchObject([{ label: "Anthropic 5-hour", percent: 100, limited: true }]);
  expect(body.windows).toHaveLength(1);
});

test("no account measurements is an empty list, not an error", async () => {
  server = startServer(0);
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ windows: [] });
});

test("per-model custom windows never duplicate their family bar", async () => {
  const now = Date.now();
  server = startServer(0);
  seed({
    "fixture\u0000acc-m": { updatedAt: now, customWindows: [
      { label: "Opus", percent: 40, resetAt: now + 86_400_000 },
      { label: "Opus", percent: 12, resetAt: now + 86_400_000, modelId: "claude-opus-5" },
    ] },
  });
  const response = await fetch(new URL("/v1/usage/windows", server.url), { headers: { "x-opencodex-api-key": KEY } });
  const body = await response.json();
  expect(body.windows.map((row: { percent: number }) => row.percent)).toEqual([40]);
});
