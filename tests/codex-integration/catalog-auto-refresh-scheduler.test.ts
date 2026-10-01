import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  catalogAutoRefreshIntervalForTests,
  catalogAutoRefreshTickCountForTests,
  isCatalogAutoRefreshRunning,
  resetCatalogAutoRefreshForTests,
  runCatalogAutoRefreshTickForTests,
  selectDriftHealCatalogPath,
  startCatalogAutoRefresh,
  stopCatalogAutoRefresh,
} from "../../src/codex/catalog-auto-refresh";
import { lastCatalogAutoRefreshOutcome, resetCatalogAutoRefreshStatusForTests } from "../../src/codex/catalog-refresh-status";
import type { CatalogOnlyOutcome } from "../../src/codex/convergence-types";
import * as bundled from "../../src/codex/catalog/bundled";
import * as entitlements from "../../src/codex/model-entitlements";
import * as appServerProcesses from "../../src/codex/app-server-processes";
import * as managementConvergence from "../../src/codex/management-convergence";
import { DEFAULT_CATALOG_PATH } from "../../src/codex/paths";
import {
  CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS,
  armDetachedConfigBaseline,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfigPreservingClaudeCode,
} from "../../src/config";
import type { OcxConfig } from "../../src/types";
import {
  installIsolatedCodexHome,
  type IsolatedCodexHome,
} from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const COMMITTED_CATALOG_ONLY = {
  kind: "catalog-only",
  changed: false,
  catalogRefresh: { status: "committed", changed: false, degraded: false, notices: [] },
} as CatalogOnlyOutcome;

let previousOpenCodexHome: string | undefined;
let openCodexHome = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;
let convergeFactoryCalls = 0;
let convergeImpl: (config: OcxConfig) => Promise<CatalogOnlyOutcome> = async () => COMMITTED_CATALOG_ONLY;
let sourceSpies: Array<{ mockRestore(): void }> = [];
let convergeSpy: { mockRestore(): void } | null = null;
let releaseHanging: ((outcome: CatalogOnlyOutcome) => void) | null = null;
let pendingTick: Promise<unknown> | null = null;

function writeCatalogAutoRefreshConfig(catalogAutoRefresh?: unknown): void {
  const config = {
    ...getDefaultConfig(),
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      },
    },
    ...(catalogAutoRefresh === undefined ? {} : { catalogAutoRefresh }),
  };
  writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
}

beforeEach(() => {
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  openCodexHome = mkdtempSync(join(tmpdir(), "ocx-catalog-auto-refresh-"));
  process.env.OPENCODEX_HOME = openCodexHome;
  isolatedCodexHome = installIsolatedCodexHome("ocx-catalog-auto-refresh-codex-");
  writeFileSync(DEFAULT_CATALOG_PATH, JSON.stringify({ models: [] }), "utf8");
  resetCatalogAutoRefreshForTests();
  resetCatalogAutoRefreshStatusForTests();
  sourceSpies = [
    spyOn(bundled, "loadBundledCodexCatalog").mockReturnValue(null),
    spyOn(entitlements, "ensureCodexEntitlementFreshness").mockResolvedValue(undefined),
    spyOn(entitlements, "discoverCodexNativeRoster").mockResolvedValue("unavailable"),
    spyOn(appServerProcesses, "listCodexAppServerProcesses").mockReturnValue([]),
    spyOn(appServerProcesses, "collectCodexAppServerCatalogStateWithin")
      .mockResolvedValue({ state: "not_running", processes: [], catalogMtimeMs: null }),
  ];
  convergeFactoryCalls = 0;
  convergeImpl = async () => COMMITTED_CATALOG_ONLY;
  releaseHanging = null;
  pendingTick = null;
  // The tick's only converge seam is a dynamic import of management-convergence.
  // Stub it so an enabled fixture cannot spend a live /models call or rewrite the catalog.
  convergeSpy = spyOn(managementConvergence, "createManagementConvergeCodex").mockImplementation((config) => {
    convergeFactoryCalls += 1;
    return () => convergeImpl(config);
  });
});

afterEach(async () => {
  releaseHanging?.(COMMITTED_CATALOG_ONLY);
  releaseHanging = null;
  if (pendingTick) {
    await pendingTick;
    pendingTick = null;
  }
  stopCatalogAutoRefresh();
  resetCatalogAutoRefreshForTests();
  resetCatalogAutoRefreshStatusForTests();
  for (const spy of sourceSpies) spy.mockRestore();
  sourceSpies = [];
  convergeSpy?.mockRestore();
  convergeSpy = null;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (openCodexHome) removeTreeWithRetry(openCodexHome);
  openCodexHome = "";
});

