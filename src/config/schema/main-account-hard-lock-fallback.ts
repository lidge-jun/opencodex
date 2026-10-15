import * as z from "zod/v4";
import { pinnedReasoningEffortConfigError } from "../provider-validation";

/**
 * Extended settings of the main-account hard lock (`codexMainAccountHardLockFallback`):
 * while the lock blocks, a qualifying Codex-native request reroutes to `model` instead of
 * failing. The dashboard row keeps the configured model when the switch is off, so
 * `enabled: false` is a remembered pause, not a cleared setting; an absent section, an
 * absent model, and a malformed section all mean the same thing — the lock refuses,
 * exactly as it does today.
 */
export const mainAccountHardLockFallbackSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().refine(model => model.length > 0 && model === model.trim() && !/\s/.test(model)),
  reasoningEffort: z.string().refine(value => pinnedReasoningEffortConfigError(value) === null).optional(),
}).strict();

/** Candidate writes must reject sections the read schema would silently discard. */
export function mainAccountHardLockFallbackError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>).codexMainAccountHardLockFallback;
  if (raw === undefined) return undefined;
  return mainAccountHardLockFallbackSchema.safeParse(raw).success
    ? undefined
    : "schema_invalid: codexMainAccountHardLockFallback requires a nonblank model selector and an optional declared reasoningEffort";
}
