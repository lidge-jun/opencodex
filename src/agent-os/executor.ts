// Phase 16 — Safe Execution: the guarded runner.
//
// A workflow step or task that performs a write-class action MUST run through
// here: the permit is redeemed (single-use, scope-bound) and only then does
// the work execute. If redemption fails the work never starts — fail closed.
// This is the seam that makes permits load-bearing instead of decorative.

import { redeemWritePermit, type PermitScope, type RedemptionResult } from "./gateway";
import { claimTask, completeTask, failTask, getTask, heartbeatTask } from "./tasks";
import type { AgentOsTask } from "./tasks";

export interface GuardedRunResult {
  task: AgentOsTask;
  redemption: RedemptionResult;
  output: Record<string, unknown> | null;
}

/**
 * Execute one task's work under a redeemed permit.
 * - Redeems the permit (fails closed before the work starts).
 * - Marks the task running, heartbeats during work, records completion/failure.
 * - The work callback receives the task payload and returns its result.
 */
export async function runGuardedTask(input: {
  taskId: string;
  permitId: string;
  token: string;
  scope: PermitScope;
  subjectType: "agent" | "task" | "global";
  subjectId: string | null;
  work: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
}): Promise<GuardedRunResult> {
  const task = getTask(input.taskId);
  if (!task) throw new Error(`task ${input.taskId} not found`);

  const redemption = redeemWritePermit({
    permitId: input.permitId,
    token: input.token,
    scope: input.scope,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  });
  if (!redemption.ok) {
    failTask(input.taskId, { message: `permit redemption failed: ${redemption.code}`, code: redemption.code });
    return { task: getTask(input.taskId)!, redemption, output: null };
  }

  // The guarded runner owns the claim: a queued task is claimed here so the
  // retry/heartbeat semantics stay identical to the worker path.
  const current = getTask(input.taskId)!;
  if (current.status === "queued") claimTask(input.taskId);

  try {
    heartbeatTask(input.taskId);
    const output = await input.work(getTask(input.taskId)!.payload);
    completeTask(input.taskId, output);
    return { task: getTask(input.taskId)!, redemption, output };
  } catch (error) {
    failTask(input.taskId, { message: error instanceof Error ? error.message : "guarded work failed" });
    return { task: getTask(input.taskId)!, redemption, output: null };
  }
}
