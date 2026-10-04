import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CatalogWritePermitRefusal,
  auditCatalogWriteWithPermit,
  type CatalogWritePermit,
  withCatalogWriteSerialization,
  type CatalogWriteIntent,
} from "../../src/codex/catalog-write-serialization";
import {
  appendCatalogWriteAudit,
  CATALOG_AUDIT_MAX_EVENT_BYTES,
  CATALOG_AUDIT_KEEP_RECORDS,
  CATALOG_AUDIT_MAX_BYTES,
  CODEX_CATALOG_AUDIT_FILE,
} from "../../src/codex/catalog/write-audit";
import { auditRefusedCatalogReplacement, replaceActiveCodexCatalog, replaceCodexModelsCache } from "../../src/codex/internal/catalog-writer";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { Database } from "bun:sqlite";
import { CODEX_HOME_JOURNAL_FILE } from "../../src/codex/codex-home-owner";
import { initializeConfigOwnership, CONFIG_UNINSTALL_MANIFEST } from "../../src/lib/config-ownership";
import type { CatalogWriteAuditEvent } from "../../src/codex/catalog/write-audit-contract";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let codexHome = "";
let opencodexHome = "";
let previousOpencodexHome: string | undefined;

const native = { slug: "gpt-5.5", description: "native" };
const routed = { slug: "ark/glm-5.3", description: "Routed via opencodex → ark/glm-5.3 (ark)." };
const catalogBytes = (...models: object[]) => `${JSON.stringify({ models }, null, 2)}\n`;

function auditPath(): string { return join(codexHome, CODEX_CATALOG_AUDIT_FILE); }
const auditEvent = (): CatalogWriteAuditEvent => ({
  opencodexHome, target: "catalog", outcome: "written", intent: "refresh", writer: "convergence",
});
function appendUnderK(event = auditEvent(), create = true) {
  const result = withCatalogWriteSerialization(codexHome,
    () => appendCatalogWriteAudit(codexHome, event, { create }), { intent: event.intent, writer: event.writer });
  if (result.kind !== "completed") throw new Error(JSON.stringify(result));
  return result.value;
}
function foreignBinding(): void {
  const foreign = join(root, "foreign"); mkdirSync(foreign);
  writeFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), JSON.stringify({
    version: 1, originalConfig: "", originalProfile: null, opencodexHome: foreign,
  }));
}
function refuseForeign() {
  return withCatalogWriteSerialization(codexHome, () => { throw new Error("foreign callback ran"); },
    { intent: "refresh", writer: "retained-sync" });
}

function catalogPath(): string {
  return join(codexHome, "opencodex-catalog.json");
}

function auditLines(): Array<Record<string, unknown>> {
  const path = join(codexHome, CODEX_CATALOG_AUDIT_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}

function replaceAs(intent: CatalogWriteIntent, content: string) {
  const outcome = withCatalogWriteSerialization(codexHome, permit =>
    replaceActiveCodexCatalog(permit, codexHome, { path: catalogPath(), content }), { intent, writer: "test" });
  if (outcome.kind !== "completed") throw new Error(JSON.stringify(outcome));
  return outcome.value;
}

beforeEach(() => {
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-audit-")));
  codexHome = join(root, "codex");
  opencodexHome = join(root, "ocx");
  mkdirSync(codexHome);
  mkdirSync(opencodexHome);
  process.env.OPENCODEX_HOME = opencodexHome;
});

afterEach(() => {
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  const path = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  removeTreeWithRetry(root);
});

describe("catalog write audit (#6529)", () => {
  test("appends only to an existing file unless asked to create it, owner-only", () => {
    const event = { opencodexHome, target: "catalog", outcome: "written", intent: "refresh", writer: "test", routedBefore: 2, routedAfter: 3 } as const;
    expect(appendUnderK(event, false)).toBe("skipped");
    expect(existsSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE))).toBe(false);
    expect(appendUnderK(event, true)).toBe("created");
    expect(appendUnderK(event, false)).toBe("appended");
    if (process.platform !== "win32") {
      expect(statSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE)).mode & 0o777).toBe(0o600);
    }
    const [first] = auditLines();
    expect(first).toMatchObject({ target: "catalog", writer: "other", routedBefore: 2, routedAfter: 3, pid: process.pid });
    expect(typeof first!.at).toBe("string");
    expect(typeof first!.command).toBe("string");
    expect(first!.opencodexHome).toBe(realpathSync.native(opencodexHome));
  });

  test("keeps the newest records once the file passes its budget", () => {
    const filler = `${JSON.stringify({ filler: "x".repeat(200) })}\n`;
    const count = Math.ceil(CATALOG_AUDIT_MAX_BYTES / filler.length) + 10;
    writeFileSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE), filler.repeat(count), { mode: 0o600 });
    appendUnderK({ opencodexHome, target: "cache", outcome: "written", intent: "cache", writer: "startup-cache" }, true);
    const lines = auditLines();
    expect(lines).toHaveLength(CATALOG_AUDIT_KEEP_RECORDS);
    expect(statSync(auditPath()).size).toBeLessThanOrEqual(CATALOG_AUDIT_MAX_BYTES);
    expect(lines.at(-1)).toMatchObject({ writer: "startup-cache" });
  });
});

