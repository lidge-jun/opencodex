import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computePreviewDigest,
  executeArchivedCleanup,
  listArchivedCandidates,
  listTrashEntries,
  normalizeArchivedRolloutPath,
  previewArchivedCleanup,
  previewExactArchivedCleanup,
  restoreTrashEntry,
  selectOldestPercent,
  type ExecuteCleanupOptions,
} from "../src/storage/cleanup";
import { STORE_BUDGET_MS } from "./helpers/test-budget";

const OLD = new Date("2026-01-01T00:00:00Z");
const MID = new Date("2026-02-01T00:00:00Z");
const NEW = new Date("2026-03-01T00:00:00Z");

let home = "";

afterEach(() => {
  if (home) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
    home = "";
  }
});

function seedLogsStore(dir: string): void {
  const logs = new Database(join(dir, "logs_2.sqlite"));
  logs.exec(`CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ts_nanos INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL,
    target TEXT NOT NULL,
    thread_id TEXT,
    estimated_bytes INTEGER NOT NULL DEFAULT 0
  )`);
  logs.exec(`INSERT INTO logs (ts, level, target, thread_id, estimated_bytes) VALUES
    (1,'INFO','t','told',10),
    (2,'INFO','t','tmid',10),
    (3,'INFO','t','active',10),
    (4,'INFO','t','tnew',10)`);
  logs.close();
}

function seedGoalsStore(dir: string): void {
  const goals = new Database(join(dir, "goals_1.sqlite"));
  goals.exec(`CREATE TABLE thread_goals (
    thread_id TEXT PRIMARY KEY NOT NULL,
    goal_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_used_seconds INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`);
  goals.exec(`CREATE TABLE thread_goal_continuation_deferrals (
    thread_id TEXT PRIMARY KEY NOT NULL REFERENCES thread_goals(thread_id) ON DELETE CASCADE
  )`);
  goals.exec(`INSERT INTO thread_goals VALUES
    ('told','g1','old','complete',0,0,1,1),
    ('tmid','g2','mid','active',0,0,2,2),
    ('active','g3','live','active',0,0,3,3)`);
  goals.exec(`INSERT INTO thread_goal_continuation_deferrals VALUES ('tmid')`);
  goals.close();
}

function seedMemoriesStore(dir: string): void {
  const memories = new Database(join(dir, "memories_1.sqlite"));
  memories.exec(`CREATE TABLE stage1_outputs (
    thread_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0
  )`);
  memories.exec(`CREATE TABLE jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
  )`);
  memories.exec(`INSERT INTO stage1_outputs VALUES
    ('told',1,'m-old','s-old',1,0),
    ('tmid',2,'m-mid','s-mid',2,1),
    ('active',3,'m-live','s-live',3,0)`);
  memories.exec(`INSERT INTO jobs VALUES
    ('memory_stage1','told','done',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL),
    ('memory_stage1','tmid','done',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL),
    ('memory_stage1','active','done',NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,NULL,NULL),
    ('memory_consolidate_global','global','done',NULL,NULL,NULL,NULL,NULL,NULL,3,NULL,0,0)`);
  memories.close();
}

function seedSatelliteStores(dir: string): void {
  seedLogsStore(dir);
  seedGoalsStore(dir);
  seedMemoriesStore(dir);
}

