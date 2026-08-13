import type { OcxCodexQuotaRecoveryConfig } from "../types";

export type CodexQuotaRecoveryPriority = OcxCodexQuotaRecoveryConfig["priority"];

export type EffectiveCodexQuotaRecoveryPolicy = Readonly<{
  enabled: boolean;
  autoRedeemResetCredit: boolean;
  priority: CodexQuotaRecoveryPriority;
  automaticRedemptionAllowed: boolean;
}>;

const DEFAULT_PRIORITY: CodexQuotaRecoveryPriority = "alternate-first";

function ownDataValue(record: Record<string, unknown> | undefined, key: string): unknown {
  if (!record) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/**
 * Normalize the persisted policy at the runtime boundary.
 *
 * Automatic redemption is authorized only by the exact double opt-in. Unknown
 * input is deliberately treated as disabled even if a caller bypasses config
 * validation and invokes this helper directly.
 */
export function effectiveCodexQuotaRecoveryPolicy(
  raw: unknown,
): EffectiveCodexQuotaRecoveryPolicy {
  let enabledValue: unknown;
  let autoRedeemValue: unknown;
  let priorityValue: unknown;
  try {
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : undefined;
    enabledValue = ownDataValue(record, "enabled");
    autoRedeemValue = ownDataValue(record, "autoRedeemResetCredit");
    priorityValue = ownDataValue(record, "priority");
  } catch {
    return Object.freeze({
      enabled: false,
      autoRedeemResetCredit: false,
      priority: DEFAULT_PRIORITY,
      automaticRedemptionAllowed: false,
    });
  }
  const enabled = enabledValue === true;
  const autoRedeemResetCredit = autoRedeemValue === true;
  const validPriority = priorityValue === "alternate-first" || priorityValue === "reset-first";
  const priority = priorityValue === "reset-first"
    ? "reset-first"
    : DEFAULT_PRIORITY;

  return Object.freeze({
    enabled,
    autoRedeemResetCredit,
    priority,
    automaticRedemptionAllowed: enabled && autoRedeemResetCredit && validPriority,
  });
}