describe("catalog auto-refresh scheduler", () => {
  test("start is idempotent, clamps below the floor, unrefs the timer, and stop clears the cadence", () => {
    // A live 15-minute interval would keep a test process alive if it were ref'd, which is
    // the whole reason start unrefs. Spying setInterval is how the sweeper and update-job
    // tests prove that property without waiting out the floor.
    const timers: Array<{ delay: number; unrefCalls: number }> = [];
    const setSpy = spyOn(globalThis, "setInterval").mockImplementation(((
      _callback: () => void,
      delay?: number,
    ) => {
      const timer = {
        delay: delay ?? 0,
        unrefCalls: 0,
        unref() {
          this.unrefCalls += 1;
          return this;
        },
      };
      timers.push(timer);
      return timer;
    }) as typeof setInterval);
    const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    try {
      startCatalogAutoRefresh(60_000);
      startCatalogAutoRefresh(30 * 60_000);
      expect(isCatalogAutoRefreshRunning()).toBe(true);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.delay).toBe(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS);
      expect(timers[0]!.unrefCalls).toBe(1);
      expect(catalogAutoRefreshIntervalForTests()).toBe(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS);

      stopCatalogAutoRefresh();
      expect(isCatalogAutoRefreshRunning()).toBe(false);
      expect(catalogAutoRefreshIntervalForTests()).toBeNull();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("resetCatalogAutoRefreshForTests leaves no live timer", () => {
    startCatalogAutoRefresh(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS);
    expect(isCatalogAutoRefreshRunning()).toBe(true);
    resetCatalogAutoRefreshForTests();
    expect(isCatalogAutoRefreshRunning()).toBe(false);
    expect(catalogAutoRefreshIntervalForTests()).toBeNull();
    expect(catalogAutoRefreshTickCountForTests()).toBe(0);
  });

  test("the unref'd startup tick fires once, survives cadence changes, and stop cancels it", async () => {
    writeCatalogAutoRefreshConfig({ intervalMinutes: 30 });
    const delayed: Array<{ callback: () => unknown; unrefs: number }> = [];
    const original = globalThis.setTimeout;
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => unknown, delay?: number) => {
      if (delay !== 3 * 60_000) return original(callback, delay);
      const handle = { callback, unrefs: 0, unref() { this.unrefs += 1; return this; } };
      delayed.push(handle);
      return handle;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      startCatalogAutoRefresh();
      startCatalogAutoRefresh();
      expect(delayed).toHaveLength(1);
      expect(delayed[0]!.unrefs).toBe(1);
      await delayed[0]!.callback();
      expect(convergeFactoryCalls).toBe(1);
      expect(catalogAutoRefreshIntervalForTests()).toBe(30 * 60_000);
      expect(delayed).toHaveLength(1);
      stopCatalogAutoRefresh();
      startCatalogAutoRefresh();
      stopCatalogAutoRefresh();
      expect(clear).toHaveBeenCalledWith(delayed[1]);
      // Even an already queued callback loses publication authority after stop.
      await delayed[1]!.callback();
      expect(convergeFactoryCalls).toBe(1);
    } finally {
      stopCatalogAutoRefresh();
      set.mockRestore();
      clear.mockRestore();
    }
  });

  test.each(["none", "bundled", "roster", "discovery"])("sources settle before converge despite %s failure", async failure => {
    writeCatalogAutoRefreshConfig();
    const steps: string[] = [];
    spyOn(bundled, "loadBundledCodexCatalog").mockImplementation(() => {
      steps.push("bundled");
      if (failure === "bundled") throw new Error("private source failure");
      return null;
    });
    spyOn(entitlements, "ensureCodexEntitlementFreshness").mockImplementation(async (_config, options) => {
      steps.push("roster");
      expect(options?.waitMs).toBe(15_000);
      if (failure === "roster") throw new Error("private roster failure");
    });
    spyOn(entitlements, "discoverCodexNativeRoster").mockImplementation(async () => {
      steps.push("discovery");
      if (failure === "discovery") throw new Error("private discovery failure");
      return "recorded";
    });
    convergeImpl = async () => { steps.push("converge"); return COMMITTED_CATALOG_ONLY; };
    await runCatalogAutoRefreshTickForTests();
    expect(steps).toEqual(["bundled", "roster", "discovery", "converge"]);
    expect(lastCatalogAutoRefreshOutcome()?.disposition.status).toBe("committed");
  });

  test("stopping during source refresh prevents roster warm and convergence", async () => {
    writeCatalogAutoRefreshConfig();
    spyOn(bundled, "loadBundledCodexCatalog").mockImplementation(() => {
      stopCatalogAutoRefresh();
      return null;
    });
    await runCatalogAutoRefreshTickForTests();
    expect(entitlements.ensureCodexEntitlementFreshness).not.toHaveBeenCalled();
    expect(entitlements.discoverCodexNativeRoster).not.toHaveBeenCalled();
    expect(convergeFactoryCalls).toBe(0);
    expect(lastCatalogAutoRefreshOutcome()).toBeNull();
  });

  test("a roster wait that exceeds its bound still allows convergence", async () => {
    writeCatalogAutoRefreshConfig();
    let entered!: () => void;
    const rosterEntered = new Promise<void>(resolve => { entered = resolve; });
    spyOn(entitlements, "ensureCodexEntitlementFreshness").mockImplementation(() => {
      entered();
      return new Promise<void>(() => {});
    });
    const deadlines: Array<() => void> = [];
    const original = globalThis.setTimeout;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
      if (delay !== 15_000) return original(callback, delay);
      deadlines.push(callback);
      return { unref() { return this; } };
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    try {
      const pending = runCatalogAutoRefreshTickForTests();
      await rosterEntered;
      expect(deadlines).toHaveLength(2);
      deadlines[1]!();
      await pending;
      expect(convergeFactoryCalls).toBe(1);
    } finally {
      timeout.mockRestore();
      clear.mockRestore();
    }
  });

  test("a changed set records reloadRequired and logs one safe restart hint", async () => {
    writeCatalogAutoRefreshConfig();
    spyOn(appServerProcesses, "listCodexAppServerProcesses").mockReturnValue([{ pid: 123, commandLine: "private fixture" }]);
    spyOn(appServerProcesses, "collectCodexAppServerCatalogStateWithin").mockResolvedValue({
      state: "stale", processes: [{ pid: 123, startedAtMs: 1 }],
      catalogMtimeMs: 2,
    });
    convergeImpl = async () => ({
      kind: "catalog-only", changed: true,
      catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] },
    });
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      await runCatalogAutoRefreshTickForTests();
      expect(lastCatalogAutoRefreshOutcome()?.reloadRequired).toBe(true);
      expect(info.mock.calls).toEqual([[
        "[catalog-auto-refresh] served model set changed; running Codex sessions keep the old list until restarted (ocx sync --restart-codex)",
      ]]);
      convergeImpl = async () => COMMITTED_CATALOG_ONLY;
      await runCatalogAutoRefreshTickForTests();
      expect(lastCatalogAutoRefreshOutcome()?.reloadRequired).toBe(true);
      expect(info).toHaveBeenCalledTimes(1);
      spyOn(appServerProcesses, "collectCodexAppServerCatalogStateWithin").mockResolvedValue({
        state: "unknown", processes: [], catalogMtimeMs: null,
      });
      await runCatalogAutoRefreshTickForTests();
      expect(lastCatalogAutoRefreshOutcome()?.reloadRequired).toBe(true);
      spyOn(appServerProcesses, "collectCodexAppServerCatalogStateWithin").mockResolvedValue({
        state: "fresh", processes: [{ pid: 124, startedAtMs: 3 }],
        catalogMtimeMs: 2,
      });
      await runCatalogAutoRefreshTickForTests();
      expect(lastCatalogAutoRefreshOutcome()?.reloadRequired).toBe(false);
    } finally { info.mockRestore(); }
  });

  test("a tick with catalogAutoRefresh absent performs a converge", async () => {
    writeCatalogAutoRefreshConfig();
    await runCatalogAutoRefreshTickForTests();
    expect(catalogAutoRefreshTickCountForTests()).toBe(1);
    expect(convergeFactoryCalls).toBe(1);
    expect(lastCatalogAutoRefreshOutcome()?.disposition.status).toBe("committed");
  });

  test("explicit enabled:false performs no converge", async () => {
    writeCatalogAutoRefreshConfig({ enabled: false, intervalMinutes: 60 });
    await runCatalogAutoRefreshTickForTests();
    expect(catalogAutoRefreshTickCountForTests()).toBe(0);
    expect(convergeFactoryCalls).toBe(0);
    expect(bundled.loadBundledCodexCatalog).not.toHaveBeenCalled();
    expect(entitlements.ensureCodexEntitlementFreshness).not.toHaveBeenCalled();
    expect(lastCatalogAutoRefreshOutcome()).toBeNull();
  });

  test("a tick with intervalMinutes:0 stays dormant even when enabled", async () => {
    // 0 is configured-but-idle, not a missing interval: clamping it to the floor would
    // start the /models fan-out the operator declined.
    writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 0 });
    await runCatalogAutoRefreshTickForTests();
    expect(catalogAutoRefreshTickCountForTests()).toBe(0);
    expect(convergeFactoryCalls).toBe(0);
    expect(lastCatalogAutoRefreshOutcome()).toBeNull();
  });

  test("a tick preserves a config hand edit made while convergence is in flight", async () => {
    writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
    convergeImpl = async (config) => {
      const onDisk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      onDisk.catalogAutoRefresh = { enabled: false, intervalMinutes: 60 };
      writeFileSync(getConfigPath(), JSON.stringify(onDisk), "utf8");
      saveConfigPreservingClaudeCode(config);
      return COMMITTED_CATALOG_ONLY;
    };

    await runCatalogAutoRefreshTickForTests();

    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.catalogAutoRefresh?.enabled).toBe(false);
  });

  test("a tick preserves listener and newly added fields edited while convergence is in flight", async () => {
    // The general live-save policy leaves hostname/port and disk-only keys out of
    // the rebase. For the tick's detached snapshot those skips would discard the
    // hand edit wholesale, so arming it detached reconciles every field instead.
    writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
    convergeImpl = async (config) => {
      const onDisk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
      onDisk.port = 10101;
      onDisk.hostname = "127.0.0.2";
      onDisk.metricsExport = { enabled: true };
      writeFileSync(getConfigPath(), JSON.stringify(onDisk), "utf8");
      // The same save convergeCodexCatalog performs after mutating discovery fields.
      config.disabledModels = ["xai:grok-0"];
      saveConfigPreservingClaudeCode(config);
      return COMMITTED_CATALOG_ONLY;
    };

    await runCatalogAutoRefreshTickForTests();

    const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
    expect(persisted.port).toBe(10101);
    expect(persisted.hostname).toBe("127.0.0.2");
    expect(persisted.metricsExport?.enabled).toBe(true);
    expect(persisted.disabledModels).toEqual(["xai:grok-0"]);
  });

  test("an overlapping tick returns immediately without a second converge", async () => {
    writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });

    let release!: (outcome: CatalogOnlyOutcome) => void;
    const hanging = new Promise<CatalogOnlyOutcome>((resolve) => {
      release = resolve;
    });
    releaseHanging = release;
    let enteredFactory: () => void = () => {};
    const factoryEntered = new Promise<void>((resolve) => {
      enteredFactory = resolve;
    });
    convergeImpl = () => {
      enteredFactory();
      return hanging;
    };

    const first = runCatalogAutoRefreshTickForTests();
    pendingTick = first;
    await factoryEntered;
    const second = runCatalogAutoRefreshTickForTests();
    await second;

    // setInterval does not skip a firing while the previous callback is still awaiting;
    // the in-flight guard is what stops a slow /models call from stacking another.
    expect(convergeFactoryCalls).toBe(1);
    expect(catalogAutoRefreshTickCountForTests()).toBe(1);
    expect(lastCatalogAutoRefreshOutcome()).toBeNull();

    release(COMMITTED_CATALOG_ONLY);
    await first;
    expect(convergeFactoryCalls).toBe(1);
    expect(catalogAutoRefreshTickCountForTests()).toBe(1);
  });
});

