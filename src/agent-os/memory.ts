// Phase 07 — Memory OS: scoped, typed, provenance-backed, inspectable records.

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";

export type MemoryScope = "global" | "project" | "agent" | "decision" | "failure" | "workflow";

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  subjectId: string | null;
  title: string;
  content: string;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface MemoryRow {
  id: string;
  scope: string;
  subject_id: string | null;
  title: string;
  content: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    subjectId: row.subject_id,
    title: row.title,
    content: row.content,
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function writeMemory(input: {
  id?: string;
  scope: MemoryScope;
  subjectId?: string | null;
  title: string;
  content: string;
  provenance?: Record<string, unknown>;
}): MemoryRecord {
  const db = openAgentOsDb();
  const id = input.id ?? `mem_${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.query(`
    INSERT INTO memories (id, scope, subject_id, title, content, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      provenance_json = excluded.provenance_json,
      updated_at = excluded.updated_at
  `).run(id, input.scope, input.subjectId ?? null, input.title, input.content, JSON.stringify(input.provenance ?? {}), now, now);
  const row = db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow;
  return rowToMemory(row);
}

export function readMemory(id: string): MemoryRecord | null {
  const row = openAgentOsDb().query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  return row ? rowToMemory(row) : null;
}

export function listMemories(filter: { scope?: MemoryScope; subjectId?: string; limit?: number } = {}): MemoryRecord[] {
  const db = openAgentOsDb();
  const limit = Math.min(filter.limit ?? 100, 500);
  if (filter.scope && filter.subjectId) {
    return (db
      .query("SELECT * FROM memories WHERE scope = ? AND subject_id = ? ORDER BY updated_at DESC, id LIMIT ?")
      .all(filter.scope, filter.subjectId, limit) as MemoryRow[]).map(rowToMemory);
  }
  if (filter.scope) {
    return (db
      .query("SELECT * FROM memories WHERE scope = ? ORDER BY updated_at DESC, id LIMIT ?")
      .all(filter.scope, limit) as MemoryRow[]).map(rowToMemory);
  }
  return (db
    .query("SELECT * FROM memories ORDER BY updated_at DESC, id LIMIT ?")
    .all(limit) as MemoryRow[]).map(rowToMemory);
}

export function deleteMemory(id: string): boolean {
  const result = openAgentOsDb().query("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}
