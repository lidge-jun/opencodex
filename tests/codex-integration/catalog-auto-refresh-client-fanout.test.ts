import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as scheduler from "../../src/codex/catalog-auto-refresh";
import { markSiblingStart, resetSiblingStartForTests } from "../../src/codex/sibling-start";
import * as convergence from "../../src/codex/management-convergence";
import * as processes from "../../src/codex/app-server-processes";
import * as runtime from "../../src/config/process-state";
import * as routes from "../../src/server/management/config-routes";
import { lastCatalogAutoRefreshOutcome, resetCatalogAutoRefreshStatusForTests } from "../../src/codex/catalog-refresh-status";
import { acquireServerBackgroundLifecycle, type ServerBackgroundLifecycleLease } from "../../src/server/background-lifecycle";
import { getConfigPath, getDefaultConfig, loadConfig } from "../../src/config";
import type { CatalogOnlyOutcome } from "../../src/codex/convergence-types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function outcome(changed: boolean): CatalogOnlyOutcome {
  return { kind: "catalog-only", changed,
    catalogRefresh: { status: "committed", changed, degraded: false, notices: [] } } as CatalogOnlyOutcome;
}
let root: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let converge: () => Promise<CatalogOnlyOutcome>;
let spies: Array<{ mockRestore(): void }>;
let leases: ServerBackgroundLifecycleLease[];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-catalog-fanout-"));
  process.env.OPENCODEX_HOME = root;
  codexHome = installIsolatedCodexHome();
  scheduler.resetCatalogAutoRefreshForTests();
  scheduler.setCatalogAutoRefreshClientFanout(null);
  resetSiblingStartForTests();
  resetCatalogAutoRefreshStatusForTests();
  // Explicit refresh with native Codex off avoids live runtime and entitlement discovery.
  writeFileSync(getConfigPath(), JSON.stringify({ ...getDefaultConfig(),
    clientIntegrations: { codex: false }, catalogAutoRefresh: { enabled: true } }));
  converge = async () => outcome(true);
  leases = [];
  spies = [
    spyOn(convergence, "createManagementConvergeCodex").mockImplementation(() => () => converge()),
    spyOn(processes, "collectCodexAppServerCatalogStateWithin")
      .mockResolvedValue({ state: "not_running", processes: [], catalogMtimeMs: null }),
    spyOn(console, "info").mockImplementation(() => {}),
  ];
});
afterEach(async () => {
  for (const lease of leases) await lease.release();
  scheduler.setCatalogAutoRefreshClientFanout(null);
  scheduler.resetCatalogAutoRefreshForTests();
  resetCatalogAutoRefreshStatusForTests();
  for (const spy of spies.reverse()) spy.mockRestore();
  resetSiblingStartForTests();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

test("changed outcomes are recorded before one client delivery; unchanged outcomes have none", async () => {
  let calls = 0;
  scheduler.setCatalogAutoRefreshClientFanout(async current => {
    calls++;
    expect(current()).toBe(true);
    expect(lastCatalogAutoRefreshOutcome()?.changed).toBe(true);
    return [{ ok: true }];
  });
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(calls).toBe(1);
  converge = async () => outcome(false);
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(calls).toBe(1);
});

test("failed results and rejection log only counts and a retry hint", async () => {
  const warnings: unknown[][] = [];
  spies.push(spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args); }));
  scheduler.setCatalogAutoRefreshClientFanout(async () => [
    { ok: false, reason: "/private/client/identifier" }, { ok: true }, { ok: false },
  ]);
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(warnings).toEqual([["[catalog-auto-refresh] 2 client integration(s) were not refreshed; ocx sync retries them"]]);
  scheduler.setCatalogAutoRefreshClientFanout(async () => { throw new Error("private secret path"); });
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(warnings[1]).toEqual(["[catalog-auto-refresh] client integrations were not refreshed; ocx sync retries them"]);
  expect(JSON.stringify(warnings)).not.toContain("private");
});

test("stop during converge prevents delivery", async () => {
  let enter!: () => void;
  let release!: (value: CatalogOnlyOutcome) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  converge = () => { enter(); return new Promise(resolve => { release = resolve; }); };
  let calls = 0;
  scheduler.setCatalogAutoRefreshClientFanout(async () => { calls++; return []; });
  const tick = scheduler.runCatalogAutoRefreshTickForTests();
  try { await entered; scheduler.stopCatalogAutoRefresh(); }
  finally { release(outcome(true)); await tick; }
  expect(calls).toBe(0);
});

test("stop during delivery invalidates the writer admission and suppresses stale warnings", async () => {
  let enter!: () => void;
  let release!: () => void;
  let current!: () => boolean;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  spies.push(warn);
  scheduler.setCatalogAutoRefreshClientFanout(async isCurrent => {
    current = isCurrent; enter(); await gate; return [{ ok: false }];
  });
  const tick = scheduler.runCatalogAutoRefreshTickForTests();
  try {
    await entered; expect(current()).toBe(true);
    scheduler.stopCatalogAutoRefresh(); expect(current()).toBe(false);
    scheduler.startCatalogAutoRefresh(); expect(current()).toBe(false);
  } finally { release(); await tick; }
  expect(warn).not.toHaveBeenCalled();
});

