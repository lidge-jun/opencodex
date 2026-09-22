import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogAutoRefreshIntervalForTests,
  catalogAutoRefreshTickCountForTests,
  isCatalogAutoRefreshRunning,
  resetCatalogAutoRefreshForTests,
  runCatalogAutoRefreshTickForTests,
  startCatalogAutoRefresh,
  stopCatalogAutoRefresh,
} from "../../src/codex/catalog-auto-refresh";
import { lastCatalogAutoRefreshOutcome, resetCatalogAutoRefreshStatusForTests } from "../../src/codex/catalog-refresh-status";
import type { CatalogOnlyOutcome } from "../../src/codex/convergence-types";
import * as managementConvergence from "../../src/codex/management-convergence";
import {
  CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS,
  getConfigPath,
  getDefaultConfig,
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
  resetCatalogAutoRefreshForTests();
  resetCatalogAutoRefreshStatusForTests();
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

  test("a tick with catalogAutoRefresh absent or enabled:false performs no converge", async () => {
    writeCatalogAutoRefreshConfig();
    await runCatalogAutoRefreshTickForTests();
    expect(catalogAutoRefreshTickCountForTests()).toBe(0);
    expect(convergeFactoryCalls).toBe(0);
    expect(lastCatalogAutoRefreshOutcome()).toBeNull();

    writeCatalogAutoRefreshConfig({ enabled: false, intervalMinutes: 60 });
    await runCatalogAutoRefreshTickForTests();
    expect(catalogAutoRefreshTickCountForTests()).toBe(0);
    expect(convergeFactoryCalls).toBe(0);
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
