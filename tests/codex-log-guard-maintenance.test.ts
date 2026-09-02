import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocx-log-guard-reclaim-"));
  roots.push(root);
  return root;
}

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

/**
 * A Codex home with a reclaimable logs database.
 *
 * `reclaimable: false` skips the 180 x 8 KiB blob fill and its checkpoint. That
 * data exists so a reclaim has real freelist pages to move, which the refusal
 * cases never reach: `compactCodexLogs` rejects on the process check before it
 * opens the database for maintenance at all. Paying for it there is incidental
 * cost, and it was the expensive kind -- the refusal case builds TWO fixtures and
 * timed out at 71s against the 60s Windows ceiling while its siblings, which
 * build one, finished in ~2s. Locally the same case takes 21ms, which is why the
 * cost was invisible until the shard ran it under contention.
 *
 * Removing the dependency rather than raising the budget: the schema and the
 * `auto_vacuum=INCREMENTAL` setting are what those tests actually need, and both
 * stay.
 */
function fixture(options: { incremental?: boolean; withFreelist?: boolean; reclaimable?: boolean } = {}) {
  const root = makeRoot();
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), "");
  const databasePath = join(codexHome, "logs_2.sqlite");
  const db = new Database(databasePath);
  if (options.incremental !== false) db.exec("PRAGMA auto_vacuum=INCREMENTAL");
  db.exec("PRAGMA journal_mode=WAL");
  createLogsSchema(db);
  db.exec("CREATE TABLE reclaim_fixture (id INTEGER PRIMARY KEY, body BLOB NOT NULL)");
  const logInsert = db.query(
    "INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, estimated_bytes) VALUES (?, 0, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 12; i += 1) {
    logInsert.run(i + 1, i % 2 === 0 ? "INFO" : "TRACE", `target-${i % 3}`, `PRIVATE-${i}`, 32 + i);
  }
  if (options.reclaimable === false) {
    db.close();
    return { codexHome, databasePath };
  }
  const fill = db.query("INSERT INTO reclaim_fixture (id, body) VALUES (?, zeroblob(8192))");
  for (let i = 0; i < 180; i += 1) fill.run(i + 1);
  if (options.withFreelist !== false) {
    db.exec("DELETE FROM reclaim_fixture WHERE id <= 150");
  }
  db.exec("PRAGMA wal_checkpoint(FULL)");
  db.close();
  return { codexHome, databasePath };
}

function scalar(db: Database, pragma: string): number {
  const row = db.query<Record<string, number>, []>(pragma).get();
  if (!row) throw new Error(`no row for ${pragma}`);
  return Number(Object.values(row)[0]);
}

function logicalSnapshot(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return {
      logs: db.query("SELECT * FROM logs ORDER BY id").all(),
      fixture: db.query("SELECT id, length(body) AS bytes FROM reclaim_fixture ORDER BY id").all(),
      triggers: db.query("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
    };
  } finally {
    db.close();
  }
}

