/**
 * The workflow-budget policy the running server enforces.
 *
 * The ceilings in workflow-budget.ts are module defaults, and a busy install that legitimately
 * runs more parallel subagents than they allow had no way to say so short of patching the
 * package. This binds the live config the same way the outbound compression opt-in does: the
 * object is installed once, read per decision, and a dashboard write that mutates it in place
 * takes effect on the next request without a restart.
 *
 * Only the three count ceilings move. The window, the interactive reserve and the tracked-root
 * bound stay where they are: the window fixes each root's ring geometry when the root first
 * appears, so changing it live would leave existing roots measured on a scale no caller reads.
 */
import { readWorkflowBudgetConfig } from "../config/schema/workflow-budget";
import type { OcxConfig } from "../types";
import { DEFAULT_WORKFLOW_BUDGET_POLICY, type WorkflowBudgetPolicy } from "./workflow-budget";

let boundConfig: Pick<OcxConfig, "workflowBudget"> | null = null;

export function bindWorkflowBudgetConfig(config: Pick<OcxConfig, "workflowBudget"> | null): void {
  boundConfig = config;
}

export function resolveWorkflowBudgetPolicy(config: Pick<OcxConfig, "workflowBudget">): WorkflowBudgetPolicy {
  const overrides = readWorkflowBudgetConfig(config);
  return {
    ...DEFAULT_WORKFLOW_BUDGET_POLICY,
    ...(overrides.maxConcurrentChildren !== undefined ? { maxConcurrentChildren: overrides.maxConcurrentChildren } : {}),
    ...(overrides.maxPhysicalSends !== undefined ? { maxPhysicalSends: overrides.maxPhysicalSends } : {}),
    ...(overrides.maxDistinctChildren !== undefined ? { maxDistinctChildren: overrides.maxDistinctChildren } : {}),
  };
}

/** Policy for the next admission or ceiling check; an unset block is the module default itself. */
export function currentWorkflowBudgetPolicy(): WorkflowBudgetPolicy {
  return boundConfig?.workflowBudget === undefined
    ? DEFAULT_WORKFLOW_BUDGET_POLICY
    : resolveWorkflowBudgetPolicy(boundConfig);
}