function buildHome(opts?: {
  withSpawnEdges?: boolean;
  withDynamicTools?: boolean;
  withSatelliteStores?: boolean;
  satellites?: "all" | "logs" | "memories" | "goals";
}): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-cleanup-"));
  mkdirSync(join(dir, "sessions", "2026", "05", "27"), { recursive: true });
  writeFileSync(join(dir, "sessions", "2026", "05", "27", "rollout-active.jsonl"), "ACTIVE".repeat(20));

  mkdirSync(join(dir, "archived_sessions"));
  writeFileSync(join(dir, "archived_sessions", "rollout-old.jsonl"), "OLD".repeat(10));
  writeFileSync(join(dir, "archived_sessions", "rollout-mid.jsonl"), "MID".repeat(20));
  writeFileSync(join(dir, "archived_sessions", "rollout-new.jsonl"), "NEW".repeat(30));
  utimesSync(join(dir, "archived_sessions", "rollout-old.jsonl"), OLD, OLD);
  utimesSync(join(dir, "archived_sessions", "rollout-mid.jsonl"), MID, MID);
  utimesSync(join(dir, "archived_sessions", "rollout-new.jsonl"), NEW, NEW);

  const db = new Database(join(dir, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    rollout_path TEXT NOT NULL,
    archived INTEGER,
    archived_at INTEGER,
    history_mode TEXT
  )`);
  db.exec(`INSERT INTO threads VALUES
    ('active','sessions/2026/05/27/rollout-active.jsonl',0,NULL,'legacy'),
    ('told','archived_sessions/rollout-old.jsonl',1,1,'legacy'),
    ('tmid','archived_sessions/rollout-mid.jsonl',1,2,'legacy'),
    ('tnew','archived_sessions/rollout-new.jsonl',1,3,'legacy')
  `);
  if (opts?.withSpawnEdges) {
    db.exec(`CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO thread_spawn_edges VALUES ('told','tmid','active')`);
  }
  if (opts?.withDynamicTools) {
    db.exec(`CREATE TABLE thread_dynamic_tools (
      thread_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      input_schema TEXT NOT NULL,
      PRIMARY KEY(thread_id, position),
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    )`);
    db.exec(`INSERT INTO thread_dynamic_tools VALUES ('told',0,'tool','d','{}')`);
  }
  db.close();
  const satellites = opts?.satellites ?? (opts?.withSatelliteStores ? "all" : undefined);
  if (satellites === "all") seedSatelliteStores(dir);
  else if (satellites === "logs") seedLogsStore(dir);
  else if (satellites === "memories") seedMemoriesStore(dir);
  else if (satellites === "goals") seedGoalsStore(dir);
  return dir;
}

function runWithDigest(
  percent: number,
  mode: "quarantine" | "permanent",
  codexHome: string,
  extra?: {
    busyTimeoutMs?: number;
    now?: number;
    digest?: string;
    _test?: ExecuteCleanupOptions["_test"];
  },
) {
  const preview = previewArchivedCleanup(percent, codexHome);
  return executeArchivedCleanup({
    percent,
    mode,
    digest: extra?.digest ?? preview.digest,
    codexHome,
    busyTimeoutMs: extra?.busyTimeoutMs,
    now: extra?.now,
    _test: extra?._test,
  });
}

describe("pinned archived threads", () => {
  function pinThread(homeDir: string, threadId: string): void {
    const db = new Database(join(homeDir, "state_5.sqlite"));
    const hasColumn = db
      .query<{ name: string }, []>(`PRAGMA table_info("threads")`)
      .all()
      .some(r => r.name === "is_pinned");
    if (!hasColumn) {
      db.exec("ALTER TABLE threads ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
    }
    db.exec(`UPDATE threads SET is_pinned = 1 WHERE id = '${threadId}'`);
    db.close();
  }

  test.each(["quarantine", "permanent"] as const)(
    "%s excludes pinned threads from preview and execution",
    mode => {
      home = buildHome();
      pinThread(home, "told");

      const preview = previewArchivedCleanup(50, home);
      expect(preview.candidates.map(c => c.relPath)).toEqual([
        "archived_sessions/rollout-mid.jsonl",
      ]);

      const result = executeArchivedCleanup({
        percent: 50,
        mode,
        digest: preview.digest,
        codexHome: home,
      });
      expect(result.ok).toBe(true);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);

      const check = new Database(join(home, "state_5.sqlite"), { readonly: true });
      expect(check.query("SELECT id FROM threads WHERE id = 'told'").get()).toBeTruthy();
      check.close();
    },
    { timeout: STORE_BUDGET_MS },
  );

  test("pinning after preview fails closed as stale_preview", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(50, home);
    expect(preview.candidates.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
    ]);

    pinThread(home, "told");

    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: preview.digest,
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stale_preview");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("exact-candidate preview also excludes pinned threads", () => {
    home = buildHome();
    pinThread(home, "told");
    const all = listArchivedCandidates(home);
    const preview = previewExactArchivedCleanup(all, home);
    expect(preview.candidates.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-mid.jsonl",
      "archived_sessions/rollout-new.jsonl",
    ]);
  }, { timeout: STORE_BUDGET_MS });

  test("pin landing after staging stops the locked reconcile and restores files", () => {
    home = buildHome();
    // Schema carries the column but nothing is pinned yet, so the preview
    // still selects the oldest archived thread.
    const db0 = new Database(join(home, "state_5.sqlite"));
    db0.exec("ALTER TABLE threads ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0");
    db0.close();

    const preview = previewArchivedCleanup(50, home);
    expect(preview.candidates.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
    ]);

    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: preview.digest,
      codexHome: home,
      _test: {
        // The realistic race: the pin lands between preview/digest
        // recompute and the reconcile write lock.
        beforeReconcileLock: () => {
          const db = new Database(join(home, "state_5.sqlite"));
          db.exec("UPDATE threads SET is_pinned = 1 WHERE id = 'told'");
          db.close();
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("pinned_thread");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);

    const check = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(check.query("SELECT id FROM threads WHERE id = 'told'").get()).toBeTruthy();
    check.close();
  }, { timeout: STORE_BUDGET_MS });
});

describe("previewArchivedCleanup", () => {
  test("lists archived files oldest-first and ignores active sessions", () => {
    home = buildHome();
    const listed = listArchivedCandidates(home);
    expect(listed.map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
      "archived_sessions/rollout-new.jsonl",
    ]);
    expect(listed.some(c => c.relPath.includes("sessions/2026"))).toBe(false);
  }, { timeout: STORE_BUDGET_MS });

  test("percent selects oldest subset and includes digest", () => {
    home = buildHome();
    const all = listArchivedCandidates(home);
    expect(selectOldestPercent(all, 0)).toEqual([]);
    expect(selectOldestPercent(all, 34).map(c => c.relPath)).toEqual([
      "archived_sessions/rollout-old.jsonl",
    ]);
    expect(selectOldestPercent(all, 100)).toHaveLength(3);
    const preview = previewArchivedCleanup(50, home);
    expect(preview.count).toBe(1);
    expect(preview.candidates[0]!.relPath).toBe("archived_sessions/rollout-old.jsonl");
    expect(preview.bytes).toBe(preview.candidates[0]!.bytes);
    expect(preview.digest).toBe(computePreviewDigest(preview.candidates, 50));
    expect(preview.digest).toMatch(/^[a-f0-9]{64}$/);
  }, { timeout: STORE_BUDGET_MS });

  test("treats .jsonl and .jsonl.zst as one logical rollout", () => {
    home = buildHome();
    writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), "ZST");
    utimesSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), OLD, OLD);
    const listed = listArchivedCandidates(home);
    const old = listed.find(c => c.relPath === "archived_sessions/rollout-old.jsonl");
    expect(old).toBeTruthy();
    expect(old!.physicalRelPaths.sort()).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-old.jsonl.zst",
    ]);
    expect(listed.filter(c => c.relPath.includes("rollout-old"))).toHaveLength(1);
  }, { timeout: STORE_BUDGET_MS });
});

describe("normalizeArchivedRolloutPath", () => {
  test("accepts exact archived paths and rejects active / basename-only matches", () => {
    home = buildHome();
    expect(normalizeArchivedRolloutPath("archived_sessions/rollout-old.jsonl", home))
      .toBe("archived_sessions/rollout-old.jsonl");
    expect(normalizeArchivedRolloutPath("archived_sessions/rollout-old.jsonl.zst", home))
      .toBe("archived_sessions/rollout-old.jsonl");
    expect(normalizeArchivedRolloutPath(join(home, "archived_sessions", "rollout-old.jsonl"), home))
      .toBe("archived_sessions/rollout-old.jsonl");
    expect(normalizeArchivedRolloutPath("sessions/2026/05/27/rollout-active.jsonl", home)).toBeNull();
    expect(normalizeArchivedRolloutPath("rollout-old.jsonl", home)).toBeNull();
    // ISO timestamps in filenames must not be treated as Windows drive letters.
    expect(normalizeArchivedRolloutPath("archived_sessions/rollout-2026-01-01T10:00:00.jsonl", home))
      .toBe("archived_sessions/rollout-2026-01-01T10:00:00.jsonl");
  }, { timeout: STORE_BUDGET_MS });
});

describe("executeArchivedCleanup", () => {
  test("quarantine moves files to .trash and removes matching threads", () => {
    home = buildHome();
    const result = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_000 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(result.removedPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-active.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    const trashFile = join(home, ".trash", "1700000000000", "rollout-old.jsonl");
    expect(existsSync(trashFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(home, ".trash", "1700000000000", "manifest.json"), "utf8"));
    expect(manifest.entries[0].threadId).toBe("told");

    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map(r => r.id);
    db.close();
    expect(ids).toEqual(["active", "tmid", "tnew"]);
  }, { timeout: STORE_BUDGET_MS });

  test("permanent deletes files and threads without creating trash", () => {
    home = buildHome();
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(false);
    expect(existsSync(join(home, ".trash"))).toBe(false);
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-active.jsonl"))).toBe(true);

    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads").all().map(r => r.id);
    db.close();
    expect(ids).toEqual(["active"]);
  }, { timeout: STORE_BUDGET_MS });

  test("stale_preview when filesystem changed after preview", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(50, home);
    writeFileSync(join(home, "archived_sessions", "rollout-extra.jsonl"), "EXTRA");
    utimesSync(join(home, "archived_sessions", "rollout-extra.jsonl"), new Date("2025-01-01"), new Date("2025-01-01"));
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: preview.digest,
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stale_preview");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("concurrent archiving that changes mtime/metadata yields stale_preview", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(50, home);
    const target = join(home, "archived_sessions", "rollout-old.jsonl");
    writeFileSync(target, "OLD".repeat(10) + "CHANGED");
    utimesSync(target, OLD, OLD);
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: preview.digest,
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("stale_preview");
  });

  test("does not delete active thread that shares basename with archived file", () => {
    home = buildHome();
    // Active row points at sessions/.../rollout-old.jsonl (same basename as archive).
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`INSERT INTO threads VALUES ('dupe','sessions/2026/05/27/rollout-old.jsonl',0,NULL,'legacy')`);
    writeFileSync(join(home, "sessions", "2026", "05", "27", "rollout-old.jsonl"), "ACTIVE-DUPE");
    db.close();

    const result = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_001 });
    expect(result.ok).toBe(true);

    const check = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = check.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map(r => r.id);
    check.close();
    expect(ids).toContain("dupe");
    expect(ids).not.toContain("told");
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-old.jsonl"))).toBe(true);
  });

  test("codex_busy probe skips all filesystem mutations", () => {
    home = buildHome();
    const locker = new Database(join(home, "state_5.sqlite"));
    locker.exec("BEGIN EXCLUSIVE");
    try {
      const result = runWithDigest(100, "quarantine", home, { busyTimeoutMs: 1 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("codex_busy");
      expect(result.count).toBe(0);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(home, ".trash"))).toBe(false);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  // Windows CI: SQLite lock contention across satellite DBs can exceed the default 5s.
  test("busy final satellite lock rolls back earlier satellite write locks", () => {
    home = buildHome({ withSatelliteStores: true });
    const goalsLocker = new Database(join(home, "goals_1.sqlite"));
    goalsLocker.exec("BEGIN EXCLUSIVE");
    try {
      const result = runWithDigest(100, "permanent", home, { busyTimeoutMs: 1 });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("codex_busy");
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(home, ".trash"))).toBe(false);
    } finally {
      goalsLocker.exec("ROLLBACK");
      goalsLocker.close();
    }

    const logs = new Database(join(home, "logs_2.sqlite"));
    logs.exec(
      `INSERT INTO logs (ts, level, target, thread_id, estimated_bytes) VALUES (99,'INFO','t','writable-after-busy',99)`,
    );
    logs.close();
    const memories = new Database(join(home, "memories_1.sqlite"));
    memories.exec(
      `INSERT INTO stage1_outputs VALUES ('writable-after-busy',1,'m','s',1,0)`,
    );
    memories.close();

    let logsRead: Database | undefined;
    let memoriesRead: Database | undefined;
    try {
      logsRead = new Database(join(home, "logs_2.sqlite"), { readonly: true });
      memoriesRead = new Database(join(home, "memories_1.sqlite"), { readonly: true });
      expect(
        logsRead.query("SELECT thread_id FROM logs WHERE thread_id='writable-after-busy'").get(),
      ).toBeTruthy();
      expect(
        memoriesRead.query(
          "SELECT thread_id FROM stage1_outputs WHERE thread_id='writable-after-busy'",
        ).get(),
      ).toBeTruthy();
    } finally {
      try { logsRead?.close(); } catch { /* */ }
      try { memoriesRead?.close(); } catch { /* */ }
    }
  }, { timeout: STORE_BUDGET_MS });

  test("rolls back staged renames when a later rename fails", () => {
    home = buildHome();
    const fresh = previewArchivedCleanup(100, home);
    expect(fresh.count).toBe(3);

    // Exclusive stage dir uses `.trash/42-1` when `.trash/42` already exists.
    const now = 42;
    mkdirSync(join(home, ".trash", String(now)), { recursive: true });

    const result = executeArchivedCleanup({
      percent: 100,
      mode: "quarantine",
      digest: fresh.digest,
      codexHome: home,
      now,
      _test: { blockStageDestBasenames: ["rollout-mid.jsonl"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
  });

  test("rolls back staged renames when DB delete aborts after staging", () => {
    home = buildHome();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`CREATE TRIGGER deny_thread_delete BEFORE DELETE ON threads
      BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    db.close();
    const result = runWithDigest(50, "quarantine", home, { now: 77 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "77", "rollout-old.jsonl"))).toBe(false);
  });

  // Windows CI: permanent cleanup + spawn/dynamic-tool SQLite work can exceed Bun's
  // default 5s under runner load (timed out at 5.5s on PR #779).
  test("deletes spawn edges with parent_thread_id/child_thread_id and cascades dynamic tools", () => {
    home = buildHome({ withSpawnEdges: true, withDynamicTools: true });
    // Delete both sides of the edge together so referenced_history does not fire.
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(db.query("SELECT COUNT(*) AS n FROM thread_spawn_edges").get() as { n: number }).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM thread_dynamic_tools").get() as { n: number }).toEqual({ n: 0 });
    db.close();
  }, { timeout: STORE_BUDGET_MS });

  test("rejects candidates still referenced by a live spawn edge", () => {
    home = buildHome({ withSpawnEdges: true });
    // Edge told→tmid; deleting only oldest (told) leaves tmid outside the set.
    const result = runWithDigest(34, "quarantine", home);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("referenced_history");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("rejects paginated history_mode threads", () => {
    home = buildHome();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`UPDATE threads SET history_mode='paginated' WHERE id='told'`);
    db.close();
    const result = runWithDigest(50, "quarantine", home);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("referenced_history");
  });

  test("quarantine removes both plain and compressed physical files", () => {
    home = buildHome();
    writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), "ZST");
    utimesSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), OLD, OLD);
    const result = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_002 });
    expect(result.ok).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"))).toBe(false);
    expect(existsSync(join(home, ".trash", "1700000000002", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "1700000000002", "rollout-old.jsonl.zst"))).toBe(true);
  });

  test("never returns ok with error field or absolute paths in error codes", () => {
    home = buildHome();
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: "deadbeef",
      codexHome: home,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_digest");
    expect(JSON.stringify(result)).not.toContain(home);
  });

  test("manifest-write failure rolls back staged files and leaves no stranded trash", () => {
    home = buildHome();
    const result = runWithDigest(50, "quarantine", home, {
      now: 88,
      _test: { failManifestWrite: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(result.trashDir).toBeUndefined();
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "88", "rollout-old.jsonl"))).toBe(false);
    // Whole stage directory must be removed — not just the staged file.
    expect(existsSync(join(home, ".trash", "88"))).toBe(false);
    // DB untouched
    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id").all().map(r => r.id);
    db.close();
    expect(ids).toContain("told");
  });

  test("rename-back failure keeps staged file and reports relative trashDir", () => {
    home = buildHome();
    const db = new Database(join(home, "state_5.sqlite"));
    db.exec(`CREATE TRIGGER deny_thread_delete BEFORE DELETE ON threads
      BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    db.close();

    const result = executeArchivedCleanup({
      percent: 50,
      mode: "quarantine",
      digest: previewArchivedCleanup(50, home).digest,
      codexHome: home,
      now: 91,
      _test: { failRollbackBasenames: ["rollout-old.jsonl"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(result.trashDir).toBe(".trash/91");
    // Staged file must not be discarded when rename-back fails.
    expect(existsSync(join(home, ".trash", "91", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "91", "manifest.json"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(home);
  });

  test("partial permanent purge preserves remaining stage and recovery path", () => {
    home = buildHome();
    const preview = previewArchivedCleanup(100, home);
    const result = executeArchivedCleanup({
      percent: 100,
      mode: "permanent",
      digest: preview.digest,
      codexHome: home,
      now: 92,
      _test: { failPurgeBasenames: ["rollout-mid.jsonl"] },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(result.trashDir).toBe(".trash/92");
    // Remaining staged file + manifest must survive for recovery.
    expect(existsSync(join(home, ".trash", "92", "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "92", "manifest.json"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(home, ".trash", "92", "manifest.json"), "utf8"),
    ) as {
      purgeIncomplete?: boolean;
      purgedRelPaths?: string[];
      entries: Array<{ relPath: string }>;
    };
    expect(manifest.purgeIncomplete).toBe(true);
    expect(manifest.purgedRelPaths).toContain("archived_sessions/rollout-old.jsonl");
    expect(manifest.entries.map(e => e.relPath)).toEqual(["archived_sessions/rollout-mid.jsonl"]);
    // Successfully purged candidates are gone from archive and stage.
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(home, ".trash", "92", "rollout-old.jsonl"))).toBe(false);
    // DB rows for the batch are already committed away.
    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = db.query<{ id: string }, []>("SELECT id FROM threads").all().map(r => r.id);
    db.close();
    expect(ids).toEqual(["active"]);
  });

  // Windows CI: multi-satellite permanent cleanup can exceed the default 5s under lock/IO load.
  test("permanent cleanup removes logs, goals, and memory rows for deleted threads", () => {
    home = buildHome({ withSatelliteStores: true });
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    expect(result.count).toBe(3);

    const logs = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    const logThreads = logs.query<{ thread_id: string }, []>(
      "SELECT thread_id FROM logs ORDER BY thread_id",
    ).all().map(r => r.thread_id);
    logs.close();
    expect(logThreads).toEqual(["active"]);

    const goals = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    const goalThreads = goals.query<{ thread_id: string }, []>(
      "SELECT thread_id FROM thread_goals ORDER BY thread_id",
    ).all().map(r => r.thread_id);
    const deferrals = goals.query<{ thread_id: string }, []>(
      "SELECT thread_id FROM thread_goal_continuation_deferrals",
    ).all();
    goals.close();
    expect(goalThreads).toEqual(["active"]);
    expect(deferrals).toEqual([]);

    const memories = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    const stage1 = memories.query<{ thread_id: string }, []>(
      "SELECT thread_id FROM stage1_outputs ORDER BY thread_id",
    ).all().map(r => r.thread_id);
    const stage1Jobs = memories.query<{ job_key: string }, []>(
      "SELECT job_key FROM jobs WHERE kind='memory_stage1' ORDER BY job_key",
    ).all().map(r => r.job_key);
    const consolidate = memories.query<{ status: string }, []>(
      "SELECT status FROM jobs WHERE kind='memory_consolidate_global' AND job_key='global'",
    ).get();
    memories.close();
    expect(stage1).toEqual(["active"]);
    expect(stage1Jobs).toEqual(["active"]);
    // tmid was selected_for_phase2, so upstream enqueues/ refreshes global consolidation.
    expect(consolidate?.status).toBe("pending");

    const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const ids = state.query<{ id: string }, []>("SELECT id FROM threads").all().map(r => r.id);
    state.close();
    expect(ids).toEqual(["active"]);
  }, { timeout: STORE_BUDGET_MS });

  test("threads read failure leaves every file and database unchanged", () => {
    home = buildHome({ withSatelliteStores: true });
    // Present state DB with no readable threads table → fail closed before FS/DB mutation.
    rmSync(join(home, "state_5.sqlite"), { force: true });
    const broken = new Database(join(home, "state_5.sqlite"));
    broken.exec(`CREATE TABLE not_threads (id TEXT PRIMARY KEY)`);
    broken.exec(`INSERT INTO not_threads VALUES ('x')`);
    broken.close();

    const beforeLogs = readFileSync(join(home, "logs_2.sqlite"));
    const beforeGoals = readFileSync(join(home, "goals_1.sqlite"));
    const beforeMemories = readFileSync(join(home, "memories_1.sqlite"));
    const beforeState = readFileSync(join(home, "state_5.sqlite"));

    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash"))).toBe(false);
    expect(Buffer.compare(beforeLogs, readFileSync(join(home, "logs_2.sqlite")))).toBe(0);
    expect(Buffer.compare(beforeGoals, readFileSync(join(home, "goals_1.sqlite")))).toBe(0);
    expect(Buffer.compare(beforeMemories, readFileSync(join(home, "memories_1.sqlite")))).toBe(0);
    expect(Buffer.compare(beforeState, readFileSync(join(home, "state_5.sqlite")))).toBe(0);
  }, { timeout: STORE_BUDGET_MS });

  // Windows CI: injected satellite rollback paths (especially goals) can measure 6–13s
  // there and trip bun's default 5s harness timeout.
  test.each([
    ["failAfterLogsMutation", { failAfterLogsMutation: true }],
    ["failAfterMemoriesMutation", { failAfterMemoriesMutation: true }],
    ["failAfterGoalsMutation", { failAfterGoalsMutation: true }],
    ["failBeforeStateCommit", { failBeforeStateCommit: true }],
  ] as const)(
    "injected %s restores every file and database",
    (_name, hook) => {
      home = buildHome({ withSatelliteStores: true });
      const files = {
        old: readFileSync(join(home, "archived_sessions", "rollout-old.jsonl")),
        mid: readFileSync(join(home, "archived_sessions", "rollout-mid.jsonl")),
        neu: readFileSync(join(home, "archived_sessions", "rollout-new.jsonl")),
      };
      const logsDb = new Database(join(home, "logs_2.sqlite"), { readonly: true });
      const logs = logsDb.query("SELECT id, ts, level, target, thread_id, estimated_bytes FROM logs ORDER BY id").all();
      logsDb.close();
      const goalsDb = new Database(join(home, "goals_1.sqlite"), { readonly: true });
      const goals = goalsDb.query("SELECT thread_id, goal_id, objective, status FROM thread_goals ORDER BY thread_id").all();
      const deferrals = goalsDb.query("SELECT thread_id FROM thread_goal_continuation_deferrals ORDER BY thread_id").all();
      goalsDb.close();
      const memDb = new Database(join(home, "memories_1.sqlite"), { readonly: true });
      const stage1 = memDb.query("SELECT thread_id, raw_memory, rollout_summary, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id").all();
      const jobs = memDb.query("SELECT kind, job_key, status FROM jobs ORDER BY kind, job_key").all();
      memDb.close();
      const stateDb = new Database(join(home, "state_5.sqlite"), { readonly: true });
      const threads = stateDb.query("SELECT id, rollout_path, archived FROM threads ORDER BY id").all();
      stateDb.close();

      const result = runWithDigest(100, "permanent", home, { now: 93, _test: { ...hook } });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("db_reconcile_failed");
      expect(result.trashDir).toBeUndefined();
      expect(existsSync(join(home, ".trash"))).toBe(false);
      expect(Buffer.compare(files.old, readFileSync(join(home, "archived_sessions", "rollout-old.jsonl")))).toBe(0);
      expect(Buffer.compare(files.mid, readFileSync(join(home, "archived_sessions", "rollout-mid.jsonl")))).toBe(0);
      expect(Buffer.compare(files.neu, readFileSync(join(home, "archived_sessions", "rollout-new.jsonl")))).toBe(0);

      const logsAfter = new Database(join(home, "logs_2.sqlite"), { readonly: true });
      expect(logsAfter.query("SELECT id, ts, level, target, thread_id, estimated_bytes FROM logs ORDER BY id").all()).toEqual(logs);
      logsAfter.close();
      const goalsAfter = new Database(join(home, "goals_1.sqlite"), { readonly: true });
      expect(goalsAfter.query("SELECT thread_id, goal_id, objective, status FROM thread_goals ORDER BY thread_id").all()).toEqual(goals);
      expect(goalsAfter.query("SELECT thread_id FROM thread_goal_continuation_deferrals ORDER BY thread_id").all()).toEqual(deferrals);
      goalsAfter.close();
      const memAfter = new Database(join(home, "memories_1.sqlite"), { readonly: true });
      expect(memAfter.query("SELECT thread_id, raw_memory, rollout_summary, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id").all()).toEqual(stage1);
      expect(memAfter.query("SELECT kind, job_key, status FROM jobs ORDER BY kind, job_key").all()).toEqual(jobs);
      memAfter.close();
      const stateAfter = new Database(join(home, "state_5.sqlite"), { readonly: true });
      expect(stateAfter.query("SELECT id, rollout_path, archived FROM threads ORDER BY id").all()).toEqual(threads);
      stateAfter.close();
    },
    { timeout: STORE_BUDGET_MS },
  );

  // Same Windows satellite-rollback budget as the injected-mutation cases above:
  // failBeforeStateCommit + failSatelliteRestore measured ~10s on windows-latest.
  test("satellite restore failure keeps recovery trashDir and manifest", () => {
    home = buildHome({ withSatelliteStores: true });
    const result = runWithDigest(100, "permanent", home, {
      now: 94,
      _test: { failBeforeStateCommit: true, failSatelliteRestore: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(result.trashDir).toBe(".trash/94");
    expect(existsSync(join(home, ".trash", "94", "manifest.json"))).toBe(true);
    expect(existsSync(join(home, ".trash", "94", "satellite-backup.json"))).toBe(true);
    // Files are still restored; trash is kept for DB recovery metadata.
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("satellite-backup write failure leaves every database and rollout unchanged", () => {
    home = buildHome({ withSatelliteStores: true });
    const files = {
      old: readFileSync(join(home, "archived_sessions", "rollout-old.jsonl")),
      mid: readFileSync(join(home, "archived_sessions", "rollout-mid.jsonl")),
      neu: readFileSync(join(home, "archived_sessions", "rollout-new.jsonl")),
    };
    const logsDb = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    const logs = logsDb.query("SELECT id, ts, level, target, thread_id, estimated_bytes FROM logs ORDER BY id").all();
    logsDb.close();
    const goalsDb = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    const goals = goalsDb.query("SELECT thread_id, goal_id, objective, status FROM thread_goals ORDER BY thread_id").all();
    const deferrals = goalsDb.query("SELECT thread_id FROM thread_goal_continuation_deferrals ORDER BY thread_id").all();
    goalsDb.close();
    const memDb = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    const stage1 = memDb.query("SELECT thread_id, raw_memory, rollout_summary, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id").all();
    const jobs = memDb.query("SELECT kind, job_key, status FROM jobs ORDER BY kind, job_key").all();
    memDb.close();
    const stateDb = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const threads = stateDb.query("SELECT id, rollout_path, archived FROM threads ORDER BY id").all();
    stateDb.close();

    const result = runWithDigest(100, "permanent", home, {
      now: 95,
      _test: { failSatelliteBackupWrite: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fs_failed");
    expect(result.trashDir).toBeUndefined();
    expect(existsSync(join(home, ".trash"))).toBe(false);
    expect(Buffer.compare(files.old, readFileSync(join(home, "archived_sessions", "rollout-old.jsonl")))).toBe(0);
    expect(Buffer.compare(files.mid, readFileSync(join(home, "archived_sessions", "rollout-mid.jsonl")))).toBe(0);
    expect(Buffer.compare(files.neu, readFileSync(join(home, "archived_sessions", "rollout-new.jsonl")))).toBe(0);

    const logsAfter = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(logsAfter.query("SELECT id, ts, level, target, thread_id, estimated_bytes FROM logs ORDER BY id").all()).toEqual(logs);
    logsAfter.close();
    const goalsAfter = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    expect(goalsAfter.query("SELECT thread_id, goal_id, objective, status FROM thread_goals ORDER BY thread_id").all()).toEqual(goals);
    expect(goalsAfter.query("SELECT thread_id FROM thread_goal_continuation_deferrals ORDER BY thread_id").all()).toEqual(deferrals);
    goalsAfter.close();
    const memAfter = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    expect(memAfter.query("SELECT thread_id, raw_memory, rollout_summary, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id").all()).toEqual(stage1);
    expect(memAfter.query("SELECT kind, job_key, status FROM jobs ORDER BY kind, job_key").all()).toEqual(jobs);
    memAfter.close();
    const stateAfter = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(stateAfter.query("SELECT id, rollout_path, archived FROM threads ORDER BY id").all()).toEqual(threads);
    stateAfter.close();
  });

  test("failed post-memories satellite-backup replace keeps prior backup parseable and restorable", () => {
    home = buildHome({ withSatelliteStores: true });
    const logsBefore = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    const logs = logsBefore.query(
      "SELECT id, ts, level, target, thread_id, estimated_bytes FROM logs ORDER BY id",
    ).all();
    logsBefore.close();
    const goalsBefore = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    const goals = goalsBefore.query(
      "SELECT thread_id, goal_id, objective, status FROM thread_goals ORDER BY thread_id",
    ).all();
    const deferrals = goalsBefore.query(
      "SELECT thread_id FROM thread_goal_continuation_deferrals ORDER BY thread_id",
    ).all();
    goalsBefore.close();
    const memBefore = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    const stage1 = memBefore.query(
      "SELECT thread_id, raw_memory, rollout_summary, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id",
    ).all();
    const jobs = memBefore.query(
      "SELECT kind, job_key, status FROM jobs ORDER BY kind, job_key",
    ).all();
    memBefore.close();

    // tmid has selected_for_phase2=1 → consolidateTouched forces a post-commit backup rewrite.
    // failSatelliteRestore keeps the prior on-disk snapshot so we can prove it was never truncated.
    const result = runWithDigest(100, "permanent", home, {
      now: 96,
      _test: { failSatelliteBackupReplace: true, failSatelliteRestore: true },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");
    expect(result.trashDir).toBe(".trash/96");

    const backupPath = join(home, ".trash", "96", "satellite-backup.json");
    expect(existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath, "utf8")) as {
      threadIds: string[];
      logs?: { rows: Array<Record<string, unknown>> };
      memories?: {
        stage1: Array<Record<string, unknown>>;
        stage1Jobs: Array<Record<string, unknown>>;
        consolidateTouched?: boolean;
        consolidateJob?: Record<string, unknown> | null;
        consolidatePostImage?: unknown;
      };
      goals?: {
        goals: Array<Record<string, unknown>>;
        deferrals: Array<Record<string, unknown>>;
      };
    };
    expect(backup.threadIds).toEqual(expect.arrayContaining(["told", "tmid", "tnew"]));
    expect(backup.logs?.rows.length).toBeGreaterThan(0);
    expect(backup.memories?.stage1.length).toBeGreaterThan(0);
    expect(backup.memories?.consolidateTouched).toBe(true);
    // Replacement never landed — prior snapshot must not carry the post-commit image.
    expect(backup.memories?.consolidatePostImage).toBeUndefined();
    expect(backup.goals?.goals.length).toBeGreaterThan(0);

    // Injected restore failure left satellites deleted; re-apply the kept prior backup.
    const logsDb = new Database(join(home, "logs_2.sqlite"));
    logsDb.exec("BEGIN IMMEDIATE");
    for (const row of backup.logs?.rows ?? []) {
      const cols = Object.keys(row);
      logsDb.run(
        `INSERT INTO logs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
        cols.map(c => row[c] as string | number | null),
      );
    }
    logsDb.exec("COMMIT");
    logsDb.close();

    const memDb = new Database(join(home, "memories_1.sqlite"));
    memDb.exec("BEGIN IMMEDIATE");
    for (const row of backup.memories?.stage1 ?? []) {
      const cols = Object.keys(row);
      memDb.run(
        `INSERT INTO stage1_outputs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
        cols.map(c => row[c] as string | number | null),
      );
    }
    for (const row of backup.memories?.stage1Jobs ?? []) {
      const cols = Object.keys(row);
      memDb.run(
        `INSERT INTO jobs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
        cols.map(c => row[c] as string | number | null),
      );
    }
    memDb.exec("COMMIT");
    memDb.close();

    const goalsDb = new Database(join(home, "goals_1.sqlite"));
    goalsDb.exec("BEGIN IMMEDIATE");
    for (const row of backup.goals?.goals ?? []) {
      const cols = Object.keys(row);
      goalsDb.run(
        `INSERT INTO thread_goals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
        cols.map(c => row[c] as string | number | null),
      );
    }
    for (const row of backup.goals?.deferrals ?? []) {
      const cols = Object.keys(row);
      goalsDb.run(
        `INSERT INTO thread_goal_continuation_deferrals (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`,
        cols.map(c => row[c] as string | number | null),
      );
    }
    goalsDb.exec("COMMIT");
    goalsDb.close();

    const logsAfter = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(logsAfter.query("SELECT id, ts, level, target, thread_id, estimated_bytes FROM logs ORDER BY id").all()).toEqual(logs);
    logsAfter.close();
    const goalsAfter = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    expect(goalsAfter.query("SELECT thread_id, goal_id, objective, status FROM thread_goals ORDER BY thread_id").all()).toEqual(goals);
    expect(goalsAfter.query("SELECT thread_id FROM thread_goal_continuation_deferrals ORDER BY thread_id").all()).toEqual(deferrals);
    goalsAfter.close();
    const memAfter = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    expect(memAfter.query("SELECT thread_id, raw_memory, rollout_summary, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id").all()).toEqual(stage1);
    // stage1 jobs restored; consolidate-global may have been mutated before the failed rewrite —
    // only assert stage1 keys are present (every deleted satellite row from the prior backup).
    const jobKeys = memAfter.query<{ kind: string; job_key: string }, []>(
      "SELECT kind, job_key FROM jobs ORDER BY kind, job_key",
    ).all();
    memAfter.close();
    for (const expected of jobs.filter(j => (j as { kind: string }).kind === "memory_stage1")) {
      expect(jobKeys).toContainEqual({
        kind: (expected as { kind: string }).kind,
        job_key: (expected as { job_key: string }).job_key,
      });
    }
  }, { timeout: STORE_BUDGET_MS });

  test("permanent cleanup works with logs-only satellite store", () => {
    home = buildHome({ satellites: "logs" });
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    const logs = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(logs.query("SELECT thread_id FROM logs ORDER BY thread_id").all().map(r => r.thread_id)).toEqual(["active"]);
    logs.close();
    expect(existsSync(join(home, "goals_1.sqlite"))).toBe(false);
    expect(existsSync(join(home, "memories_1.sqlite"))).toBe(false);
    const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(state.query("SELECT id FROM threads").all().map(r => r.id)).toEqual(["active"]);
    state.close();
  });

  test("permanent cleanup works with memories-only satellite store", () => {
    home = buildHome({ satellites: "memories" });
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    const memories = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    expect(memories.query("SELECT thread_id FROM stage1_outputs ORDER BY thread_id").all().map(r => r.thread_id)).toEqual(["active"]);
    expect(memories.query("SELECT job_key FROM jobs WHERE kind='memory_stage1' ORDER BY job_key").all().map(r => r.job_key)).toEqual(["active"]);
    expect(memories.query("SELECT status FROM jobs WHERE kind='memory_consolidate_global' AND job_key='global'").get()?.status).toBe("pending");
    memories.close();
    expect(existsSync(join(home, "logs_2.sqlite"))).toBe(false);
    expect(existsSync(join(home, "goals_1.sqlite"))).toBe(false);
  });

  test("permanent cleanup works with goals-only satellite store", () => {
    home = buildHome({ satellites: "goals" });
    const result = runWithDigest(100, "permanent", home);
    expect(result.ok).toBe(true);
    const goals = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    expect(goals.query("SELECT thread_id FROM thread_goals ORDER BY thread_id").all().map(r => r.thread_id)).toEqual(["active"]);
    expect(goals.query("SELECT thread_id FROM thread_goal_continuation_deferrals").all()).toEqual([]);
    goals.close();
    expect(existsSync(join(home, "logs_2.sqlite"))).toBe(false);
    expect(existsSync(join(home, "memories_1.sqlite"))).toBe(false);
  });

  // Windows CI: multi-DB reconcile + restore with concurrent writers measures 2–7s there
  // (vs <400ms locally) and trips bun's default 5s harness timeout.
  test("concurrent satellite writes after mutation are preserved on restore", () => {
    home = buildHome({ withSatelliteStores: true });
    const result = runWithDigest(100, "permanent", home, {
      now: 96,
      _test: {
        failBeforeStateCommit: true,
        afterSatelliteMutations: () => {
          const logs = new Database(join(home, "logs_2.sqlite"));
          logs.exec(
            `INSERT INTO logs (ts, level, target, thread_id, estimated_bytes) VALUES (99,'INFO','t','concurrent-insert',99)`,
          );
          logs.close();
          const mem = new Database(join(home, "memories_1.sqlite"));
          mem.exec(
            `UPDATE jobs SET status='running' WHERE kind='memory_consolidate_global' AND job_key='global'`,
          );
          mem.close();
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");

    const logs = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(logs.query("SELECT thread_id FROM logs WHERE thread_id='concurrent-insert'").get()).toBeTruthy();
    expect(
      logs.query("SELECT COUNT(*) AS n FROM logs WHERE thread_id IN ('told','tmid','tnew')").get()?.n,
    ).toBe(3);
    expect(logs.query("SELECT thread_id FROM logs WHERE thread_id='active'").get()).toBeTruthy();
    logs.close();

    const memories = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    expect(
      memories.query(
        "SELECT status FROM jobs WHERE kind='memory_consolidate_global' AND job_key='global'",
      ).get()?.status,
    ).toBe("running");
    expect(
      memories.query("SELECT thread_id FROM stage1_outputs ORDER BY thread_id").all().map(r => r.thread_id),
    ).toEqual(["active", "tmid", "told"]);
    memories.close();

    const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(state.query("SELECT id FROM threads ORDER BY id").all().map(r => r.id)).toEqual([
      "active", "tmid", "tnew", "told",
    ]);
    state.close();
  }, { timeout: STORE_BUDGET_MS });

  // Windows CI: same multi-satellite restore profile as above (timed out at 5s on PR #558).
  test("concurrent consolidate enqueue watermark change is preserved on restore", () => {
    home = buildHome({ withSatelliteStores: true });
    const result = runWithDigest(100, "permanent", home, {
      now: 97,
      _test: {
        failBeforeStateCommit: true,
        afterSatelliteMutations: () => {
          const mem = new Database(join(home, "memories_1.sqlite"));
          mem.exec(
            `UPDATE jobs SET input_watermark = 99999
             WHERE kind='memory_consolidate_global' AND job_key='global' AND status='pending'`,
          );
          mem.close();
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("db_reconcile_failed");

    const memories = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    const consolidate = memories.query<{
      status: string;
      input_watermark: number | null;
    }, []>(
      "SELECT status, input_watermark FROM jobs WHERE kind='memory_consolidate_global' AND job_key='global'",
    ).get();
    memories.close();
    expect(consolidate?.status).toBe("pending");
    expect(Number(consolidate?.input_watermark ?? 0)).toBe(99999);

    const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(state.query("SELECT id FROM threads ORDER BY id").all().map(r => r.id)).toEqual([
      "active", "tmid", "tnew", "told",
    ]);
    state.close();
  }, { timeout: STORE_BUDGET_MS });
});

describe("listTrashEntries + restoreTrashEntry", () => {
  test("round-trip quarantine → restore returns files and threads", () => {
    home = buildHome();
    const original = readFileSync(join(home, "archived_sessions", "rollout-old.jsonl"), "utf8");
    const quarantined = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_100 });
    expect(quarantined.ok).toBe(true);
    expect(quarantined.trashDir).toBe(".trash/1700000000100");

    const listed = listTrashEntries(home);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(".trash/1700000000100");
    expect(listed[0]!.fileCount).toBe(1);
    expect(listed[0]!.mode).toBe("quarantine");
    expect(listed[0]!.quarantinedAt).toBe(1_700_000_000_100);
    expect(JSON.stringify(listed)).not.toContain(home.replaceAll("\\", "\\\\"));

    const restored = restoreTrashEntry(".trash/1700000000100", { codexHome: home });
    expect(restored.ok).toBe(true);
    expect(restored.count).toBe(1);
    expect(restored.restoredPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(readFileSync(join(home, "archived_sessions", "rollout-old.jsonl"), "utf8")).toBe(original);
    expect(existsSync(join(home, ".trash", "1700000000100"))).toBe(false);
    expect(listTrashEntries(home)).toEqual([]);

    const db = new Database(join(home, "state_5.sqlite"), { readonly: true });
    const row = db.query<{ id: string; rollout_path: string; archived: number | null }, []>(
      "SELECT id, rollout_path, archived FROM threads WHERE id='told'",
    ).get();
    db.close();
    expect(row).toEqual({
      id: "told",
      rollout_path: "archived_sessions/rollout-old.jsonl",
      archived: 1,
    });
    expect(existsSync(join(home, "sessions", "2026", "05", "27", "rollout-active.jsonl"))).toBe(true);
  });

  test("restore refuses when Codex DB is busy", () => {
    home = buildHome();
    const quarantined = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_200 });
    expect(quarantined.ok).toBe(true);

    const locker = new Database(join(home, "state_5.sqlite"));
    locker.exec("BEGIN EXCLUSIVE");
    try {
      const restored = restoreTrashEntry(".trash/1700000000200", {
        codexHome: home,
        busyTimeoutMs: 1,
      });
      expect(restored.ok).toBe(false);
      expect(restored.error).toBe("codex_busy");
      expect(existsSync(join(home, ".trash", "1700000000200", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
  });

  test("rejects missing, invalid, and path-escaping trash ids", () => {
    home = buildHome();
    expect(restoreTrashEntry(".trash/999", { codexHome: home }).error).toBe("missing_trash");
    expect(restoreTrashEntry("../etc/passwd", { codexHome: home }).error).toBe("invalid_trash");
    expect(restoreTrashEntry(".trash/../sessions", { codexHome: home }).error).toBe("invalid_trash");
    expect(restoreTrashEntry(".trash/not-an-epoch", { codexHome: home }).error).toBe("invalid_trash");
    expect(restoreTrashEntry("", { codexHome: home }).error).toBe("invalid_trash");
  });

  test("refuses restore when destination archived file already exists", () => {
    home = buildHome();
    const quarantined = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_300 });
    expect(quarantined.ok).toBe(true);
    writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl"), "COLLISION");
    const restored = restoreTrashEntry(".trash/1700000000300", { codexHome: home });
    expect(restored.ok).toBe(false);
    expect(restored.error).toBe("dest_exists");
    expect(existsSync(join(home, ".trash", "1700000000300", "rollout-old.jsonl"))).toBe(true);
  });

  // Windows CI: quarantine + multi-satellite restore (state/tools/spawn/logs remap)
  // measured ~8s on windows-latest against Bun's default 5s harness timeout.
  test("quarantine retains satellite-backup and restores satellite + state dependents", () => {
    home = buildHome({ withSatelliteStores: true, withDynamicTools: true, withSpawnEdges: true });
    // 100%: spawn edge told→tmid stays inside the delete set (cross-boundary edges refuse cleanup).
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_000_400 });
    expect(quarantined.ok).toBe(true);
    const backupPath = join(home, ".trash", "1700000000400", "satellite-backup.json");
    expect(existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(readFileSync(backupPath, "utf8")) as {
      threadIds: string[];
      threads?: Array<Record<string, unknown>>;
      dynamicTools?: Array<Record<string, unknown>>;
      spawnEdges?: Array<Record<string, unknown>>;
      logs?: { path: string; rows: unknown[] };
    };
    expect(backup.threadIds).toContain("told");
    expect(backup.threads?.some(r => r.id === "told")).toBe(true);
    expect(backup.dynamicTools?.length).toBeGreaterThan(0);
    expect(backup.spawnEdges?.length).toBeGreaterThan(0);
    expect(backup.logs?.rows.length).toBeGreaterThan(0);

    // Simulate Codex rotating to a newer logs DB — restore must remap to current home.
    renameSync(join(home, "logs_2.sqlite"), join(home, "logs_3.sqlite"));

    const restored = restoreTrashEntry(".trash/1700000000400", { codexHome: home });
    expect(restored.ok).toBe(true);
    expect(existsSync(backupPath)).toBe(false);

    const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(state.query("SELECT id FROM threads WHERE id='told'").get()).toEqual({ id: "told" });
    expect(state.query("SELECT COUNT(*) AS n FROM thread_dynamic_tools WHERE thread_id='told'").get())
      .toEqual({ n: 1 });
    expect(state.query("SELECT COUNT(*) AS n FROM thread_spawn_edges WHERE parent_thread_id='told' OR child_thread_id='told'").get())
      .toEqual({ n: 1 });
    state.close();

    const logs = new Database(join(home, "logs_3.sqlite"), { readonly: true });
    expect(logs.query("SELECT COUNT(*) AS n FROM logs WHERE thread_id='told'").get()).toEqual({ n: 1 });
    logs.close();
  }, { timeout: STORE_BUDGET_MS });

  test("rejects malformed satellite-backup.json without destroying trash", () => {
    home = buildHome();
    const quarantined = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_500 });
    expect(quarantined.ok).toBe(true);
    writeFileSync(join(home, ".trash", "1700000000500", "satellite-backup.json"), "{truncated");
    const restored = restoreTrashEntry(".trash/1700000000500", { codexHome: home });
    expect(restored.ok).toBe(false);
    expect(restored.error).toBe("db_reconcile_failed");
    expect(existsSync(join(home, ".trash", "1700000000500", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
  });

  test("refuses restore when manifest has threads but state DB is absent", () => {
    home = buildHome();
    const quarantined = runWithDigest(50, "quarantine", home, { now: 1_700_000_000_600 });
    expect(quarantined.ok).toBe(true);
    unlinkSync(join(home, "state_5.sqlite"));
    const restored = restoreTrashEntry(".trash/1700000000600", { codexHome: home });
    expect(restored.ok).toBe(false);
    expect(restored.error).toBe("db_reconcile_failed");
    expect(existsSync(join(home, ".trash", "1700000000600", "rollout-old.jsonl"))).toBe(true);
  });

  test("partial purge survivors restore only remaining physical files", () => {
    home = buildHome();
    writeFileSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), "ZST");
    utimesSync(join(home, "archived_sessions", "rollout-old.jsonl.zst"), OLD, OLD);
    const preview = previewArchivedCleanup(50, home);
    const result = executeArchivedCleanup({
      percent: 50,
      mode: "permanent",
      digest: preview.digest,
      codexHome: home,
      now: 1_700_000_000_700,
      _test: { failPurgeBasenames: ["rollout-old.jsonl"] },
    });
    expect(result.ok).toBe(false);
    expect(result.trashDir).toBe(".trash/1700000000700");
    const manifest = JSON.parse(
      readFileSync(join(home, ".trash", "1700000000700", "manifest.json"), "utf8"),
    ) as { entries: Array<{ physicalRelPaths: string[] }> };
    expect(manifest.entries[0]!.physicalRelPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);
    // Twin was purged; stage only has the survivor.
    expect(existsSync(join(home, ".trash", "1700000000700", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, ".trash", "1700000000700", "rollout-old.jsonl.zst"))).toBe(false);

    const restored = restoreTrashEntry(".trash/1700000000700", { codexHome: home });
    expect(restored.ok).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
  });

  test("rejects mixed valid+malformed manifest entries as invalid_trash without touching staged files", () => {
    home = buildHome();
    const stage = join(home, ".trash", "1700000000800");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "rollout-old.jsonl"), "OLD-STAGE");
    writeFileSync(join(stage, "rollout-mid.jsonl"), "MID-STAGE");
    writeFileSync(join(stage, "manifest.json"), JSON.stringify({
      quarantinedAt: 1_700_000_000_800,
      mode: "quarantine",
      entries: [
        {
          relPath: "archived_sessions/rollout-old.jsonl",
          bytes: 9,
          mtimeMs: OLD.getTime(),
          physicalRelPaths: ["archived_sessions/rollout-old.jsonl"],
          threadId: "told",
          rolloutPath: "archived_sessions/rollout-old.jsonl",
          archived: 1,
        },
        {
          relPath: "archived_sessions/rollout-mid.jsonl",
          bytes: 9,
          mtimeMs: MID.getTime(),
          // Malformed: non-string path must reject the entire manifest (no per-entry filter).
          physicalRelPaths: ["archived_sessions/rollout-mid.jsonl", null],
          threadId: "tmid",
          rolloutPath: "archived_sessions/rollout-mid.jsonl",
          archived: 1,
        },
      ],
    }));

    const restored = restoreTrashEntry(".trash/1700000000800", { codexHome: home });
    expect(restored.ok).toBe(false);
    expect(restored.error).toBe("invalid_trash");
    expect(readFileSync(join(stage, "rollout-old.jsonl"), "utf8")).toBe("OLD-STAGE");
    expect(readFileSync(join(stage, "rollout-mid.jsonl"), "utf8")).toBe("MID-STAGE");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(readFileSync(join(home, "archived_sessions", "rollout-old.jsonl"), "utf8")).toBe("OLD".repeat(10));
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    expect(readFileSync(join(home, "archived_sessions", "rollout-mid.jsonl"), "utf8")).toBe("MID".repeat(20));
  });

  test("legacy quarantine without satellite-backup reconstructs production-shaped thread from rollout", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cleanup-legacy-"));
    home = dir;
    mkdirSync(join(dir, "archived_sessions"), { recursive: true });

    const rolloutBody = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          id: "told",
          model_provider: "openai",
          source: "cli",
          cwd: "/tmp/project",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "user_message", message: "restore me please" },
      }),
    ].join("\n") + "\n";

    const stage = join(dir, ".trash", "1700000000900");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "rollout-old.jsonl"), rolloutBody);
    writeFileSync(join(stage, "manifest.json"), JSON.stringify({
      quarantinedAt: 1_700_000_000_900,
      mode: "quarantine",
      entries: [
        {
          relPath: "archived_sessions/rollout-old.jsonl",
          bytes: Buffer.byteLength(rolloutBody),
          mtimeMs: OLD.getTime(),
          physicalRelPaths: ["archived_sessions/rollout-old.jsonl"],
          threadId: "told",
          rolloutPath: "archived_sessions/rollout-old.jsonl",
          archived: 1,
        },
      ],
    }));
    // Intentionally no satellite-backup.json — Phase-2 legacy quarantine shape.

    const db = new Database(join(dir, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER,
      archived_at INTEGER
    )`);
    db.close();

    const restored = restoreTrashEntry(".trash/1700000000900", { codexHome: home });
    expect(restored.ok).toBe(true);
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(stage)).toBe(false);

    const state = new Database(join(dir, "state_5.sqlite"), { readonly: true });
    const row = state.query<{
      id: string;
      rollout_path: string;
      model_provider: string;
      source: string;
      first_user_message: string;
      has_user_event: number;
      archived: number | null;
    }, []>(
      `SELECT id, rollout_path, model_provider, source, first_user_message, has_user_event, archived
       FROM threads WHERE id='told'`,
    ).get();
    state.close();
    expect(row).toEqual({
      id: "told",
      rollout_path: "archived_sessions/rollout-old.jsonl",
      model_provider: "openai",
      source: "cli",
      first_user_message: "restore me please",
      has_user_event: 1,
      archived: 1,
    });
  });

  test("legacy compressed-only quarantine restores .jsonl.zst and reconstructs the thread row", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-cleanup-legacy-zst-"));
    home = dir;
    mkdirSync(join(dir, "archived_sessions"), { recursive: true });

    const rolloutBody = [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-01-01T00:00:00.000Z",
        payload: {
          id: "told",
          model_provider: "openai",
          source: "cli",
          cwd: "/tmp/project",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-01-01T00:00:01.000Z",
        payload: { type: "user_message", message: "compressed restore please" },
      }),
    ].join("\n") + "\n";
    const compressed = Bun.zstdCompressSync(Buffer.from(rolloutBody, "utf8"));

    const stage = join(dir, ".trash", "1700000000910");
    mkdirSync(stage, { recursive: true });
    // Sparse legacy manifest: no threads snapshot, only the compressed physical file.
    writeFileSync(join(stage, "rollout-old.jsonl.zst"), compressed);
    writeFileSync(join(stage, "manifest.json"), JSON.stringify({
      quarantinedAt: 1_700_000_000_910,
      mode: "quarantine",
      entries: [
        {
          relPath: "archived_sessions/rollout-old.jsonl",
          bytes: compressed.byteLength,
          mtimeMs: OLD.getTime(),
          physicalRelPaths: ["archived_sessions/rollout-old.jsonl.zst"],
          threadId: "told",
          rolloutPath: "archived_sessions/rollout-old.jsonl",
          archived: 1,
        },
      ],
    }));
    // Intentionally no satellite-backup.json and no plain .jsonl sibling.

    const db = new Database(join(dir, "state_5.sqlite"));
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      source TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER,
      archived_at INTEGER
    )`);
    db.close();

    const restored = restoreTrashEntry(".trash/1700000000910", { codexHome: home });
    expect(restored.ok).toBe(true);
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl.zst"))).toBe(true);
    // Must not materialize an unbounded plain decompressed sibling on disk.
    expect(existsSync(join(dir, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(stage)).toBe(false);

    const state = new Database(join(dir, "state_5.sqlite"), { readonly: true });
    const row = state.query<{
      id: string;
      rollout_path: string;
      model_provider: string;
      source: string;
      first_user_message: string;
      has_user_event: number;
      archived: number | null;
    }, []>(
      `SELECT id, rollout_path, model_provider, source, first_user_message, has_user_event, archived
       FROM threads WHERE id='told'`,
    ).get();
    state.close();
    expect(row).toEqual({
      id: "told",
      rollout_path: "archived_sessions/rollout-old.jsonl",
      model_provider: "openai",
      source: "cli",
      first_user_message: "compressed restore please",
      has_user_event: 1,
      archived: 1,
    });
  }, { timeout: STORE_BUDGET_MS });

  test.each([
    ["failAfterStateCommit", { failAfterStateCommit: true }, "db_reconcile_failed"],
    ["failAfterFirstSatelliteCommit", { failAfterFirstSatelliteCommit: true }, "db_reconcile_failed"],
    ["failAtLeftoverStageGate", { failAtLeftoverStageGate: true }, "fs_failed"],
  ] as const)(
    "injected %s leaves partial restore with pending marker and retry succeeds",
    (_name, hook, error) => {
      home = buildHome({
        withSatelliteStores: true,
        withDynamicTools: true,
        withSpawnEdges: true,
      });
      const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_000 });
      expect(quarantined.ok).toBe(true);
      const trashId = quarantined.trashDir!;
      const stage = join(home, ...trashId.split("/"));

      const failed = restoreTrashEntry(trashId, { codexHome: home, _test: { ...hook } });
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe(error);
      // Files stay restored — accurate partial counts, no restage.
      expect(failed.count).toBe(3);
      expect(failed.restoredPaths).toEqual([
        "archived_sessions/rollout-old.jsonl",
        "archived_sessions/rollout-mid.jsonl",
        "archived_sessions/rollout-new.jsonl",
      ]);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
      expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(false);
      expect(existsSync(join(stage, "manifest.json"))).toBe(true);
      expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

      const pending = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
        filesRestored: boolean;
        acceptedDestRels: string[];
        pending: { state: boolean; logs: boolean; memories: boolean; goals: boolean };
      };
      expect(pending.filesRestored).toBe(true);
      expect(pending.acceptedDestRels).toContain("archived_sessions/rollout-old.jsonl");

      const retried = restoreTrashEntry(trashId, { codexHome: home });
      expect(retried.ok).toBe(true);
      expect(retried.count).toBe(3);
      expect(existsSync(stage)).toBe(false);
      expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);

      const stateAfter = new Database(join(home, "state_5.sqlite"), { readonly: true });
      expect(stateAfter.query("SELECT id FROM threads WHERE id='told'").get()).toEqual({ id: "told" });
      expect(stateAfter.query("SELECT COUNT(*) AS n FROM thread_dynamic_tools WHERE thread_id='told'").get())
        .toEqual({ n: 1 });
      stateAfter.close();
      const logsAfter = new Database(join(home, "logs_2.sqlite"), { readonly: true });
      expect(logsAfter.query("SELECT COUNT(*) AS n FROM logs WHERE thread_id='told'").get()).toEqual({ n: 1 });
      logsAfter.close();
    },
    { timeout: STORE_BUDGET_MS },
  );

  test("late failure after logs commit keeps metadata, persists pending sections, and resume preserves pre-existing rows", () => {
    // Regression for the old non-atomic path: compensate logs then hit busy on
    // state — which deleted logs while leaving state+files. Prefer partial+resume.
    home = buildHome({
      withSatelliteStores: true,
      withDynamicTools: true,
      withSpawnEdges: true,
    });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_100 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const stateSeed = new Database(join(home, "state_5.sqlite"));
    stateSeed.exec(`INSERT INTO threads VALUES (
      'told','archived_sessions/rollout-old.jsonl',1,1,'legacy'
    )`);
    stateSeed.exec(`INSERT INTO thread_dynamic_tools VALUES ('told',0,'pre','d','{}')`);
    stateSeed.close();
    const logsSeed = new Database(join(home, "logs_2.sqlite"));
    logsSeed.exec(
      `INSERT INTO logs (id, ts, level, target, thread_id, estimated_bytes) VALUES (1,1,'INFO','pre','told',10)`,
    );
    logsSeed.close();
    const memSeed = new Database(join(home, "memories_1.sqlite"));
    memSeed.exec(`INSERT INTO stage1_outputs VALUES ('told',1,'pre-m','pre-s',1,0)`);
    memSeed.close();
    const goalsSeed = new Database(join(home, "goals_1.sqlite"));
    goalsSeed.exec(`INSERT INTO thread_goals VALUES ('told','g1','pre','complete',0,0,1,1)`);
    goalsSeed.close();

    const failed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterFirstSatelliteCommit: true },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("db_reconcile_failed");
    expect(failed.count).toBe(3);

    // Files stay; no restage; no metadata compensation.
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const pending = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
      pending: { state: boolean; logs: boolean; memories: boolean; goals: boolean };
    };
    expect(pending.pending).toEqual({
      state: false,
      logs: false,
      memories: true,
      goals: true,
    });

    // Pre-existing conflict-ignored rows stay; newly restored mid/new rows stay.
    const state = new Database(join(home, "state_5.sqlite"), { readonly: true });
    expect(state.query("SELECT COUNT(*) AS n FROM threads WHERE id IN ('told','tmid','tnew')").get())
      .toEqual({ n: 3 });
    expect(
      state.query("SELECT name FROM thread_dynamic_tools WHERE thread_id='told' AND position=0").get(),
    ).toEqual({ name: "pre" });
    state.close();
    const logs = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(
      logs.query("SELECT ts, target, estimated_bytes FROM logs WHERE id=1").get(),
    ).toEqual({ ts: 1, target: "pre", estimated_bytes: 10 });
    expect(logs.query("SELECT COUNT(*) AS n FROM logs WHERE thread_id IN ('tmid','tnew')").get())
      .toEqual({ n: 2 });
    logs.close();

    // State locked after logs would have been compensated under the old design —
    // resume must still finish without dest_exists and without deleting pre rows.
    let locker: Database | undefined;
    let retried: ReturnType<typeof restoreTrashEntry>;
    try {
      locker = new Database(join(home, "state_5.sqlite"));
      locker.exec("BEGIN EXCLUSIVE");
      // State already done in pending — busy state must not block satellite resume.
      retried = restoreTrashEntry(trashId, { codexHome: home, busyTimeoutMs: 1 });
    } finally {
      try { locker?.exec("ROLLBACK"); } catch { /* */ }
      try { locker?.close(); } catch { /* */ }
    }
    expect(retried!.ok).toBe(true);
    expect(retried!.count).toBe(3);
    expect(existsSync(stage)).toBe(false);

    const mem = new Database(join(home, "memories_1.sqlite"), { readonly: true });
    expect(mem.query("SELECT raw_memory FROM stage1_outputs WHERE thread_id='told'").get())
      .toEqual({ raw_memory: "pre-m" });
    expect(
      mem.query("SELECT COUNT(*) AS n FROM stage1_outputs WHERE thread_id IN ('told','tmid','tnew')").get(),
    ).toEqual({ n: 2 }); // fixture seeds told+tmid only
    mem.close();
    const goals = new Database(join(home, "goals_1.sqlite"), { readonly: true });
    expect(goals.query("SELECT objective FROM thread_goals WHERE thread_id='told'").get())
      .toEqual({ objective: "pre" });
    expect(
      goals.query("SELECT COUNT(*) AS n FROM thread_goals WHERE thread_id IN ('told','tmid','tnew')").get(),
    ).toEqual({ n: 2 }); // fixture seeds told+tmid only
    goals.close();
  }, { timeout: STORE_BUDGET_MS });

  test("leftover-stage failure never restages files and retry accepts destinations", () => {
    // Regression for reverse-move failure after metadata compensation: restage
    // could leave metadata deleted while files remained at dest. We never restage.
    home = buildHome({ withSatelliteStores: true, withDynamicTools: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_200 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const logsSeed = new Database(join(home, "logs_2.sqlite"));
    logsSeed.exec(
      `INSERT INTO logs (id, ts, level, target, thread_id, estimated_bytes) VALUES (1,42,'INFO','pre','told',99)`,
    );
    logsSeed.close();

    const failed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAtLeftoverStageGate: true },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("fs_failed");
    expect(failed.count).toBe(3);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const pending = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
      pending: { state: boolean; logs: boolean; memories: boolean; goals: boolean };
    };
    expect(pending.pending).toEqual({
      state: false,
      logs: false,
      memories: false,
      goals: false,
    });

    // Pre-existing log preserved; satellite rows from this restore remain.
    const logs = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(
      logs.query("SELECT ts, target, estimated_bytes FROM logs WHERE id=1").get(),
    ).toEqual({ ts: 42, target: "pre", estimated_bytes: 99 });
    expect(logs.query("SELECT COUNT(*) AS n FROM logs WHERE thread_id IN ('told','tmid','tnew')").get())
      .toEqual({ n: 3 });
    logs.close();

    const retried = restoreTrashEntry(trashId, { codexHome: home });
    expect(retried.ok).toBe(true);
    expect(retried.count).toBe(3);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);

    const logsAfter = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    expect(
      logsAfter.query("SELECT ts, target FROM logs WHERE id=1").get(),
    ).toEqual({ ts: 42, target: "pre" });
    logsAfter.close();
  }, { timeout: STORE_BUDGET_MS });

  test("initial restore-pending write failure moves no files", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_300 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const failed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failInitialPendingWrite: true },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("fs_failed");
    expect(failed.count).toBe(0);
    expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(false);

    const retried = restoreTrashEntry(trashId, { codexHome: home });
    expect(retried.ok).toBe(true);
    expect(retried.count).toBe(3);
    expect(existsSync(stage)).toBe(false);
  }, { timeout: STORE_BUDGET_MS });

  test("interrupted pending update preserves the previous valid marker", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_400 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const failed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failPendingWriteBeforeRename: true },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("fs_failed");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const pending = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
      filesRestored: boolean;
      acceptedDestRels: string[];
      pending: { state: boolean; logs: boolean; memories: boolean; goals: boolean };
    };
    // Atomic rename never landed the post-state update — prior marker remains.
    expect(pending.filesRestored).toBe(true);
    expect(pending.pending).toEqual({
      state: true,
      logs: true,
      memories: true,
      goals: true,
    });
    expect(pending.acceptedDestRels).toContain("archived_sessions/rollout-old.jsonl");

    const retried = restoreTrashEntry(trashId, { codexHome: home });
    expect(retried.ok).toBe(true);
    expect(retried.error).toBeUndefined();
    expect(existsSync(stage)).toBe(false);
  }, { timeout: STORE_BUDGET_MS });

  test("crash after file move retries without dest_exists or fs_failed", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_500 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const crashed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterFileMoves: true },
    });
    expect(crashed.ok).toBe(false);
    expect(crashed.error).toBe("fs_failed");
    expect(crashed.count).toBe(3);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const retried = restoreTrashEntry(trashId, { codexHome: home });
    expect(retried.ok).toBe(true);
    expect(retried.error).not.toBe("dest_exists");
    expect(retried.error).not.toBe("fs_failed");
    expect(retried.count).toBe(3);
    expect(existsSync(stage)).toBe(false);
  }, { timeout: STORE_BUDGET_MS });

  test("mid-move failure keeps placed dest, marker, and resumes without dest_exists", () => {
    // First rename succeeds, second throws. Do not reverse the first file or drop
    // the durable planned acceptedDestRels — retry must finish both states.
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_550 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const failed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterMoveCount: 1 },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("fs_failed");
    expect(failed.count).toBe(1);
    expect(failed.restoredPaths).toEqual(["archived_sessions/rollout-old.jsonl"]);

    // First dest stays; remaining rollouts stay staged; marker keeps full plan.
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(false);
    expect(existsSync(join(stage, "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "rollout-new.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const pending = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
      filesRestored: boolean;
      acceptedDestRels: string[];
      pending: { state: boolean; logs: boolean; memories: boolean; goals: boolean };
    };
    expect(pending.filesRestored).toBe(true);
    expect(pending.acceptedDestRels).toEqual([
      "archived_sessions/rollout-old.jsonl",
      "archived_sessions/rollout-mid.jsonl",
      "archived_sessions/rollout-new.jsonl",
    ]);
    expect(pending.pending).toEqual({
      state: true,
      logs: true,
      memories: true,
      goals: true,
    });

    const retried = restoreTrashEntry(trashId, { codexHome: home });
    expect(retried.ok).toBe(true);
    expect(retried.error).not.toBe("dest_exists");
    expect(retried.error).not.toBe("fs_failed");
    expect(retried.count).toBe(3);
    expect(existsSync(stage)).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("malformed restore-pending.json is not treated as a fresh restore", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_600 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    writeFileSync(join(stage, "restore-pending.json"), "{not-valid-json", "utf8");
    const failed = restoreTrashEntry(trashId, { codexHome: home });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("fs_failed");
    expect(failed.count).toBe(0);
    // Stage intact — no silent fresh restore that would move files under a corrupt marker.
    expect(existsSync(join(stage, "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(false);
    expect(readFileSync(join(stage, "restore-pending.json"), "utf8")).toBe("{not-valid-json");
  }, { timeout: STORE_BUDGET_MS });

  test("resume with owed satellite sections and missing backup fails closed", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_700 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const partial = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterFirstSatelliteCommit: true },
    });
    expect(partial.ok).toBe(false);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);
    expect(existsSync(join(stage, "satellite-backup.json"))).toBe(true);
    const pendingAfterPartial = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
      pending: { logs: boolean; memories: boolean; goals: boolean };
    };
    expect(
      pendingAfterPartial.pending.logs
      || pendingAfterPartial.pending.memories
      || pendingAfterPartial.pending.goals,
    ).toBe(true);

    unlinkSync(join(stage, "satellite-backup.json"));
    const failed = restoreTrashEntry(trashId, { codexHome: home });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("db_reconcile_failed");
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(join(stage, "manifest.json"))).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("resume with owed logs section but missing logs in backup fails closed", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_800 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const partial = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterStateCommit: true },
    });
    expect(partial.ok).toBe(false);

    const backupPath = join(stage, "satellite-backup.json");
    const backup = JSON.parse(readFileSync(backupPath, "utf8")) as Record<string, unknown>;
    delete backup.logs;
    writeFileSync(backupPath, JSON.stringify(backup));

    const pending = JSON.parse(readFileSync(join(stage, "restore-pending.json"), "utf8")) as {
      pending: { logs: boolean; memories: boolean; goals: boolean };
    };
    expect(pending.pending.logs).toBe(true);

    const failed = restoreTrashEntry(trashId, { codexHome: home });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("db_reconcile_failed");
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(join(stage, "manifest.json"))).toBe(true);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("failed tombstone rename keeps stage recoverable and listed", () => {
    home = buildHome();
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_001_900 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const failed = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failStageTombstoneRename: true },
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toBe("fs_failed");
    expect(failed.count).toBe(3);
    expect(existsSync(stage)).toBe(true);
    expect(existsSync(join(stage, "manifest.json"))).toBe(true);
    expect(listTrashEntries(home).some(e => e.id === trashId)).toBe(true);

    const retried = restoreTrashEntry(trashId, { codexHome: home });
    expect(retried.ok).toBe(true);
    expect(existsSync(stage)).toBe(false);
    expect(listTrashEntries(home)).toEqual([]);
  }, { timeout: STORE_BUDGET_MS });

  test("tombstone delete failure reports success without phantom trash entry", () => {
    home = buildHome();
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_002_000 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const restored = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failTombstoneDelete: true },
    });
    expect(restored.ok).toBe(true);
    expect(existsSync(stage)).toBe(false);
    expect(listTrashEntries(home)).toEqual([]);

    const trashRoot = join(home, ".trash");
    const tombstones = readdirSync(trashRoot).filter(n => n.startsWith(".tombstone-"));
    expect(tombstones.length).toBe(1);
  }, { timeout: STORE_BUDGET_MS });

  test("cleanup rejects overlap with accepted restore-pending destinations after state-commit failure", () => {
    home = buildHome({ withSatelliteStores: true });
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_002_000 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));
    const restoredRel = "archived_sessions/rollout-old.jsonl";

    const partial = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterStateCommit: true },
    });
    expect(partial.ok).toBe(false);
    expect(existsSync(join(home, restoredRel))).toBe(true);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const overlapDigest = computePreviewDigest(
      selectOldestPercent(listArchivedCandidates(home), 100),
      100,
    );
    const blocked = executeArchivedCleanup({
      percent: 100,
      mode: "quarantine",
      digest: overlapDigest,
      codexHome: home,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("restore_pending_overlap");
    expect(existsSync(join(home, restoredRel))).toBe(true);
    expect(existsSync(stage)).toBe(true);

    const retry = restoreTrashEntry(trashId, { codexHome: home });
    expect(retry.ok).toBe(true);
    expect(existsSync(join(home, restoredRel))).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("cleanup rejects overlap with accepted restore-pending destinations after file-move failure", () => {
    home = buildHome();
    const quarantined = runWithDigest(100, "quarantine", home, { now: 1_700_000_002_100 });
    expect(quarantined.ok).toBe(true);
    const trashId = quarantined.trashDir!;
    const stage = join(home, ...trashId.split("/"));

    const partial = restoreTrashEntry(trashId, {
      codexHome: home,
      _test: { failAfterMoveCount: 1 },
    });
    expect(partial.ok).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "rollout-mid.jsonl"))).toBe(true);
    expect(existsSync(join(stage, "restore-pending.json"))).toBe(true);

    const overlapDigest = computePreviewDigest(
      selectOldestPercent(listArchivedCandidates(home), 100),
      100,
    );
    const blocked = executeArchivedCleanup({
      percent: 100,
      mode: "permanent",
      digest: overlapDigest,
      codexHome: home,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("restore_pending_overlap");
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(stage)).toBe(true);

    const retry = restoreTrashEntry(trashId, { codexHome: home });
    expect(retry.ok).toBe(true);
  }, { timeout: STORE_BUDGET_MS });

  test("percent preview backfills past pending oldest archive for manual cleanup", () => {
    home = buildHome();
    const stage = join(home, ".trash", "1700000");
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "restore-pending.json"), JSON.stringify({
      version: 1,
      filesRestored: true,
      acceptedDestRels: ["archived_sessions/rollout-old.jsonl"],
      pending: { state: true, logs: false, memories: false, goals: false },
    }));

    const preview = previewArchivedCleanup(34, home);
    expect(preview.count).toBe(1);
    expect(preview.candidates.map(c => c.relPath)).toEqual(["archived_sessions/rollout-mid.jsonl"]);

    const result = runWithDigest(34, "quarantine", home, { now: 1_700_000_001_000 });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(existsSync(join(home, "archived_sessions", "rollout-old.jsonl"))).toBe(true);
    expect(existsSync(join(home, "archived_sessions", "rollout-mid.jsonl"))).toBe(false);
    expect(existsSync(join(home, "archived_sessions", "rollout-new.jsonl"))).toBe(true);
  });
});
