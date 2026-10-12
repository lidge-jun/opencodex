import * as z from "zod/v4";

/** Failure-only, opt-in recovery; it never chooses the initial compaction model. */
export const compactionRecoverySchema = z.object({
  enabled: z.boolean(),
  model: z.string().trim().min(1).max(512).regex(/^[^\s\u0000-\u0020\u007f-\u009f]+$/),
  allowDevinInvalidArgument: z.boolean().optional(),
}).strict();

export function compactionRecoveryConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const recovery = (value as Record<string, unknown>).compactionRecovery;
  return recovery === undefined || compactionRecoverySchema.safeParse(recovery).success
    ? null : "schema_invalid: compactionRecovery: requires enabled, a nonblank model, and optional boolean allowDevinInvalidArgument";
}
