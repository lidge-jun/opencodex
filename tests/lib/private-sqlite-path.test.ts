/** Refusing links and other reparse points at SQLite database and sidecar names before anything is created. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPrivateSqliteSidecars,
  isWindowsReparsePoint,
  nativeReparseProbeApplies,
  preparePrivateSqliteDatabase,
  setSqlitePathReparseProbeForTests,
  UnsafeSqlitePathError,
} from "../../src/lib/private-sqlite-path";
import { acquireSpendLedgerOwner, SPEND_LEDGER_OWNER_FILENAME, SpendLedgerOwnerError } from "../../src/lib/spend-ledger-owner";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root = "";
let database = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-sqlite-path-"));
  database = join(root, "store.sqlite");
});
afterEach(() => {
  setSqlitePathReparseProbeForTests(null);
  removeTreeWithRetry(root);
});

test("a missing database is created as a private regular file", () => {
  preparePrivateSqliteDatabase(database);
  const stat = statSync(database);
  expect(stat.isFile()).toBe(true);
  expect(stat.size).toBe(0);
  if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
});

test("an existing database and a regular hot journal are accepted unchanged", () => {
  writeFileSync(database, "db", { mode: 0o600 });
  writeFileSync(`${database}-journal`, "journal", { mode: 0o600 });
  preparePrivateSqliteDatabase(database);
  expect(readFileSync(database, "utf8")).toBe("db");
  expect(readFileSync(`${database}-journal`, "utf8")).toBe("journal");
});

for (const kind of ["dangling link", "link", "hard link", "directory"] as const) {
  test(`a ${kind} at the database name is refused without touching what it names`, () => {
    const target = join(root, "outside");
    if (kind === "dangling link") symlinkSync(target, database);
    else if (kind === "directory") mkdirSync(database);
    else {
      writeFileSync(target, "outside");
      if (kind === "link") symlinkSync(target, database);
      else linkSync(target, database);
    }
    expect(() => preparePrivateSqliteDatabase(database)).toThrow(UnsafeSqlitePathError);
    if (kind === "dangling link") expect(existsSync(target)).toBe(false);
    else if (kind !== "directory") expect(readFileSync(target, "utf8")).toBe("outside");
  });
}

for (const suffix of ["-journal", "-wal", "-shm"]) {
  test(`a link at the ${suffix} sidecar is refused before the database is created`, () => {
    const target = join(root, "outside");
    symlinkSync(target, `${database}${suffix}`);
    expect(() => preparePrivateSqliteDatabase(database)).toThrow(UnsafeSqlitePathError);
    expect(() => assertPrivateSqliteSidecars(database)).toThrow(UnsafeSqlitePathError);
    expect(existsSync(database)).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
}

test("an entry the reparse probe flags is refused, database or sidecar", () => {
  writeFileSync(database, "db", { mode: 0o600 });
  setSqlitePathReparseProbeForTests(path => path === database);
  expect(() => preparePrivateSqliteDatabase(database)).toThrow(UnsafeSqlitePathError);
  expect(readFileSync(database, "utf8")).toBe("db");

  const fresh = join(root, "fresh.sqlite");
  writeFileSync(`${fresh}-wal`, "", { mode: 0o600 });
  setSqlitePathReparseProbeForTests(path => path === `${fresh}-wal`);
  expect(() => preparePrivateSqliteDatabase(fresh)).toThrow(UnsafeSqlitePathError);
  expect(existsSync(fresh)).toBe(false);
});

test("a probe that cannot answer fails closed, and the spend-ledger owner reports it as unavailable", () => {
  writeFileSync(database, "db", { mode: 0o600 });
  setSqlitePathReparseProbeForTests(() => { throw new Error("native attribute query unavailable"); });
  expect(() => preparePrivateSqliteDatabase(database)).toThrow(UnsafeSqlitePathError);

  const home = join(root, "owner-home");
  mkdirSync(home);
  writeFileSync(join(home, SPEND_LEDGER_OWNER_FILENAME), "", { mode: 0o600 });
  let failure: unknown;
  try { acquireSpendLedgerOwner(home).release(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(SpendLedgerOwnerError);
  expect((failure as SpendLedgerOwnerError).code).toBe("SPEND_LEDGER_OWNER_UNAVAILABLE");
});

test("the native attribute query runs on Windows except ARM64, whose Bun build cannot load FFI", () => {
  expect(nativeReparseProbeApplies("win32", "x64")).toBe(true);
  expect(nativeReparseProbeApplies("win32", "arm64")).toBe(false);
  expect(nativeReparseProbeApplies("darwin", "arm64")).toBe(false);
  expect(nativeReparseProbeApplies("linux", "x64")).toBe(false);
});

test.skipIf(process.platform !== "win32" || process.arch === "arm64")("the native Windows probe reports links and junctions, not regular files", () => {
  writeFileSync(database, "db");
  const fileLink = join(root, "file-link");
  symlinkSync(database, fileLink, "file");
  const directory = join(root, "directory");
  mkdirSync(directory);
  const junction = join(root, "junction");
  symlinkSync(directory, junction, "junction");
  expect(isWindowsReparsePoint(database)).toBe(false);
  expect(isWindowsReparsePoint(directory)).toBe(false);
  expect(isWindowsReparsePoint(fileLink)).toBe(true);
  expect(isWindowsReparsePoint(junction)).toBe(true);
});
