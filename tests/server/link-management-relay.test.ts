/**
 * #6957: the Home end of the Remote Link management relay, through the real hub-link listener.
 *
 * The link key admits only allowlisted GET reads under /v1/link-management; every other method,
 * path or refresh query is a 404 before a handler runs, and the prefix does not exist on the
 * public listener at all. The Codex settings document is what a Child applies when it syncs.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { isPassiveRead } from "../../src/lib/passive-read";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore } from "../../src/link/store";
import { parseHomeCodexSettingsDocument } from "../../src/link/codex-settings";
import { LINK_MANAGEMENT_READ_PATHS } from "../../src/link/management-routes";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ENV_KEY = "link-mgmt-env-admission";
const OTHER_KEY = "link-mgmt-other-admission";
const LINKED_KEY = "link-mgmt-linked-admission";
const LINKED_ID = "linked-key";
const ADMIN_KEY = "link-mgmt-admin-admission";
const PROVIDER_SECRET = "fixture-provider-credential-not-relayed";
/** A provider still waiting for its first model choice: discovery would decide it and save. */
const PENDING_MODELS = Array.from({ length: 20 }, (_, index) => `pending-model-${index + 1}`);
/** The query each allowlisted read needs to reach its handler's work, as the CLI sends it. */
const READ_QUERY: Record<string, string> = { "/api/providers/keys": "?name=mock", "/api/oauth/accounts": "?provider=anthropic" };

const previous = {
  home: process.env.OPENCODEX_HOME,
  codexHome: process.env.CODEX_HOME,
  apiToken: process.env.OPENCODEX_API_AUTH_TOKEN,
  adminToken: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
};
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(closeActiveConnections?: boolean): Promise<void>; url: URL } | null = null;
/** Every request a Home handler sends to a provider upstream lands here. */
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamHits = 0;
/** Requests that left the machine (answered locally here), and everything a passive read did. */
let externalCalls: string[] = [];
let passiveEffects: string[] = [];
let restoreWatchers: Array<() => void> = [];

/**
 * Answer every non-loopback request locally, so no test here reaches a real provider, and record
 * any fetch, child process or file mutation made inside a passive read, whatever started it.
 */
function watchHomeEffects(): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (isPassiveRead()) passiveEffects.push(`fetch ${url}`);
    if (/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])[:/]/.test(url)) return originalFetch(input, init);
    externalCalls.push(url);
    return Promise.resolve(Response.json({ error: "fixture upstream" }, { status: 503 }));
  }) as typeof fetch;
  restoreWatchers.push(() => { globalThis.fetch = originalFetch; });
  const wrap = (target: object, names: string[], label: string, mutates: (args: unknown[]) => boolean = () => true) => {
    for (const name of names) {
      const original = (target as Record<string, (...args: unknown[]) => unknown>)[name]!;
      const spy = spyOn(target as Record<string, (...args: unknown[]) => unknown>, name).mockImplementation(function (this: unknown, ...args: unknown[]) {
        if (isPassiveRead() && mutates(args)) passiveEffects.push(`${label}.${name} ${String(args[0])}`);
        return original.apply(this, args);
      });
      restoreWatchers.push(() => spy.mockRestore());
    }
  };
  wrap(childProcess, ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync"], "child_process");
  wrap(Bun, ["spawn", "spawnSync", "write"], "Bun");
  wrap(fs, ["writeFileSync", "appendFileSync", "copyFileSync", "renameSync", "chmodSync", "mkdirSync", "rmSync", "unlinkSync",
    "writeSync", "ftruncateSync", "truncateSync", "linkSync", "symlinkSync", "utimesSync"], "fs");
  wrap(fsPromises, ["writeFile", "appendFile", "copyFile", "rename", "chmod", "mkdir", "rm", "unlink", "truncate"], "fs/promises");
  wrap(fs, ["openSync"], "fs", opensForWrite);
  wrap(fsPromises, ["open"], "fs/promises", opensForWrite);
}

