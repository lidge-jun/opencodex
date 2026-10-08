import * as z from "zod/v4";
import type { OcxConfig } from "../../types";

/** Opt-in allowances for canonical ChatGPT reasoning replay; absence keeps existing cleanup. */
export const nativeReasoningRetentionSchema = z.object({
  modelSwitch: z.boolean().optional(),
  accountSwitch: z.boolean().optional(),
}).strict();

export function nativeReasoningRetentionConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const retention = (value as Record<string, unknown>).nativeReasoningRetention;
  return retention === undefined || nativeReasoningRetentionSchema.safeParse(retention).success
    ? null : "schema_invalid: nativeReasoningRetention: accepts only optional boolean modelSwitch and accountSwitch fields";
}

/** Resolve malformed synthetic inputs the same way as degraded disk config: both off. */
export function resolveNativeReasoningRetention(
  config: Pick<OcxConfig, "nativeReasoningRetention">,
): { modelSwitch: boolean; accountSwitch: boolean } {
  const parsed = nativeReasoningRetentionSchema.safeParse(config.nativeReasoningRetention);
  return {
    modelSwitch: parsed.success && parsed.data.modelSwitch === true,
    accountSwitch: parsed.success && parsed.data.accountSwitch === true,
  };
}
