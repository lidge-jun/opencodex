import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as paths from "../../src/config/paths";
import { hardenExistingSecret, loadConfig } from "../../src/config";
import * as rows from "../../src/server/management/model-rows";
import * as switches from "../../src/codex/desktop-switches";
import * as codexSync from "../../src/codex/sync";
import * as configStore from "../../src/config";
import { handleConfigRoutes, syncEnabledClientIntegrations } from "../../src/server/management/config-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { applyIntegration, refreshIntegrationCoordinated } from "../../src/integrations/writer";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { resetHardenedStateForTests, setPlatformForTests, setIcaclsRunnerForTests, setAsyncIcaclsRunnerForTests,
  setAsyncIcaclsBeltSchedulerForTests, setNowForTests, windowsSecretAclReapPendingForPath,
  type IcaclsResult } from "../../src/lib/windows-secret-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const success: IcaclsResult = { success: true, exitCode: 0, timedOut: false, stdout: "" };
const keys = ["OPENCODEX_HOME", "HERMES_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", "OPENCODEX_ACL_TIMEOUT_MS", "OPENCODEX_ACL_VERIFY_EXISTING"];
const initial = [{ namespaced: "mock/one", provider: "mock", id: "one" }];
const grown = [...initial, { namespaced: "mock/two", provider: "mock", id: "two" }];
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
let fixture: string, root: string, home: string, config: OcxConfig;
let previous: Array<string | undefined>;
let restores: Array<() => void>;
let releases: Array<() => void>;
beforeEach(async () => {
  fixture = mkdtempSync(join(tmpdir(), "ocx-catalog-admission-"));
  root = join(fixture, "ocx"); home = join(fixture, "hermes");
  previous = keys.map(key => process.env[key]); restores = []; releases = [];
  process.env.OPENCODEX_HOME = root; process.env.HERMES_HOME = home;
  process.env.CODEX_HOME = join(fixture, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(fixture, "claude");
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(fixture, "desktop");
  process.env.OPENCODEX_ACL_TIMEOUT_MS = "1000";
  delete process.env.OPENCODEX_ACL_VERIFY_EXISTING;
  for (const dir of [root, home, process.env.CODEX_HOME]) mkdirSync(dir, { recursive: true });
  resetHardenedStateForTests(); setPlatformForTests("win32");
  setSyntheticWindowsPrincipalForTests("*S-1-5-21-1-2-3-1001");
  setIcaclsRunnerForTests(() => success); setAsyncIcaclsRunnerForTests(async () => success);
  config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1", allowPrivateNetwork: true } },
    clientIntegrations: { "claude-desktop": false, grok: false } };
  writeFileSync(join(root, "config.json"), JSON.stringify(config));
  writeFileSync(join(home, "config.yaml"), "providers: {}\n");
  expect(applyIntegration({ clientId: "hermes", config, models: initial, port: 10100 }).ok).toBe(true);
  await paths.flushConfigDirHardeningAndReaps(root);
  config = loadConfig();
  await paths.flushConfigDirHardeningAndReaps(root);
  resetHardenedStateForTests();
  // Warm the independent read-path file hardener; only the parent flight is cold in this probe.
  hardenExistingSecret(join(root, "config.json"));
  const models = spyOn(rows, "loadExportModels").mockResolvedValue(grown);
  restores.push(() => models.mockRestore());
});
afterEach(async () => {
  for (const release of releases) release();
  await paths.flushConfigDirHardeningAndReaps(root);
  for (const restore of restores.reverse()) restore();
  setAsyncIcaclsBeltSchedulerForTests(null); setNowForTests(null);
  setAsyncIcaclsRunnerForTests(null); setIcaclsRunnerForTests(null); setPlatformForTests(null);
  setSyntheticWindowsPrincipalForTests(null); resetHardenedStateForTests();
  keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  });
  removeTreeWithRetry(fixture);
});
function publication() {
  const store = createIntegrationStateStore();
  return { client: readFileSync(join(home, "config.yaml"), "utf8"),
    files: readdirSync(store.root, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile()).map(entry => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(store.root.length), readFileSync(path).toString("base64")];
      }).sort((a, b) => a[0]!.localeCompare(b[0]!)) };
}
function clock() {
  let now = 0;
  const timers = new Map<() => void, number>();
  setNowForTests(() => now);
  setAsyncIcaclsBeltSchedulerForTests((callback, milliseconds) => {
    timers.set(callback, now + milliseconds); return () => { timers.delete(callback); };
  });
  return { advance(milliseconds: number) {
    now += milliseconds;
    for (const [callback, deadline] of timers) if (deadline <= now) { timers.delete(callback); callback(); }
  } };
}
function holdParent() {
  const entered = deferred(), release = deferred(), reached = deferred();
  let held = true;
  const descendants: string[] = [];
  setAsyncIcaclsRunnerForTests(async () => { entered.resolve(); await release.promise; return success; });
  setIcaclsRunnerForTests(args => {
    if (held && args[0]?.startsWith(root + sep)) descendants.push(args[0]);
    return success;
  });
  const barrier = paths.withConfigDirHardeningSettled;
  const entry = spyOn(paths, "withConfigDirHardeningSettled").mockImplementation(<T>(dir: string, mutate: () => T) => {
    const work = barrier(dir, mutate); reached.resolve(); return work;
  });
  restores.push(() => entry.mockRestore());
  const finish = () => { held = false; release.resolve(); };
  releases.push(finish);
  paths.hardenConfigDir();
  return { entered: entered.promise, reached: reached.promise, arrive: reached.resolve, descendants, release: finish };
}

