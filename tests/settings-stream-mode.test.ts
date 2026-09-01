/**
 * /api/settings streamMode surface (#314 WP1) + config persistence round-trip.
 *
 * streamMode is persisted in config.json (including the macOS explicit eager
 * opt-in; Windows services do not inherit shell env), degraded to "auto" with
 * a warning when the persisted value is invalid (must never trip loadConfig's
 * backup-and-defaults repair path), and settable alone via PUT (legacy
 * codexAutoStart-only PUTs keep working).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../src/config";
import { handleManagementAPI, type ManagementApiDeps } from "../src/server/management-api";
import { invalidateStartupHealthCache } from "../src/server/startup-health-cache";
import { USAGE_RANGES, USAGE_SURFACES } from "../src/usage/summary";
import type { OcxConfig } from "../src/types";
import {
  appOwnedBytesSnapshot,
  configureAppOwnedMemoryBudget,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../src/lib/app-owned-memory";
import {
  evictOldestUsageSummaryForBudget,
  getUsageSummaryCacheEntry,
  resetUsageSummaryCacheForTests,
  setUsageSummaryCacheEntry,
  usageSummaryRetainedStoreSnapshot,
} from "../src/server/management/usage-summary-cache";
import { resetUsageAggregateCacheForTests } from "../src/server/management/usage-aggregate-cache";
import { catalogConvergenceFactory } from "./helpers/catalog-convergence";
import { startupHealthFixture } from "./helpers/startup-health";
import { removeTreeWithRetry } from "./helpers/remove-tree";

let TEST_DIR = "";
const previousHome = process.env.OPENCODEX_HOME;
const readTestStartupHealth: NonNullable<ManagementApiDeps["getCachedStartupHealth"]> = async () => (
  startupHealthFixture()
);

function baseConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        defaultModel: "gpt-test",
      },
    },
  };
}

function putSettings(
  config: OcxConfig,
  body: unknown,
  deps: ManagementApiDeps = {},
): Promise<Response | null> {
  const req = new Request("http://127.0.0.1:10100/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleManagementAPI(req, new URL(req.url), config, {
    getCachedStartupHealth: readTestStartupHealth,
    ...deps,
  });
}

function getSettings(config: OcxConfig): Promise<Response | null> {
  const req = new Request("http://127.0.0.1:10100/api/settings");
  return handleManagementAPI(req, new URL(req.url), config, {
    getCachedStartupHealth: readTestStartupHealth,
  });
}

beforeEach(() => {
  resetAppOwnedMemoryForTests();
  resetUsageSummaryCacheForTests();
  resetUsageAggregateCacheForTests();
  invalidateStartupHealthCache();
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-settings-stream-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
});

afterEach(() => {
  resetAppOwnedMemoryForTests();
  resetUsageSummaryCacheForTests();
  resetUsageAggregateCacheForTests();
  invalidateStartupHealthCache();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (TEST_DIR && existsSync(TEST_DIR)) {
    try {
      removeTreeWithRetry(TEST_DIR);
    } catch {
      /* Windows may briefly retain file handles during test cleanup */
    }
  }
});

