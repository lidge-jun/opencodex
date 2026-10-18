import * as z from "zod/v4";
import { ACCOUNT_PAUSE_REASONS } from "../../types/account-auto-pause";

export const accountAutoPausePolicySchema = z.object({
  enabled: z.boolean().optional(),
  consecutiveFailures: z.number().int().min(1).max(100).optional(),
}).strict();
export const accountPauseDetailsSchema = z.object({
  reason: z.enum(ACCOUNT_PAUSE_REASONS),
  pausedAt: z.number().int().nonnegative(),
}).strict();
export const accountPauseStateSchema = z.record(z.string(), z.object({
  revision: z.string(), details: accountPauseDetailsSchema.optional(),
}).strict());