test.each([false, true])("Hermes refresh waits without publishing: unattended=%s", async unattended => {
  clock();
  const before = publication(), parent = holdParent();
  await parent.entered;
  let completed = false;
  const work = syncEnabledClientIntegrations(10100, config, {}, unattended ? { unattended: { isCurrent: () => true } } : {});
  void work.then(() => { completed = true; parent.arrive(); });
  try {
    await parent.reached; await turn();
    expect(parent.descendants).toEqual([]);
    expect(publication()).toEqual(before);
    expect(completed).toBe(false);
  } finally { parent.release(); }
  expect(await work).toEqual([{ client: "hermes", ok: true, changed: true }]);
  expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain("mock/two");
  expect(createIntegrationStateStore().listOperations("hermes")).toHaveLength(2);
});

test.each([false, true])("Hermes timeout refuses publication and retains parent ownership: unattended=%s", async unattended => {
  const before = publication(), time = clock(), parent = holdParent();
  await parent.entered;
  const work = syncEnabledClientIntegrations(10100, config, {}, unattended ? { unattended: { isCurrent: () => true } } : {});
  void work.then(parent.arrive);
  await parent.reached; await turn(); time.advance(1000); await turn();
  const outcomes = await work;
  expect(outcomes).toMatchObject([{ client: "hermes", ok: false, reason: "ca_unavailable", diagnostic: { stage: "ca", cause: "ETIMEDOUT" } }]);
  expect(parent.descendants).toEqual([]);
  expect(publication()).toEqual(before);
  expect(JSON.stringify(outcomes)).not.toContain(fixture);
  time.advance(100_000); await paths.flushConfigDirHardening(root);
  expect(windowsSecretAclReapPendingForPath(root)).toBe(true);
  const retained = syncEnabledClientIntegrations(10100, config, {}, unattended ? { unattended: { isCurrent: () => true } } : {});
  await turn(); time.advance(1000); await turn();
  expect(await retained).toMatchObject([{ client: "hermes", ok: false, reason: "ca_unavailable" }]);
  expect(publication()).toEqual(before);
  expect(parent.descendants).toEqual([]);
  parent.release(); await paths.flushConfigDirHardeningAndReaps(root);
  expect(await syncEnabledClientIntegrations(10100, config)).toEqual([{ client: "hermes", ok: true, changed: true }]);
});

test("unattended guard runs again after ACL admission", async () => {
  clock();
  const before = publication(), parent = holdParent();
  await parent.entered;
  let current = true;
  const work = syncEnabledClientIntegrations(10100, config, {}, { unattended: { isCurrent: () => current } });
  void work.then(parent.arrive);
  await parent.reached; await turn(); current = false; parent.release();
  expect(await work).toMatchObject([{ client: "hermes", ok: false, refusalReason: "superseded_store" }]);
  expect(publication()).toEqual(before);
});

test.each(["hermes", "mcode"] as const)("admission follows the final revalidation and writer lock: %s", async clientId => {
  clock();
  const configPath = join(home, clientId === "hermes" ? "config.yaml" : "mcode.yaml");
  if (clientId !== "hermes") writeFileSync(configPath, "{}\n");
  const input = { clientId, config, models: initial, port: 10100,
    resolvedPaths: { configPath, detectDir: home } };
  expect(applyIntegration(input).ok).toBe(true);
  await paths.flushConfigDirHardeningAndReaps(root);
  resetHardenedStateForTests();
  const before = publication(), clientBefore = readFileSync(configPath, "utf8"), discovered = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  const work = refreshIntegrationCoordinated({ ...input, models: grown }, {
    settleConfigRoot: true,
    revalidate: async () => {
      parent = holdParent(); await parent.entered; discovered.resolve(); return null;
    },
  });
  await discovered.promise;
  if (!parent) throw new Error("Revalidation did not start");
  void work.then(parent.arrive);
  try {
    await parent.reached; await turn();
    expect(parent.descendants).toEqual([]);
    expect(publication()).toEqual(before);
    expect(readFileSync(configPath, "utf8")).toBe(clientBefore);
  } finally { parent.release(); }
  expect(await work).toMatchObject({ ok: true, changed: true });
  expect(readFileSync(configPath, "utf8")).toContain("mock/two");
});

