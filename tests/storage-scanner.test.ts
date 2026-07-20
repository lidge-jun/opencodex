import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStorage, type StorageBucket, type StorageReport } from "../src/storage/scanner";

const OLD_MTIME = new Date("2026-01-02T03:04:05Z");
const MID_MTIME = new Date("2026-03-04T05:06:07Z");
const NEW_MTIME = new Date("2026-06-07T08:09:10Z");

let fixtureHome = "";
let previousCodexHome: string | undefined;

/**
 * Builds a synthetic CODEX_HOME mirroring the layout documented in
 * devlog/_plan/500_storage-page-session-cleanup/20_codex-storage-structure.md:
 * date-partitioned sessions/, flat archived_sessions/, versioned state / logs
 * sqlite files with WAL siblings, plus non-session dirs for the "other" bucket.
 */
function buildFixtureHome(home: string = mkdtempSync(join(tmpdir(), "ocx-storage-fixture-"))): string {

  mkdirSync(join(home, "sessions", "2026", "05", "27"), { recursive: true });
  mkdirSync(join(home, "sessions", "2026", "06", "01"), { recursive: true });
  writeFileSync(join(home, "sessions", "2026", "05", "27", "rollout-a.jsonl"), "a".repeat(100));
  writeFileSync(join(home, "sessions", "2026", "05", "27", "rollout-b.jsonl"), "b".repeat(2000));
  writeFileSync(join(home, "sessions", "2026", "06", "01", "rollout-c.jsonl"), "c".repeat(300));
  utimesSync(join(home, "sessions", "2026", "05", "27", "rollout-a.jsonl"), OLD_MTIME, OLD_MTIME);
  utimesSync(join(home, "sessions", "2026", "05", "27", "rollout-b.jsonl"), MID_MTIME, MID_MTIME);
  utimesSync(join(home, "sessions", "2026", "06", "01", "rollout-c.jsonl"), NEW_MTIME, NEW_MTIME);

  mkdirSync(join(home, "archived_sessions"));
  writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl"), "d".repeat(50));

  // Real state_5.sqlite/logs_2.sqlite are WAL-mode (devlog 20_codex-storage-structure.md: "every
  // root sqlite has -wal + -shm siblings live while Codex runs"). Checkpoint+truncate here so the
  // fixture starts sidecar-free, like a state_5.sqlite would look after Codex fully quits — the
  // exact starting condition that must NOT gain new -wal/-shm files from a "read-only" scan.
  const state = new Database(join(home, "state_5.sqlite"));
  state.exec("PRAGMA journal_mode=WAL");
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER)");
  state.exec("INSERT INTO threads VALUES ('t1','sessions/a.jsonl',0),('t2','sessions/b.jsonl',1),('t3','sessions/c.jsonl',0)");
  state.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  state.close();
  // Older versioned DB + stale WAL sibling: must count toward bucket size, but row
  // counts must come from the newest suffix (state_5), never this one.
  writeFileSync(join(home, "state_4.sqlite"), "e".repeat(64));
  writeFileSync(join(home, "state_4.sqlite-wal"), "f".repeat(32));

  const logs = new Database(join(home, "logs_2.sqlite"));
  logs.exec("PRAGMA journal_mode=WAL");
  logs.exec("CREATE TABLE logs (ts INTEGER, level TEXT, estimated_bytes INTEGER)");
  logs.exec("INSERT INTO logs VALUES (1,'info',10),(2,'info',20),(3,'warn',30),(4,'error',40),(5,'info',50)");
  logs.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  logs.close();

  mkdirSync(join(home, "attachments"));
  writeFileSync(join(home, "attachments", "img.png"), "g".repeat(700));
  mkdirSync(join(home, "deletion_manifests"));
  writeFileSync(join(home, "deletion_manifests", "m1.json"), "h".repeat(40));

  mkdirSync(join(home, "plugins", "cache"), { recursive: true });
  writeFileSync(join(home, "plugins", "cache", "plugin.bin"), "i".repeat(900));
  writeFileSync(join(home, "config.toml"), "# codex config\n");

  return home;
}

function bucket(report: StorageReport, key: StorageBucket["key"]): StorageBucket {
  const found = report.buckets.find(b => b.key === key);
  if (!found) throw new Error(`bucket ${key} missing from report`);
  return found;
}

function snapshotTree(dir: string): Map<string, { size: number; mtimeMs: number }> {
  const out = new Map<string, { size: number; mtimeMs: number }>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const stat = statSync(full);
      out.set(full, { size: stat.size, mtimeMs: stat.mtimeMs });
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  previousCodexHome = undefined;
  if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
  fixtureHome = "";
});