describe("the catalog writer funnel (#6529)", () => {
  test("identical bytes are not rewritten and not audited", () => {
    writeFileSync(catalogPath(), catalogBytes(native, routed));
    const before = statSync(catalogPath()).mtimeMs;
    expect(replaceAs("refresh", catalogBytes(native, routed))).toEqual({ kind: "unchanged" });
    expect(statSync(catalogPath()).mtimeMs).toBe(before);
    expect(auditLines()).toEqual([]);
  });

  test("a refresh cannot clear every routed row while config.json is missing", () => {
    writeFileSync(catalogPath(), catalogBytes(native, routed));
    expect(replaceAs("refresh", catalogBytes(native))).toEqual({ kind: "refused", reason: "unbacked-routed-clear" });
    expect(readFileSync(catalogPath(), "utf8")).toBe(catalogBytes(native, routed));
    expect(auditLines()).toEqual([expect.objectContaining({
      target: "catalog",
      outcome: "refused",
      reason: "unbacked-routed-clear",
      intent: "refresh",
      routedBefore: 1,
      routedAfter: 0,
      configSource: "default",
    })]);
  });

  test("a refresh clears them once config.json is a readable file, and says so", () => {
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {} }));
    writeFileSync(catalogPath(), catalogBytes(native, routed));
    expect(replaceAs("refresh", catalogBytes(native))).toEqual({ kind: "written" });
    expect(readFileSync(catalogPath(), "utf8")).toBe(catalogBytes(native));
    expect(auditLines()).toEqual([expect.objectContaining({
      outcome: "written",
      routedBefore: 1,
      routedAfter: 0,
      configSource: "file",
    })]);
  });

  test("only a restore clears routed rows unconditionally", () => {
    writeFileSync(catalogPath(), catalogBytes(native, routed));
    expect(replaceAs("restore", catalogBytes(native))).toEqual({ kind: "written" });
    expect(auditLines()).toEqual([expect.objectContaining({ outcome: "written", intent: "restore", configSource: "default" })]);
  });

  test("a models-cache permit never replaces the catalog", () => {
    writeFileSync(catalogPath(), catalogBytes(native, routed));
    expect(() => withCatalogWriteSerialization(codexHome, permit =>
      replaceActiveCodexCatalog(permit, codexHome, { path: catalogPath(), content: catalogBytes(native) }),
    { intent: "cache", writer: "test" })).toThrow(CatalogWritePermitRefusal);
    expect(readFileSync(catalogPath(), "utf8")).toBe(catalogBytes(native, routed));
  });

  test("the models cache skips identical bytes and audits real writes", () => {
    const cachePath = join(codexHome, "models_cache.json");
    const write = (content: string) => withCatalogWriteSerialization(codexHome, permit =>
      replaceCodexModelsCache(permit, codexHome, { path: cachePath, content }), { intent: "cache", writer: "test" });
    expect(write(catalogBytes(native, routed))).toEqual({ kind: "completed", value: { kind: "written" } });
    expect(write(catalogBytes(native, routed))).toEqual({ kind: "completed", value: { kind: "unchanged" } });
    expect(auditLines()).toEqual([expect.objectContaining({ target: "cache", outcome: "written", routedBefore: null, routedAfter: 1 })]);
  });
});

