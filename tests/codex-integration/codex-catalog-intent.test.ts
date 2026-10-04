import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as owner from "../../src/codex/codex-home-owner";
import * as appServer from "../../src/codex/app-server-processes";
import {
  catalogWritePermitContext, CatalogWritePermitRefusal, withCatalogWriteSerialization,
  type CatalogWriteIntent, type CatalogWritePermit,
} from "../../src/codex/catalog-write-serialization";
import { replaceActiveCodexCatalog, replaceCodexModelsCache } from "../../src/codex/internal/catalog-writer";
import { withConfigMutationLockSync } from "../../src/config/mutation-lock";
import { restoreCodexCatalog } from "../../src/codex/catalog/restore";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let codexHome = "";
let opencodexHome = "";
let catalogPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;
const native = `${JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] })}\n`;
const routed = `${JSON.stringify({ models: [{ slug: "test/model", description: "Routed via opencodex → test/model (fixture)." }] })}\n`;

function acquire<T>(intent: CatalogWriteIntent, callback: (permit: CatalogWritePermit) => T) {
  return withCatalogWriteSerialization(codexHome, callback, { intent, writer: "intent-contract" });
}
function replace(intent: CatalogWriteIntent, content = native) {
  return acquire(intent, permit => replaceActiveCodexCatalog(permit, codexHome, { path: catalogPath, content }));
}
function journal(boundHome: string) {
  writeFileSync(join(codexHome, owner.CODEX_HOME_JOURNAL_FILE), JSON.stringify({
    version: 1, originalConfig: "", originalProfile: null, pid: 1,
    timestamp: "2026-10-04T00:00:00Z", opencodexHome: boundHome,
  }));
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-intent-")));
  codexHome = join(root, "codex");
  opencodexHome = join(root, "ocx");
  mkdirSync(codexHome); mkdirSync(opencodexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  catalogPath = join(codexHome, "opencodex-catalog.json");
  writeFileSync(catalogPath, routed);
});