test("process leases register before scheduler start and clear only on last release", async () => {
  const registrations: Array<scheduler.CatalogChangedClientFanout | null> = [];
  const realSet = scheduler.setCatalogAutoRefreshClientFanout;
  spies.push(spyOn(scheduler, "setCatalogAutoRefreshClientFanout").mockImplementation(hook => {
    registrations.push(hook); realSet(hook);
  }));
  const realStart = scheduler.startCatalogAutoRefresh;
  spies.push(spyOn(scheduler, "startCatalogAutoRefresh").mockImplementation(() => {
    expect(typeof registrations.at(-1)).toBe("function"); realStart();
  }));
  const first = acquireServerBackgroundLifecycle(() => {}, loadConfig());
  const second = acquireServerBackgroundLifecycle(() => {}, loadConfig());
  leases.push(first, second);
  expect(registrations).toHaveLength(1);
  await first.release(); expect(registrations).toHaveLength(1);
  await second.release(); expect(registrations.at(-1)).toBeNull();
});

test("lifecycle hook uses current runtime port and skips missing runtime, stale generation and hub", async () => {
  let hook!: scheduler.CatalogChangedClientFanout;
  const realSet = scheduler.setCatalogAutoRefreshClientFanout;
  spies.push(spyOn(scheduler, "setCatalogAutoRefreshClientFanout").mockImplementation(value => {
    if (value) hook = value; realSet(value);
  }));
  const lease = acquireServerBackgroundLifecycle(() => {}, loadConfig()); leases.push(lease);
  const read = spyOn(runtime, "readRuntimePort").mockReturnValue(null); spies.push(read);
  const sync = spyOn(routes, "syncEnabledClientIntegrations").mockResolvedValue([]); spies.push(sync);
  expect(await hook(() => true)).toEqual([]); expect(sync).not.toHaveBeenCalled();
  read.mockReturnValue({ pid: process.pid, port: 12345 });
  expect(await hook(() => false)).toEqual([]); expect(sync).not.toHaveBeenCalled();
  writeFileSync(getConfigPath(), JSON.stringify({ ...loadConfig(), runtimeRole: "hub" }));
  expect(await hook(() => true)).toEqual([]); expect(sync).not.toHaveBeenCalled();
  writeFileSync(getConfigPath(), JSON.stringify({ ...loadConfig(), runtimeRole: "standalone" }));
  await hook(() => true); expect(sync.mock.calls[0]?.[0]).toBe(12345);
  read.mockReturnValue({ pid: process.pid, port: 12346 });
  await hook(() => true); expect(sync.mock.calls[1]?.[0]).toBe(12346);
  expect(sync.mock.calls[1]?.[3]?.unattended?.isCurrent()).toBe(true);
  markSiblingStart(12344);
  expect(await hook(() => true)).toEqual([]); expect(sync).toHaveBeenCalledTimes(2);
});

test("a loop startup failure clears its registered hook", () => {
  const registrations: Array<scheduler.CatalogChangedClientFanout | null> = [];
  const realSet = scheduler.setCatalogAutoRefreshClientFanout;
  spies.push(spyOn(scheduler, "setCatalogAutoRefreshClientFanout").mockImplementation(hook => {
    registrations.push(hook); realSet(hook);
  }));
  spies.push(spyOn(scheduler, "startCatalogAutoRefresh").mockImplementation(() => { throw new Error("start failure"); }));
  expect(() => acquireServerBackgroundLifecycle(() => {}, loadConfig())).toThrow("start failure");
  expect(typeof registrations[0]).toBe("function"); expect(registrations.at(-1)).toBeNull();
});


test("shutdown revokes delivery synchronously but another live owner keeps admission", async () => {
  let hook!: scheduler.CatalogChangedClientFanout;
  const realSet = scheduler.setCatalogAutoRefreshClientFanout;
  spies.push(spyOn(scheduler, "setCatalogAutoRefreshClientFanout").mockImplementation(value => {
    if (value) hook = value; realSet(value);
  }));
  const first = acquireServerBackgroundLifecycle(() => {}, loadConfig()); leases.push(first);
  spies.push(spyOn(runtime, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 12345 }));
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const sync = spyOn(routes, "syncEnabledClientIntegrations").mockImplementation(async (_port, _config, _deps, options) => {
    enter(); await gate; if (options?.unattended?.isCurrent()) writes++; return [];
  }); spies.push(sync);
  const flight = hook(() => true);
  try { await entered; first.revokeClientFanout(); }
  finally { release(); await flight; }
  expect(writes).toBe(0); sync.mockClear();
  expect(await hook(() => true)).toEqual([]); expect(sync).not.toHaveBeenCalled();
  const second = acquireServerBackgroundLifecycle(() => {}, loadConfig()); leases.push(second);
  await hook(() => true); expect(writes).toBe(1);
  second.revokeClientFanout(); sync.mockClear();
  expect(await hook(() => true)).toEqual([]); expect(sync).not.toHaveBeenCalled();
});


test("delivery binds the newest owner and cannot transfer authority mid-flight", async () => {
  let hook!: scheduler.CatalogChangedClientFanout;
  const realSet = scheduler.setCatalogAutoRefreshClientFanout;
  spies.push(spyOn(scheduler, "setCatalogAutoRefreshClientFanout").mockImplementation(value => {
    if (value) hook = value; realSet(value);
  }));
  const first = acquireServerBackgroundLifecycle(() => {}, loadConfig()); leases.push(first);
  const newest = acquireServerBackgroundLifecycle(() => {}, loadConfig()); leases.push(newest);
  spies.push(spyOn(runtime, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 12345 }));
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const sync = spyOn(routes, "syncEnabledClientIntegrations").mockImplementation(async (_port, _config, _deps, options) => {
    enter(); await gate; if (options?.unattended?.isCurrent()) writes++; return [];
  }); spies.push(sync);
  const flight = hook(() => true);
  try { await entered; newest.revokeClientFanout(); }
  finally { release(); await flight; }
  expect(writes).toBe(0);
  await hook(() => true); expect(writes).toBe(1);
});