describe("bounded audit descriptors and privacy", () => {
  test("400 records is the final cap including the appended event, below the byte cap", () => {
    writeFileSync(auditPath(), '{}\n'.repeat(400), { mode: 0o600 });
    expect(appendUnderK()).toBe("appended");
    expect(auditLines()).toHaveLength(400);
    expect(auditLines().at(-1)).toMatchObject({ writer: "convergence" });
  });

  test("compaction fits bytes even when the newest 400 records would exceed 256 KiB", () => {
    const line = `${JSON.stringify({ padding: "x".repeat(4000) })}\n`;
    writeFileSync(auditPath(), line.repeat(100), { mode: 0o600 });
    const inode = statSync(auditPath()).ino;
    expect(appendUnderK()).toBe("appended");
    expect(statSync(auditPath()).ino).toBe(inode);
    expect(statSync(auditPath()).size).toBeLessThanOrEqual(256 * 1024);
    expect(auditLines().length).toBeLessThan(400);
    expect(auditLines().at(-1)).toMatchObject({ writer: "convergence" });
  });

  test("oversized unterminated tail and malformed or partial lines retain only complete JSON records", () => {
    for (const bytes of ["x".repeat(1024 * 1024), '{}\ninvalid\n{"kept":true}\n{"partial":']) {
      writeFileSync(auditPath(), bytes, { mode: 0o600 });
      expect(appendUnderK()).toBe("appended");
      const lines = auditLines();
      expect(lines.at(-1)).toMatchObject({ writer: "convergence" });
      expect(statSync(auditPath()).size).toBeLessThanOrEqual(256 * 1024);
      expect(lines).not.toContainEqual({ partial: true });
    }
    expect(auditLines()[1]).toEqual({ kept: true });
  });

  test("fixed named projection excludes arbitrary properties and unknown writer/argv secrets", () => {
    const originalArgv = process.argv;
    const secret = "token-private-test-value";
    try {
      process.argv = ["bun", secret, "--api-key", secret];
      const input = { ...auditEvent(), writer: secret, token: secret, model: "private/model",
        opencodexHome: "/Users/example/" + "x".repeat(2000) };
      expect(appendUnderK(input)).toBe("created");
      const bytes = readFileSync(auditPath(), "utf8");
      expect(bytes).not.toContain(secret);
      expect(bytes).not.toContain("example");
      expect(bytes).not.toContain("private/model");
      expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(CATALOG_AUDIT_MAX_EVENT_BYTES);
      expect(auditLines()[0]).toMatchObject({ writer: "other", command: "other" });
      expect(Object.keys(auditLines()[0]!).sort()).toEqual([
        "at", "command", "intent", "opencodexHome", "outcome", "pid", "ppid", "routedAfter", "routedBefore", "target", "writer",
      ]);
    } finally { process.argv = originalArgv; }
  });

  test("accepted production writer categories preserve startup and sync distinctions", () => {
    for (const writer of ["startup-cache", "sync-cache"]) appendUnderK({ ...auditEvent(), writer });
    expect(auditLines().map(line => line.command)).toEqual(["startup-cache", "sync-cache"]);
  });

  test("the serialized event ceiling refuses an oversize event before any file mutation", () => {
    // Bypasses TS only at the adapter boundary to exercise its final byte guard.
    const oversized = { ...auditEvent(), reason: "x".repeat(3000) } as unknown as CatalogWriteAuditEvent;
    expect(appendUnderK(oversized)).toBe("skipped");
    expect(existsSync(auditPath())).toBe(false);
  });

  test("symlink, directory, and public mode audits never change a real catalog outcome", () => {
    const target = join(root, "target"); writeFileSync(target, "untouched");
    symlinkSync(target, auditPath());
    expect(replaceAs("restore", catalogBytes(native))).toEqual({ kind: "written" });
    expect(readFileSync(target, "utf8")).toBe("untouched");
    rmSync(auditPath()); mkdirSync(auditPath());
    expect(replaceAs("restore", catalogBytes(native, routed))).toEqual({ kind: "written" });
    rmSync(auditPath(), { recursive: true });
    writeFileSync(auditPath(), '{}\n', { mode: 0o644 });
    if (process.platform !== "win32") {
      expect(replaceAs("restore", catalogBytes(native))).toEqual({ kind: "written" });
      expect(readFileSync(auditPath(), "utf8")).toBe('{}\n');
      expect(statSync(auditPath()).mode & 0o777).toBe(0o644);
    }
  });

  test("forged, released and wrong-home permits cannot mutate audit files", () => {
    expect(() => auditCatalogWriteWithPermit({} as CatalogWritePermit, codexHome,
      { target: "catalog", outcome: "written" })).toThrow(CatalogWritePermitRefusal);
    let leaked: CatalogWritePermit | undefined;
    withCatalogWriteSerialization(codexHome, permit => {
      leaked = permit;
      expect(() => auditCatalogWriteWithPermit(permit, root,
        { target: "catalog", outcome: "written" })).toThrow(CatalogWritePermitRefusal);
    }, { intent: "refresh", writer: "convergence" });
    expect(() => auditCatalogWriteWithPermit(leaked!, codexHome,
      { target: "catalog", outcome: "written" })).toThrow(CatalogWritePermitRefusal);
    expect(existsSync(auditPath())).toBe(false);
  });
});

