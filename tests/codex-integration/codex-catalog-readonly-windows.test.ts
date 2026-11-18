/**
 * Issue #8358 (Windows catalog write EPERM).
 *
 * On a Windows Child, `%USERPROFILE%\.codex\opencodex-catalog.json` carried the
 * read-only FILE ATTRIBUTE, so the catalog's temp+rename publication failed with
 * `EPERM: operation not permitted, rename '...opencodex-catalog.json.ocx.<pid>.<n>.tmp'
 * -> '...opencodex-catalog.json'`. `service.log` only said
 * `catalog sync skipped: EPERM ...`, and Remote Link enrollment failed at the
 * generic "Child enrollment" phase.
 *
 * OpenCodex owns the catalog, so the shared atomic writer repairs it: on win32, a
 * rename onto an existing read-only catalog clears the attribute and retries once,
 * and a still-failing publication names the file. Anything else through the same
 * helper is unchanged. The Windows branch runs on Linux CI through the repair seam,
 * never by mutating `process.platform`, so the writer's real win32 ACL path is not
 * dragged in.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setCatalogReadOnlyRepairForTests } from "../../src/config/atomic-write";
import { atomicWriteFile, type AtomicWriteIO } from "../../src/config";
import {
  CodexCatalogReadOnlyError,
  catalogReadOnlyRepairFor,
  defaultCatalogReadOnlyRepair,
  publishWithReadOnlyRepair,
  type CatalogReadOnlyRepair,
} from "../../src/lib/codex-catalog-read-only";
import {
  type CatalogWritePermit,
  withCatalogWriteSerialization,
} from "../../src/codex/catalog-write-serialization";
import { replaceActiveCodexCatalog } from "../../src/codex/internal/catalog-writer";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../../src/codex/user-identity";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TEST_CATALOG_WRITE = { intent: "refresh", writer: "catalog-readonly" } as const;

let root = "";
let codexHome = "";
let opencodexHome = "";
let catalogPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

/** Simulated destination state: the attribute the writer reports and how many renames fail. */
function scenario(attribute: "read-only" | "writable", denials: number) {
  const cleared: string[] = [];
  let readOnly = attribute === "read-only";
  let attempts = 0;
  const repair: CatalogReadOnlyRepair = {
    platform: "win32",
    isReadOnly: () => readOnly,
    makeWritable: path => { cleared.push(path); readOnly = false; },
  };
  const io = (effects: string[]): AtomicWriteIO => ({
    write(path, content) { effects.push(`temp:${path}`); writeFileSync(path, content, { encoding: "utf8", mode: 0o600 }); },
    harden(path) { chmodSync(path, 0o600); },
    rename(source, destination) {
      effects.push(`rename:${source}->${destination}`);
      attempts += 1;
      if (attempts <= denials) {
        const error = new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`) as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      renameSync(source, destination);
    },
    truncate(path) { truncateSync(path, 0); },
    unlink(path) { unlinkSync(path); },
  });
  return { repair, io, cleared, renameAttempts: () => attempts };
}

function acquire<T>(callback: (permit: CatalogWritePermit) => T): T {
  const outcome = withCatalogWriteSerialization(codexHome, callback, TEST_CATALOG_WRITE);
  if (outcome.kind !== "completed") throw new Error(`K unavailable: ${outcome.reason}`);
  return outcome.value;
}

function replaceCatalog(io: AtomicWriteIO, content: string) {
  return acquire(permit => replaceActiveCodexCatalog(permit, codexHome, { path: catalogPath, content }, io));
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-catalog-readonly-")));
  codexHome = join(root, "codex");
  opencodexHome = join(root, "opencodex");
  mkdirSync(codexHome); mkdirSync(opencodexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  catalogPath = join(codexHome, "opencodex-catalog.json");
  writeFileSync(catalogPath, '{"models":[]}\n');
});

afterEach(() => {
  setCatalogReadOnlyRepairForTests(undefined);
  const databasePath = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${databasePath}${suffix}`, { force: true });
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousOpencodexHome;
  removeTreeWithRetry(root);
});

test("a read-only catalog rename clears the attribute and retries once", () => {
  const sim = scenario("read-only", 1);
  const effects: string[] = [];
  setCatalogReadOnlyRepairForTests(sim.repair);

  const result = replaceCatalog(sim.io(effects), '{"models":[{"slug":"gpt-test"}]}\n');

  expect(result).toEqual({ kind: "written" });
  expect(sim.cleared).toEqual([catalogPath]);
  expect(sim.renameAttempts()).toBe(2);
  expect(readFileSync(catalogPath, "utf8")).toContain("gpt-test");
  // No temporary or backup residue is left behind by the retried publication.
  expect(readdirSync(codexHome).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("a catalog still refused after clearing the attribute names the file and the attribute", () => {
  const sim = scenario("read-only", Number.POSITIVE_INFINITY);
  const effects: string[] = [];
  setCatalogReadOnlyRepairForTests(sim.repair);

  let failure: unknown;
  try { replaceCatalog(sim.io(effects), '{"models":[{"slug":"gpt-test"}]}\n'); }
  catch (error) { failure = error; }

  expect(failure).toBeInstanceOf(CodexCatalogReadOnlyError);
  expect((failure as Error).message).toBe(`Codex catalog is read-only: ${catalogPath}`);
  expect(sim.cleared).toEqual([catalogPath]);
  expect(sim.renameAttempts()).toBe(2);
  // The previous catalog survives, and the temp does not.
  expect(readFileSync(catalogPath, "utf8")).toBe('{"models":[]}\n');
  expect(readdirSync(codexHome).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("a refusal on a writable destination stays the ordinary rename error", () => {
  const sim = scenario("writable", 1);
  const effects: string[] = [];
  setCatalogReadOnlyRepairForTests(sim.repair);

  expect(() => replaceCatalog(sim.io(effects), '{"models":[{"slug":"gpt-test"}]}\n')).toThrow("EPERM");

  expect(sim.cleared).toEqual([]);
  expect(sim.renameAttempts()).toBe(1);
});

test("the repair never touches a destination the shared writer does not own", () => {
  const sim = scenario("read-only", 1);
  const effects: string[] = [];
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, "model = 'old'\n");
  setCatalogReadOnlyRepairForTests(sim.repair);

  // Same read-only attribute and the same working seam: only the artifact name differs.
  expect(() => atomicWriteFile(configPath, "model = 'new'\n", sim.io(effects))).toThrow("EPERM");

  expect(sim.cleared).toEqual([]);
  expect(sim.renameAttempts()).toBe(1);
  expect(readFileSync(configPath, "utf8")).toBe("model = 'old'\n");
});

test("the repair is a Windows rule, and a POSIX catalog publication keeps the plain rename", () => {
  // The production selector itself: the catalog on a non-Windows host, and any
  // non-catalog file on Windows, get no repair at all.
  expect(catalogReadOnlyRepairFor(join(root, "codex", "opencodex-catalog.json"), "linux")).toBeNull();
  expect(catalogReadOnlyRepairFor(join(root, "codex", "config.toml"), "win32")).toBeNull();
  expect(catalogReadOnlyRepairFor(join(root, "codex", "opencodex-catalog.json"), "win32")).not.toBeNull();

  const sim = scenario("read-only", 1);
  const effects: string[] = [];
  // Disabling the seam is exactly what the writer decides for a POSIX host.
  setCatalogReadOnlyRepairForTests(null);

  expect(() => replaceCatalog(sim.io(effects), '{"models":[{"slug":"gpt-test"}]}\n')).toThrow("EPERM");
  expect(sim.cleared).toEqual([]);
  expect(sim.renameAttempts()).toBe(1);
  expect(existsSync(catalogPath)).toBe(true);
});

/** Review of #8382: the named error is reserved for a destination that is still read-only. */
function denial(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

test("a failed attribute clear is reported as the read-only catalog, with its cause", () => {
  const chmodFailure = denial("EPERM");
  let renames = 0;
  let failure: unknown;
  try {
    publishWithReadOnlyRepair(() => { renames += 1; throw denial("EPERM"); }, "C:/u/.codex/opencodex-catalog.json", {
      platform: "win32", isReadOnly: () => true, makeWritable: () => { throw chmodFailure; },
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CodexCatalogReadOnlyError);
  expect((failure as Error).cause).toBe(chmodFailure);
  expect(renames).toBe(1);
});

test("a retry that fails for another reason keeps that error instead of claiming read-only", () => {
  const diskFull = denial("ENOSPC");
  let renames = 0;
  let failure: unknown;
  try {
    publishWithReadOnlyRepair(() => { renames += 1; throw renames === 1 ? denial("EPERM") : diskFull; },
      "C:/u/.codex/opencodex-catalog.json", { platform: "win32", isReadOnly: () => true, makeWritable: () => {} });
  } catch (error) { failure = error; }
  expect(failure).toBe(diskFull);
  expect(renames).toBe(2);
});


test("the named error keeps an errno code so disk-failure classification still applies", () => {
  let failure: unknown;
  try {
    publishWithReadOnlyRepair(() => { throw denial("EACCES"); }, "C:/u/.codex/opencodex-catalog.json",
      { platform: "win32", isReadOnly: () => true, makeWritable: () => {} });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(CodexCatalogReadOnlyError);
  expect((failure as NodeJS.ErrnoException).code).toBe("EACCES");
});

test("the production attribute helpers read and clear the owner-write bit", () => {
  const file = join(root, "opencodex-catalog.json");
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o444);
  const repair = defaultCatalogReadOnlyRepair("win32");
  expect(repair.isReadOnly(file)).toBe(true);
  repair.makeWritable(file);
  expect(repair.isReadOnly(file)).toBe(false);
});