describe("catalog auto-refresh drift heal", () => {
  test.each([
    ["Codex OFF", (config: OcxConfig) => { config.clientIntegrations = { ...config.clientIntegrations, codex: false }; }],
    ["picker order", (config: OcxConfig) => { config.codexAccountPriorities = { __main__: 5 }; }],
  ] as const)("real persisted config stays stable and a later %s edit blocks the client write", async (_label, edit) => {
    const drift = await import("../../src/codex/config-drift-heal");
    const desired = await import("../../src/codex/desired-state");
    const processState = await import("../../src/config/process-state");
    const inject = await import("../../src/codex/inject");
    const ownership = await import("../../src/integrations/native/ownership-preflight");
    writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
    const fixture = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
    fixture.apiKeys = [{ key: "fixture-key", name: "fixture", createdAt: "2026-01-01T00:00:00.000Z" }];
    // The load path assigns a stable id to this legacy row without writing config.json.
    (fixture.providers as Record<string, Record<string, unknown>>).xai!.modelCosts = {
      "grok-fixture": { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.5 },
    };
    writeFileSync(getConfigPath(), JSON.stringify(fixture), "utf8");
    const persistedBefore = readFileSync(getConfigPath(), "utf8");
    const firstLoad = loadConfig();
    const captured = JSON.stringify(firstLoad);
    armDetachedConfigBaseline(firstLoad);
    expect(JSON.stringify(firstLoad)).toBe(captured);
    expect(JSON.stringify(loadConfig())).toBe(captured);
    expect(readFileSync(getConfigPath(), "utf8")).toBe(persistedBefore);

    let editBeforeWrite = false;
    let injectorCalls = 0;
    let allowedWrites = 0;
    let refusedWrites = 0;
    const spies = [
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true),
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] }),
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43_210 } as never),
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({ ownership: "owned", reason: "fixture" }),
      spyOn(inject, "injectCodexConfig").mockImplementation((async (_port, _config, options) => {
        injectorCalls += 1;
        if (editBeforeWrite) {
          const onDisk = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
          edit(onDisk);
          writeFileSync(getConfigPath(), JSON.stringify(onDisk), "utf8");
        }
        try {
          options?.beforeClientWrite?.();
          allowedWrites += 1;
        } catch {
          refusedWrites += 1;
        }
        return { success: true, message: "fixture" };
      }) as typeof inject.injectCodexConfig),
    ];
    try {
      await runCatalogAutoRefreshTickForTests();
      expect(injectorCalls).toBe(1);
      expect(allowedWrites).toBe(1);
      expect(refusedWrites).toBe(0);
      editBeforeWrite = true;
      await runCatalogAutoRefreshTickForTests();
      expect(injectorCalls).toBe(2);
      expect(allowedWrites).toBe(1);
      expect(refusedWrites).toBe(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  // Mock the writer and drift observer: a test must never reach a real Codex home.
  async function runHealTick(afterInjectDrifted: boolean) {
    const drift = await import("../../src/codex/config-drift-heal");
    const observeDrift = drift.codexConfigDrift;
    const desired = await import("../../src/codex/desired-state");
    const processState = await import("../../src/config/process-state");
    const sync = await import("../../src/codex/sync");
    const inject = await import("../../src/codex/inject");
    const ownership = await import("../../src/integrations/native/ownership-preflight");
    const configPath = join(openCodexHome, "healed-config.toml");
    const injected: Array<{ port: number; lockTimeoutMs: number | undefined }> = [];
    const info: string[] = [];
    const spies = [
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true),
      spyOn(drift, "codexConfigDrift").mockImplementation(() => observeDrift(
        () => ({ injectedOpenaiBaseUrl: "http://127.0.0.1:43210/backend-api/codex" }),
        configPath,
      )),
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43_210 } as never),
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({ ownership: "owned", reason: "fixture" }),
      spyOn(sync, "syncModelsToCodex").mockImplementation((async () => { throw new Error("full sync must not run"); }) as never),
      spyOn(inject, "injectCodexConfig").mockImplementation((async (port, _config, options) => {
        options?.beforeClientWrite?.();
        injected.push({ port, lockTimeoutMs: options?.lockTimeoutMs });
        if (!afterInjectDrifted) writeFileSync(configPath, 'openai_base_url = "http://127.0.0.1:43210/backend-api/codex"\n');
        return { success: true, message: "fixture" };
      }) as typeof inject.injectCodexConfig),
      spyOn(console, "info").mockImplementation((...args: unknown[]) => { info.push(args.join(" ")); }),
    ];
    try {
      writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
      writeFileSync(configPath, 'model = "gpt-5"\n');
      await runCatalogAutoRefreshTickForTests();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    return { injected, info };
  }

  test("injects through the live runtime port with a one-second lock wait and reports observed keys", async () => {
    const healed = await runHealTick(false);
    expect(healed.injected).toEqual([{ port: 43_210, lockTimeoutMs: 1000 }]);
    expect(healed.info.some(line => line.includes("re-injected"))).toBe(true);
  });

  test("an injector that leaves the keys missing is not reported as a heal", async () => {
    const ceded = await runHealTick(true);
    expect(ceded.injected).toEqual([{ port: 43_210, lockTimeoutMs: 1000 }]);
    expect(ceded.info.some(line => line.includes("; re-injected"))).toBe(false);
    expect(ceded.info.some(line => line.includes("not re-injected this tick"))).toBe(true);
  });

  test("a foreign service home prevents the drift healer from reaching the injector", async () => {
    const drift = await import("../../src/codex/config-drift-heal");
    const desired = await import("../../src/codex/desired-state");
    const processState = await import("../../src/config/process-state");
    const ownership = await import("../../src/integrations/native/ownership-preflight");
    const inject = await import("../../src/codex/inject");
    const spies = [
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true),
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] }),
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43_210 } as never),
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({
        ownership: "foreign",
        reason: "fixture foreign install",
      }),
      spyOn(inject, "injectCodexConfig"),
      spyOn(console, "info").mockImplementation(() => {}),
    ];
    try {
      writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
      await runCatalogAutoRefreshTickForTests();
      expect(inject.injectCodexConfig).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test.each(["config", "generation"] as const)("admission refused on %s does not bypass the ownership veto on a foreign home", async (authority) => {
    const drift = await import("../../src/codex/config-drift-heal");
    const desired = await import("../../src/codex/desired-state");
    const processState = await import("../../src/config/process-state");
    const admission = await import("../../src/codex/admission");
    const ownership = await import("../../src/integrations/native/ownership-preflight");
    const inject = await import("../../src/codex/inject");
    // A write guard that derives veto from the admission result would pass here:
    // the refusal authority is not service-home. Ownership must veto on its own.
    const spies = [
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true),
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] }),
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43_210 } as never),
      spyOn(admission, "admitCodexWrite").mockReturnValue({
        kind: "refused",
        authority,
        message: "fixture refusal",
      }),
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({
        ownership: "foreign",
        reason: "fixture foreign install",
      }),
      spyOn(inject, "injectCodexConfig"),
      spyOn(console, "info").mockImplementation(() => {}),
    ];
    try {
      writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
      await runCatalogAutoRefreshTickForTests();
      expect(inject.injectCodexConfig).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("service-home ownership is rechecked at the injector write boundary", async () => {
    const drift = await import("../../src/codex/config-drift-heal");
    const desired = await import("../../src/codex/desired-state");
    const processState = await import("../../src/config/process-state");
    const ownership = await import("../../src/integrations/native/ownership-preflight");
    const inject = await import("../../src/codex/inject");
    const own = spyOn(ownership, "inspectNativeCodexOwnership")
      .mockReturnValueOnce({ ownership: "owned", reason: "fixture" })
      .mockReturnValue({ ownership: "foreign", reason: "fixture foreign install" });
    const injector = spyOn(inject, "injectCodexConfig").mockImplementation((async (_port, _config, options) => {
      options?.beforeClientWrite?.();
      return { success: true, message: "fixture" };
    }) as typeof inject.injectCodexConfig);
    const spies = [
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true),
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] }),
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43_210 } as never),
      own,
      injector,
      spyOn(console, "info").mockImplementation(() => {}),
    ];
    try {
      writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
      await runCatalogAutoRefreshTickForTests();
      expect(own).toHaveBeenCalledTimes(2);
      expect(injector).toHaveBeenCalledTimes(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test.each(["stop", "restart", "settings", "off"])("a deferred injector cannot write or log success after %s", async (change) => {
    const drift = await import("../../src/codex/config-drift-heal");
    const desired = await import("../../src/codex/desired-state");
    const processState = await import("../../src/config/process-state");
    const sync = await import("../../src/codex/sync");
    const inject = await import("../../src/codex/inject");
    const ownership = await import("../../src/integrations/native/ownership-preflight");
    let entered!: () => void;
    const enteredInjector = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    const info: string[] = [];
    const spies = [
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true),
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] }),
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43_210 } as never),
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({ ownership: "owned", reason: "fixture" }),
      spyOn(sync, "syncModelsToCodex").mockImplementation((async () => {
        entered();
        await released;
        writes += 1;
        return { ok: true } as never;
      }) as never),
      spyOn(inject, "injectCodexConfig").mockImplementation((async (_port, _config, options) => {
        entered();
        await released;
        try {
          options?.beforeClientWrite?.();
          writes += 1;
        } catch { /* stale tick refused at the write boundary */ }
        return { success: true, message: "fixture" };
      }) as typeof inject.injectCodexConfig),
      spyOn(console, "info").mockImplementation((...args: unknown[]) => { info.push(args.join(" ")); }),
    ];
    try {
      writeCatalogAutoRefreshConfig({ enabled: true, intervalMinutes: 60 });
      startCatalogAutoRefresh();
      const tick = runCatalogAutoRefreshTickForTests();
      await enteredInjector;
      if (change === "stop" || change === "restart") {
        stopCatalogAutoRefresh();
        if (change === "restart") startCatalogAutoRefresh();
      } else {
        const persisted = JSON.parse(readFileSync(getConfigPath(), "utf8")) as OcxConfig;
        if (change === "off") persisted.clientIntegrations = { ...persisted.clientIntegrations, codex: false };
        else persisted.injectionModel = "changed-while-healing";
        writeFileSync(getConfigPath(), JSON.stringify(persisted), "utf8");
      }
      release();
      await tick;
      expect(writes).toBe(0);
      expect(info.some(line => line.includes("re-injected"))).toBe(false);
    } finally {
      release();
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("a valid non-default journaled catalog survives a removed config path", () => {
    const journalPath = join(openCodexHome, "journal.json");
    const defaultPath = join(openCodexHome, "opencodex-catalog.json");
    const alternatePath = join(openCodexHome, "alternate-catalog.json");
    writeFileSync(defaultPath, JSON.stringify({ models: [] }));
    writeFileSync(alternatePath, JSON.stringify({ models: [{ slug: "alternate" }] }));
    writeFileSync(journalPath, JSON.stringify({ version: 1, injectedCatalogPath: "alternate-catalog.json" }));
    expect(selectDriftHealCatalogPath(journalPath, defaultPath, path => join(openCodexHome, path))).toBe(alternatePath);
  });

  test("the drift branch passes a journaled non-default catalog to the injector", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-heal-catalog-child-"));
    const home = join(root, "home");
    const ocx = join(root, "ocx");
    const codex = join(root, "codex");
    const tmp = join(root, "tmp");
    for (const directory of [home, ocx, codex, tmp]) mkdirSync(directory);
    const schedulerPath = fileURLToPath(new URL("../../src/codex/catalog-auto-refresh.ts", import.meta.url));
    const driftPath = fileURLToPath(new URL("../../src/codex/config-drift-heal.ts", import.meta.url));
    const desiredPath = fileURLToPath(new URL("../../src/codex/desired-state.ts", import.meta.url));
    const processStatePath = fileURLToPath(new URL("../../src/config/process-state.ts", import.meta.url));
    const syncPath = fileURLToPath(new URL("../../src/codex/sync.ts", import.meta.url));
    const injectPath = fileURLToPath(new URL("../../src/codex/inject.ts", import.meta.url));
    const configPath = fileURLToPath(new URL("../../src/config.ts", import.meta.url));
    const admissionPath = fileURLToPath(new URL("../../src/codex/admission.ts", import.meta.url));
    const ownershipPath = fileURLToPath(new URL("../../src/integrations/native/ownership-preflight.ts", import.meta.url));
    const script = `
      const { spyOn } = require("bun:test");
      const fs = require("node:fs");
      const path = require("node:path");
      const configModule = require(${JSON.stringify(configPath)});
      const sources = require(${JSON.stringify(fileURLToPath(new URL("../../src/codex/catalog-auto-refresh-sources.ts", import.meta.url)))});
      spyOn(sources, "refreshCatalogAutoRefreshSources").mockResolvedValue(undefined);
      const scheduler = require(${JSON.stringify(schedulerPath)});
      const drift = require(${JSON.stringify(driftPath)});
      const desired = require(${JSON.stringify(desiredPath)});
      const processState = require(${JSON.stringify(processStatePath)});
      const sync = require(${JSON.stringify(syncPath)});
      const inject = require(${JSON.stringify(injectPath)});
      const admission = require(${JSON.stringify(admissionPath)});
      const ownership = require(${JSON.stringify(ownershipPath)});
      const catalogPath = path.join(process.env.CODEX_HOME, "alternate-catalog.json");
      fs.writeFileSync(catalogPath, JSON.stringify({ models: [{ slug: "alternate" }] }));
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), 'model = "gpt-5"\\n');
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "opencodex-journal.json"), JSON.stringify({ version: 1, injectedCatalogPath: "alternate-catalog.json" }));
      fs.writeFileSync(configModule.getConfigPath(), JSON.stringify({ ...configModule.getDefaultConfig(), defaultProvider: "xai", providers: { xai: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" } }, catalogAutoRefresh: { enabled: true, intervalMinutes: 60 } }));
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true);
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] });
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43210 });
      spyOn(admission, "admitCodexWrite").mockReturnValue({ kind: "admitted" });
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({ ownership: "owned", reason: "fixture" });
      spyOn(sync, "syncModelsToCodex").mockImplementation(async () => { throw new Error("full sync called"); });
      let received = null;
      spyOn(inject, "injectCodexConfig").mockImplementation(async (_port, _config, options) => { received = options.catalogPath; options.beforeClientWrite(); return { success: true, message: "fixture" }; });
      spyOn(console, "info").mockImplementation(() => {});
      await scheduler.runCatalogAutoRefreshTickForTests();
      process.stdout.write(JSON.stringify({ received }));
    `;
    try {
      const result = spawnSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, OPENCODEX_HOME: ocx, CODEX_HOME: codex, TMPDIR: tmp },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ received: join(realpathSync.native(codex), "alternate-catalog.json") });
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("a missing catalog defers injection until catalog convergence creates one", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-heal-missing-catalog-"));
    const home = join(root, "home");
    const ocx = join(root, "ocx");
    const codex = join(root, "codex");
    const tmp = join(root, "tmp");
    for (const directory of [home, ocx, codex, tmp]) mkdirSync(directory);
    const source = (name: string) => fileURLToPath(new URL(`../../src/${name}`, import.meta.url));
    const script = `
      const { spyOn } = require("bun:test");
      const fs = require("node:fs");
      const path = require("node:path");
      const config = require(${JSON.stringify(source("config.ts"))});
      const sources = require(${JSON.stringify(fileURLToPath(new URL("../../src/codex/catalog-auto-refresh-sources.ts", import.meta.url)))});
      spyOn(sources, "refreshCatalogAutoRefreshSources").mockResolvedValue(undefined);
      const scheduler = require(${JSON.stringify(source("codex/catalog-auto-refresh.ts"))});
      const drift = require(${JSON.stringify(source("codex/config-drift-heal.ts"))});
      const desired = require(${JSON.stringify(source("codex/desired-state.ts"))});
      const processState = require(${JSON.stringify(source("config/process-state.ts"))});
      const inject = require(${JSON.stringify(source("codex/inject.ts"))});
      const management = require(${JSON.stringify(source("codex/management-convergence.ts"))});
      const admission = require(${JSON.stringify(source("codex/admission.ts"))});
      const ownership = require(${JSON.stringify(source("integrations/native/ownership-preflight.ts"))});
      const catalog = path.join(process.env.CODEX_HOME, "opencodex-catalog.json");
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "config.toml"), 'model = "gpt-5"\\n');
      fs.writeFileSync(config.getConfigPath(), JSON.stringify({ ...config.getDefaultConfig(), defaultProvider: "xai", providers: { xai: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" } }, catalogAutoRefresh: { enabled: true, intervalMinutes: 60 } }));
      spyOn(desired, "shouldSyncCodexOnStart").mockReturnValue(true);
      spyOn(drift, "codexConfigDrift").mockReturnValue({ drifted: true, missingKeys: ["openai_base_url"] });
      spyOn(processState, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 43210 });
      spyOn(admission, "admitCodexWrite").mockReturnValue({ kind: "admitted" });
      spyOn(ownership, "inspectNativeCodexOwnership").mockReturnValue({ ownership: "owned", reason: "fixture" });
      const received = [];
      spyOn(inject, "injectCodexConfig").mockImplementation(async (_port, _config, options) => { received.push(options.catalogPath); return { success: true, message: "fixture" }; });
      let converges = 0;
      spyOn(management, "createManagementConvergeCodex").mockImplementation(() => async () => {
        if (++converges === 1) fs.writeFileSync(catalog, JSON.stringify({ models: [] }));
        return { kind: "catalog-only", changed: false, catalogRefresh: { status: "committed", changed: false, degraded: false, notices: [] } };
      });
      const info = [];
      spyOn(console, "info").mockImplementation((message) => info.push(message));
      await scheduler.runCatalogAutoRefreshTickForTests();
      const first = { received: [...received], converges, catalogExists: fs.existsSync(catalog),
        rootsStillMissing: !fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8").includes("openai_base_url"),
        deferred: info.some(line => line.includes("not re-injected this tick")) };
      await scheduler.runCatalogAutoRefreshTickForTests();
      process.stdout.write(JSON.stringify({ first, received, converges }));
    `;
    try {
      const result = spawnSync(process.execPath, ["--eval", script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home, OPENCODEX_HOME: ocx, CODEX_HOME: codex, TMPDIR: tmp },
        encoding: "utf8", timeout: 20_000,
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        first: { received: [], converges: 1, catalogExists: true, rootsStillMissing: true, deferred: true },
        received: [join(realpathSync.native(codex), "opencodex-catalog.json")],
        converges: 2,
      });
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("invalid journal bytes and unsafe catalogs are read without mutation", () => {
    const journalPath = join(openCodexHome, "journal.json");
    const defaultPath = join(openCodexHome, "opencodex-catalog.json");
    writeFileSync(defaultPath, JSON.stringify({ models: [] }));
    writeFileSync(journalPath, "{invalid journal bytes");
    expect(selectDriftHealCatalogPath(journalPath, defaultPath, path => join(openCodexHome, path))).toBe(defaultPath);
    expect(readFileSync(journalPath, "utf8")).toBe("{invalid journal bytes");
    writeFileSync(journalPath, JSON.stringify({ version: 1, injectedCatalogPath: "linked.json" }));
    symlinkSync(defaultPath, join(openCodexHome, "linked.json"));
    expect(selectDriftHealCatalogPath(journalPath, defaultPath, path => join(openCodexHome, path))).toBe(defaultPath);
    writeFileSync(defaultPath, "not a catalog");
    expect(selectDriftHealCatalogPath(journalPath, defaultPath, path => join(openCodexHome, path))).toBeNull();
  });
});

