import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as scheduler from "../../src/codex/catalog-auto-refresh";
import { resetSiblingStartForTests } from "../../src/codex/sibling-start";
import * as convergence from "../../src/codex/management-convergence";
import * as processes from "../../src/codex/app-server-processes";
import { lastCatalogAutoRefreshOutcome, resetCatalogAutoRefreshStatusForTests } from "../../src/codex/catalog-refresh-status";
import { getConfigPath, getDefaultConfig } from "../../src/config";
import type { CatalogOnlyOutcome } from "../../src/codex/convergence-types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// The link slot (050): data-free, notified once per changed tick before the client delivery.
function outcome(changed: boolean): CatalogOnlyOutcome {
  return { kind: "catalog-only", changed,
    catalogRefresh: { status: "committed", changed, degraded: false, notices: [] } } as CatalogOnlyOutcome;
}
let root: string;
let previousHome: string | undefined;
let codexHome: IsolatedCodexHome;
let converge: () => Promise<CatalogOnlyOutcome>;
let spies: Array<{ mockRestore(): void }>;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-catalog-link-fanout-"));
  process.env.OPENCODEX_HOME = root;
  codexHome = installIsolatedCodexHome();
  scheduler.resetCatalogAutoRefreshForTests();
  scheduler.setCatalogAutoRefreshClientFanout(null);
  scheduler.setCatalogAutoRefreshLinkFanout(null);
  resetSiblingStartForTests();
  resetCatalogAutoRefreshStatusForTests();
  writeFileSync(getConfigPath(), JSON.stringify({ ...getDefaultConfig(),
    clientIntegrations: { codex: false }, catalogAutoRefresh: { enabled: true } }));
  converge = async () => outcome(true);
  spies = [
    spyOn(convergence, "createManagementConvergeCodex").mockImplementation(() => () => converge()),
    spyOn(processes, "collectCodexAppServerCatalogStateWithin")
      .mockResolvedValue({ state: "not_running", processes: [], catalogMtimeMs: null }),
    spyOn(console, "info").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  scheduler.setCatalogAutoRefreshClientFanout(null);
  scheduler.setCatalogAutoRefreshLinkFanout(null);
  scheduler.resetCatalogAutoRefreshForTests();
  resetCatalogAutoRefreshStatusForTests();
  for (const spy of spies.reverse()) spy.mockRestore();
  resetSiblingStartForTests();
  codexHome.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

test("a changed tick calls the link slot once, after recording and before the client delivery; an unchanged tick never", async () => {
  const order: string[] = [];
  scheduler.setCatalogAutoRefreshLinkFanout(() => { order.push("link"); expect(lastCatalogAutoRefreshOutcome()?.changed).toBe(true); });
  scheduler.setCatalogAutoRefreshClientFanout(async () => { order.push("client"); return [{ ok: true }]; });
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(order).toEqual(["link", "client"]);
  converge = async () => outcome(false);
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(order).toEqual(["link", "client"]);
});

test("a throwing link slot does not stop the client delivery", async () => {
  let clients = 0;
  scheduler.setCatalogAutoRefreshLinkFanout(() => { throw new Error("link scheduler failed"); });
  scheduler.setCatalogAutoRefreshClientFanout(async () => { clients++; return [{ ok: true }]; });
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(clients).toBe(1);
});

test("setCatalogAutoRefreshLinkFanout(null) removes the slot", async () => {
  let calls = 0;
  scheduler.setCatalogAutoRefreshLinkFanout(() => { calls++; });
  await scheduler.runCatalogAutoRefreshTickForTests();
  scheduler.setCatalogAutoRefreshLinkFanout(null);
  await scheduler.runCatalogAutoRefreshTickForTests();
  expect(calls).toBe(1);
});
