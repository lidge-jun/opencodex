// Phase 10 — Multi-Agent Teams: bounded-parallel child tasks with isolation.

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";
import { enqueueTask, type AgentOsTask } from "./tasks";
import { recordAgentEvent } from "./events";

export interface TeamSpec {
  name: string;
  /** Max children executing concurrently. Bounded, never unbounded fan-out. */
  maxParallel: number;
  childAgentIds: string[];
  childKinds: { kind: string; title: string; payload?: Record<string, unknown> }[];
}

export interface TeamRun {
  id: string;
  teamName: string;
  maxParallel: number;
  status: "running" | "succeeded" | "failed";
  taskIds: string[];
  createdAt: number;
}

interface TeamRunRow {
  id: string;
  team_name: string;
  max_parallel: number;
  status: string;
  task_ids_json: string;
  created_ms: number;
}

function rowToTeamRun(row: TeamRunRow): TeamRun {
  return {
    id: row.id,
    teamName: row.team_name,
    maxParallel: row.max_parallel,
    status: row.status as TeamRun["status"],
    taskIds: JSON.parse(row.task_ids_json) as string[],
    createdAt: row.created_ms,
  };
}

export function startTeamRun(spec: TeamSpec): TeamRun {
  const db = openAgentOsDb();
  if (spec.maxParallel < 1) throw new Error("maxParallel must be >= 1");
  if (spec.childKinds.length === 0) throw new Error("a team run needs at least one child task");
  const id = `team_${randomUUID().slice(0, 8)}`;
  // Bounded dispatch: enqueue only the first maxParallel children now. The
  // dispatcher enqueues the rest as slots free up (keeps parallelism bounded).
  const dispatchable = spec.childKinds.slice(0, spec.maxParallel);
  const deferred = spec.childKinds.slice(spec.maxParallel);
  const taskIds = dispatchable.map((child) =>
    enqueueTask({
      kind: child.kind,
      title: child.title,
      payload: { ...child.payload, teamRunId: id, deferred: false },
    }).id,
  );
  const now = Date.now();
  db.query(
    "INSERT INTO team_runs (id, team_name, max_parallel, status, task_ids_json, created_ms) VALUES (?, ?, ?, 'running', ?, ?)",
  ).run(id, spec.name, spec.maxParallel, JSON.stringify({ dispatched: taskIds, deferred }), now);
  recordAgentEvent({ taskId: id, kind: "team.started", payload: { teamName: spec.name, children: spec.childKinds.length, maxParallel: spec.maxParallel } });
  const row = db.query("SELECT * FROM team_runs WHERE id = ?").get(id) as TeamRunRow;
  return rowToTeamRun(row);
}

export function getTeamRun(id: string): TeamRun | null {
  const row = openAgentOsDb().query("SELECT * FROM team_runs WHERE id = ?").get(id) as TeamRunRow | undefined;
  return row ? rowToTeamRun(row) : null;
}

export function setTeamRunStatus(id: string, status: TeamRun["status"]): boolean {
  const result = openAgentOsDb()
    .query("UPDATE team_runs SET status = ? WHERE id = ?")
    .run(status, id);
  return result.changes > 0;
}

/** The stored dispatch plan (dispatched + deferred ids). */
export function teamDispatchPlan(teamRunId: string): { dispatched: string[]; deferred: string[] } {
  const row = openAgentOsDb().query("SELECT task_ids_json FROM team_runs WHERE id = ?").get(teamRunId) as
    | { task_ids_json: string }
    | undefined;
  if (!row) throw new Error(`team run ${teamRunId} not found`);
  return JSON.parse(row.task_ids_json) as { dispatched: string[]; deferred: string[] };
}