describe("GET /api/settings", () => {
  test("reports streamMode auto by default", async () => {
    const config = baseConfig();
    const res = await getSettings(config);
    expect(res).not.toBeNull();
    const body = await res!.json() as { streamMode?: string };
    expect(body.streamMode).toBe("auto");
  });

  test("reports a persisted non-auto streamMode", async () => {
    const config = { ...baseConfig(), streamMode: "eager-relay" as const };
    const body = await (await getSettings(config))!.json() as { streamMode?: string };
    expect(body.streamMode).toBe("eager-relay");
  });

  test("reports appOwnedMemoryBudgetMb with the 256 MiB default", async () => {
    const body = await (await getSettings(baseConfig()))!.json() as { appOwnedMemoryBudgetMb?: number };
    expect(body.appOwnedMemoryBudgetMb).toBe(256);
  });

  test("reports the effective account-picker state", async () => {
    const absent = await (await getSettings(baseConfig()))!.json() as {
      codexAccountPickerEnabled?: boolean;
    };
    const inferred = await (await getSettings({
      ...baseConfig(),
      codexAccountNamespaces: { side: "stored-account" },
    }))!.json() as { codexAccountPickerEnabled?: boolean };
    const hidden = await (await getSettings({
      ...baseConfig(),
      codexAccountNamespaces: { side: "stored-account" },
      codexAccountPickerEnabled: false,
    }))!.json() as { codexAccountPickerEnabled?: boolean };

    expect(absent.codexAccountPickerEnabled).toBe(false);
    expect(inferred.codexAccountPickerEnabled).toBe(true);
    expect(hidden.codexAccountPickerEnabled).toBe(false);
  });

  test("reports redacted codexRuntime diagnostics and clamp correlation", async () => {
    const { chmodSync } = await import("node:fs");
    const {
      persistEffortClamp,
      resetCodexRuntimeResolveCacheForTests,
    } = await import("../src/codex/runtime");
    resetCodexRuntimeResolveCacheForTests();

    const fakeCodex = process.platform === "win32"
      ? join(TEST_DIR, "bin", "codex.cmd")
      : join(TEST_DIR, "bin", "codex");
    mkdirSync(join(TEST_DIR, "bin"), { recursive: true });
    if (process.platform === "win32") {
      writeFileSync(fakeCodex, "@echo off\r\necho codex-cli 0.133.0\r\n", "utf8");
    } else {
      writeFileSync(fakeCodex, "#!/bin/sh\necho 'codex-cli 0.133.0'\n", "utf8");
      chmodSync(fakeCodex, 0o755);
    }
    persistEffortClamp({
      runtimePath: fakeCodex,
      runtimeVersion: "0.133.0",
      removedEfforts: ["max", "ultra"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir: TEST_DIR });

    const previousCli = process.env.CODEX_CLI_PATH;
    const previousPath = process.env.PATH;
    try {
      process.env.CODEX_CLI_PATH = fakeCodex;
      process.env.PATH = "";
      const body = await (await getSettings(baseConfig()))!.json() as {
        codexRuntime?: {
          path?: string;
          version?: string | null;
          source?: string;
          warning?: string | null;
          newerAvailable?: { path?: string; version?: string | null } | null;
          catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
        };
      };
      expect(typeof body.codexRuntime?.path).toBe("string");
      // OPENCODEX_HOME lives under the OS user profile; username must stay redacted on all OS.
      expect(body.codexRuntime?.path?.toLowerCase()).not.toMatch(/[/\\]users[/\\][^/\\[\]]+[/\\]/i);
      expect(body.codexRuntime?.path?.toLowerCase()).not.toContain("alice");
      expect(body.codexRuntime?.version).toBe("0.133.0");
      expect(body.codexRuntime?.source).toBe("environment");
      expect(body.codexRuntime?.catalogClamp).toEqual({
        active: true,
        removedEfforts: ["max", "ultra"],
        runtimeVersion: "0.133.0",
      });
      expect(
        body.codexRuntime?.newerAvailable === null
        || (typeof body.codexRuntime?.newerAvailable === "object" && body.codexRuntime?.newerAvailable !== null),
      ).toBe(true);
      expect(typeof body.codexRuntime?.warning).toBe("string");
      expect(body.codexRuntime?.warning).toContain("0.133.0");
    } finally {
      if (previousCli === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = previousCli;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      resetCodexRuntimeResolveCacheForTests();
    }
  });
});

describe("usage summary retained-store accounting", () => {
  test("accounts cached summaries and centralized oldest eviction exactly", async () => {
    for (const range of ["30d", "7d"]) {
      const req = new Request(`http://127.0.0.1:10100/api/usage?range=${range}`);
      expect((await handleManagementAPI(req, new URL(req.url), baseConfig()))!.status).toBe(200);
    }
    // Derived, not hardcoded: one usage request warms the whole
    // range x surface cross-product, so a literal here turns any future range
    // into a failure in a file about stream mode.
    const warmedEntries = USAGE_RANGES.length * USAGE_SURFACES.length;
    const before = usageSummaryRetainedStoreSnapshot();
    expect(before.count).toBe(warmedEntries);
    expect(before.bytes).toBeGreaterThan(0);
    const released = evictOldestUsageSummaryForBudget();
    const after = usageSummaryRetainedStoreSnapshot();
    expect(released).toBeGreaterThan(0);
    expect(after.count).toBe(warmedEntries - 1);
    expect(after.bytes).toBe(before.bytes - released);
  });

  test("oldest eviction follows revision read completion order, not generatedAt", async () => {
    for (const range of ["30d", "7d"]) {
      const req = new Request(`http://127.0.0.1:10100/api/usage?range=${range}`);
      expect((await handleManagementAPI(req, new URL(req.url), baseConfig()))!.status).toBe(200);
    }
    const seed = getUsageSummaryCacheEntry("30d:all");
    expect(seed).toBeDefined();
    // Simulate an older-started slow read that COMPLETES last: its generatedAt
    // is older than everything else, but its revisionReadAt is the newest.
    setUsageSummaryCacheEntry("slow:stale-generated", {
      revisionKey: "slow-read",
      identityKey: "slow-read",
      maxReadBytes: 64 * 1024 * 1024,
      overlayVersion: 0,
      timeZone: seed!.timeZone,
      expiresAt: Date.now() + 60_000,
      freshUntil: Date.now() + 60_000,
      lastSeenSize: 0,
      revisionReadAt: Date.now() + 10_000,
      summary: { ...seed!.summary, generatedAt: 1 },
    });
    const warmedEntries = USAGE_RANGES.length * USAGE_SURFACES.length;
    const before = usageSummaryRetainedStoreSnapshot();
    expect(before.count).toBe(warmedEntries + 1);
    // The slow-read entry has the minimum generatedAt; a generatedAt-keyed
    // implementation would evict it first. Completion order must win instead.
    const released = evictOldestUsageSummaryForBudget();
    expect(released).toBeGreaterThan(0);
    expect(getUsageSummaryCacheEntry("slow:stale-generated")).toBeDefined();
    expect(usageSummaryRetainedStoreSnapshot().count).toBe(warmedEntries);
  });
});

describe("PUT /api/settings", () => {
  test("legacy codexAutoStart-only PUT still works (regression)", async () => {
    const config = baseConfig();
    const res = await putSettings(config, { codexAutoStart: true });
    expect(res!.status).toBe(200);
    expect(config.codexAutoStart).toBe(true);
  });

  test("streamMode-only PUT works (Windows/macOS stream-shape escape hatch)", async () => {
    const config = baseConfig();
    const res = await putSettings(config, { streamMode: "eager-relay" });
    expect(res!.status).toBe(200);
    const body = await res!.json() as { streamMode?: string };
    expect(body.streamMode).toBe("eager-relay");
    expect(config.streamMode).toBe("eager-relay");
  });

  test("auto normalizes to key removal, persisted round-trip drops it", async () => {
    const config = { ...baseConfig(), streamMode: "legacy-tee" as const };
    const res = await putSettings(config, { streamMode: "auto" });
    expect(res!.status).toBe(200);
    expect(config.streamMode).toBeUndefined();
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
    expect("streamMode" in raw).toBe(false);
  });

  test("non-auto value persists and survives loadConfig", async () => {
    const config = baseConfig();
    await putSettings(config, { streamMode: "legacy-tee" });
    const reloaded = loadConfig();
    expect(reloaded.streamMode).toBe("legacy-tee");
  });

  test("rejects invalid streamMode with 400", async () => {
    const config = baseConfig();
    const res = await putSettings(config, { streamMode: "bogus" });
    expect(res!.status).toBe(400);
    const body = await res!.json() as { error?: string };
    expect(body.error).toContain("streamMode");
  });

  test("rejects empty body with 400", async () => {
    const config = baseConfig();
    const res = await putSettings(config, {});
    expect(res!.status).toBe(400);
  });

  test.each([[null], [[]], ["settings"], [42]] as const)(
    "rejects a non-object settings body with 400 (%j)",
    async body => {
      const response = await putSettings(baseConfig(), body);
      expect(response!.status).toBe(400);
      expect(await response!.json()).toEqual({ error: "settings body must be an object" });
    },
  );

  test("account-picker enable persists before one catalog convergence", async () => {
    const config = baseConfig();
    let persisted = false;
    let convergences = 0;
    const response = await putSettings(config, { codexAccountPickerEnabled: true }, {
      saveConfigPreservingClaudeCode: saved => {
        persisted = true;
        expect(saved.codexAccountPickerEnabled).toBe(true);
        expect(saved.codexAccountNamespaces).toEqual({ main: "@main" });
      },
      createManagementConvergeCodex: catalogConvergenceFactory(() => {
        expect(persisted).toBe(true);
        convergences += 1;
      }),
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      codexAccountPickerEnabled: true,
      catalogRefreshPending: false,
    });
    expect(convergences).toBe(1);
    expect(config.codexAccountNamespaces).toEqual({ main: "@main" });
  });

  test("codexDesktopAuthless (#1107): absent reports false, enable persists and converges once, disable deletes the key", async () => {
    const config = baseConfig();
    const absent = await (await getSettings(config))!.json() as { codexDesktopAuthless?: boolean };
    expect(absent.codexDesktopAuthless).toBe(false);

    let convergences = 0;
    let saved: OcxConfig | undefined;
    const on = await putSettings(config, { codexDesktopAuthless: true }, {
      saveConfigPreservingClaudeCode: next => { saved = next; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });
    expect(on!.status).toBe(200);
    expect(await on!.json()).toMatchObject({ codexDesktopAuthless: true });
    expect(saved?.codexDesktopAuthless).toBe(true);
    expect(convergences).toBe(1);

    const same = await putSettings(config, { codexDesktopAuthless: true }, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });
    expect(same!.status).toBe(200);
    expect(convergences).toBe(1);

    const off = await putSettings(config, { codexDesktopAuthless: false }, {
      saveConfigPreservingClaudeCode: next => { saved = next; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });
    expect(off!.status).toBe(200);
    expect(await off!.json()).toMatchObject({ codexDesktopAuthless: false });
    expect(Object.hasOwn(saved!, "codexDesktopAuthless")).toBe(false);
    expect(convergences).toBe(2);

    const bad = await putSettings(config, { codexDesktopAuthless: "yes" });
    expect(bad!.status).toBe(400);
  });

  test("account-picker disable does not initialize an empty namespace map", async () => {
    const config = baseConfig();
    let convergences = 0;
    const response = await putSettings(config, { codexAccountPickerEnabled: false }, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      codexAccountPickerEnabled: false,
      catalogRefreshPending: false,
    });
    expect(config.codexAccountNamespaces).toBeUndefined();
    expect(convergences).toBe(0);
  });

  test("account-picker convergence failure remains a successful persisted mutation", async () => {
    const config = {
      ...baseConfig(),
      codexAccountNamespaces: { main: "@main" },
      codexAccountPickerEnabled: false,
    };
    let persisted = false;
    let convergences = 0;
    const response = await putSettings(config, { codexAccountPickerEnabled: true }, {
      saveConfigPreservingClaudeCode: () => { persisted = true; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => {
        expect(persisted).toBe(true);
        convergences += 1;
        throw new Error("private refresh failure detail");
      }),
    });

    expect(response!.status).toBe(200);
    const payload = await response!.json();
    expect(payload).toMatchObject({
      ok: true,
      codexAccountPickerEnabled: true,
      catalogRefreshPending: true,
    });
    expect(JSON.stringify(payload)).not.toContain("private refresh failure detail");
    expect(config.codexAccountPickerEnabled).toBe(true);
    expect(convergences).toBe(1);
  });

  test.each([
    ["unavailable", { status: "skipped", reason: "catalog-unavailable", retryable: false }],
    ["busy", { status: "skipped", reason: "busy", retryable: true }],
    ["disk failure", {
      status: "failed",
      reason: "disk",
      phase: "commit",
      retryable: false,
      partialWrite: true,
    }],
  ] as const)("account-picker treats a non-committed %s catalog as pending", async (_state, result) => {
    const config = {
      ...baseConfig(),
      codexAccountNamespaces: { main: "@main" },
      codexAccountPickerEnabled: false,
    };
    let convergences = 0;
    const response = await putSettings(config, { codexAccountPickerEnabled: true }, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: catalogConvergenceFactory(
        () => { convergences += 1; },
        result,
      ),
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      codexAccountPickerEnabled: true,
      catalogRefreshPending: true,
    });
    expect(convergences).toBe(1);
  });

  test("account-picker disable and re-enable preserve custom namespace order", async () => {
    const namespaces = { side: "stored-account", main: "@main" };
    const config = { ...baseConfig(), codexAccountNamespaces: namespaces };
    const persistedOrders: string[][] = [];
    let convergences = 0;
    const deps: ManagementApiDeps = {
      saveConfigPreservingClaudeCode: saved => {
        persistedOrders.push(Object.keys(saved.codexAccountNamespaces ?? {}));
      },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    };

    const disabled = await putSettings(config, { codexAccountPickerEnabled: false }, deps);
    expect(await disabled!.json()).toMatchObject({ codexAccountPickerEnabled: false });
    const reenabled = await putSettings(config, { codexAccountPickerEnabled: true }, deps);
    expect(await reenabled!.json()).toMatchObject({ codexAccountPickerEnabled: true });

    expect(config.codexAccountNamespaces).toBe(namespaces);
    expect(persistedOrders).toEqual([["side", "main"], ["side", "main"]]);
    expect(convergences).toBe(2);
  });

  test("account-picker rejects non-boolean values before persistence or refresh", async () => {
    let persisted = false;
    let refreshed = false;
    const response = await putSettings(baseConfig(), { codexAccountPickerEnabled: "yes" }, {
      saveConfigPreservingClaudeCode: () => { persisted = true; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshed = true; }),
    });

    expect(response!.status).toBe(400);
    expect(persisted).toBe(false);
    expect(refreshed).toBe(false);
  });

  test("failed persistence rolls back picker and other settings", async () => {
    const config = baseConfig();
    const before = structuredClone(config);
    let refreshed = false;
    const request = putSettings(config, {
      codexAutoStart: false,
      streamMode: "legacy-tee",
      appOwnedMemoryBudgetMb: 128,
      codexAccountPickerEnabled: true,
    }, {
      saveConfigPreservingClaudeCode: () => { throw new Error("save failed"); },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshed = true; }),
    });

    await expect(request).rejects.toThrow("save failed");
    expect(config).toEqual(before);
    expect(refreshed).toBe(false);
  });

  test("selector allocation failure rolls back before persistence", async () => {
    const config = baseConfig();
    Object.defineProperty(config, "codexAccounts", {
      configurable: true,
      get: () => { throw new Error("selector allocation failed"); },
    });
    let persisted = false;
    let refreshed = false;

    const request = putSettings(config, {
      codexAutoStart: false,
      streamMode: "legacy-tee",
      appOwnedMemoryBudgetMb: 128,
      codexAccountPickerEnabled: true,
    }, {
      saveConfigPreservingClaudeCode: () => { persisted = true; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshed = true; }),
    });

    await expect(request).rejects.toThrow("selector allocation failed");
    expect(Object.hasOwn(config, "codexAutoStart")).toBe(false);
    expect(Object.hasOwn(config, "streamMode")).toBe(false);
    expect(Object.hasOwn(config, "appOwnedMemoryBudgetMb")).toBe(false);
    expect(Object.hasOwn(config, "codexAccountNamespaces")).toBe(false);
    expect(Object.hasOwn(config, "codexAccountPickerEnabled")).toBe(false);
    expect(persisted).toBe(false);
    expect(refreshed).toBe(false);
  });

  test("settings PUT rejects below above fractional and nonnumeric budget values", async () => {
    for (const value of [63, 4097, 64.5, "64"]) {
      const res = await putSettings(baseConfig(), { appOwnedMemoryBudgetMb: value });
      expect(res!.status).toBe(400);
      expect(await res!.json()).toMatchObject({ error: expect.stringContaining("appOwnedMemoryBudgetMb") });
    }
  });

  test("settings PUT applies a valid budget change synchronously through enforcement", async () => {
    let bytes = 70 * 1024 * 1024;
    let evictions = 0;
    registerRetainedStore({
      id: "test_cache",
      category: "caches",
      snapshot: () => ({ count: bytes > 0 ? 1 : 0, bytes, evictableBytes: bytes, pinnedBytes: 0, oldestAt: bytes > 0 ? 1 : null }),
      evictOldest: () => {
        const released = bytes;
        bytes = 0;
        evictions += 1;
        return released;
      },
    });
    configureAppOwnedMemoryBudget(256 * 1024 * 1024);
    const config = baseConfig();
    const res = await putSettings(config, { appOwnedMemoryBudgetMb: 64 });
    expect(res!.status).toBe(200);
    expect(config.appOwnedMemoryBudgetMb).toBe(64);
    expect(evictions).toBe(1);
    expect(appOwnedBytesSnapshot()).toMatchObject({ budgetBytes: 64 * 1024 * 1024, retainedBytes: 0 });
  });
});

