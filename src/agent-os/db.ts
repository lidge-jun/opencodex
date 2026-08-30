// Agent OS core storage (Phases 02-16 subsystem).
//
// Local-first persistent store for the Agent OS roadmap: agent registry,
// durable task queue, permission policy, memory, skills, workflows, sessions,
// and the Brain Universe observatory. Lives under the existing OPENCODEX_HOME
// config dir like every other opencodex/PaohupByPaoZa ledger — no new process,
// no external database. Derived indexes are rebuildable; this file is the only
// source of truth for Agent OS metadata.

import { Database } from "bun:sqlite";
import { getConfigDir } from "../config";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// v3: brain_files persists latest scan snapshots for Atlas/Universe graphs.
// v2: brain_projects/brain_scans/brain_sessions/brain_session_events
// (Phase 15 Brain Universe), team_runs (Phase 10), remote_nodes (Phase 12),
// reviews (Phase 16 slice), write_permits (Phase 16 gateway). Databases created
// by v1 builds lack these tables; the v2 migration is additive (CREATE TABLE IF
// NOT EXISTS) and never touches v1 data.
export const AGENT_OS_SCHEMA_VERSION = 3;

let dbHandle: Database | null = null;
let dbFile = "";

export function agentOsDbPath(dir = getConfigDir()): string {
  return join(dir, "agent-os.sqlite3");
}

/** Open (and lazily migrate) the Agent OS store. One handle per process. */
export function openAgentOsDb(dir = getConfigDir()): Database {
  if (dbHandle) return dbHandle;
  const path = agentOsDbPath(dir);
  mkdirSync(dir, { recursive: true });
  dbHandle = new Database(path, { create: true });
  dbHandle.exec("PRAGMA journal_mode = WAL;");
  dbHandle.exec("PRAGMA foreign_keys = ON;");
  migrate(dbHandle);
  dbHandle.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  dbFile = path;
  return dbHandle;
}

/** Test seam: close and forget the cached handle. */
export function closeAgentOsDbForTests(): void {
  dbHandle?.close();
  dbHandle = null;
  dbFile = "";
}

export function agentOsDbFile(): string {
  return dbFile;
}

function migrate(db: Database): void {
  const current = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get() as { name: string } | undefined;
  let storedVersion = 0;
  if (current) {
    const row = db.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined;
    storedVersion = Number(row?.value ?? 0);
  }
  if (storedVersion > AGENT_OS_SCHEMA_VERSION) {
    throw new Error(
      `agent-os.sqlite3 schema version ${storedVersion} is newer than this build supports (${AGENT_OS_SCHEMA_VERSION})`,
    );
  }
  if (storedVersion === AGENT_OS_SCHEMA_VERSION) return;

  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Phase 02: Agent Registry -------------------------------------------
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'generalist',
        enabled INTEGER NOT NULL DEFAULT 1,
        permissions_json TEXT NOT NULL DEFAULT '{}',
        health TEXT NOT NULL DEFAULT 'unknown',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Phase 04: Persistent Task Queue ------------------------------------
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        run_after_ms INTEGER NOT NULL DEFAULT 0,
        heartbeat_ms INTEGER,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL,
        result_json TEXT,
        error_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status_runafter ON tasks(status, run_after_ms);

      -- Phase 05: Sandbox / permission policy ------------------------------
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,             -- 'agent' | 'task' | 'global'
        subject_id TEXT,                        -- agent id, task id, or NULL for global
        capability TEXT NOT NULL,               -- e.g. 'fs.read', 'net.fetch', 'shell.exec'
        effect TEXT NOT NULL,                   -- 'allow' | 'deny'
        scope_json TEXT NOT NULL DEFAULT '{}',  -- path prefixes, host allowlists
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_policies_subject ON policies(subject_type, subject_id, capability);

      -- Phase 05: approval ledger (fail-closed, human in the loop) ----------
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending|granted|denied|expired
        requested_ms INTEGER NOT NULL,
        decided_ms INTEGER,
        decided_by TEXT
      );

      -- Phase 07: Memory OS --------------------------------------------------
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,                    -- global|project|agent|decision|failure
        subject_id TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Phase 08: Skill Store ------------------------------------------------
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '0',
        path TEXT,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',  -- active|deprecated|missing
        config_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL
      );

      -- Phase 09: Workflow Engine --------------------------------------------
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running',
        state_json TEXT NOT NULL DEFAULT '{}',
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );

      -- Phase 11: Observability (agent-side events; proxy traffic has its own ledgers)
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        task_id TEXT,
        agent_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_task ON agent_events(task_id, ts_ms);

      -- Phase 10: Team runs (bounded-parallel children) ----------------------
      CREATE TABLE IF NOT EXISTS team_runs (
        id TEXT PRIMARY KEY,
        team_name TEXT NOT NULL,
        max_parallel INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        task_ids_json TEXT NOT NULL DEFAULT '{}',
        created_ms INTEGER NOT NULL
      );

      -- Phase 12: Remote execution nodes -------------------------------------
      CREATE TABLE IF NOT EXISTS remote_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        max_parallel INTEGER NOT NULL DEFAULT 1,
        last_heartbeat_ms INTEGER NOT NULL
      );

      -- Phase 16 (read-only part): Reviewer Council results ------------------
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        verdict TEXT NOT NULL,
        score INTEGER,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_subject ON reviews(subject_kind, subject_id);

      -- Phase 15 (Brain Universe): project registry + scans ------------------
      CREATE TABLE IF NOT EXISTS brain_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        scan_enabled INTEGER NOT NULL DEFAULT 1,
        scan_mode TEXT NOT NULL DEFAULT 'standard'
      );
      CREATE TABLE IF NOT EXISTS brain_scans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES brain_projects(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        coverage_json TEXT NOT NULL,
        created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS brain_files (
        scan_id TEXT NOT NULL REFERENCES brain_scans(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES brain_projects(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        disposition TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        extension TEXT,
        modified_ms INTEGER NOT NULL,
        PRIMARY KEY (scan_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_brain_files_project_scan ON brain_files(project_id, scan_id);
      CREATE TABLE IF NOT EXISTS brain_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        agent_id TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        started_at TEXT,
        ended_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS brain_session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES brain_sessions(id) ON DELETE CASCADE,
        ts_ms INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_brain_events_session ON brain_session_events(session_id, ts_ms);

      -- Phase 16: SHA-bound single-use write permits --------------------------
      CREATE TABLE IF NOT EXISTS write_permits (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        scope_hash TEXT NOT NULL,
        token_digest TEXT NOT NULL,
        issued_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'issued'
      );
      CREATE INDEX IF NOT EXISTS idx_write_permits_digest ON write_permits(token_digest);
    `);
    db.query(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(String(AGENT_OS_SCHEMA_VERSION));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