describe("foreign refusal is K-held append only", () => {
  test("foreign and unknown owner refusals create no file and never invoke callbacks", () => {
    foreignBinding();
    expect(refuseForeign()).toEqual({ kind: "unavailable", reason: "foreign-owner" });
    expect(existsSync(auditPath())).toBe(false);
    writeFileSync(join(codexHome, CODEX_HOME_JOURNAL_FILE), "invalid");
    expect(refuseForeign()).toEqual({ kind: "unavailable", reason: "owner-unknown" });
    expect(existsSync(auditPath())).toBe(false);
  });

  test("foreign appends exactly once within capacity, retaining inode, mode and original bytes", () => {
    appendUnderK();
    const original = readFileSync(auditPath(), "utf8");
    const before = statSync(auditPath());
    foreignBinding();
    expect(refuseForeign()).toEqual({ kind: "unavailable", reason: "foreign-owner" });
    expect(readFileSync(auditPath(), "utf8").startsWith(original)).toBe(true);
    expect(statSync(auditPath()).ino).toBe(before.ino);
    expect(statSync(auditPath()).mode).toBe(before.mode);
    expect(auditLines()).toHaveLength(2);
    expect(auditLines()[1]).toMatchObject({ outcome: "refused", reason: "foreign-owner", writer: "retained-sync" });
  });

  test("foreign skips byte cap, record cap, oversized, malformed and partial files without any mutation", () => {
    foreignBinding();
    for (const bytes of ['{}\n'.repeat(400), JSON.stringify({ x: "x".repeat(256 * 1024 - 9) }) + '\n',
      '{}\n'.repeat(90000), '{}\n{"partial":', '{}\ninvalid\n']) {
      writeFileSync(auditPath(), bytes, { mode: 0o600 });
      const before = statSync(auditPath());
      expect(refuseForeign()).toEqual({ kind: "unavailable", reason: "foreign-owner" });
      expect(readFileSync(auditPath(), "utf8")).toBe(bytes);
      expect(statSync(auditPath()).mtimeMs).toBe(before.mtimeMs);
    }
  });

  test("busy K preserves precheck owner refusal and never appends unlocked", () => {
    appendUnderK(); foreignBinding();
    const original = readFileSync(auditPath(), "utf8");
    const path = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
    const blocker = new Database(path);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      expect(refuseForeign()).toEqual({ kind: "unavailable", reason: "foreign-owner" });
      expect(readFileSync(auditPath(), "utf8")).toBe(original);
    } finally { blocker.exec("ROLLBACK"); blocker.close(); }
  });
});

