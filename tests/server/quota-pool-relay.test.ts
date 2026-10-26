/**
 * `GET /api/quota-pool` over every path GOAT reads it (goat-si/goat #684 §3.3):
 * the Home's management API, a Remote Link Child's relay (`/v1/link-management` on the Home's
 * link listener) and a Hub client's relay (`/api/machine/hub-relay/api/quota-pool`).
 *
 * Passive-read guard in the style of link-management-relay.test.ts: inside the read, any fetch,
 * process spawn or file write is a finding, the Home's durable state must not change, and a pool
 * account with an expired token must not be refreshed (a refresh would have to fetch).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { isPassiveRead } from "../../src/lib/passive-read";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { applyAccountQuotaFromUpstreamHeaders, clearAccountQuota } from "../../src/codex/quota";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import { linkManagementReadAllowed } from "../../src/link/management-routes";
import { relayHubManagementRequest } from "../../src/client/hub-relay";
import { readQuotaPoolIdentity } from "../../src/quota-pool/identity";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { nullPaths, QuotaPoolSchema } from "../helpers/quota-pool-schema";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const LINKED_KEY = "quota-pool-linked-admission";
const ADMIN_KEY = "quota-pool-admin-admission";
const POOL_EMAIL = "qp-pool-expired@example.test";
const previous = {
  home: process.env.OPENCODEX_HOME,
  apiToken: process.env.OPENCODEX_API_AUTH_TOKEN,
  adminToken: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
};
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(closeActiveConnections?: boolean): Promise<void>; url: URL } | null = null;
let effects: string[] = [];
let restore: Array<() => void> = [];

/** Record every fetch, spawn and file write made inside a passive read; answer off-machine fetches locally. */
function watchEffects(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isPassiveRead()) effects.push(`fetch ${url}`);
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])[:/]/.test(url)) return originalFetch(input, init);
    return Promise.resolve(Response.json({ error: "fixture upstream" }, { status: 503 }));
  }) as typeof fetch;
  restore.push(() => { globalThis.fetch = originalFetch; });
  const wrap = (target: object, names: string[], label: string, mutates: (args: unknown[]) => boolean = () => true) => {
    for (const name of names) {
      const original = (target as Record<string, (...args: unknown[]) => unknown>)[name]!;
      const spy = spyOn(target as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (isPassiveRead() && mutates(args)) effects.push(`${label}.${name} ${String(args[0])}`);
        return original.apply(this, args);
      });
      restore.push(() => spy.mockRestore());
    }
  };
  wrap(childProcess, ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync"], "child_process");
  wrap(Bun, ["spawn", "spawnSync", "write"], "Bun");
  wrap(fs, ["writeFileSync", "appendFileSync", "copyFileSync", "renameSync", "chmodSync", "mkdirSync", "rmSync", "unlinkSync",
    "writeSync", "ftruncateSync", "truncateSync", "linkSync", "symlinkSync", "utimesSync"], "fs");
  wrap(fsPromises, ["writeFile", "appendFile", "copyFile", "rename", "chmod", "mkdir", "rm", "unlink", "truncate"], "fs/promises");
  const forWrite = (args: unknown[]) => {
    const flags = args[1];
    if (flags === undefined) return false;
    if (typeof flags === "number") {
      const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
      return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
    }
    return !["r", "rs", "sr"].includes(String(flags));
  };
  wrap(fs, ["openSync"], "fs", forWrite);
  wrap(fsPromises, ["open"], "fs/promises", forWrite);
}

function durableState(): Record<string, string> {
  const state: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      try { const stat = fs.statSync(path); state[path] = `${stat.size}:${stat.mtimeMs}:${stat.mode}`; } catch { state[path] = "vanished"; }
    }
  };
  walk(testHome);
  if (codexHome) walk(codexHome.path);
  return state;
}

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    runtimeRole: "hub",
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, apiKey: "fixture-key", models: ["m"] },
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
    // Expired token: reading its quota actively would refresh it first.
    codexAccounts: [{ id: "qp-pool-expired", email: POOL_EMAIL, plan: "plus", isMain: false }],
    apiKeys: [{ id: "linked-key", name: "linked-key", key: LINKED_KEY, createdAt: "2026-10-21T00:00:00.000Z" }],
    clientIntegrations: { codex: false },
    webSearchSidecar: { enabled: false },
  } as OcxConfig;
}

