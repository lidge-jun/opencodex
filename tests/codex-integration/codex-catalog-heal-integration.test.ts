import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armDetachedConfigBaseline, loadConfig, saveConfig } from "../../src/config";
import { captureCatalogAdmissionSnapshot, createCatalogConvergeRequest } from "../../src/codex/catalog-admission";
import { clearGatherRoutedModelsInflight, resetCatalogRuntimeStateForTests } from "../../src/codex/catalog";
import { setBundledCatalogCacheForTests } from "../../src/codex/catalog/bundled";
import { catalogBackupPathFor, legacyCatalogBackupPath } from "../../src/codex/catalog/parsing";
import { restoreCodexCatalog } from "../../src/codex/catalog/restore";
import { subscribeCatalogPublication, type CatalogPublicationEvent } from "../../src/codex/catalog/publication-observer";
import { withCatalogWriteSerialization, type CatalogWriteIntent, type CatalogWritePermit } from "../../src/codex/catalog-write-serialization";
import { commitCodexCatalogCandidate, gatherCodexCatalogCandidate } from "../../src/codex/convergence";
import { replaceActiveCodexCatalog, replaceCodexModelsCache } from "../../src/codex/internal/catalog-writer";
import { restoreNativeCodex, restoreNativeCodexAsync } from "../../src/codex/inject/restore";
import { createManagementConvergeCodex } from "../../src/codex/management-convergence";
import { clearModelCache } from "../../src/codex/model-cache";
import { resetCodexModelEntitlementCacheForTests } from "../../src/codex/model-entitlements";
import { resetCodexRuntimeResolveCacheForTests, setCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { resetSiblingStartForTests } from "../../src/codex/sibling-start";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import * as outbound from "../../src/lib/provider-outbound";
import * as coordination from "../../src/codex/inject-coordination";
import * as configToml from "../../src/codex/inject/config-toml";
import * as remove from "../../src/codex/inject/remove";
import * as journal from "../../src/codex/journal";
import * as history from "../../src/codex/history-provider";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let codexHome = "";
let ocxHome = "";
let catalogPath = "";
let previousEnv: Partial<Record<"CODEX_HOME" | "OPENCODEX_HOME" | "CODEX_CLI_PATH", string>>;
let previousFetch: typeof fetch;
let events: CatalogPublicationEvent[];
const cleanup: Array<() => void> = [];
const nativeEntry = {
  slug: "gpt-5.5", display_name: "Native", priority: 1, visibility: "list",
  base_instructions: "You are Codex.",
  supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
};
const nativeBytes = `${JSON.stringify({ models: [nativeEntry] }, null, 2)}\n`;
const routedBytes = `${JSON.stringify({ models: [nativeEntry, {
  slug: "fixture/model", description: "Routed via opencodex → fixture (fixture).",
}] }, null, 2)}\n`;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function config(withProvider = false): OcxConfig {
  return { port: 10100, defaultProvider: withProvider ? "together" : "openai", modelCacheTtlMs: 0,
    providers: withProvider ? { together: {
      adapter: "openai-chat", baseUrl: "https://api.together.xyz/v1", authMode: "key",
      apiKey: "synthetic-catalog-key", models: ["configured-model"], liveModels: true,
    } } : {} };
}

function acquire<T>(intent: CatalogWriteIntent, callback: (permit: CatalogWritePermit) => T): T {
  const acquired = withCatalogWriteSerialization(codexHome, callback, { intent, writer: "heal-integration" });
  expect(acquired.kind).toBe("completed");
  if (acquired.kind !== "completed") throw new Error("Expected catalog admission.");
  return acquired.value;
}

function stubGather() {
  const entered = deferred();
  const release = deferred();
  const stub = spyOn(outbound, "providerOutboundGet").mockImplementation(async (name, _provider, url) => {
    expect(name).toBe("together");
    expect(new URL(url).pathname).toBe("/v1/models");
    entered.resolve();
    await release.promise;
    return Response.json({ data: [{ id: "discovered-model" }] });
  });
  cleanup.push(() => stub.mockRestore());
  return { entered, release, stub };
}

beforeEach(() => {
  previousEnv = { CODEX_HOME: process.env.CODEX_HOME, OPENCODEX_HOME: process.env.OPENCODEX_HOME,
    CODEX_CLI_PATH: process.env.CODEX_CLI_PATH };
  previousFetch = globalThis.fetch;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-heal-integration-")));
  codexHome = join(root, "codex"); ocxHome = join(root, "ocx");
  mkdirSync(codexHome); mkdirSync(ocxHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = ocxHome;
  process.env.CODEX_CLI_PATH = join(root, "must-not-execute");
  globalThis.fetch = (async () => { throw new Error("Unexpected upstream request."); }) as typeof fetch;
  resetSiblingStartForTests();
  clearModelCache(); clearGatherRoutedModelsInflight();
  resetCatalogRuntimeStateForTests(); resetCodexRuntimeResolveCacheForTests();
  resetCodexModelEntitlementCacheForTests();
  const runtime = { command: process.env.CODEX_CLI_PATH, version: "0.145.0", source: "fallback" as const };
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, { models: [nativeEntry] });
  catalogPath = join(codexHome, "opencodex-catalog.json");
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
  writeFileSync(catalogPath, nativeBytes);
  saveConfig(config());
  events = [];
  cleanup.push(subscribeCatalogPublication(event => { events.push(event); }));
});

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  globalThis.fetch = previousFetch;
  clearModelCache(); clearGatherRoutedModelsInflight();
  resetCatalogRuntimeStateForTests(); resetCodexRuntimeResolveCacheForTests();
  resetCodexModelEntitlementCacheForTests(); resetSiblingStartForTests();
  const lock = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${lock}${suffix}`, { force: true });
  for (const name of ["CODEX_HOME", "OPENCODEX_HOME", "CODEX_CLI_PATH"] as const) {
    if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name];
  }
  removeTreeWithRetry(root);
});

test("a gate closed during actual provider gathering prevents every fixed commit write", async () => {
  saveConfig(config(true));
  const retained = loadConfig();
  armDetachedConfigBaseline(retained);
  const gather = stubGather();
  let allowed = true;
  let guardCalls = 0;
  const run = createManagementConvergeCodex(retained, { beforeCommit: () => { guardCalls++; return allowed; } });
  const pending = run(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
  try {
    await gather.entered.promise;
    expect(guardCalls).toBe(0);
    allowed = false;
    gather.release.resolve();
    const outcome = await pending;
    expect(outcome.catalogRefresh).toEqual({ status: "skipped", reason: "stale", retryable: true });
    expect(guardCalls).toBe(1);
    expect(events).toEqual([]);
    expect(readFileSync(catalogPath, "utf8")).toBe(nativeBytes);
    for (const path of [catalogBackupPathFor(catalogPath), legacyCatalogBackupPath(), join(codexHome, "models_cache.json")]) {
      expect(existsSync(path)).toBe(false);
    }
  } finally { gather.release.resolve(); await pending; }
});

test.each([undefined, Promise.resolve(true)])("an untyped guard returning %p cannot authorize commit", async value => {
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config()));
  expect(gathered.kind).toBe("candidate");
  if (gathered.kind !== "candidate") throw new Error("Expected catalog candidate.");
  // Exercise JS callers that bypass the synchronous boolean TypeScript contract.
  const beforeCommit = (() => value) as unknown as () => boolean;
  expect(await commitCodexCatalogCandidate(gathered.candidate, 1_000, { beforeCommit }))
    .toEqual({ kind: "stale", reason: "process-local" });
  expect(events).toEqual([]);
  expect(existsSync(catalogBackupPathFor(catalogPath))).toBe(false);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("a journal target differing from the prepared config target prevents catalog and cache publication", async () => {
  const expectedCatalogPath = join(codexHome, "journal-catalog.json");
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(expectedCatalogPath, routedBytes);
  writeFileSync(cachePath, nativeBytes);
  const run = createManagementConvergeCodex(loadConfig(), { expectedCatalogPath, beforeCommit: () => true });
  const outcome = await run(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
  expect(outcome.catalogRefresh).toEqual({ status: "skipped", reason: "stale", retryable: true });
  expect(events).toEqual([]);
  expect(readFileSync(catalogPath, "utf8")).toBe(nativeBytes);
  expect(readFileSync(expectedCatalogPath, "utf8")).toBe(routedBytes);
  expect(readFileSync(cachePath, "utf8")).toBe(nativeBytes);
  expect(existsSync(catalogBackupPathFor(catalogPath))).toBe(false);
  expect(existsSync(catalogBackupPathFor(expectedCatalogPath))).toBe(false);
  expect(existsSync(legacyCatalogBackupPath())).toBe(false);
});

test("successful guarded discovery retains the caller's detached baseline and unrelated disk edits", async () => {
  saveConfig(config(true));
  const retained = loadConfig();
  armDetachedConfigBaseline(retained);
  const gather = stubGather();
  const run = createManagementConvergeCodex(retained, { beforeCommit: () => true, expectedCatalogPath: catalogPath });
  const pending = run(createCatalogConvergeRequest({ deadlineMs: 1_000 }));
  try {
    await gather.entered.promise;
    const configPath = join(ocxHome, "config.json");
    const handEdited = JSON.parse(readFileSync(configPath, "utf8"));
    handEdited.port = 20200;
    handEdited.shutdownTimeoutMs = 12345;
    writeFileSync(configPath, JSON.stringify(handEdited));
    gather.release.resolve();
    expect((await pending).catalogRefresh.status).toBe("committed");
    const persisted = loadConfig();
    expect(persisted.port).toBe(20200);
    expect(persisted.shutdownTimeoutMs).toBe(12345);
    expect(persisted.modelDiscovery?.knownModels?.together?.ids).toEqual(["discovered-model"]);
    expect(events).toContainEqual({ kind: "published", path: catalogPath, intent: "refresh" });
  } finally { gather.release.resolve(); await pending; }
});

test("written and unchanged catalog acceptance notifies despite a throwing subscriber; cache stays silent", () => {
  let delivered = 0;
  cleanup.push(subscribeCatalogPublication(() => { throw new Error("Subscriber failure."); }));
  cleanup.push(subscribeCatalogPublication(() => { delivered++; }));
  const prepared = { path: catalogPath, content: routedBytes };
  expect(acquire("pull", permit => replaceActiveCodexCatalog(permit, codexHome, prepared))).toEqual({ kind: "written" });
  expect(acquire("pull", permit => replaceActiveCodexCatalog(permit, codexHome, prepared))).toEqual({ kind: "unchanged" });
  acquire("cache", permit => replaceCodexModelsCache(permit, codexHome,
    { path: join(codexHome, "models_cache.json"), content: nativeBytes }));
  expect(delivered).toBe(2);
  expect(events).toEqual(Array.from({ length: 2 }, () => ({ kind: "published", path: catalogPath, intent: "pull" })));
});

test("a refused catalog clear publishes no observer event", () => {
  writeFileSync(catalogPath, routedBytes);
  writeFileSync(join(ocxHome, "config.json"), "{");
  expect(acquire("refresh", permit => replaceActiveCodexCatalog(permit, codexHome,
    { path: catalogPath, content: nativeBytes })))
    .toEqual({ kind: "refused", reason: "unbacked-routed-clear" });
  expect(events).toEqual([]);
});

test.each(["native", "missing", "corrupt"])("catalog-only restore notifies success for %s even without a writer", state => {
  if (state === "missing") rmSync(catalogPath);
  if (state === "corrupt") writeFileSync(catalogPath, "{");
  const restored = restoreCodexCatalog();
  expect(restored.removed).toBe(0);
  expect(events).toEqual([{ kind: "published", path: catalogPath, intent: "restore" }]);
});

/** Native config IO uses load-time paths; stub that boundary so installed files are never touched. */
function stubNativeConfigRestore() {
  const spies = [
    spyOn(configToml, "currentExternalCodexModelProvider").mockReturnValue(null),
    spyOn(coordination, "captureCodexPreImages").mockReturnValue({ config: null, profile: null, journal: null }),
    spyOn(coordination, "restoreCodexPreImages").mockReturnValue({ complete: true, unrestored: [] }),
    spyOn(coordination, "codexWriteCoordinationEligibility").mockReturnValue({ kind: "legacy-uncoordinated", reason: "fixture" }),
    spyOn(remove, "readOcxProviderTableBlock").mockReturnValue(null),
    spyOn(journal, "journaledInjectedCatalogPath").mockImplementation(() => catalogPath),
    spyOn(journal, "releaseJournalHomeBinding").mockImplementation(() => {}),
    spyOn(journal, "restoreJournalState").mockReturnValue({
      configRestored: true, profileRestored: true, configChanged: false, profileChanged: false,
      complete: true, unverified: false,
    }),
  ];
  const preflight = spyOn(history, "preflightCodexHistoryInjection").mockReturnValue(history.HISTORY_RELABEL_STANDS_DOWN);
  cleanup.push(...spies.map(stub => () => stub.mockRestore()), () => preflight.mockRestore());
  return { preflight, compensation: spies[2] };
}

test.each(["sync", "async"] as const)("%s native release fences observers before catalog restoration", async mode => {
  stubNativeConfigRestore();
  writeFileSync(catalogPath, routedBytes);
  const stages: string[] = [];
  cleanup.push(subscribeCatalogPublication(event => {
    if (event.kind === "native-released") stages.push(readFileSync(catalogPath, "utf8"));
    throw new Error("Observer cannot turn native release into compensation.");
  }));
  const restored = mode === "sync" ? restoreNativeCodex({ skipHistory: true }) : await restoreNativeCodexAsync();
  expect(restored.artifacts.config.state).toBe("ok");
  expect(restored.artifacts.catalog.state).toBe("ok");
  expect(stages).toEqual([routedBytes]);
  expect(events).toEqual([
    { kind: "native-released", path: catalogPath },
    { kind: "published", path: catalogPath, intent: "restore" },
  ]);
});

test("a config restore that compensates emits no native release or catalog publication", () => {
  const { preflight, compensation } = stubNativeConfigRestore();
  preflight.mockReturnValueOnce(history.HISTORY_RELABEL_STANDS_DOWN)
    .mockReturnValueOnce(history.HISTORY_RELABEL_STANDS_DOWN)
    .mockReturnValueOnce("history_state_database_missing");
  expect(restoreNativeCodex({ skipHistory: true }).artifacts.config.state).toBe("failed");
  expect(compensation).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
});
