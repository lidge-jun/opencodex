import { GUARDRAILS_DATA_TYPES } from "./constants";
import type {
  GuardrailsOverview,
  GuardrailsTrafficProtection,
} from "./types";

export function guardrailsTrafficProtectionStatus(
  overview: GuardrailsOverview | undefined,
): GuardrailsTrafficProtection {
  if (!overview) return "unknown";
  if (!overview.configuredEnabled && !overview.enabled) return "disabled";
  if (
    !overview.enabled
    || overview.activation.status !== "active"
    || overview.registry.status !== "ready"
  ) {
    return "unavailable";
  }
  if (overview.registry.effectiveRuleCount <= 0) return "no-rules";
  if (
    overview.providerScope.mode === "selected"
    && !overview.providerScope.providerIds.some(id =>
      overview.providerOptions.some(provider =>
        provider.id === id
        && provider.configured
        && !provider.disabled))
  ) {
    return "no-provider-coverage";
  }
  if (overview.mode === "detect") return "detect";
  if (
    overview.enabledDataTypes.length < GUARDRAILS_DATA_TYPES.length
    || overview.disabledBuiltinRuleIds.length > 0
    || overview.failurePolicy === "passthrough"
    || overview.providerScope.mode === "selected"
  ) {
    return "reduced";
  }
  return "enforce";
}