describe("publication and registration semantics", () => {
  test("no-op creates neither audit nor uninstall metadata; a real owner creation inside home registers once", () => {
    expect(initializeConfigOwnership(opencodexHome)).toBe(true);
    const manifestPath = join(opencodexHome, CONFIG_UNINSTALL_MANIFEST);
    const originalManifest = readFileSync(manifestPath, "utf8");
    const internalHome = join(opencodexHome, "codex"); mkdirSync(internalHome);
    const prepared = { path: join(internalHome, "catalog.json"), content: catalogBytes(native) };
    writeFileSync(prepared.path, prepared.content);
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {} }));
    const write = (content: string) => withCatalogWriteSerialization(internalHome, permit =>
      replaceActiveCodexCatalog(permit, internalHome, { ...prepared, content }), { intent: "restore", writer: "catalog-restore" });
    expect(write(prepared.content)).toEqual({ kind: "completed", value: { kind: "unchanged" } });
    expect(existsSync(join(internalHome, CODEX_CATALOG_AUDIT_FILE))).toBe(false);
    expect(readFileSync(manifestPath, "utf8")).toBe(originalManifest);
    expect(write(catalogBytes(native, routed))).toMatchObject({ value: { kind: "written" } });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.paths).toContain(`codex/${CODEX_CATALOG_AUDIT_FILE}`);
    const before = readFileSync(manifestPath, "utf8");
    write(prepared.content);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
    const dbPath = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), internalHome);
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
  });

  test("outside-home registration rejection remains a residual and does not widen manifest ownership", () => {
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {} }));
    expect(replaceAs("restore", catalogBytes(native))).toEqual({ kind: "written" });
    expect(existsSync(auditPath())).toBe(true);
    expect(existsSync(join(opencodexHome, CONFIG_UNINSTALL_MANIFEST))).toBe(false);
  });

  test("non-file config and existing owner audit never attempt ownership registration", () => {
    expect(replaceAs("restore", catalogBytes(native))).toEqual({ kind: "written" });
    expect(existsSync(join(opencodexHome, CONFIG_UNINSTALL_MANIFEST))).toBe(false);
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {} }));
    expect(replaceAs("restore", catalogBytes(native, routed))).toEqual({ kind: "written" });
    expect(existsSync(join(opencodexHome, CONFIG_UNINSTALL_MANIFEST))).toBe(false);
  });

  test("early unbacked refusal records one event without entering funnel", () => {
    writeFileSync(catalogPath(), catalogBytes(native, routed));
    withCatalogWriteSerialization(codexHome, permit => {
      auditRefusedCatalogReplacement(permit, codexHome, { path: catalogPath(), content: catalogBytes(native) },
        "unbacked-routed-removal");
    }, { intent: "refresh", writer: "retained-sync" });
    expect(auditLines()).toHaveLength(1);
    expect(auditLines()[0]).toMatchObject({ outcome: "refused", reason: "unbacked-routed-removal", routedBefore: 1, routedAfter: 0 });
    expect(readFileSync(catalogPath(), "utf8")).toBe(catalogBytes(native, routed));
  });

  test("a competing K connection cannot mutate audit while a permit holder writes complete records", async () => {
    const path = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
    const result = withCatalogWriteSerialization(codexHome, permit => {
      const held = new Database(path);
      try {
        held.exec("PRAGMA busy_timeout=0");
        expect(() => held.exec("BEGIN IMMEDIATE")).toThrow();
        auditCatalogWriteWithPermit(permit, codexHome, { target: "catalog", outcome: "written" });
      } finally { held.close(); }
    }, { intent: "refresh", writer: "convergence" });
    expect(result.kind).toBe("completed");
    await Promise.all(Array.from({ length: 420 }, () => Promise.resolve().then(() => appendUnderK())));
    expect(auditLines()).toHaveLength(400);
    expect(statSync(auditPath()).size).toBeLessThanOrEqual(256 * 1024);
    expect(auditLines().every(line => line.writer === "convergence")).toBe(true);
  });
});