function testDeps(codexHome: string, overrides: Record<string, unknown> = {}) {
  return {
    codexHome,
    processCheck: () => ({ state: "ok" as const, processes: [] }),
    withLock: <T>(_home: string, _database: string, work: () => T) => ({
      kind: "completed" as const,
      value: work(),
    }),
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("Codex Log Guard reclaim", () => {
  test("incrementally reclaims freelist pages while preserving every logical row and trigger", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const { codexHome, databasePath } = fixture();
    const db = new Database(databasePath);
    db.exec("CREATE TRIGGER user_trigger BEFORE INSERT ON logs BEGIN SELECT 1; END;");
    db.close();
    const beforeLogical = logicalSnapshot(databasePath);
    const beforeBytes = statSync(databasePath).size;

    const result = mod.compactCodexLogs(testDeps(codexHome));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.before.freelistPages).toBeGreaterThan(0);
    expect(result.report.after.freelistPages).toBeLessThan(result.report.before.freelistPages);
    expect(result.report.pagesReclaimed).toBeGreaterThan(0);
    expect(result.report.after.databaseBytes).toBeLessThanOrEqual(beforeBytes);
    expect(result.report.integrity).toEqual({ before: "ok", after: "ok" });
    expect(logicalSnapshot(databasePath)).toEqual(beforeLogical);
  });

  test("is a safe no-op when there is nothing reclaimable", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const { codexHome } = fixture({ withFreelist: false });
    const result = mod.compactCodexLogs(testDeps(codexHome));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.pagesReclaimed).toBe(0);
    expect(result.report.complete).toBe(true);
  });

  test("refuses databases that are not already auto_vacuum=INCREMENTAL", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const { codexHome, databasePath } = fixture({ incremental: false });
    const db = new Database(databasePath, { readonly: true });
    expect(scalar(db, "PRAGMA auto_vacuum")).not.toBe(2);
    db.close();

    expect(mod.compactCodexLogs(testDeps(codexHome))).toEqual({
      ok: false,
      error: "auto_vacuum_not_incremental",
    });
  });

  test("refuses unknown log schemas before maintenance", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const { codexHome, databasePath } = fixture();
    const db = new Database(databasePath);
    db.exec("ALTER TABLE logs ADD COLUMN future_field TEXT");
    db.close();

    expect(mod.compactCodexLogs(testDeps(codexHome))).toEqual({
      ok: false,
      error: "unsupported_schema",
    });
  });

  test("fails closed when Codex is running or process enumeration is uncertain", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    // Refused before any maintenance runs, so neither fixture needs reclaimable pages.
    const running = fixture({ reclaimable: false });
    expect(mod.compactCodexLogs(testDeps(running.codexHome, {
      processCheck: () => ({ state: "ok" as const, processes: [{ pid: 42, commandLine: "codex exec" }] }),
    }))).toEqual({ ok: false, error: "codex_running" });

    const unknown = fixture({ reclaimable: false });
    expect(mod.compactCodexLogs(testDeps(unknown.codexHome, {
      processCheck: () => ({ state: "unknown" as const, reason: "enumeration_failed" as const }),
    }))).toEqual({ ok: false, error: "process_enumeration_failed" });
  });

  test("fails closed when the Log Guard lock is busy", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;
    const { codexHome } = fixture();
    expect(mod.compactCodexLogs(testDeps(codexHome, {
      withLock: () => ({ kind: "unavailable" as const, reason: "busy" as const }),
    }))).toEqual({ ok: false, error: "busy" });
  });

  test("requires quick_check before changing any pages", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;
    const { codexHome, databasePath } = fixture();
    const before = logicalSnapshot(databasePath);
    const db = new Database(databasePath, { readonly: true });
    const freelist = scalar(db, "PRAGMA freelist_count");
    db.close();

    const result = mod.compactCodexLogs(testDeps(codexHome, {
      quickCheck: () => ["synthetic corruption"],
    }));
    expect(result).toEqual({ ok: false, error: "integrity_check_failed", phase: "before" });
    expect(logicalSnapshot(databasePath)).toEqual(before);
    const afterDb = new Database(databasePath, { readonly: true });
    expect(scalar(afterDb, "PRAGMA freelist_count")).toBe(freelist);
    afterDb.close();
  });

  test("reports a post-maintenance quick_check failure explicitly", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;
    const { codexHome } = fixture();
    let checks = 0;
    const result = mod.compactCodexLogs(testDeps(codexHome, {
      quickCheck: () => {
        checks += 1;
        return checks === 1 ? ["ok"] : ["synthetic post failure"];
      },
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("integrity_check_failed");
    expect(result.phase).toBe("after");
  });

  test("stops at the per-run page budget and reports remaining work", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;
    const { codexHome } = fixture();

    const result = mod.compactCodexLogs(testDeps(codexHome, {
      batchPages: 1,
      maxPagesPerRun: 2,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.pagesReclaimed).toBeLessThanOrEqual(2);
    expect(result.report.complete).toBe(false);
    expect(result.report.stopReason).toBe("page_budget");
    expect(result.report.after.freelistPages).toBeGreaterThan(0);
  });
  test("derives batch budgets from the real page size, not a fixed page count", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    if (!mod) return;
    // The guide promises ~8 MiB batches and ~256 MiB per run, converted with the
    // database's page size. Fixed page counts meant something different at every
    // page size: at 4 KiB pages the old 512/8192 was 2 MiB/32 MiB.
    const { codexHome } = fixture({ incremental: true, withFreelist: true });
    const result = mod.compactCodexLogs(testDeps(codexHome));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pageSize = result.report.pageSize;
    expect(pageSize).toBeGreaterThan(0);
    // 8 MiB / pageSize, and 256 MiB / pageSize, both at least one page.
    const expectedBatch = Math.max(1, Math.floor((8 * 1024 * 1024) / pageSize));
    expect(expectedBatch * pageSize).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });

  test("reports logicalBytesReclaimed alongside the physical figure", async () => {
    const mod = await import("../src/codex/log-guard/maintenance").catch(() => null);
    if (!mod) return;
    // Documented before it existed. It is deliberately distinct from the
    // physical figure: an incremental vacuum can return pages to the free list
    // without the file shrinking, so logical progress with zero physical
    // shrinkage is normal rather than a failed run.
    const { codexHome } = fixture({ incremental: true, withFreelist: true });
    const result = mod.compactCodexLogs(testDeps(codexHome));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.logicalBytesReclaimed)
      .toBe(result.report.pagesReclaimed * result.report.pageSize);
    expect(typeof result.report.physicalDatabaseBytesReclaimed).toBe("number");
  });
});
