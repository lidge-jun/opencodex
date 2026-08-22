import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectCodexLogs, resetCodexLogGuardInspectionCache } from "../src/codex/log-guard/inspect";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-"));
  roots.push(root);
  return root;
}

function createCurrentLogsDb(path: string): void {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ts_nanos INTEGER NOT NULL,
      level TEXT NOT NULL,
      target TEXT NOT NULL,
      feedback_log_body TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_logs_ts ON logs(ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_thread_id ON logs(thread_id);
    CREATE INDEX idx_logs_thread_id_ts ON logs(thread_id, ts DESC, ts_nanos DESC, id DESC);
    CREATE INDEX idx_logs_process_uuid_threadless_ts
      ON logs(process_uuid, ts DESC, ts_nanos DESC, id DESC)
      WHERE thread_id IS NULL;
  `);
  const insert = db.query(`
    INSERT INTO logs (
      ts, ts_nanos, level, target, feedback_log_body,
      module_path, file, line, thread_id, process_uuid, estimated_bytes
    ) VALUES (?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
  `);
  insert.run(1, "TRACE", "codex_api::sse", "PRIVATE prompt alpha", "proc-a", 100);
  insert.run(2, "TRACE", "codex_api::sse", "PRIVATE prompt beta", "proc-a", 200);
  insert.run(3, "INFO", "codex_core", "PRIVATE info body", "proc-a", 50);
  insert.run(4, "WARN", "codex_core", "PRIVATE warning body", "proc-b", 75);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of ["-wal", "-shm"]) {
    try {
      unlinkSync(`${path}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
}

function snapshotDir(path: string): Map<string, { size: number; mtimeMs: number }> {
  const snapshot = new Map<string, { size: number; mtimeMs: number }>();
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    const stat = statSync(full);
    snapshot.set(name, { size: stat.size, mtimeMs: stat.mtimeMs });
  }
  return snapshot;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex Log Guard inspection", () => {
  test("inspects only canonical logs_2.sqlite from resolved sqlite_home", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const sqliteHome = join(root, "sqlite-home");
    mkdirSync(codexHome);
    mkdirSync(sqliteHome);
    writeFileSync(join(codexHome, "config.toml"), `sqlite_home = ${JSON.stringify(sqliteHome)}\n`);
    createCurrentLogsDb(join(sqliteHome, "logs_2.sqlite"));
    writeFileSync(join(sqliteHome, "logs_99.sqlite"), "not a database");

    const report = inspectCodexLogs({ codexHome });

    expect(report.externalSqliteHome).toBe(true);
    expect(report).not.toHaveProperty("sqliteHome");
    expect(report).not.toHaveProperty("databasePath");
    expect(report).not.toHaveProperty("codexHome");
    expect(report.schema.state).toBe("compatible");
    expect(report.capabilities).toEqual({
      inspection: { state: "supported" },
      protection: { state: "supported" },
      reclaim: { state: "supported" },
    });
    expect(report.metrics?.totalRows).toBe(4);
    expect(report.metrics?.rowsByLevel).toEqual({ INFO: 1, TRACE: 2, WARN: 1 });
    expect(report.metrics?.traceRows).toBe(2);
    expect(report.metrics?.traceShare).toBe(0.5);
    expect(report.metrics?.topTargets[0]).toEqual({ target: "TARGET_1", rows: 2 });
    expect(report.metrics?.reclaimableBytes).toBeGreaterThanOrEqual(0);
  });

  test("never exposes feedback bodies, arbitrary levels, target names, or paths", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const databasePath = join(codexHome, "logs_2.sqlite");
    const sensitiveTarget = "token=abc@diagnostic-target";
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(databasePath);

    const db = new Database(databasePath);
    db.query(`
      INSERT INTO logs (
        ts, ts_nanos, level, target, feedback_log_body,
        module_path, file, line, thread_id, process_uuid, estimated_bytes
      ) VALUES (?, 0, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)
    `).run(5, "SECRET_LEVEL_TOKEN", sensitiveTarget, "PRIVATE injected body", "proc-c", 25);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();

    const report = inspectCodexLogs({ codexHome });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("PRIVATE prompt alpha");
    expect(serialized).not.toContain("PRIVATE prompt beta");
    expect(serialized).not.toContain("PRIVATE info body");
    expect(serialized).not.toContain("PRIVATE injected body");
    expect(serialized).not.toContain("feedback_log_body");
    expect(serialized).not.toContain("SECRET_LEVEL_TOKEN");
    expect(serialized).not.toContain(sensitiveTarget);
    expect(serialized).not.toContain(codexHome);
    expect(report.metrics?.rowsByLevel.OTHER).toBe(1);
    expect(report.metrics?.topTargets.every(item => /^TARGET_\d+$/.test(item.target))).toBe(true);
  });

  test("performs zero filesystem writes and does not create WAL/SHM sidecars", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(join(codexHome, "logs_2.sqlite"));
    const before = snapshotDir(codexHome);

    inspectCodexLogs({ codexHome });

    const after = snapshotDir(codexHome);
    expect(after).toEqual(before);
    expect(readdirSync(codexHome)).not.toContain("logs_2.sqlite-wal");
    expect(readdirSync(codexHome)).not.toContain("logs_2.sqlite-shm");
  });

  test("monitors an unknown future schema but refuses mutation capabilities", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(join(codexHome, "logs_2.sqlite"));
    const db = new Database(join(codexHome, "logs_2.sqlite"));
    db.exec("ALTER TABLE logs ADD COLUMN future_field TEXT");
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema.state).toBe("unsupported");
    expect(report.schema.reason).toBe("unknown_schema");
    expect(report.metrics?.totalRows).toBe(4);
    expect(report.capabilities.inspection).toEqual({ state: "supported" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "unknown_schema" });
  });

  test("refuses a same-name logs view as mutation-compatible", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const databasePath = join(codexHome, "logs_2.sqlite");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(databasePath);
    const db = new Database(databasePath);
    db.exec(`
      ALTER TABLE logs RENAME TO logs_source;
      CREATE VIEW logs AS
        SELECT id, ts, ts_nanos, level, target, feedback_log_body, module_path,
               file, line, thread_id, process_uuid, estimated_bytes
        FROM logs_source;
    `);
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "unknown_schema" });
  });

  test("refuses changed column types or constraints despite matching names", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const databasePath = join(codexHome, "logs_2.sqlite");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(databasePath);
    const db = new Database(databasePath);
    db.exec(`
      ALTER TABLE logs RENAME TO logs_source;
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        level BLOB NOT NULL,
        target TEXT NOT NULL,
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "unknown_schema" });
  });

  test("refuses same columns when table-level DDL differs", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const databasePath = join(codexHome, "logs_2.sqlite");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(databasePath);
    const db = new Database(databasePath);
    db.exec(`
      ALTER TABLE logs RENAME TO logs_source;
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        level TEXT NOT NULL,
        target TEXT NOT NULL,
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "unknown_schema" });
  });

  test("requires every canonical Codex logs index", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const databasePath = join(codexHome, "logs_2.sqlite");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(databasePath);
    const db = new Database(databasePath);
    db.exec("DROP INDEX idx_logs_thread_id_ts");
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "unknown_schema" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "unknown_schema" });
  });

  test("allows unrelated user triggers without weakening schema validation", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const databasePath = join(codexHome, "logs_2.sqlite");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    createCurrentLogsDb(databasePath);
    const db = new Database(databasePath);
    db.exec(`
      CREATE TRIGGER user_logs_observer
      AFTER INSERT ON logs
      BEGIN
        SELECT 1;
      END;
    `);
    db.close();

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "compatible" });
    expect(report.capabilities.protection).toEqual({ state: "supported" });
    expect(report.capabilities.reclaim).toEqual({ state: "supported" });
  });

  test("returns path-private unavailable state when sqlite_home resolution fails", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    const privatePath = join(root, "private-config-location");
    mkdirSync(codexHome);

    const report = inspectCodexLogs({
      codexHome,
      readConfig: () => {
        const error = new Error(`cannot read ${privatePath}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
    });
    const serialized = JSON.stringify(report);

    expect(report.externalSqliteHome).toBeNull();
    expect(report.schema).toEqual({ state: "unavailable", reason: "inspect_failed" });
    expect(report.capabilities).toEqual({
      inspection: { state: "unsupported", reason: "inspect_failed" },
      protection: { state: "unsupported", reason: "inspect_failed" },
      reclaim: { state: "unsupported", reason: "inspect_failed" },
    });
    expect(report.files).toEqual({ databaseBytes: 0, walBytes: 0, shmBytes: 0 });
    expect(report.metrics).toBeNull();
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(privatePath);
  });

  test("reports a missing canonical database without falling back to logs_N", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    writeFileSync(join(codexHome, "logs_3.sqlite"), "future-looking file");

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "missing", reason: "database_missing" });
    expect(report.metrics).toBeNull();
    expect(report.files).toEqual({ databaseBytes: 0, walBytes: 0, shmBytes: 0 });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "database_missing" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "database_missing" });
  });

  test("treats a canonical database directory as unreadable, not missing", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    mkdirSync(join(codexHome, "logs_2.sqlite"));

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unreadable", reason: "database_unreadable" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "database_unreadable" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "database_unreadable" });
  });

  test("treats an existing empty canonical database as unreadable, not missing", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    writeFileSync(join(codexHome, "logs_2.sqlite"), "");

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unreadable", reason: "database_unreadable" });
    expect(report.files.databaseBytes).toBe(0);
    expect(report.capabilities.inspection).toEqual({ state: "supported" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "database_unreadable" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "database_unreadable" });
  });

  test("degrades unreadable databases to inspectable metadata instead of throwing", () => {
    const root = makeRoot();
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "");
    writeFileSync(join(codexHome, "logs_2.sqlite"), "not sqlite");

    const report = inspectCodexLogs({ codexHome });

    expect(report.schema).toEqual({ state: "unreadable", reason: "database_unreadable" });
    expect(report.files.databaseBytes).toBeGreaterThan(0);
    expect(report.metrics).toBeNull();
    expect(report.capabilities.inspection).toEqual({ state: "supported" });
    expect(report.capabilities.protection).toEqual({ state: "unsupported", reason: "database_unreadable" });
    expect(report.capabilities.reclaim).toEqual({ state: "unsupported", reason: "database_unreadable" });
  });
  test("repeat inspection is memoized and invalidated by a write", () => {
    // readMetrics runs four unbounded aggregates over the whole logs table, and
    // bun:sqlite is synchronous, so every repeat scan occupies the proxy thread.
    // A dashboard refresh, a page rendering both panels, and a poll loop all
    // repeat an identical scan; memoizing on database+WAL identity removes that.
    const root = makeRoot();
    const databasePath = join(root, "logs_2.sqlite");
    createCurrentLogsDb(databasePath);

    resetCodexLogGuardInspectionCache();
    const first = inspectCodexLogs({ codexHome: root });
    const second = inspectCodexLogs({ codexHome: root });
    // Same object identity proves the aggregates did not run a second time.
    expect(second).toBe(first);

    // A write must invalidate: a cached answer is never staler than
    // "nothing has been written since".
    const db = new Database(databasePath);
    db.run("INSERT INTO logs (ts, ts_nanos, level, target, estimated_bytes) VALUES (1, 1, 'INFO', 'later', 64)");
    db.close();

    const third = inspectCodexLogs({ codexHome: root });
    expect(third).not.toBe(first);
    expect(third.metrics?.totalRows).toBe((first.metrics?.totalRows ?? 0) + 1);
  });

  test("resetCodexLogGuardInspectionCache forces a fresh scan", () => {
    const root = makeRoot();
    createCurrentLogsDb(join(root, "logs_2.sqlite"));

    resetCodexLogGuardInspectionCache();
    const first = inspectCodexLogs({ codexHome: root });
    expect(inspectCodexLogs({ codexHome: root })).toBe(first);

    resetCodexLogGuardInspectionCache();
    expect(inspectCodexLogs({ codexHome: root })).not.toBe(first);
  });
  test("an atomic replacement at identical size and mtime still invalidates", () => {
    // size:mtimeMs is not an identity. Writing a new file and renaming it over
    // the old one can preserve both, and the cache then served the previous
    // schema verdict indefinitely - a persistent wrong answer, which is worse
    // than the repeated scan the cache exists to avoid.
    const root = makeRoot();
    const databasePath = join(root, "logs_2.sqlite");
    createCurrentLogsDb(databasePath);

    resetCodexLogGuardInspectionCache();
    const before = inspectCodexLogs({ codexHome: root });
    expect(before.schema.state).toBe("compatible");

    const original = statSync(databasePath);
    const replacement = join(root, "replacement.tmp");
    // A file of the same byte length that is NOT a usable database.
    writeFileSync(replacement, Buffer.alloc(original.size, 0x41));
    renameSync(replacement, databasePath);
    utimesSync(databasePath, original.atime, original.mtime);

    const after = inspectCodexLogs({ codexHome: root });
    expect(after).not.toBe(before);
    expect(after.schema.state).not.toBe("compatible");
  });
});
