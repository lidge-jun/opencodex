import * as z from "zod/v4";
import type { OcxConfig } from "../../types";

/**
 * Per-install bounds for the root-workflow count ceilings.
 *
 * The lower concurrency bound is two because one slot is always held back for the interactive
 * turn; at one, every worker turn would be refused. The upper bounds keep each ceiling a
 * ceiling: a value large enough to never fire is a way of switching the guard off, and that is
 * not what this setting is for.
 */
export const WORKFLOW_BUDGET_BOUNDS = {
  maxConcurrentChildren: { min: 2, max: 64 },
  maxPhysicalSends: { min: 1, max: 10_000 },
  maxDistinctChildren: { min: 1, max: 1_024 },
} as const;

const bounded = (key: keyof typeof WORKFLOW_BUDGET_BOUNDS) =>
  z.number().int().min(WORKFLOW_BUDGET_BOUNDS[key].min).max(WORKFLOW_BUDGET_BOUNDS[key].max).optional();

/** Omitted fields keep the built-in ceiling, so an absent block is today's behavior byte for byte. */
export const workflowBudgetSchema = z.object({
  maxConcurrentChildren: bounded("maxConcurrentChildren"),
  maxPhysicalSends: bounded("maxPhysicalSends"),
  maxDistinctChildren: bounded("maxDistinctChildren"),
}).strict();

export type WorkflowBudgetConfig = z.infer<typeof workflowBudgetSchema>;

export const WORKFLOW_BUDGET_SHAPE_HINT = "accepts only optional integer maxConcurrentChildren (2-64), maxPhysicalSends (1-10000) and maxDistinctChildren (1-1024)";

export function workflowBudgetConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const budget = (value as Record<string, unknown>).workflowBudget;
  return budget === undefined || workflowBudgetSchema.safeParse(budget).success
    ? null : "schema_invalid: workflowBudget: " + WORKFLOW_BUDGET_SHAPE_HINT;
}

/** Malformed input resolves to no overrides, the same way a degraded disk block does. */
export function readWorkflowBudgetConfig(config: Pick<OcxConfig, "workflowBudget">): WorkflowBudgetConfig {
  const parsed = workflowBudgetSchema.safeParse(config.workflowBudget);
  return parsed.success && parsed.data ? parsed.data : {};
}
