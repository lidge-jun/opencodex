import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countPendingOpencodexHistory } from "../../src/codex/history-provider";
import { setStateDbPreflightOpenFailureForTests, type StateDbPreflightOpenPhase } from "../../src/codex/history-state-open";

const fixtures = new Set<string>();
afterEach(() => {
  setStateDbPreflightOpenFailureForTests(undefined);
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
  fixtures.clear();
});

function checkpointedWalFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ocx-pending-history-wal-"));
  fixtures.add(dir);
  const dbPath = join(dir, "state_5.sqlite");
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE threads (id TEXT PRIMARY KEY)");
    db.run("INSERT INTO threads VALUES ('retained-thread')");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  // SQLite header bytes 18/19 prove this is a real WAL store, even without sidecars.
  expect([...readFileSync(dbPath).subarray(18, 20)]).toEqual([2, 2]);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
  return { dbPath, backupPath: join(dir, "absent-backup.json") };
}

test("pending history probe accepts a checkpointed WAL store without sidecars", () => {
  const { dbPath, backupPath } = checkpointedWalFixture();
  expect(countPendingOpencodexHistory(dbPath, backupPath)).toEqual({ pendingRows: 0, backupEntries: 0 });
});

test.each(["open", "first-read"] as const)("pending history probe recovers SQLITE_CANTOPEN at %s", (failurePhase) => {
  const { dbPath, backupPath } = checkpointedWalFixture();
  const phases: StateDbPreflightOpenPhase[] = [];
  // VFS behavior varies by platform; force only the primary failure, then read the real DB.
  setStateDbPreflightOpenFailureForTests((_path, phase) => {
    phases.push(phase);
    return phase === failurePhase
      ? Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" })
      : undefined;
  });
  expect(countPendingOpencodexHistory(dbPath, backupPath)).toEqual({ pendingRows: 0, backupEntries: 0 });
  expect(phases).toContain(failurePhase);
  expect(existsSync(`${dbPath}-wal`)).toBe(false);
  expect(existsSync(`${dbPath}-shm`)).toBe(false);
});
