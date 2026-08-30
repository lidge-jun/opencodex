// Phase 11 (agent-side) — event trail for tasks/agents; powers timeline + replay.

import { openAgentOsDb } from "./db";

export interface AgentOsEvent {
  id: number;
  tsMs: number;
  taskId: string | null;
  agentId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

export function recordAgentEvent(input: {
  taskId?: string | null;
  agentId?: string | null;
  kind: string;
  payload?: Record<string, unknown>;
}): AgentOsEvent {
  const db = openAgentOsDb();
  const ts = Date.now();
  const result = db
    .query("INSERT INTO agent_events (ts_ms, task_id, agent_id, kind, payload_json) VALUES (?, ?, ?, ?, ?)")
    .run(ts, input.taskId ?? null, input.agentId ?? null, input.kind, JSON.stringify(input.payload ?? {}));
  return {
    id: Number(result.lastInsertRowid),
    tsMs: ts,
    taskId: input.taskId ?? null,
    agentId: input.agentId ?? null,
    kind: input.kind,
    payload: input.payload ?? {},
  };
}

export function listEventsForTask(taskId: string): AgentOsEvent[] {
  const rows = openAgentOsDb()
    .query("SELECT * FROM agent_events WHERE task_id = ? ORDER BY ts_ms, id")
    .all(taskId) as {
    id: number;
    ts_ms: number;
    task_id: string | null;
    agent_id: string | null;
    kind: string;
    payload_json: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    tsMs: row.ts_ms,
    taskId: row.task_id,
    agentId: row.agent_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }));
}