/**
 * Opening for reading is a read; a flag that can create, truncate or change a file is a write.
 * Numeric flags are judged by their write bits, so a read-only open with modifiers such as
 * O_NONBLOCK (the bounded macOS Info.plist identity read, #6973) stays a read.
 */
function opensForWrite(args: unknown[]): boolean {
  const flags = args[1];
  if (flags === undefined) return false;
  if (typeof flags === "number") {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return !["r", "rs", "sr"].includes(String(flags));
}

test("the passive effect watcher classifies opens by their write capability", () => {
  const { O_RDONLY, O_NONBLOCK, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
  for (const flags of [undefined, "r", "rs", "sr", O_RDONLY, O_RDONLY | O_NONBLOCK]) {
    expect(opensForWrite(["/fixture", flags])).toBe(false);
  }
  for (const flags of ["w", "wx", "w+", "a", "ax", "a+", "as", "r+", "rs+", O_WRONLY, O_RDWR, O_RDONLY | O_CREAT, O_RDONLY | O_TRUNC, O_WRONLY | O_APPEND]) {
    expect(opensForWrite(["/fixture", flags])).toBe(true);
  }
});

/** Every file under the Home's config and Codex homes, with what a write would change. */
function durableState(): Record<string, string> {
  const state: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      try {
        const stat = fs.statSync(path);
        state[path] = `${stat.size}:${stat.mtimeMs}:${stat.mode}`;
      } catch { state[path] = "vanished"; }
    }
  };
  walk(testHome);
  if (codexHome) walk(codexHome.path);
  return state;
}

function key(id: string, value: string) {
  return { id, name: id, key: value, createdAt: "2026-09-25T00:00:00.000Z" };
}

function config(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    runtimeRole: "hub",
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, apiKey: PROVIDER_SECRET, models: ["test-model"] },
      pending: {
        adapter: "openai-chat", baseUrl: "http://127.0.0.1:9/v1", allowPrivateNetwork: true, liveModels: false, models: PENDING_MODELS,
        initialModelSelection: { version: 1, registrationId: "69596959-6959-4959-8959-695969596959", status: "pending" },
      },
      live: { adapter: "openai-chat", baseUrl: `${upstream!.url.origin}/v1`, allowPrivateNetwork: true, apiKey: "fixture-live-upstream-key" },
      // A provider whose quota the Home probes upstream on a cold cache.
      openrouter: { adapter: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", apiKey: "fixture-openrouter-key", liveModels: false, models: ["openrouter/auto"] },
      // Canonical OpenAI: the sidecar reads then ask whether native main may be used.
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
    },
    // A Codex pool account whose token has expired: reading its quota would refresh the token first.
    codexAccounts: [{ id: "pool-expired", email: "pool-expired@example.test", plan: "plus", isMain: false }],
    apiKeys: [key("other-key", OTHER_KEY), key(LINKED_ID, LINKED_KEY)],
    clientIntegrations: { codex: false },
    fastMode: true,
    multiAgentMode: "v1",
    injectionModel: "mock/test-model",
    injectionEffort: "high",
    syncCodexSubagentDefaults: true,
    webSearchSidecar: { enabled: false },
  } as OcxConfig;
}

async function linkBase(): Promise<string> {
  const linkPort = JSON.parse(await Bun.file(linkStorePath()).text()).listenerPort as number;
  return `http://127.0.0.1:${linkPort}`;
}

function get(base: string, path: string, credential?: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(init.headers as Record<string, string> | undefined) },
  });
}

