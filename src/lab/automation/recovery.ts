import type { LabAutomationPolicyV1, LabAutomationStateV1 } from "./types";
import { transitionRun } from "./queue";
import { setCooldown } from "./cooldown";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";

/** Reconcile runs left running after process restart. */
export function recoverLabAutomationState(
  policy: LabAutomationPolicyV1,
  state: LabAutomationStateV1,
  now: number,
): LabAutomationStateV1 {
  let next = { ...state };
  for (const run of state.runs) {
    if (run.state !== "running") continue;
    next = transitionRun(next, run.runId, "abandoned", now, "process_restart");
    next = setCooldown(
      next,
      run.runKey,
      now + Math.min(policy.failureCooldownMs, LAB_AUTOMATION_HARD_MAX.failureCooldownMs),
      now,
    );
  }
  return next;
}
