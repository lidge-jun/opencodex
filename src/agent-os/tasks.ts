// Phase 04 — Persistent task queue: durable, recoverable, traced tasks.

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";
import { recordAgentEvent } from "./events";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AgentOsTask {
  id: string;
  agentId: string | null;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  runAfterMs: number;
  heartbeatMs: number | null;
  createdMs: number;
  updatedMs: number;
  result: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
}

interface TaskRow {
  id: string;
  agent_id: string | null;
  kind: string;
  title: string;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after_ms: number;
  heartbeat_ms: number | null;
  created_ms: number;
  updated_ms: number;
  result_json: string | null;
  error_json: string | null;
}

function rowToTask(row: TaskRow): AgentOsTask {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    title: row.title,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status as TaskStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAfterMs: row.run_after_ms,
    heartbeatMs: row.heartbeat_ms,
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
    result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : null,
    error: row.error_json ? (JSON.parse(row.error_json) as { message: string; code?: string }) : null,
  };
}

export interface TaskInput {
  agentId?: string | null;
  kind: string;
  title: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfterMs?: number;
}

export function enqueueTask(input: TaskInput): AgentOsTask {
  const db = openAgentOsDb();
  const id = `task_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  db.query(`
    INSERT INTO tasks (id, agent_id, kind, title, payload_json, status, attempts, max_attempts, run_after_ms, created_ms, updated_ms)
    VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
  `).run(id, input.agentId ?? null, input.kind, input.title, JSON.stringify(input.payload ?? {}), input.maxAttempts ?? 3, input.runAfterMs ?? 0, now, now);
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  const task = rowToTask(row);
  recordAgentEvent({ taskId: task.id, agentId: task.agentId, kind: "task.queued" });
  return task;
}

/**
 * Claim the next runnable task. Survives restarts: a task left 'running' from a
 * dead process (stale heartbeat) becomes claimable again after the stale window.
 */
export function claimNextTask(options: { staleRunningMs?: number; now?: number } = {}): AgentOsTask | null {
  const db = openAgentOsDb();
  const now = options.now ?? Date.now();
  const stale = options.staleRunningMs ?? 120_000;
  // Recover stale running tasks first (crash recovery path).
  db.query(
    "UPDATE tasks SET status = 'queued', updated_ms = ? WHERE status = 'running' AND (heartbeat_ms IS NULL OR heartbeat_ms < ?)",
  ).run(now, now - stale);
  const row = db
    .query(
      "SELECT * FROM tasks WHERE status = 'queued' AND run_after_ms <= ? ORDER BY created_ms, rowid LIMIT 1",
    )
    .get(now) as TaskRow | undefined;
  if (!row) return null;
  db.query("UPDATE tasks SET status = 'running', attempts = attempts + 1, heartbeat_ms = ?, updated_ms = ? WHERE id = ?")
    .run(now, now, row.id);
  const claimed = db.query("SELECT * FROM tasks WHERE id = ?").get(row.id) as TaskRow;
  const task = rowToTask(claimed);
  recordAgentEvent({ taskId: task.id, agentId: task.agentId, kind: "task.claimed" });
  return task;
}

/** Claim one specific task by id (used by the guarded runner). */
export function claimTask(id: string): AgentOsTask | null {
  const db = openAgentOsDb();
  const now = Date.now();
  const changed = db
    .query("UPDATE tasks SET status = 'running', attempts = attempts + 1, heartbeat_ms = ?, updated_ms = ? WHERE id = ? AND status = 'queued'")
    .run(now, now, id);
  if (changed.changes === 0) return null;
  const row = db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow;
  const task = rowToTask(row);
  recordAgentEvent({ taskId: task.id, agentId: task.agentId, kind: "task.claimed" });
  return task;
}

export function heartbeatTask(id: string): boolean {
  const result = openAgentOsDb()
    .query("UPDATE tasks SET heartbeat_ms = ?, updated_ms = ? WHERE id = ? AND status = 'running'")
    .run(Date.now(), Date.now(), id);
  return result.changes > 0;
}

export function completeTask(id: string, result: Record<string, unknown>): boolean {
  const now = Date.now();
  const changed = openAgentOsDb()
    .query("UPDATE tasks SET status = 'succeeded', result_json = ?, updated_ms = ?, heartbeat_ms = ? WHERE id = ? AND status = 'running'")
    .run(JSON.stringify(result), now, now, id);
  if (changed.changes > 0) recordAgentEvent({ taskId: id, kind: "task.succeeded" });
  return changed.changes > 0;
}

export function failTask(id: string, error: { message: string; code?: string }): boolean {
  const db = openAgentOsDb();
  const now = Date.now();
  // Queued tasks can fail too (e.g. permit redemption failed before the work
  // started); treat them as terminal failures with no retry bookkeeping.
  const queuedRow = db.query("SELECT id FROM tasks WHERE id = ? AND status = 'queued'").get(id) as
    | { id: string }
    | undefined;
  if (queuedRow) {
    db.query("UPDATE tasks SET status = 'failed', error_json = ?, updated_ms = ? WHERE id = ?")
      .run(JSON.stringify(error), now, id);
    recordAgentEvent({ taskId: id, kind: "task.failed", payload: { error, phase: "pre-claim" } });
    return true;
  }
  const row = db.query("SELECT attempts, max_attempts FROM tasks WHERE id = ? AND status = 'running'").get(id) as
    | { attempts: number; max_attempts: number }
    | undefined;
  if (!row) return false;
  const retry = row.attempts < row.max_attempts;
  const backoffMs = Math.min(60_000, 2 ** row.attempts * 1000);
  db.query(
    retry
      ? "UPDATE tasks SET status = 'queued', error_json = ?, run_after_ms = ?, updated_ms = ? WHERE id = ?"
      : "UPDATE tasks SET status = 'failed', error_json = ?, updated_ms = ? WHERE id = ?",
  ).run(JSON.stringify(error), ...(retry ? [now + backoffMs, now, id] as const : [now, id] as const));
  recordAgentEvent({ taskId: id, kind: retry ? "task.retry_scheduled" : "task.failed", payload: { error } });
  return true;
}

export function cancelTask(id: string): boolean {
  const result = openAgentOsDb()
    .query("UPDATE tasks SET status = 'cancelled', updated_ms = ? WHERE id = ? AND status IN ('queued', 'running')")
    .run(Date.now(), id);
  return result.changes > 0;
}

export function getTask(id: string): AgentOsTask | null {
  const row = openAgentOsDb().query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listTasks(status?: TaskStatus): AgentOsTask[] {
  const db = openAgentOsDb();
  const rows = (
    status
      ? db.query("SELECT * FROM tasks WHERE status = ? ORDER BY created_ms, rowid").all(status)
      : db.query("SELECT * FROM tasks ORDER BY created_ms, rowid").all()
  ) as TaskRow[];
  return rows.map(rowToTask);
}
