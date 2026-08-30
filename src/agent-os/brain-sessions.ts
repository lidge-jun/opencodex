// Phase 15 (Brain Universe) — Session Indexer.
//
// Imports Claude-style JSONL session logs and Codex-style logs into the
// canonical session/event schema. Large files are read line-by-line from a
// stream (never loaded whole into memory) and the importer records a byte
// offset per session so an interrupted import resumes where it stopped.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { openAgentOsDb } from "./db";

export type SessionSource = "claude" | "codex" | "pao" | "custom";

export interface BrainSession {
  id: string;
  projectId: string | null;
  agentId: string | null;
  source: SessionSource;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface CanonicalEvent {
  tsMs: number;
  eventType: string;
  payload: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  project_id: string | null;
  agent_id: string | null;
  source: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  metadata_json: string;
}

function rowToSession(row: SessionRow): BrainSession {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    source: row.source as SessionSource,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

export function createSession(input: {
  id?: string;
  projectId?: string | null;
  agentId?: string | null;
  source: SessionSource;
  startedAt?: string | null;
  metadata?: Record<string, unknown>;
}): BrainSession {
  const db = openAgentOsDb();
  const id = input.id ?? `sess_${randomUUID().slice(0, 8)}`;
  db.query(
    "INSERT INTO brain_sessions (id, project_id, agent_id, source, status, started_at, ended_at, metadata_json) VALUES (?, ?, ?, ?, 'running', ?, NULL, ?)"
  ).run(id, input.projectId ?? null, input.agentId ?? null, input.source, input.startedAt ?? new Date().toISOString(), JSON.stringify(input.metadata ?? {}));
  const row = db.query("SELECT * FROM brain_sessions WHERE id = ?").get(id) as SessionRow;
  return rowToSession(row);
}

export function getSession(id: string): BrainSession | null {
  const row = openAgentOsDb().query("SELECT * FROM brain_sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listSessions(projectId?: string): BrainSession[] {
  const db = openAgentOsDb();
  const rows = (
    projectId
      ? db.query("SELECT * FROM brain_sessions WHERE project_id = ? ORDER BY started_at, id").all(projectId)
      : db.query("SELECT * FROM brain_sessions ORDER BY started_at, id").all()
  ) as SessionRow[];
  return rows.map(rowToSession);
}

export function closeSession(id: string, endedAt = new Date().toISOString()): boolean {
  const result = openAgentOsDb()
    .query("UPDATE brain_sessions SET status = 'completed', ended_at = ? WHERE id = ?")
    .run(endedAt, id);
  return result.changes > 0;
}

export function appendEvent(sessionId: string, event: CanonicalEvent): number {
  const result = openAgentOsDb()
    .query("INSERT INTO brain_session_events (session_id, ts_ms, event_type, payload_json) VALUES (?, ?, ?, ?)")
    .run(sessionId, event.tsMs, event.eventType, JSON.stringify(event.payload));
  return Number(result.lastInsertRowid);
}

export function eventsForSession(sessionId: string): CanonicalEvent[] {
  return (openAgentOsDb()
    .query("SELECT ts_ms, event_type, payload_json FROM brain_session_events WHERE session_id = ? ORDER BY ts_ms, id")
    .all(sessionId) as { ts_ms: number; event_type: string; payload_json: string }[])
    .map((row) => ({ tsMs: row.ts_ms, eventType: row.event_type, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

/** Map a raw JSONL record onto the canonical event vocabulary. */
export function mapToCanonicalEvent(raw: Record<string, unknown>): CanonicalEvent | null {
  const type = raw.type ?? raw.event ?? raw.kind;
  const tsRaw = raw.timestamp ?? raw.ts ?? raw.ts_ms;
  const tsMs = typeof tsRaw === "number"
    ? tsRaw < 10_000_000_000 ? tsRaw * 1000 : tsRaw
    : typeof tsRaw === "string" ? Date.parse(tsRaw) || Date.now() : Date.now();
  if (typeof type !== "string") return null;
  const mapping: Record<string, string> = {
    user: "user.message",
    user_message: "user.message",
    assistant: "agent.message",
    reasoning: "agent.reasoning_summary",
    tool_use: "tool.called",
    tool_result: "tool.completed",
    error: "error.raised",
    file_read: "file.read",
    file_write: "file.modified",
    test_pass: "test.passed",
    test_fail: "test.failed",
  };
  const canonical = mapping[type] ?? (type.includes(".") ? type : `agent.${type}`);
  return { tsMs, eventType: canonical, payload: raw };
}

export interface ImportProgress {
  sessionId: string;
  eventsIngested: number;
  linesBroken: number;
  offsetBytes: number;
}

/** Resume offset stored per session under key import_offset:<file>. */
function getOffset(sessionId: string, file: string): number {
  const row = openAgentOsDb()
    .query("SELECT value FROM schema_meta WHERE key = ?")
    .get(`import_offset:${sessionId}:${file}`) as { value: string } | undefined;
  return Number(row?.value ?? 0);
}

function setOffset(sessionId: string, file: string, offset: number): void {
  openAgentOsDb()
    .query("INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`import_offset:${sessionId}:${file}`, String(offset));
}

/**
 * Import a JSONL session log. Streaming line reader; broken lines are counted
 * (not fatal) and the byte offset is checkpointed so a crashed import resumes.
 */
export async function importSessionJsonl(sessionId: string, file: string): Promise<ImportProgress> {
  const resumeFrom = getOffset(sessionId, file);
  let eventsIngested = 0;
  let linesBroken = 0;
  let offsetBytes = resumeFrom;

  const stream = createReadStream(file, { encoding: "utf8", start: resumeFrom });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // newline
    const trimmed = line.trim();
    if (trimmed.length === 0) { offsetBytes += lineBytes; continue; }
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      const event = mapToCanonicalEvent(raw);
      if (event) {
        appendEvent(sessionId, event);
        eventsIngested += 1;
      } else {
        linesBroken += 1;
      }
    } catch {
      linesBroken += 1;
    }
    offsetBytes += lineBytes;
  }
  setOffset(sessionId, file, offsetBytes);
  return { sessionId, eventsIngested, linesBroken, offsetBytes };
}