describe("scanStorage", () => {
  test("aggregates bucket bytes, file counts, and mtimes from a fixture home", () => {
    fixtureHome = buildFixtureHome();
    const report = scanStorage(fixtureHome);

    expect(report.codexHome).toBe(fixtureHome);
    expect(report.generatedAt).toBeGreaterThan(0);

    const sessions = bucket(report, "sessions");
    expect(sessions.bytes).toBe(2400);
    expect(sessions.fileCount).toBe(3);
    expect(sessions.oldest).toBe(OLD_MTIME.getTime());
    expect(sessions.newest).toBe(NEW_MTIME.getTime());

    const archived = bucket(report, "archived_sessions");
    expect(archived.bytes).toBe(50);
    expect(archived.fileCount).toBe(1);

    const attachments = bucket(report, "attachments");
    expect(attachments.bytes).toBe(700);
    expect(attachments.fileCount).toBe(1);

    const manifests = bucket(report, "deletion_manifests");
    expect(manifests.bytes).toBe(40);
    expect(manifests.fileCount).toBe(1);

    const stateDb = bucket(report, "state_db");
    const stateBytes = statSync(join(fixtureHome, "state_5.sqlite")).size + 64 + 32;
    expect(stateDb.bytes).toBe(stateBytes);
    expect(stateDb.fileCount).toBe(3);

    const logsDb = bucket(report, "logs_db");
    expect(logsDb.bytes).toBe(statSync(join(fixtureHome, "logs_2.sqlite")).size);
    expect(logsDb.fileCount).toBe(1);

    const other = bucket(report, "other");
    const configBytes = statSync(join(fixtureHome, "config.toml")).size;
    expect(other.bytes).toBe(900 + configBytes);
    expect(other.fileCount).toBe(2);

    const expectedTotalBytes = report.buckets.reduce((sum, b) => sum + b.bytes, 0);
    const expectedTotalFiles = report.buckets.reduce((sum, b) => sum + b.fileCount, 0);
    expect(report.total.bytes).toBe(expectedTotalBytes);
    expect(report.total.fileCount).toBe(expectedTotalFiles);
  });

  test("ranks largest files per bucket with home-relative forward-slash paths", () => {
    fixtureHome = buildFixtureHome();
    const report = scanStorage(fixtureHome);

    const sessions = bucket(report, "sessions");
    expect(sessions.largest?.[0]).toEqual({ path: "sessions/2026/05/27/rollout-b.jsonl", bytes: 2000 });
    expect(sessions.largest?.[1]).toEqual({ path: "sessions/2026/06/01/rollout-c.jsonl", bytes: 300 });
    expect(sessions.largest?.length).toBeLessThanOrEqual(5);
  });

  test("counts DB rows read-only, resolving the newest versioned sqlite", () => {
    fixtureHome = buildFixtureHome();
    const report = scanStorage(fixtureHome);

    expect(bucket(report, "state_db").rows).toBe(3);
    expect(bucket(report, "logs_db").rows).toBe(5);
  });

  test("counts DB rows correctly when CODEX_HOME contains URI-reserved characters", () => {
    // A literal '#'/'?'/'%' in the path is legal on POSIX filesystems and starts a
    // fragment/query/escape if the immutable file: URI is built by naive string
    // concatenation — it must not silently degrade every row count to null.
    const parent = mkdtempSync(join(tmpdir(), "ocx-storage-uri-"));
    const weirdHome = join(parent, "weird#name?with%percent");
    mkdirSync(weirdHome);
    fixtureHome = buildFixtureHome(weirdHome);

    const report = scanStorage(fixtureHome);
    expect(bucket(report, "state_db").rows).toBe(3);
    expect(bucket(report, "logs_db").rows).toBe(5);
  });

  test("returns null row counts for an unreadable db without throwing", () => {
    fixtureHome = buildFixtureHome();
    // A newer-versioned garbage file shadows state_5: rows must degrade to null,
    // never throw — mirrors the locked/corrupt DB skip in the plan (33, item 5).
    writeFileSync(join(fixtureHome, "state_9.sqlite"), "this is not a database");

    const report = scanStorage(fixtureHome);
    expect(bucket(report, "state_db").rows).toBeNull();
    expect(bucket(report, "logs_db").rows).toBe(5);
  });

  test("reads through an active writer lock without blocking or writing", () => {
    // Row counts use an immutable connection (never takes SQLite's lock protocol), so a scan
    // must complete instantly against the last-checkpointed data instead of blocking on
    // SQLITE_BUSY — and, same as any other scan, must not create sidecar files.
    fixtureHome = buildFixtureHome();
    const holder = new Database(join(fixtureHome, "state_5.sqlite"));
    holder.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE");
    try {
      const before = snapshotTree(fixtureHome);
      const report = scanStorage(fixtureHome);
      expect(bucket(report, "state_db").rows).toBe(3);
      const after = snapshotTree(fixtureHome);
      expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    } finally {
      holder.close();
    }
  });

  test("reports empty buckets for a missing or empty home without throwing", () => {
    fixtureHome = mkdtempSync(join(tmpdir(), "ocx-storage-empty-"));
    const emptyReport = scanStorage(fixtureHome);
    expect(emptyReport.total).toEqual({ bytes: 0, fileCount: 0 });
    for (const b of emptyReport.buckets) {
      expect(b.bytes).toBe(0);
      expect(b.fileCount).toBe(0);
    }

    const missing = scanStorage(join(fixtureHome, "does-not-exist"));
    expect(missing.total).toEqual({ bytes: 0, fileCount: 0 });
  });

  test("throws when the home exists but is not a directory", () => {
    fixtureHome = mkdtempSync(join(tmpdir(), "ocx-storage-notdir-"));
    const filePath = join(fixtureHome, "home-is-a-file");
    writeFileSync(filePath, "not a directory");
    // A missing home is a normal fresh-machine state (zeros), but a *broken* home
    // must surface as an error so /api/storage can answer with its fallback envelope.
    expect(() => scanStorage(filePath)).toThrow();
  });

  test("defaults to the CODEX_HOME environment override when no home is passed", () => {
    fixtureHome = buildFixtureHome();
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = fixtureHome;

    const report = scanStorage();
    expect(report.codexHome).toBe(fixtureHome);
    expect(bucket(report, "sessions").bytes).toBe(2400);
  });

  test("performs zero writes under CODEX_HOME (read-only invariant)", () => {
    fixtureHome = buildFixtureHome();
    const before = snapshotTree(fixtureHome);

    scanStorage(fixtureHome);

    const after = snapshotTree(fixtureHome);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, stat] of before) {
      expect(after.get(path)).toEqual(stat);
    }
  });
});
