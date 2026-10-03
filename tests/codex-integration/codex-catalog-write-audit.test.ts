import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CatalogWritePermitRefusal,
  withCatalogWriteSerialization,
  type CatalogWriteIntent,
} from "../../src/codex/catalog-write-serialization";
import {
  appendCatalogWriteAudit,
  CATALOG_AUDIT_KEEP_RECORDS,
  CATALOG_AUDIT_MAX_BYTES,
  CODEX_CATALOG_AUDIT_FILE,
} from "../../src/codex/catalog/write-audit";
import { replaceActiveCodexCatalog, replaceCodexModelsCache } from "../../src/codex/internal/catalog-writer";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let codexHome = "";
let opencodexHome = "";
let previousOpencodexHome: string | undefined;

const native = { slug: "gpt-5.5", description: "native" };
const routed = { slug: "ark/glm-5.3", description: "Routed via opencodex → ark/glm-5.3 (ark)." };
const catalogBytes = (...models: object[]) => `${JSON.stringify({ models }, null, 2)}\n`;

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
    const event = { target: "catalog", outcome: "written", intent: "refresh", writer: "test", routedBefore: 2, routedAfter: 3 } as const;
    expect(appendCatalogWriteAudit(codexHome, event, { create: false })).toBe("skipped");
    expect(existsSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE))).toBe(false);
    expect(appendCatalogWriteAudit(codexHome, event, { create: true })).toBe("created");
    expect(appendCatalogWriteAudit(codexHome, event, { create: false })).toBe("appended");
    if (process.platform !== "win32") {
      expect(statSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE)).mode & 0o777).toBe(0o600);
    }
    const [first] = auditLines();
    expect(first).toMatchObject({ ...event, pid: process.pid });
    expect(typeof first!.at).toBe("string");
    expect(typeof first!.command).toBe("string");
    expect(first!.opencodexHome).toBe(realpathSync.native(opencodexHome));
  });

  test("keeps the newest records once the file passes its budget", () => {
    const filler = `${JSON.stringify({ filler: "x".repeat(200) })}\n`;
    const count = Math.ceil(CATALOG_AUDIT_MAX_BYTES / filler.length) + 10;
    writeFileSync(join(codexHome, CODEX_CATALOG_AUDIT_FILE), filler.repeat(count));
    appendCatalogWriteAudit(codexHome, { target: "cache", outcome: "written", intent: "cache", writer: "newest" }, { create: false });
    const lines = auditLines();
    expect(lines).toHaveLength(CATALOG_AUDIT_KEEP_RECORDS + 1);
    expect(lines.at(-1)).toMatchObject({ writer: "newest" });
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