test("descriptor observation reads at most 256 KiB plus the boundary byte", () => {
  const line = JSON.stringify({ padding: "x".repeat(3000) }) + '\n';
  writeFileSync(auditPath(), line.repeat(500), { mode: 0o600 });
  const reads = spyOn(fs, "readSync");
  try {
    expect(appendUnderK()).toBe("appended");
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    const total = reads.mock.calls.reduce((sum, call) => sum + Number(call[3]), 0);
    expect(total).toBeLessThanOrEqual(256 * 1024 + 1);
    expect(reads.mock.calls[0]![4]).toBeGreaterThan(0);
    expect(auditLines().at(-1)).toMatchObject({ writer: "convergence" });
  } finally { reads.mockRestore(); }
});

test("read and write IO failures leave actual publication and refusal outcomes unchanged", () => {
  writeFileSync(auditPath(), '{}\n', { mode: 0o600 });
  for (const operation of ["readSync", "writeSync"] as const) {
    const failure = spyOn(fs, operation).mockImplementation(() => { throw new Error("audit IO error"); });
    try {
      const content = catalogBytes(native, { slug: operation, description: "native" });
      expect(replaceAs("restore", content)).toEqual({ kind: "written" });
      expect(readFileSync(catalogPath(), "utf8")).toBe(content);
      expect(readFileSync(auditPath(), "utf8")).toBe('{}\n');
    } finally { failure.mockRestore(); }
  }
  foreignBinding();
  const failure = spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("audit IO error"); });
  try {
    expect(refuseForeign()).toEqual({ kind: "unavailable", reason: "foreign-owner" });
    expect(readFileSync(auditPath(), "utf8")).toBe('{}\n');
  } finally { failure.mockRestore(); }
});

test("retained sync and convergence each audit their early removal refusal exactly once", async () => {
  const oldCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  const { saveConfig } = await import("../../src/config");
  const { captureCatalogAdmissionSnapshot } = await import("../../src/codex/catalog-admission");
  const { gatherCodexCatalogCandidate, commitCodexCatalogCandidate } = await import("../../src/codex/convergence");
  const { syncCatalogModels } = await import("../../src/codex/catalog/retained-sync");
  const { resetCatalogRuntimeStateForTests } = await import("../../src/codex/catalog");
  const { setCodexRuntimeResolveCacheForTests, resetCodexRuntimeResolveCacheForTests } = await import("../../src/codex/runtime");
  const { setBundledCatalogCacheForTests, invalidateBundledCatalogCache } = await import("../../src/codex/catalog/bundled");
  const config = { port: 10100, defaultProvider: "openai", providers: {} };
  const runtime = { source: "test", codexBin: process.execPath, version: "0.999.0",
    channel: "cli", modelSlug: "gpt-5.5", capabilities: {} };
  const baseline = { models: [{ ...native, display_name: "Native", priority: 1, visibility: "list",
    base_instructions: "fixture", supported_reasoning_levels: [{ effort: "medium", description: "Medium" }] }] };
  try {
    resetCatalogRuntimeStateForTests();
    setCodexRuntimeResolveCacheForTests({ runtime, failures: [] });
    setBundledCatalogCacheForTests(runtime, baseline);
    saveConfig(config);
    writeFileSync(catalogPath(), JSON.stringify({ models: [...baseline.models, routed] }));
    writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
    saveConfig({ ...config, providers: { ark: {
      adapter: "openai-chat", baseUrl: "https://api.example.test/v1", liveModels: false, models: ["glm-5.3"],
    } } });
    const retained = await syncCatalogModels(config);
    expect(retained.skippedReason).toBe("unbacked_routed_removal");
    expect(auditLines()).toHaveLength(1);
    expect(auditLines()[0]).toMatchObject({ reason: "unbacked-routed-removal", writer: "retained-sync" });
    const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(config));
    expect(gathered.kind).toBe("candidate");
    if (gathered.kind !== "candidate") throw new Error(JSON.stringify(gathered));
    expect(await commitCodexCatalogCandidate(gathered.candidate, 1000)).toEqual({
      kind: "refused", reason: "unbacked-routed-removal",
    });
    expect(auditLines()).toHaveLength(2);
    expect(auditLines()[1]).toMatchObject({ reason: "unbacked-routed-removal", writer: "convergence" });
  } finally {
    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    invalidateBundledCatalogCache();
    resetCatalogRuntimeStateForTests();
    resetCodexRuntimeResolveCacheForTests();
  }
});
