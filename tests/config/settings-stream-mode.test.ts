/**
 * /api/settings streamMode surface (#314 WP1) + config persistence round-trip.
 *
 * streamMode is persisted in config.json (including the macOS explicit eager
 * opt-in; Windows services do not inherit shell env), degraded to "auto" with
 * a warning when the persisted value is invalid (must never trip loadConfig's
 * backup-and-defaults repair path), and settable alone via PUT (legacy
 * codexAutoStart-only PUTs keep working).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import { writeRuntimePort } from "../../src/config/process-state";
import { handleManagementAPI, type ManagementApiDeps } from "../../src/server/management-api";
import { invalidateStartupHealthCache } from "../../src/server/startup-health-cache";
import { USAGE_RANGES, USAGE_SURFACES } from "../../src/usage/summary";
import type { OcxConfig } from "../../src/types";
import {
  appOwnedBytesSnapshot,
  configureAppOwnedMemoryBudget,
  registerRetainedStore,
  resetAppOwnedMemoryForTests,
} from "../../src/lib/app-owned-memory";
import {
  evictOldestUsageSummaryForBudget,
  getUsageSummaryCacheEntry,
  resetUsageSummaryCacheForTests,
  setUsageSummaryCacheEntry,
  usageSummaryRetainedStoreSnapshot,
} from "../../src/server/management/usage-summary-cache";
import { resetUsageAggregateCacheForTests } from "../../src/server/management/usage-aggregate-cache";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { repoRoot } from "../helpers/repo-root";
import { MANAGED_AGENTS_TABLE_MARKER, MANAGED_SUBAGENT_DEFAULT_MARKER } from "../../src/codex/subagent-defaults";
import { startupHealthFixture } from "../helpers/startup-health";
import { removeTreeWithRetry } from "../helpers/remove-tree";

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

function putDesktopSwitchInIsolatedHome(
  codexHome: string,
  config: OcxConfig,
  body: Record<string, boolean>,
): { status: number; body: Record<string, unknown> } {
  const script = `
    const { writeRuntimePort } = await import("./src/config/process-state");
    const { handleManagementAPI } = await import("./src/server/management-api");
    const { catalogConvergenceFactory } = await import("./tests/helpers/catalog-convergence");
    const { startupHealthFixture } = await import("./tests/helpers/startup-health");
    const config = JSON.parse(process.env.OCX_TEST_ROUTE_CONFIG);
    const requestBody = JSON.parse(process.env.OCX_TEST_ROUTE_BODY);
    writeRuntimePort({ pid: process.pid, port: config.port });
    const request = new Request("http://127.0.0.1:10100/api/settings", {
      method: "PUT",
      // Same requirement as the in-process cases: managementRequestOrigin derives the
      // allowed origin from the Host header, and a constructed Request carries none, so
      // without this the handler is never reached and the response is a 403.
      headers: { host: "127.0.0.1:10100", "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const response = await handleManagementAPI(request, new URL(request.url), config, {
      saveConfigPreservingClaudeCode: () => {},
      getCachedStartupHealth: async () => startupHealthFixture(),
      createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
    });
    console.log(JSON.stringify({ status: response.status, body: await response.json() }));
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: repoRoot(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: join(TEST_DIR, "child-opencodex"),
      OCX_TEST_ROUTE_CONFIG: JSON.stringify(config),
      OCX_TEST_ROUTE_BODY: JSON.stringify(body),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (child.status !== 0) {
    throw new Error(`isolated settings route failed: ${child.stderr || child.stdout}`);
  }
  const line = child.stdout.trim().split("\n").filter(Boolean).at(-1);
  expect(line).toBeDefined();
  return JSON.parse(line!) as { status: number; body: Record<string, unknown> };
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

  test("separates stored and effective desktop state on an authenticated non-loopback bind", async () => {
    const body = await (await getSettings({
      ...baseConfig(),
      hostname: "192.168.1.20",
      codexDesktopAuthless: true,
      codexClientCompaction: true,
    }))!.json() as {
      codexDesktopAuthless?: boolean;
      codexClientCompaction?: boolean;
      codexDesktopSwitches?: unknown;
    };

    expect(body.codexDesktopAuthless).toBe(true);
    expect(body.codexClientCompaction).toBe(true);
    expect(body.codexDesktopSwitches).toEqual({
      codexDesktopAuthless: {
        stored: true,
        effective: false,
        inertReason: "non_loopback_bind_requires_admission_token",
      },
      codexClientCompaction: {
        stored: true,
        effective: false,
        inertReason: "non_loopback_bind_requires_admission_token",
      },
      apply: { applied: false, reason: "not_requested", retryable: false },
      authSource: {
        presentsCodexAccount: true,
        summary: "The Codex app will require its own account sign-in.",
      },
    });
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
      resolveCodexRuntimeAsync,
    } = await import("../../src/codex/runtime");
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
      removedEfforts: ["xhigh"],
      affectedModels: ["gpt-5.6-sol"],
    }, { configDir: TEST_DIR });

    const previousCli = process.env.CODEX_CLI_PATH;
    const previousPath = process.env.PATH;
    try {
      process.env.CODEX_CLI_PATH = fakeCodex;
      process.env.PATH = "";
      // Settings serve the runtime stale-while-revalidate; land the probe first so this
      // asserts the validated projection rather than the cold deferred answer.
      await resolveCodexRuntimeAsync();
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
        removedEfforts: ["xhigh"],
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

describe("settings codexRuntime snapshot", () => {
  /** A launcher whose `--version` takes ~2s, as a real Codex probe can under load. */
  function slowFakeCodex(version: string): string {
    mkdirSync(join(TEST_DIR, "slow-bin"), { recursive: true });
    if (process.platform === "win32") {
      const path = join(TEST_DIR, "slow-bin", "codex.cmd");
      writeFileSync(
        path,
        `@echo off\r\n"%SystemRoot%\\System32\\ping.exe" -n 3 127.0.0.1 >nul\r\necho codex-cli ${version}\r\n`,
        "utf8",
      );
      return path;
    }
    const path = join(TEST_DIR, "slow-bin", "codex");
    writeFileSync(path, `#!/bin/sh\nsleep 2\necho 'codex-cli ${version}'\n`, { encoding: "utf8", mode: 0o755 });
    return path;
  }

  async function withRuntimeEnv(command: string, run: () => Promise<void>): Promise<void> {
    const keys = ["CODEX_CLI_PATH", "PATH", "LOCALAPPDATA", "HOME"] as const;
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      process.env.CODEX_CLI_PATH = command;
      // No other codex on PATH or in the install roots: only the launcher above is probed.
      process.env.PATH = process.platform === "win32" ? "" : "/usr/bin:/bin";
      process.env.LOCALAPPDATA = join(TEST_DIR, "no-codex-app");
      process.env.HOME = join(TEST_DIR, "no-codex-home");
      await run();
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }

  test("GET answers without waiting on the runtime probe and serves it once it lands", async () => {
    const { resetCodexRuntimeResolveCacheForTests, resolveCodexRuntimeAsync } = await import("../../src/codex/runtime");
    resetCodexRuntimeResolveCacheForTests();
    const launcher = slowFakeCodex("0.200.0");
    try {
      await withRuntimeEnv(launcher, async () => {
        type Body = { codexRuntime: { version: string | null; source: string } };
        const coldStarted = performance.now();
        const cold = await (await getSettings(baseConfig()))!.json() as Body;
        // The sync resolver made this request take the whole ~2s probe.
        expect(performance.now() - coldStarted).toBeLessThan(1_000);
        expect(cold.codexRuntime).toMatchObject({ version: null, source: "environment" });

        // The refresh the GET started runs on async exec: timers keep firing meanwhile.
        const refresh = resolveCodexRuntimeAsync();
        const tickStarted = performance.now();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(performance.now() - tickStarted).toBeLessThan(250);
        expect((await refresh).runtime.version).toBe("0.200.0");

        const warmStarted = performance.now();
        const warm = await (await getSettings(baseConfig()))!.json() as Body;
        expect(performance.now() - warmStarted).toBeLessThan(1_000);
        expect(warm.codexRuntime).toMatchObject({ version: "0.200.0", source: "environment" });
      });
    } finally {
      resetCodexRuntimeResolveCacheForTests();
    }
  }, 30_000);

  test("an expired memo stays observable while its refresh runs, then gives way to the result", async () => {
    // Catalog gather and convergence read the memo through peek. With the refresh off the
    // event loop they can now read during it; an expired memo reported as unavailable there
    // sent gather to the persisted runtime and got convergence's candidate rejected.
    const {
      peekCodexRuntimeProcessCache,
      resetCodexRuntimeResolveCacheForTests,
      resolveCodexRuntimeAsync,
    } = await import("../../src/codex/runtime");
    resetCodexRuntimeResolveCacheForTests();
    const launcher = slowFakeCodex("0.200.0");
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      await withRuntimeEnv(launcher, async () => {
        await resolveCodexRuntimeAsync();
        const first = peekCodexRuntimeProcessCache();
        expect(first.kind).toBe("available");

        offset = 20_000;
        expect(peekCodexRuntimeProcessCache().kind).toBe("unavailable");

        const refresh = resolveCodexRuntimeAsync();
        const during = peekCodexRuntimeProcessCache();
        expect(during.kind).toBe("available");
        if (during.kind === "available" && first.kind === "available") {
          expect(during.valueIdentity).toBe(first.valueIdentity);
        }

        await refresh;
        const after = peekCodexRuntimeProcessCache();
        expect(after.kind).toBe("available");
        if (after.kind === "available" && first.kind === "available") {
          expect(after.valueIdentity).not.toBe(first.valueIdentity);
        }
      });
    } finally {
      clock.mockRestore();
      resetCodexRuntimeResolveCacheForTests();
    }
  }, 30_000);

  test("a runtime switch during the background probe keeps its result out of the memo", async () => {
    const {
      clearCodexRuntimeResolveCache,
      peekCodexRuntimeProcessCache,
      resetCodexRuntimeResolveCacheForTests,
      resolveCodexRuntimeAsync,
    } = await import("../../src/codex/runtime");
    resetCodexRuntimeResolveCacheForTests();
    const launcher = slowFakeCodex("0.200.0");
    try {
      await withRuntimeEnv(launcher, async () => {
        const refresh = resolveCodexRuntimeAsync();
        // persistCodexRuntime and clearPersistedCodexRuntime invalidate through this.
        clearCodexRuntimeResolveCache();
        expect((await refresh).runtime.version).toBe("0.200.0");
        expect(peekCodexRuntimeProcessCache().kind).toBe("unavailable");
      });
    } finally {
      resetCodexRuntimeResolveCacheForTests();
    }
  }, 30_000);

  test("a runtime file rewritten by another process during the probe keeps its result out of the memo", async () => {
    const {
      codexRuntimeStatePath,
      peekCodexRuntimeProcessCache,
      resetCodexRuntimeResolveCacheForTests,
      resolveCodexRuntimeAsync,
    } = await import("../../src/codex/runtime");
    resetCodexRuntimeResolveCacheForTests();
    const launcher = slowFakeCodex("0.200.0");
    try {
      await withRuntimeEnv(launcher, async () => {
        const refresh = resolveCodexRuntimeAsync();
        // No in-process persist, so no epoch bump: only the on-disk selection changes.
        writeFileSync(codexRuntimeStatePath(), JSON.stringify({
          version: 1, command: join(TEST_DIR, "other-codex"), source: "configured", updatedAt: new Date().toISOString(),
        }));
        expect((await refresh).runtime.version).toBe("0.200.0");
        expect(peekCodexRuntimeProcessCache().kind).toBe("unavailable");
      });
    } finally {
      rmSync(codexRuntimeStatePath(), { force: true });
      resetCodexRuntimeResolveCacheForTests();
    }
  }, 30_000);
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

  test("codexClientCompaction (#3978): absent reports false, changes converge once, and disable deletes the key", async () => {
    const config = baseConfig();
    const absent = await (await getSettings(config))!.json() as { codexClientCompaction?: boolean };
    expect(absent.codexClientCompaction).toBe(false);

    let convergences = 0;
    let saved: OcxConfig | undefined;
    const on = await putSettings(config, { codexClientCompaction: true }, {
      saveConfigPreservingClaudeCode: next => { saved = next; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });
    expect(on!.status).toBe(200);
    expect(await on!.json()).toMatchObject({ codexClientCompaction: true });
    expect(saved?.codexClientCompaction).toBe(true);
    expect(convergences).toBe(1);

    const same = await putSettings(config, { codexClientCompaction: true }, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });
    expect(same!.status).toBe(200);
    expect(convergences).toBe(1);

    const off = await putSettings(config, { codexClientCompaction: false }, {
      saveConfigPreservingClaudeCode: next => { saved = next; },
      createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences += 1; }),
    });
    expect(off!.status).toBe(200);
    expect(await off!.json()).toMatchObject({ codexClientCompaction: false });
    expect(Object.hasOwn(saved!, "codexClientCompaction")).toBe(false);
    expect(convergences).toBe(2);

    const bad = await putSettings(config, { codexClientCompaction: "yes" });
    expect(bad!.status).toBe(400);
  });

  test.each([
    {
      field: "codexDesktopAuthless" as const,
      expectedAuth: "requires_openai_auth = false",
      presentsCodexAccount: false,
      authSummary: "The Codex app will not require its own account sign-in.",
    },
    {
      field: "codexClientCompaction" as const,
      expectedAuth: "requires_openai_auth = true",
      presentsCodexAccount: true,
      authSummary: "The Codex app will require its own account sign-in.",
    },
  ])("$field rewrites the live Codex config before PUT returns", async ({
    field,
    expectedAuth,
    presentsCodexAccount,
    authSummary,
  }) => {
    const config = baseConfig();
    const codexHome = join(TEST_DIR, `codex-${field}`);
    mkdirSync(codexHome, { recursive: true });
    const codexConfigPath = join(codexHome, "config.toml");
    writeFileSync(codexConfigPath, 'model = "gpt-5.5"\n', "utf8");
    const response = putDesktopSwitchInIsolatedHome(codexHome, config, { [field]: true });

    expect(response.status).toBe(200);
    const body = response.body as {
      codexDesktopSwitches?: {
        codexDesktopAuthless?: { stored?: boolean; effective?: boolean };
        codexClientCompaction?: { stored?: boolean; effective?: boolean };
        apply?: unknown;
        authSource?: { presentsCodexAccount?: boolean; summary?: string };
      };
    };
    expect(body.codexDesktopSwitches?.apply).toEqual({ applied: true });
    expect(body.codexDesktopSwitches?.[field]).toEqual({ stored: true, effective: true });
    expect(body.codexDesktopSwitches?.authSource?.presentsCodexAccount).toBe(presentsCodexAccount);
    expect(body.codexDesktopSwitches?.authSource?.summary).toBe(authSummary);
    const injected = readFileSync(codexConfigPath, "utf8");
    expect(injected).toContain("[model_providers.opencodex]");
    expect(injected).toContain(expectedAuth);
  });

  test.each([
    {
      reason: "integration_disabled" as const,
      retryable: false,
      configPatch: { clientIntegrations: { codex: false } },
      live: true,
    },
    {
      reason: "proxy_not_running" as const,
      retryable: true,
      configPatch: {},
      live: false,
    },
  ])("reports an unapplied desktop switch as $reason with retryable=$retryable", async ({
    reason,
    retryable,
    configPatch,
    live,
  }) => {
    const config = { ...baseConfig(), ...configPatch } as OcxConfig;
    if (live) writeRuntimePort({ pid: process.pid, port: config.port });
    const response = await putSettings(config, { codexDesktopAuthless: true }, {
      saveConfigPreservingClaudeCode: () => {},
      createManagementConvergeCodex: catalogConvergenceFactory(() => {}),
    });

    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      codexDesktopAuthless: true,
      codexDesktopSwitches: {
        codexDesktopAuthless: { stored: true, effective: true },
        apply: { applied: false, reason, retryable },
        authSource: { presentsCodexAccount: false },
      },
    });
  });

  test("reports a non-retryable injection refusal without touching the ambient Codex home", () => {
    const codexHome = join(TEST_DIR, "codex-ambiguous-config");
    mkdirSync(codexHome, { recursive: true });
    // Ambiguous OpenCodex-managed sub-agent markers are a deterministic, non-retryable
    // injection refusal. (A missing config.toml no longer is: it is bootstrapped, below.)
    writeFileSync(join(codexHome, "config.toml"), [
      MANAGED_AGENTS_TABLE_MARKER, "[agents]", MANAGED_SUBAGENT_DEFAULT_MARKER, "", 'default_subagent_model = "gpt-5.6-sol"', "",
    ].join("\n"), "utf8");
    const response = putDesktopSwitchInIsolatedHome(
      codexHome,
      baseConfig(),
      { codexDesktopAuthless: true },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codexDesktopSwitches: {
        apply: {
          applied: false,
          reason: "injection_refused",
          retryable: false,
        },
      },
    });
  });

  test("applies the authless switch on a fresh Codex home without config.toml (#5422)", () => {
    const codexHome = join(TEST_DIR, "codex-missing-config");
    mkdirSync(codexHome, { recursive: true });
    const response = putDesktopSwitchInIsolatedHome(
      codexHome,
      baseConfig(),
      { codexDesktopAuthless: true },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ codexDesktopSwitches: { apply: { applied: true } } });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("opencodex");
  });

  test("a paginated Codex home still applies the switch while native history relabeling stands down", async () => {
    const config = baseConfig();
    const codexHome = join(TEST_DIR, "codex-paginated");
    mkdirSync(codexHome, { recursive: true });
    const configPath = join(codexHome, "config.toml");
    const rolloutPath = join(codexHome, "paginated.jsonl");
    const rollout = JSON.stringify({
      ordinal: 0,
      type: "session_meta",
      payload: {
        id: "paginated",
        history_mode: "paginated",
        model_provider: "opencodex",
      },
    }) + "\n";
    writeFileSync(configPath, [
      'model_provider = "opencodex"',
      "[model_providers.opencodex]",
      'name = "OpenCodex"',
      'base_url = "http://127.0.0.1:10100/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = true",
      "",
    ].join("\n"), "utf8");
    writeFileSync(rolloutPath, rollout, "utf8");
    const database = new Database(join(codexHome, "state_5.sqlite"));
    database.run("CREATE TABLE threads (id TEXT, rollout_path TEXT, model_provider TEXT, history_mode TEXT)");
    database.run("INSERT INTO threads VALUES ('paginated', ?, 'opencodex', 'paginated')", rolloutPath);
    database.close();
    const response = putDesktopSwitchInIsolatedHome(
      codexHome,
      config,
      { codexDesktopAuthless: true },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      codexDesktopSwitches: { apply: { applied: true } },
    });
    expect(readFileSync(configPath, "utf8")).toContain("requires_openai_auth = false");
    expect(readFileSync(rolloutPath, "utf8")).toBe(rollout);
    const verifier = new Database(join(codexHome, "state_5.sqlite"), { readonly: true });
    expect(verifier.query("SELECT model_provider FROM threads WHERE id = 'paginated'").get())
      .toEqual({ model_provider: "opencodex" });
    verifier.close();
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
import { ManagementRequest as Request } from "../helpers/management-auth";

describe("manual compaction settings", () => {
  test("saves, reloads, replaces effort, and clears without changing other settings", async () => {
    const config = baseConfig();
    config.effortCap = "high";
    const originalProviders = structuredClone(config.providers);
    expect((await (await getSettings(config))!.json()).compactionRouting).toBeNull();
    const setting = { model: "gateway/cheap", reasoningEffort: "low" };
    const response = await putSettings(config, { compactionRouting: setting });
    expect(response?.status).toBe(200);
    expect((await response!.json()).compactionRouting).toEqual(setting);
    expect(loadConfig().compactionRouting).toEqual(setting);
    expect((await (await getSettings(config))!.json()).compactionRouting).toEqual(setting);
    await putSettings(config, { compactionRouting: { model: "gateway/cheap" } });
    expect(loadConfig().compactionRouting).toEqual({ model: "gateway/cheap" });
    const automatic = { model: "gateway/cheap", triggers: ["manual", "auto"] };
    expect((await putSettings(config, { compactionRouting: automatic }))?.status).toBe(200);
    expect(loadConfig().compactionRouting).toEqual(automatic);
    await putSettings(config, { compactionRouting: null });
    expect(config.compactionRouting).toBeUndefined();
    expect(loadConfig().compactionRouting).toBeUndefined();
    expect(config.effortCap).toBe("high");
    expect(config.providers).toEqual(originalProviders);
    expect((await (await getSettings(config))!.json()).compactionRouting).toBeNull();
  });

  test("rejects malformed settings before any mutation", async () => {
    const config = baseConfig();
    config.compactionRouting = { model: "gateway/cheap", reasoningEffort: "low" };
    const before = structuredClone(config);
    for (const value of [false, [], {}, { model: " " }, { model: 2 }, { model: "m", reasoningEffort: "invalid" }, { model: "m", enabled: true },
      { model: "m", triggers: [] }, { model: "m", triggers: ["nope"] }, { model: "m", triggers: ["manual", "manual"] }, { model: "m", triggers: "manual" }]) {
      const response = await putSettings(config, { compactionRouting: value, streamMode: "eager-relay" });
      expect(response?.status).toBe(400);
      expect(config).toEqual(before);
    }
  });

  test("failed persistence restores the override and its deletion intent", async () => {
    const { projectConfigRebaseProvenance } = await import("../../src/config/rebase-provenance");
    const config = baseConfig();
    config.compactionRouting = { model: "gateway/cheap", reasoningEffort: "low" };
    const before = projectConfigRebaseProvenance(config);
    const deps = { saveConfigPreservingClaudeCode() { throw new Error("fixture save failure"); } };
    for (const value of [null, { model: "gateway/other" }]) {
      await expect(putSettings(config, { compactionRouting: value }, deps)).rejects.toThrow("fixture save failure");
      expect(projectConfigRebaseProvenance(config)).toEqual(before);
      expect(config.compactionRouting).toEqual({ model: "gateway/cheap", reasoningEffort: "low" });
    }
  });
});
