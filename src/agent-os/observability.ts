// Phase 11 — Observability & Replay: task timelines with failure replay
// (metadata-only; never re-executes side effects silently).

import { openAgentOsDb } from "./db";
import { listEventsForTask, type AgentOsEvent } from "./events";
import { getTask, type AgentOsTask } from "./tasks";

export interface TaskTimeline {
  task: AgentOsTask;
  events: AgentOsEvent[];
}

export function taskTimeline(taskId: string): TaskTimeline | null {
  const task = getTask(taskId);
  if (!task) return null;
  return { task, events: listEventsForTask(taskId) };
}

export type ReplayDecision = "safe" | "unsafe_side_effects" | "missing_task";

export interface ReplayPlan {
  decision: ReplayDecision;
  reason: string;
  taskId?: string;
}

/**
 * Decide whether a failed task may be re-run. Replay is metadata-safe only for
 * side-effect-free task kinds; anything marked with side effects requires an
 * explicit human-approved new task, never a silent auto-retry.
 */
const SIDE_EFFECT_FREE_KINDS = new Set(["scan", "report", "analyze", "index", "search"]);

export function planReplay(taskId: string): ReplayPlan {
  const task = getTask(taskId);
  if (!task) return { decision: "missing_task", reason: `task ${taskId} not found` };
  if (task.status !== "failed") {
    return { decision: "unsafe_side_effects", reason: `task is ${task.status}, not failed — replay only applies to failures`, taskId };
  }
  if (SIDE_EFFECT_FREE_KINDS.has(task.kind)) {
    return { decision: "safe", reason: `kind "${task.kind}" is side-effect-free`, taskId };
  }
  return { decision: "unsafe_side_effects", reason: `kind "${task.kind}" may have external side effects; create an approved new task instead`, taskId };
}