beforeEach(async () => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-link-mgmt-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = ENV_KEY;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_KEY;
  upstreamHits = 0;
  externalCalls = [];
  passiveEffects = [];
  watchHomeEffects();
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      upstreamHits += 1;
      return Response.json({ object: "list", data: [{ id: "live-a", object: "model" }, { id: "live-b", object: "model" }] });
    },
  });
  codexHome = installIsolatedCodexHome("ocx-link-mgmt-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "mock/test-model" }] }));
  writeFileSync(join(codexHome.path, "config.toml"), "");
  saveCodexAccountCredential("pool-expired", {
    accessToken: "access-pool-expired", refreshToken: "refresh-pool-expired",
    expiresAt: Date.now() - 60_000, chatgptAccountId: "acct-pool-expired",
  });
  // A malformed, loosely permitted OAuth store: a Home load backs it up and tightens it.
  writeFileSync(join(testHome, "auth.json"), "{ not json", { mode: 0o644 });
  const { saveConfig } = await import("../../src/config");
  writeLinkStore(linkStorePath(), {
    version: 1,
    listenerPort: null,
    links: [{
      id: "lnk_0123456789abcdef",
      alias: "mgmt-test",
      direction: "client-initiated",
      hostKeyFingerprint: "SHA256:abcdefghijklmnop",
      tunnelPort: 2222,
      apiKeyId: LINKED_ID,
      createdAt: "2026-09-25T00:00:00.000Z",
    }],
  });
  saveConfig(config());
  const { startServer } = await import("../../src/server");
  server = startServer(0);
});