async function linkBase(): Promise<string> {
  const port = JSON.parse(await Bun.file(linkStorePath()).text()).listenerPort as number;
  return `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-quota-pool-relay-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "quota-pool-env-admission";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_KEY;
  effects = [];
  watchEffects();
  codexHome = installIsolatedCodexHome("ocx-quota-pool-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "mock/m" }] }));
  saveCodexAccountCredential("qp-pool-expired", {
    accessToken: "access-qp-pool-expired", refreshToken: "refresh-qp-pool-expired",
    expiresAt: Date.now() - 60_000, chatgptAccountId: "acct-qp-pool-expired",
  });
  writeLinkStore(linkStorePath(), {
    version: 1,
    listenerPort: null,
    links: [{
      id: "lnk_00000000000000aa", alias: "quota-pool-test", direction: "client-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: "linked-key", createdAt: "2026-10-21T00:00:00.000Z",
    }],
  });
  const { saveConfig } = await import("../../src/config");
  saveConfig(config());
  const { startServer } = await import("../../src/server");
  server = startServer(0);
  const reset = Math.floor(Date.now() / 1000) + 3600;
  applyAccountQuotaFromUpstreamHeaders("qp-pool-expired", new Headers({
    "x-codex-primary-used-percent": "64", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(reset),
    "x-codex-secondary-used-percent": "18", "x-codex-secondary-reset-at": String(reset + 4 * 86400),
  }));
  // The seeding above persists the quota cache on a 250 ms debounce; let it land before any
  // test takes its durable-state baseline, so only the read is measured.
  await Bun.sleep(600);
});

/** Refused by the management auth layer before the handler runs. */
async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("ocx.quota-pool");
}

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  // The seeded reading lives in process memory; leaving it would make a later file's pool account
  // look freshly measured.
  clearAccountQuota();
  await Bun.sleep(300); // let the clear's debounced persist land before the home is removed
  for (const undo of restore.splice(0).reverse()) undo();
  codexHome?.restore();
  codexHome = null;
  for (const [key, value] of [["OPENCODEX_HOME", previous.home], ["OPENCODEX_API_AUTH_TOKEN", previous.apiToken],
    ["OPENCODEX_ADMIN_AUTH_TOKEN", previous.adminToken]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

async function expectPool(response: Response, role = "hub") {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  for (const secret of [POOL_EMAIL, "qp-pool-expired", "acct-qp-pool-expired", "access-qp-pool-expired", LINKED_KEY, ADMIN_KEY]) {
    expect(text).not.toContain(secret);
  }
  const body = JSON.parse(text);
  expect(nullPaths(body)).toEqual([]);
  const pool = QuotaPoolSchema.parse(body);
  expect(pool.producer).toMatchObject({ role, homeId: readQuotaPoolIdentity()!.homeId });
  const openai = pool.providers.find(provider => provider.provider === "openai");
  // The passive read checks no credential, so no Codex row may be reported as needing reauth.
  expect(openai?.accounts.map(row => row.state).filter(state => state === "reauth")).toEqual([]);
  const account = openai?.accounts.find(row => row.windows.length > 0);
  expect(account?.windows.map(window => [window.kind, window.usedPercent])).toEqual([["burst_5h", 64], ["weekly", 18]]);
  return pool;
}

describe("GET /api/quota-pool", () => {
  test("the server mints the identity at startup, so the read only reads it", () => {
    expect(readQuotaPoolIdentity()?.homeId).toMatch(/^home_[0-9a-f]{32}$/);
  });

  test("Home management read: authorized like its neighbours, passive, and refresh is ignored", async () => {
    await expectRefused(await fetch(`${server!.url.origin}/api/quota-pool`));
    const before = durableState();
    effects = [];
    for (const query of ["", "?refresh=1"]) {
      await expectPool(await fetch(`${server!.url.origin}/api/quota-pool${query}`, { headers: { "x-opencodex-api-key": ADMIN_KEY } }));
    }
    await Bun.sleep(250);
    expect(effects).toEqual([]);
    expect(durableState()).toEqual(before);
  });

  test("Remote Link Child relay: link key only, read-only, passive", async () => {
    expect(linkManagementReadAllowed("GET", "/api/quota-pool")).toBe(true);
    expect(linkManagementReadAllowed("POST", "/api/quota-pool")).toBe(false);
    const base = await linkBase();
    expect((await fetch(`${base}/v1/link-management/api/quota-pool`)).status).toBe(401);
    const before = durableState();
    effects = [];
    const first = await expectPool(await fetch(`${base}/v1/link-management/api/quota-pool`, { headers: { authorization: `Bearer ${LINKED_KEY}` } }));
    const second = await expectPool(await fetch(`${base}/v1/link-management/api/quota-pool`, { headers: { authorization: `Bearer ${LINKED_KEY}` } }));
    expect(second.providers.flatMap(p => p.accounts.map(a => a.accountRef))).toEqual(first.providers.flatMap(p => p.accounts.map(a => a.accountRef)));
    for (const method of ["POST", "PUT", "DELETE"]) {
      const refused = await fetch(`${base}/v1/link-management/api/quota-pool`, { method, headers: { authorization: `Bearer ${LINKED_KEY}` }, body: "{}" });
      expect({ method, status: refused.status }).toEqual({ method, status: 404 });
    }
    await Bun.sleep(250);
    expect(effects).toEqual([]);
    expect(durableState()).toEqual(before);
  });

  test("Hub client relay: /api/machine/hub-relay/api/quota-pool reaches the hub's read", async () => {
    const relay = (headers: Record<string, string>) => relayHubManagementRequest(
      new Request("http://127.0.0.1:1/api/machine/hub-relay/api/quota-pool?refresh=1", { headers }),
      "/api/quota-pool?refresh=1",
      { managementUrl: server!.url.origin, browserOrigin: "http://127.0.0.1:1" },
    );
    await expectRefused(await relay({}));
    const before = durableState();
    effects = [];
    await expectPool(await relay({ "x-opencodex-api-key": ADMIN_KEY }));
    await Bun.sleep(250);
    expect(effects).toEqual([]);
    expect(durableState()).toEqual(before);
  });
});