afterEach(() => {
  const lock = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${lock}${suffix}`, { force: true });
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(root);
});

for (const intent of ["refresh", "cache", "pull", "restore"] as const) {
  test(`${intent} context is available only for its live permit`, () => {
    let leaked: CatalogWritePermit | undefined;
    expect(acquire(intent, permit => {
      leaked = permit;
      expect(catalogWritePermitContext(permit)).toEqual({ intent, writer: "intent-contract" });
      return "live";
    })).toEqual({ kind: "completed", value: "live" });
    expect(() => catalogWritePermitContext(leaked!)).toThrow(CatalogWritePermitRefusal);
    expect(() => catalogWritePermitContext({} as CatalogWritePermit)).toThrow(CatalogWritePermitRefusal);
  });
}

test("cache intent cannot replace even identical catalog bytes", () => {
  expect(() => replace("cache", routed)).toThrow(CatalogWritePermitRefusal);
  expect(readFileSync(catalogPath, "utf8")).toBe(routed);
});

for (const configState of ["missing", "malformed", "directory"] as const) {
  test(`refresh cannot clear routed rows with ${configState} config`, () => {
    const configPath = join(opencodexHome, "config.json");
    if (configState === "malformed") writeFileSync(configPath, "{ invalid");
    if (configState === "directory") mkdirSync(configPath);
    expect(replace("refresh")).toEqual({ kind: "completed", value: { kind: "refused", reason: "unbacked-routed-clear" } });
    expect(readFileSync(catalogPath, "utf8")).toBe(routed);
  });
}

test("refresh clear uses saved config under an already-held C transaction", () => {
  writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  expect(acquire("refresh", permit => withConfigMutationLockSync(() =>
    replaceActiveCodexCatalog(permit, codexHome, { path: catalogPath, content: native }))))
    .toEqual({ kind: "completed", value: { kind: "written" } });
  expect(readFileSync(catalogPath, "utf8")).toBe(native);
});

test("contended C refuses refresh clear without changing catalog bytes", () => {
  writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai" }));
  withConfigMutationLockSync(() => undefined);
  const holder = new Database(join(opencodexHome, "config-mutation.sqlite"));
  holder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  try {
    expect(replace("refresh")).toEqual({ kind: "completed", value: { kind: "refused", reason: "unbacked-routed-clear" } });
    expect(readFileSync(catalogPath, "utf8")).toBe(routed);
  } finally { holder.exec("ROLLBACK"); holder.close(); }
});

for (const intent of ["pull", "restore"] as const) {
  test(`${intent} can deliberately clear routed rows without config`, () => {
    expect(replace(intent)).toEqual({ kind: "completed", value: { kind: "written" } });
    expect(readFileSync(catalogPath, "utf8")).toBe(native);
  });
}

test("identical catalog and cache bytes preserve mtimes and app-server memo", () => {
  const cachePath = join(codexHome, "models_cache.json");
  writeFileSync(cachePath, native);
  for (const path of [catalogPath, cachePath]) utimesSync(path, 1_000, 1_000);
  const before = [statSync(catalogPath).mtimeMs, statSync(cachePath).mtimeMs];
  const reset = spyOn(appServer, "resetCodexAppServerCatalogStateCache");
  try {
    expect(replace("refresh", routed)).toEqual({ kind: "completed", value: { kind: "unchanged" } });
    expect(acquire("cache", permit => replaceCodexModelsCache(permit, codexHome, { path: cachePath, content: native })))
      .toEqual({ kind: "completed", value: { kind: "unchanged" } });
    expect([statSync(catalogPath).mtimeMs, statSync(cachePath).mtimeMs]).toEqual(before);
    expect(reset).not.toHaveBeenCalled();
  } finally { reset.mockRestore(); }
});

test("raw malformed bytes are repaired despite equal UTF-8 decoded strings", () => {
  writeFileSync(catalogPath, Buffer.from([0x80]));
  expect(replace("refresh", "\uFFFD")).toEqual({ kind: "completed", value: { kind: "written" } });
  expect(readFileSync(catalogPath)).toEqual(Buffer.from([0xef, 0xbf, 0xbd]));
});

for (const state of ["foreign", "unknown"] as const) {
  test(`${state} ownership refuses every intent before callback and leaves artifacts intact`, () => {
    const foreign = join(root, "foreign"); mkdirSync(foreign);
    if (state === "foreign") journal(foreign);
    else writeFileSync(join(codexHome, owner.CODEX_HOME_JOURNAL_FILE), "invalid journal");
    const cachePath = join(codexHome, "models_cache.json"); writeFileSync(cachePath, "cache-before");
    for (const intent of ["refresh", "cache", "pull", "restore"] as const) {
      let called = false;
      expect(acquire(intent, () => { called = true; }))
        .toEqual({ kind: "unavailable", reason: state === "foreign" ? "foreign-owner" : "owner-unknown" });
      expect(called).toBe(false);
    }
    expect(readFileSync(catalogPath, "utf8")).toBe(routed);
    expect(readFileSync(cachePath, "utf8")).toBe("cache-before");
    expect(() => restoreCodexCatalog()).toThrow(CatalogWritePermitRefusal);
    // Later calls retry ownership inspection, allowing recovered evidence.
    journal(opencodexHome);
    expect(acquire("cache", () => "recovered")).toEqual({ kind: "completed", value: "recovered" });
  });
}

for (const state of ["foreign", "unknown"] as const) {
  test(`${state} ownership observed after K acquisition refuses before callback`, () => {
    const inspect = spyOn(owner, "inspectCodexHomeOwner").mockReturnValueOnce({ kind: "unbound" })
      .mockReturnValueOnce(state === "foreign" ? { kind: "foreign", boundHome: join(root, "foreign") } : { kind: "unknown" });
    try {
      let called = false;
      expect(acquire("refresh", () => { called = true; }))
        .toEqual({ kind: "unavailable", reason: state === "foreign" ? "foreign-owner" : "owner-unknown" });
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(called).toBe(false);
    } finally { inspect.mockRestore(); }
    expect(acquire("cache", () => "released")).toEqual({ kind: "completed", value: "released" });
  });
}
