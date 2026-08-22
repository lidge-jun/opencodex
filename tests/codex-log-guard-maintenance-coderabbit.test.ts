import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compactCodexLogs,
  type CodexLogGuardMaintenanceDeps,
} from "../src/codex/log-guard/maintenance";

const roots: string[] = [];

function createLogsSchema(db: Database): void {
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
}

function fixture(): { codexHome: string; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-cr-reclaim-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const databasePath = join(codexHome, "logs_2.sqlite");
  const db = new Database(databasePath);
  db.exec("PRAGMA auto_vacuum=INCREMENTAL");
  db.exec("PRAGMA journal_mode=WAL");
  createLogsSchema(db);
  db.exec("CREATE TABLE reclaim_fixture (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
  const fill = db.query("INSERT INTO reclaim_fixture (id, body) VALUES (?, zeroblob(8192))");
  for (let i = 0; i < 220; i += 1) fill.run(i + 1);
  db.exec("DELETE FROM reclaim_fixture WHERE id <= 200");
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.close();
  return { codexHome, databasePath };
}

function scalar(path: string, pragma: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query<Record<string, number>, []>(pragma).get();
    if (!row) throw new Error(`missing ${pragma}`);
    return Number(Object.values(row)[0]);
  } finally {
    db.close();
  }
}

function deps(
  codexHome: string,
  extra: Partial<CodexLogGuardMaintenanceDeps> = {},
): CodexLogGuardMaintenanceDeps {
  return {
    codexHome,
    processCheck: () => ({ state: "ok" as const, processes: [] }),
    withLock: <T>(_home: string, _database: string, work: () => T) => ({
      kind: "completed" as const,
      value: work(),
    }),
    ...extra,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CodeRabbit Log Guard reclaim regressions", () => {
  test("rejects a regular-file replacement between the pre-open check and SQLite open", () => {
    const { codexHome, databasePath } = fixture();
    const backup = `${databasePath}.original`;
    let opened = false;

    const result = compactCodexLogs(deps(codexHome, {
      openDatabase: (path: string, flags: number) => {
        opened = true;
        renameSync(path, backup);
        copyFileSync(backup, path); // same bytes, different filesystem identity
        return new Database(path, flags);
      },
    }));

    expect(opened).toBe(true);
    expect(result).toEqual({ ok: false, error: "unsafe_path" });
  });

  test("rechecks Codex processes after acquiring the Log Guard lock", () => {
    const { codexHome } = fixture();
    let checks = 0;
    const result = compactCodexLogs(deps(codexHome, {
      processCheck: () => {
        checks += 1;
        return checks === 1
          ? { state: "ok" as const, processes: [] }
          : { state: "ok" as const, processes: [{ pid: 42, commandLine: "codex exec" }] };
      },
    }));

    expect(result).toEqual({ ok: false, error: "codex_running" });
    expect(checks).toBe(2);
  });

  test("classifies continuous progress stopped by MAX_ITERATIONS as bounded work", () => {
    const { codexHome } = fixture();
    const result = compactCodexLogs(deps(codexHome, {
      batchPages: 1,
      maxPagesPerRun: 100_000,
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.before.freelistPages).toBeGreaterThan(64);
    expect(result.report.iterations).toBe(64);
    expect(result.report.pagesReclaimed).toBeGreaterThan(0);
    expect(result.report.after.freelistPages).toBeGreaterThan(0);
    expect(result.report.stopReason).toBe("page_budget");
  });

  test("refuses compaction when a WAL reader prevents the initial FULL checkpoint", () => {
    const { codexHome, databasePath } = fixture();
    const reader = new Database(databasePath, { readonly: true });
    let result;
    const beforeFreelist = scalar(databasePath, "PRAGMA freelist_count");
    try {
      reader.exec("BEGIN");
      reader.query("SELECT count(*) AS n FROM logs").get();

      const writer = new Database(databasePath);
      try {
        writer.query(
          "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (1, 0, 'INFO', 'test', NULL, 1)",
        ).run();
      } finally {
        writer.close();
      }

      result = compactCodexLogs(deps(codexHome));
      expect(result).toEqual({ ok: false, error: "busy" });
      expect(scalar(databasePath, "PRAGMA freelist_count")).toBe(beforeFreelist);
    } finally {
      try { reader.exec("ROLLBACK"); } catch { /* close releases the read transaction */ }
      reader.close();
    }
  });

  test("reports a busy checkpoint as partial success after a vacuum batch commits", () => {
    const { codexHome, databasePath } = fixture();
    const testDeps = deps(codexHome);
    let reader: Database | undefined;
    let getterReads = 0;

    // Injection point: runCompaction reads batchPages after its initial FULL
    // checkpoint and before the first incremental-vacuum batch. Creating the
    // blocking reader here makes only the mid-loop checkpoint busy.
    Object.defineProperty(testDeps, "batchPages", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        if (!reader) {
          reader = new Database(databasePath, { readonly: true });
          reader.exec("BEGIN");
          reader.query("SELECT count(*) AS n FROM logs").get();
          const writer = new Database(databasePath);
          try {
            writer.query(
              "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (2, 0, 'INFO', 'after-initial-checkpoint', NULL, 1)",
            ).run();
          } finally {
            writer.close();
          }
        }
        return 1;
      },
    });

    try {
      const result = compactCodexLogs(testDeps);
      expect(getterReads).toBe(1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.report.iterations).toBe(1);
      expect(result.report.pagesReclaimed).toBeGreaterThan(0);
      expect(result.report.stopReason).toBe("busy");
      expect(result.report.after.freelistPages).toBeLessThan(result.report.before.freelistPages);
    } finally {
      if (reader) {
        try { reader.exec("ROLLBACK"); } catch { /* close releases the read transaction */ }
        reader.close();
      }
    }
  });

  test("reports thrown SQLITE_BUSY as partial success after an earlier batch commits", () => {
    const { codexHome, databasePath } = fixture();
    let vacuumCalls = 0;

    const result = compactCodexLogs(deps(codexHome, {
      batchPages: 1,
      maxPagesPerRun: 100_000,
      openDatabase: (path: string, flags: number) => {
        const inner = new Database(path, flags);
        return new Proxy(inner, {
          get(target, property) {
            if (property === "exec") {
              return (sql: string) => {
                if (/^PRAGMA incremental_vacuum\(/.test(sql)) {
                  vacuumCalls += 1;
                  if (vacuumCalls === 2) {
                    const error = new Error("database is locked") as Error & { code?: string };
                    error.code = "SQLITE_BUSY";
                    throw error;
                  }
                }
                return target.exec(sql);
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as Database;
      },
    }));

    expect(vacuumCalls).toBe(2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.iterations).toBe(1);
    expect(result.report.pagesReclaimed).toBeGreaterThan(0);
    expect(result.report.stopReason).toBe("busy");
    expect(result.report.after.freelistPages).toBeLessThan(result.report.before.freelistPages);
  });
});