describe("catalog auto-refresh without a managed Codex client", () => {
  function writeIntegrationOffConfig(catalogAutoRefresh?: unknown): void {
    const config = {
      ...getDefaultConfig(),
      defaultProvider: "xai",
      providers: { xai: { adapter: "openai-responses", baseUrl: "https://api.x.ai/v1" } },
      clientIntegrations: { codex: false },
      ...(catalogAutoRefresh === undefined ? {} : { catalogAutoRefresh }),
    };
    writeFileSync(getConfigPath(), JSON.stringify(config), "utf8");
  }

  test("an absent section stays dormant: no Codex sources and no converge", async () => {
    writeIntegrationOffConfig();
    await runCatalogAutoRefreshTickForTests();
    expect(convergeFactoryCalls).toBe(0);
    expect(bundled.loadBundledCodexCatalog).not.toHaveBeenCalled();
    expect(entitlements.ensureCodexEntitlementFreshness).not.toHaveBeenCalled();
    expect(entitlements.discoverCodexNativeRoster).not.toHaveBeenCalled();
    expect(catalogAutoRefreshTickCountForTests()).toBe(0);
  });

  test("an explicit enabled:true still converges but never reads Codex sources", async () => {
    writeIntegrationOffConfig({ enabled: true, intervalMinutes: 60 });
    await runCatalogAutoRefreshTickForTests();
    expect(convergeFactoryCalls).toBe(1);
    expect(bundled.loadBundledCodexCatalog).not.toHaveBeenCalled();
    expect(entitlements.ensureCodexEntitlementFreshness).not.toHaveBeenCalled();
    expect(entitlements.discoverCodexNativeRoster).not.toHaveBeenCalled();
  });
});