describe("config.json schema resilience", () => {
  test("invalid persisted streamMode degrades to auto without nuking the config", () => {
    const config = { ...baseConfig(), streamMode: "eager-relay" as const };
    saveConfig(config);
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
    raw.streamMode = "legacy_tee"; // hand-edit typo
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    const reloaded = loadConfig();
    // Degraded, not defaulted: providers must survive.
    expect(reloaded.streamMode).toBeUndefined();
    expect(reloaded.providers.openai).toBeDefined();
    expect(reloaded.providers.openai!.apiKey).toBe("sk-secret-value");
  });

  test("valid persisted streamMode round-trips through loadConfig", () => {
    const config = { ...baseConfig(), streamMode: "legacy-tee" as const };
    saveConfig(config);
    expect(loadConfig().streamMode).toBe("legacy-tee");
  });

  test("malformed persisted appOwnedMemoryBudgetMb degrades to default without dropping providers", () => {
    saveConfig({ ...baseConfig(), appOwnedMemoryBudgetMb: 128 });
    const raw = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as Record<string, unknown>;
    raw.appOwnedMemoryBudgetMb = "huge";
    writeFileSync(getConfigPath(), JSON.stringify(raw, null, 2));
    const reloaded = loadConfig();
    expect(reloaded.appOwnedMemoryBudgetMb).toBe(256);
    expect(reloaded.providers.openai?.apiKey).toBe("sk-secret-value");
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