test("Aside profile and peer refresh timeouts are sanitized and publish nothing", async () => {
  const asidePath = join(home, ".aside", "u", "0", "models.json");
  mkdirSync(join(asidePath, ".."), { recursive: true });
  writeFileSync(asidePath, "{}\n");
  writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({ currentAccountId: 0, accounts: [{ id: 0 }] }));
  config.asideProfileSync = { allProfiles: true };
  expect(applyIntegration({ clientId: "aside", config, models: initial, port: 10100, env: {}, home }).ok).toBe(true);
  await paths.flushConfigDirHardeningAndReaps(root); resetHardenedStateForTests();
  const before = publication(), asideBefore = readFileSync(asidePath, "utf8"), time = clock(), parent = holdParent();
  await parent.entered;
  const work = refreshOwnedCatalogIntegrations({ config, models: async () => grown, port: 10100, home,
    env: { HERMES_HOME: home } }, ["aside", "hermes"]);
  void work.then(parent.arrive);
  await parent.reached; await turn(); time.advance(1000); await turn();
  // Each profile/client owns its existing admission budget; observe the second entry explicitly.
  await turn(); time.advance(1000); await turn();
  expect(await work).toEqual([
    { client: "aside", profileId: 0, ok: false, reason: "ca_unavailable", diagnostic: { stage: "ca", cause: "ETIMEDOUT" } },
    { client: "hermes", ok: false, reason: "ca_unavailable", diagnostic: { stage: "ca", cause: "ETIMEDOUT" } },
  ]);
  expect(parent.descendants).toEqual([]);
  expect(publication()).toEqual(before);
  expect(readFileSync(asidePath, "utf8")).toBe(asideBefore);
});

test.each(["settings", "sync"] as const)("%s committed before Hermes timeout is reported as partial", async surface => {
  const before = publication(), time = clock();
  const discovered = deferred();
  let parent: ReturnType<typeof holdParent> | undefined;
  const models = spyOn(rows, "loadExportModels").mockImplementation(async () => {
    await paths.flushConfigDirHardeningAndReaps(root); resetHardenedStateForTests();
    hardenExistingSecret(join(root, "config.json"));
    parent = holdParent(); await parent.entered; discovered.resolve(); return grown;
  });
  restores.push(() => models.mockRestore());
  const observed = spyOn(switches, "observedCodexDesktopSwitchApply").mockResolvedValue({ applied: false, retryable: false, reason: "not_requested" });
  restores.push(() => observed.mockRestore());
  const runtime = spyOn(configStore, "readRuntimePort").mockReturnValue({ pid: process.pid, port: 10100 });
  restores.push(() => runtime.mockRestore());
  const catalogPath = join(root, "committed-catalog.json");
  const sync = spyOn(codexSync, "syncModelsToCodex").mockImplementation(async () => {
    writeFileSync(catalogPath, "committed");
    return { status: "applied", ok: true, added: 2, catalogPath, catalogExists: true,
      catalogWritten: true, configChanged: true, cacheSynced: true, message: "Synced" };
  });
  restores.push(() => sync.mockRestore());
  const url = new URL(`http://127.0.0.1:10100/api/${surface}`);
  const work = handleConfigRoutes({ config, url,
    req: new Request(url, { method: surface === "settings" ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fastRows: false }) }),
    deps: { readRuntimePort: () => ({ port: 10100 }), getCachedStartupHealth: async () => ({}) },
    convergeCodexCatalog: async () => ({}), syncClaudeAgentDefsBestEffort: async () => {},
  } as unknown as ManagementContext);
  void work.then(discovered.resolve);
  // Discovery is the final unrelated await and starts the parent only after settings commit.
  await discovered.promise;
  if (!parent) throw new Error("Hermes discovery did not start");
  void work.then(parent.arrive);
  await parent.reached; await turn(); time.advance(1000); await turn();
  const response = await work;
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({ ok: true, partial: true, ...(surface === "settings"
    ? { fastRows: false } : { status: "applied", catalogWritten: true, configChanged: true, cacheSynced: true }),
    integrations: [{ client: "hermes", ok: false, reason: "ca_unavailable", diagnostic: { stage: "ca", cause: "ETIMEDOUT" } }] });
  if (surface === "settings") {
    expect(config.fastRows).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "config.json"), "utf8")).fastRows).toBe(false);
  } else expect(readFileSync(catalogPath, "utf8")).toBe("committed");
  expect(publication()).toEqual(before);
  expect(parent.descendants).toEqual([]);
});
