// Phase 09 — Workflow Engine: durable versioned step graphs with approvals.
//
// A workflow definition is an ordered list of steps. Each step is a task kind
// executed through the Phase 04 queue, so retries/recovery inherit queue
// semantics. An optional approval gate pauses the run until granted.

import { randomUUID } from "node:crypto";
import { openAgentOsDb } from "./db";
import { claimNextTask, completeTask, enqueueTask, failTask, getTask, type AgentOsTask } from "./tasks";
import { recordAgentEvent } from "./events";

export interface WorkflowStep {
  kind: string;
  title: string;
  requiresApproval?: boolean;
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStep[];
}

export type WorkflowRunStatus = "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  state: {
    stepIndex: number;
    currentTaskId: string | null;
    approvals: Record<string, "granted" | "denied">;
    results: Record<string, unknown>;
  };
  createdMs: number;
  updatedMs: number;
}

interface RunRow {
  id: string;
  workflow_id: string;
  status: string;
  state_json: string;
  created_ms: number;
  updated_ms: number;
}

interface WorkflowDefRow {
  id: string;
  name: string;
  version: number;
  definition_json: string;
  created_at: string;
}

export function registerWorkflow(definition: WorkflowDefinition): string {
  const db = openAgentOsDb();
  const id = `wf_${randomUUID().slice(0, 8)}`;
  db.query("INSERT INTO workflows (id, name, version, definition_json, created_at) VALUES (?, ?, 1, ?, ?)")
    .run(id, definition.name, JSON.stringify(definition), new Date().toISOString());
  return id;
}

function loadDefinition(workflowId: string): WorkflowDefinition {
  const row = openAgentOsDb().query("SELECT * FROM workflows WHERE id = ?").get(workflowId) as WorkflowDefRow | undefined;
  if (!row) throw new Error(`workflow ${workflowId} not found`);
  return JSON.parse(row.definition_json) as WorkflowDefinition;
}

function runFromRow(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status as WorkflowRunStatus,
    state: JSON.parse(row.state_json) as WorkflowRun["state"],
    createdMs: row.created_ms,
    updatedMs: row.updated_ms,
  };
}

export function startWorkflowRun(workflowId: string): WorkflowRun {
  const db = openAgentOsDb();
  loadDefinition(workflowId); // fail fast on unknown workflow
  const id = `run_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const state = { stepIndex: 0, currentTaskId: null as string | null, approvals: {} as Record<string, "granted" | "denied">, results: {} as Record<string, unknown> };
  db.query("INSERT INTO workflow_runs (id, workflow_id, status, state_json, created_ms, updated_ms) VALUES (?, ?, 'running', ?, ?, ?)")
    .run(id, workflowId, JSON.stringify(state), now, now);
  recordAgentEvent({ taskId: id, kind: "workflow.started", payload: { workflowId } });
  const row = db.query("SELECT * FROM workflow_runs WHERE id = ?").get(id) as RunRow;
  const run = runFromRow(row);
  // Enqueue the first step immediately so the run is observable without an
  // explicit first pump; approval gates are honored inside the pump.
  return pumpWorkflowRun(run.id);
}

export function getWorkflowRun(runId: string): WorkflowRun | null {
  const row = openAgentOsDb().query("SELECT * FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined;
  return row ? runFromRow(row) : null;
}

function saveState(run: WorkflowRun): void {
  openAgentOsDb()
    .query("UPDATE workflow_runs SET status = ?, state_json = ?, updated_ms = ? WHERE id = ?")
    .run(run.status, JSON.stringify(run.state), Date.now(), run.id);
}

/**
 * Drive a run forward by one pump: enqueue the current step, await its task,
 * honor approval gates. Call repeatedly (tick loop or after task completion).
 */
export function pumpWorkflowRun(runId: string, now = Date.now()): WorkflowRun {
  const run = getWorkflowRun(runId);
  if (!run || (run.status !== "running" && run.status !== "waiting_approval")) return run!;
  const definition = loadDefinition(run.workflowId);
  const steps = definition.steps;

  // Resume an in-flight step task if one exists.
  if (run.state.currentTaskId) {
    const task = getTask(run.state.currentTaskId);
    if (task && task.status === "running") return run;
    if (task && task.status === "succeeded") {
      run.state.results[`step_${run.state.stepIndex}`] = task.result ?? {};
      run.state.currentTaskId = null;
      run.state.stepIndex += 1;
      run.status = "running";
      recordAgentEvent({ taskId: run.id, kind: "workflow.step_completed", payload: { stepIndex: run.state.stepIndex - 1 } });
    } else if (task && task.status === "failed") {
      run.status = "failed";
      saveState(run);
      recordAgentEvent({ taskId: run.id, kind: "workflow.failed", payload: { stepIndex: run.state.stepIndex } });
      return run;
    } else if (task && task.status === "queued") {
      return run; // waiting for the queue worker
    }
  }

  if (run.state.stepIndex >= steps.length) {
    run.status = "succeeded";
    saveState(run);
    recordAgentEvent({ taskId: run.id, kind: "workflow.succeeded" });
    return run;
  }

  const step = steps[run.state.stepIndex];
  if (step.requiresApproval && run.state.approvals[`step_${run.state.stepIndex}`] !== "granted") {
    run.status = "waiting_approval";
    saveState(run);
    recordAgentEvent({ taskId: run.id, kind: "workflow.approval_required", payload: { stepIndex: run.state.stepIndex } });
    return run;
  }

  const task = enqueueTask({ kind: step.kind, title: step.title, payload: { workflowRunId: run.id, stepIndex: run.state.stepIndex } });
  run.state.currentTaskId = task.id;
  saveState(run);
  return run;
}

export function grantWorkflowApproval(runId: string, stepIndex: number, granted: boolean): WorkflowRun | null {
  const run = getWorkflowRun(runId);
  if (!run) return null;
  run.state.approvals[`step_${stepIndex}`] = granted ? "granted" : "denied";
  if (!granted) {
    run.status = "cancelled";
    saveState(run);
    recordAgentEvent({ taskId: run.id, kind: "workflow.approval_denied", payload: { stepIndex } });
    return run;
  }
  run.status = "running";
  saveState(run);
  recordAgentEvent({ taskId: run.id, kind: "workflow.approval_granted", payload: { stepIndex } });
  return pumpWorkflowRun(runId);
}

export { claimNextTask, completeTask, failTask };