afterEach(async () => {
  if (server) await server.stop(true);
  server = null;
  await upstream?.stop(true);
  upstream = null;
  for (const restore of restoreWatchers.splice(0).reverse()) restore();
  codexHome?.restore();
  codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previous.home;
  if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous.codexHome;
  if (previous.apiToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previous.apiToken;
  if (previous.adminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previous.adminToken;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

describe("Remote Link management relay on the Home", () => {
  test("admits allowlisted reads only with the link key", async () => {
    const base = await linkBase();
    for (const credential of [undefined, ENV_KEY, OTHER_KEY]) {
      const refused = await get(base, "/v1/link-management/api/effort-caps", credential);
      expect({ credential, status: refused.status }).toEqual({ credential, status: 401 });
    }
    const caps = await get(base, "/v1/link-management/api/effort-caps", LINKED_KEY);
    expect(caps.status).toBe(200);
    expect(caps.headers.get("cache-control")).toBe("no-store");
    expect(Array.isArray((await caps.json() as { efforts?: unknown }).efforts)).toBe(true);
    const head = await get(base, "/v1/link-management/api/settings", LINKED_KEY, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  test("relays a masked projection and never a provider credential", async () => {
    const providers = await get(await linkBase(), "/v1/link-management/api/providers", LINKED_KEY, {
      headers: { cookie: "session=browser", "x-opencodex-gui-origin": "http://127.0.0.1:1" },
    });
    expect(providers.status).toBe(200);
    const text = await providers.text();
    expect(text).not.toContain(PROVIDER_SECRET);
    expect(text).not.toContain(LINKED_KEY);
    const rows = JSON.parse(text) as Array<{ name: string; hasApiKey: boolean }>;
    expect(rows.find(row => row.name === "mock")?.hasApiKey).toBe(true);
    const keys = await get(await linkBase(), "/v1/link-management/api/providers/keys?name=mock", LINKED_KEY);
    expect(keys.status).toBe(200);
    expect(await keys.text()).not.toContain(PROVIDER_SECRET);
  });

  test("refuses writes, unlisted reads and refresh queries before a handler runs", async () => {
    const base = await linkBase();
    const refused: Array<[string, string]> = [
      ["PUT", "/v1/link-management/api/settings"],
      ["POST", "/v1/link-management/api/providers"],
      ["DELETE", "/v1/link-management/api/providers"],
      ["GET", "/v1/link-management/api/logs"],
      ["GET", "/v1/link-management/api/config"],
      ["GET", "/v1/link-management/api/provider-quotas?refresh=1"],
      ["GET", "/v1/link-management/api/codex-auth/accounts?refresh=1"],
      // Reads that make the Home do upstream work or persist discovery are not reads here.
      ["GET", "/v1/link-management/api/oauth/accounts?provider=anthropic&quota=1"],
      ["GET", "/v1/link-management/api/providers/keys?name=mock&quota=1"],
      ["GET", "/v1/link-management/api/models"],
      ["GET", "/v1/link-management/api/model-presets"],
      ["GET", "/v1/link-management/api/subagent-models"],
      ["GET", "/v1/link-management/api/subagent-model-fallback"],
      ["GET", "/v1/link-management/api/diagnostics/project-config"],
      ["GET", "/v1/link-management/codex-settings?x=1"],
      ["GET", "/v1/link-management"],
    ];
    for (const [method, path] of refused) {
      const response = await get(base, path, LINKED_KEY, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
    }
  });

  test("the prefix exists only on the link listener", async () => {
    const response = await get(server!.url.origin, "/v1/link-management/api/effort-caps", LINKED_KEY);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("efforts");
  });

  test("every allowlisted read names a real Home management route", async () => {
    const base = await linkBase();
    for (const path of LINK_MANAGEMENT_READ_PATHS) {
      // The key-pool read names its provider, as `ocx account` sends it.
      const query = path === "/api/providers/keys" ? "?name=mock" : "";
      const response = await get(base, `/v1/link-management${path}${query}`, LINKED_KEY);
      await response.body?.cancel();
      expect({ path, routed: response.status !== 404 && response.status !== 401 }).toEqual({ path, routed: true });
    }
  });

  test("no allowlisted read changes the Home config, reaches an upstream or starts a process (#6959)", async () => {
    const base = await linkBase();
    const { getConfigPath } = await import("../../src/config");
    const before = readFileSync(getConfigPath(), "utf8");
    expect(JSON.parse(before).providers.pending.initialModelSelection.status).toBe("pending");
    const admin = { headers: { "x-opencodex-api-key": ADMIN_KEY } };
    // The Home's live, in-memory configuration as its own dashboard reads it.
    const liveConfig = async () => {
      const response = await get(server!.url.origin, "/api/config", undefined, admin);
      expect(response.status).toBe(200);
      return await response.json() as { providers: Record<string, { initialModelSelection?: { status?: string } }> };
    };
    const liveBefore = await liveConfig();
    expect(liveBefore.providers.pending?.initialModelSelection?.status).toBe("pending");
    // Native main fenced because service ownership was unknown at boot: re-inspecting it from a
    // read would activate the native-main lifecycle and its recovery.
    const nativeStartup = await import("../../src/codex/native-profile-startup");
    let ownershipProbes = 0;
    const fence = nativeStartup.blockNativeMainStartupForUnownedServiceHome("ownership-unknown", {
      reprobe: () => { ownershipProbes += 1; return "unknown"; },
      expectedHomeId: "link-6959-home",
      startOwnedLifecycle: () => { throw new Error("fixture: not activated"); },
    });
    nativeStartup.__resetNativeMainOwnershipRetries();
    const durableBefore = durableState();
    upstreamHits = 0;
    passiveEffects = [];
    // Each read is judged against the state the previous read left, so one finding cannot hide another.
    const findings: Array<{ method: string; path: string; status: number; configChanged: boolean; effects: string[] }> = [];
    let current = before;
    for (const method of ["GET", "HEAD"]) {
      for (const path of LINK_MANAGEMENT_READ_PATHS) {
        const response = await get(base, `/v1/link-management${path}${READ_QUERY[path] ?? ""}`, LINKED_KEY, { method });
        await response.body?.cancel();
        const after = readFileSync(getConfigPath(), "utf8");
        const row = { method, path, status: response.status, configChanged: after !== current, effects: passiveEffects.splice(0) };
        if (row.status !== 200 || row.configChanged || row.effects.length > 0) findings.push(row);
        current = after;
      }
    }
    expect(findings).toEqual([]);
    expect(ownershipProbes).toBe(0);
    expect(durableState()).toEqual(durableBefore);
    // Work a read leaves scheduled stays in its passive scope. The longest ordinary delay among the
    // known producers is the responses snapshot debounce (SNAPSHOT_DEBOUNCE_MS, 2 s).
    await Bun.sleep(2_500);
    expect(passiveEffects).toEqual([]);
    expect(durableState()).toEqual(durableBefore);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(await liveConfig()).toEqual(liveBefore);
    expect(upstreamHits).toBe(0);

    // The fixture is live: the same reads made by the Home itself do each kind of work.
    const homeRead = async (path: string) => { await (await get(server!.url.origin, path, undefined, admin)).body?.cancel(); };
    const backups = () => readdirSync(testHome).filter(name => name.startsWith("auth.json.invalid-")).length;
    const backupsBefore = backups();
    await homeRead("/api/oauth/accounts?provider=anthropic");
    expect(backups()).toBeGreaterThan(backupsBefore);
    externalCalls = [];
    await homeRead("/api/provider-quotas");
    expect(externalCalls.some(url => url.includes("openrouter.ai"))).toBe(true);
    externalCalls = [];
    await homeRead("/api/codex-auth/accounts");
    expect(externalCalls.length).toBeGreaterThan(0);
    await homeRead("/api/sidecar-settings");
    expect(ownershipProbes).toBeGreaterThan(0);
    void fence.release();
    await homeRead("/api/models");
    expect(upstreamHits).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(getConfigPath(), "utf8")).providers.pending.initialModelSelection.status).not.toBe("pending");
    expect((await liveConfig()).providers.pending?.initialModelSelection?.status).not.toBe("pending");
    // Work a link read left scheduled would have run by now, still inside its passive scope.
    expect(passiveEffects).toEqual([]);
  });

  test("answers the injection model read from Home config without discovery", async () => {
    const response = await get(await linkBase(), "/v1/link-management/api/injection-model", LINKED_KEY);
    expect(response.status).toBe(200);
    const body = await response.json() as { model: string | null; effort: string | null; efforts: string[]; available: Array<{ namespaced: string }> };
    expect({ model: body.model, effort: body.effort }).toEqual({ model: "mock/test-model", effort: "high" });
    expect(body.efforts).toContain("high");
    const offered = body.available.map(row => row.namespaced);
    expect(offered).toContain("mock/test-model");
    expect(offered.some(slug => slug.startsWith("live/") || slug.startsWith("pending/"))).toBe(false);
    expect(upstreamHits).toBe(0);
  });

  test("publishes the Home's OpenCodex-owned Codex settings", async () => {
    const response = await get(await linkBase(), "/v1/link-management/codex-settings", LINKED_KEY);
    expect(response.status).toBe(200);
    const document = parseHomeCodexSettingsDocument(await response.json());
    expect(document?.settings).toEqual({
      fastMode: true,
      multiAgentMode: "v1",
      webSearchSidecarEnabled: false,
      subagentDefaults: { model: "mock/test-model", reasoningEffort: "high" },
    });
    expect(document?.home.name.length).toBeGreaterThan(0);
  });
});

describe("passive management reads (#6959)", () => {
  test("demote only memory-only stores when a usage read meets a full memory budget", async () => {
    const memory = await import("../../src/lib/app-owned-memory");
    const { runPassiveRead } = await import("../../src/lib/passive-read");
    const replay = await import("../../src/adapters/google-antigravity-replay");
    // A persisted replay session: evicting it rewrites antigravity-replay.json after a debounce.
    replay.__resetAntigravityReplayCache();
    replay.observeAntigravityReplay("gemini-3-pro", "-6959", [{ functionCall: { name: "get_x", args: { a: 1 } }, thoughtSignature: "sig-6959-0123456789abcdef" }]);
    expect(replay.antigravityReplaySessionKeysForTests().length).toBe(1);
    // A cache whose eviction is not declared memory-only.
    let undeclaredDemotions = 0;
    const unregisterCache = memory.registerRetainedStore({
      id: "fixture_undeclared_cache",
      category: "caches",
      snapshot: () => ({ count: 1, bytes: 1024, evictableBytes: 1024, pinnedBytes: 0, oldestAt: 0 }),
      evictOldest: () => { undeclaredDemotions += 1; return 0; },
    });
    // A resident continuation far over any budget: demoting it would spill it to disk.
    let continuationDemotions = 0;
    const unregister = memory.registerRetainedStore({
      id: "fixture_continuation",
      category: "continuation",
      snapshot: () => ({ count: 1, bytes: 8 * 1024 ** 3, evictableBytes: 8 * 1024 ** 3, pinnedBytes: 0, oldestAt: 1 }),
      evictOldest: () => { continuationDemotions += 1; return 0; },
    });
    try {
      // One ledger row, so a cold usage read builds and publishes its caches.
      writeFileSync(join(testHome, "usage.jsonl"), `${JSON.stringify({
        requestId: "usage-6959", timestamp: Date.now() - 1_000, provider: "mock", model: "test-model",
        status: 200, durationMs: 1, usageStatus: "reported", usage: { inputTokens: 1, outputTokens: 1 }, totalTokens: 2,
      })}\n`);
      const runs = () => memory.appOwnedBytesSnapshot().enforcement.runs;
      const before = runs();
      for (const method of ["GET", "HEAD"]) {
        for (const query of ["", "?range=7d", "?range=30d"]) {
          const response = await get(await linkBase(), `/v1/link-management/api/usage${query}`, LINKED_KEY, { method });
          expect(response.status).toBe(200);
          await response.body?.cancel();
        }
      }
      expect(runs()).toBeGreaterThan(before);
      expect(await runPassiveRead(async () => memory.enforceAppOwnedMemoryBudget())).toBeDefined();
      // Past the replay snapshot debounce: a demotion would have scheduled its write by now.
      await Bun.sleep(2_500);
      expect({ continuationDemotions, undeclaredDemotions, replaySessions: replay.antigravityReplaySessionKeysForTests().length, passiveEffects })
        .toEqual({ continuationDemotions: 0, undeclaredDemotions: 0, replaySessions: 1, passiveEffects: [] });
      // The Home's own enforcement demotes all three.
      memory.enforceAppOwnedMemoryBudget();
      expect(continuationDemotions).toBeGreaterThan(0);
      expect(undeclaredDemotions).toBeGreaterThan(0);
      expect(replay.antigravityReplaySessionKeysForTests().length).toBe(0);
    } finally {
      unregister();
      unregisterCache();
      replay.__resetAntigravityReplayCache();
    }
  });

  test("discover no models, so a pending provider stays pending", async () => {
    const { fetchAllModels } = await import("../../src/server/management/shared");
    const { getConfigPath, loadConfig } = await import("../../src/config");
    const { runPassiveRead } = await import("../../src/lib/passive-read");
    const before = readFileSync(getConfigPath(), "utf8");
    expect(await runPassiveRead(() => fetchAllModels(loadConfig()))).toEqual([]);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(before);
    expect(upstreamHits).toBe(0);
  });

  test("serve the last startup-health reading without starting a diagnostic", async () => {
    const { getCachedStartupHealth, getStartupHealthSnapshot, resetStartupHealthCacheForTests } = await import("../../src/server/startup-health-cache");
    const { runPassiveRead } = await import("../../src/lib/passive-read");
    resetStartupHealthCacheForTests();
    let probes = 0;
    let reading: Awaited<ReturnType<typeof getCachedStartupHealth>> | null = null;
    const deps = {
      probe: async () => { probes += 1; return reading!; },
      waitForProbe: <T>(probe: Promise<T>) => probe,
    };
    try {
      reading = await runPassiveRead(async () => {
        getStartupHealthSnapshot(config(), deps);
        return await getCachedStartupHealth(config(), deps);
      });
      expect(reading.diagnosticStale).toBe(true);
      expect(probes).toBe(0);
      // The Home's own read of the same cold cache starts the diagnostic.
      await getCachedStartupHealth(config(), deps);
      expect(probes).toBe(1);
    } finally {
      resetStartupHealthCacheForTests();
    }
  });
});
