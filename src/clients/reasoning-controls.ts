import type { OcxProviderConfig } from "../types";
import { isDeclaredReasoningEffort, isReasoningEffortOmitted, modelRecordValue, reasoningEffortMapFor } from "../reasoning-effort";
import { resolveReasoningCapabilities } from "../providers/reasoning-capabilities";

function mappedClientEffort(provider: OcxProviderConfig, modelId: string, requested: string | undefined): string | undefined {
  if (requested === undefined || !isDeclaredReasoningEffort(requested)) return undefined;
  const key = requested === "ultra" ? "max" : requested;
  const map = reasoningEffortMapFor(provider, modelId);
  return map && Object.hasOwn(map, key) ? map[key] : requested;
}

/** Decode an effort-only client's switch without turning it into a model strength. */
export function resolveThinkingEnabled(
  provider: OcxProviderConfig,
  modelId: string,
  options: { thinkingEnabled?: boolean; reasoning?: string },
): boolean | undefined {
  const capabilities = resolveReasoningCapabilities(provider, modelId);
  if (capabilities.supportsReasoning === false || capabilities.supportsThinkingToggle !== true) return undefined;
  if (typeof options.thinkingEnabled === "boolean") return options.thinkingEnabled;
  // Effort-enum clients select a switch and, when supported, a real positive strength.
  // An explicit boolean above remains independent and takes precedence over that shorthand.
  const effort = options.reasoning ?? (capabilities.supportsReasoningEffort === false
    ? modelRecordValue(provider.modelDefaultReasoningEfforts, modelId) : undefined);
  const value = mappedClientEffort(provider, modelId, effort);
  if (value !== undefined) {
    // Legacy adaptive wire policy cannot be represented by a boolean; leave its serializer in charge.
    if (isReasoningEffortOmitted(value) || value === "adaptive") return undefined;
    return value !== "none" && value !== "disabled";
  }
  return capabilities.defaultThinkingEnabled;
}

/** Resolve client aliases before strength-only policy can strip or clamp them. */
export function normalizeThinkingOptions(provider: OcxProviderConfig, modelId: string, options: { thinkingEnabled?: boolean; reasoning?: string }): void {
  const capabilities = resolveReasoningCapabilities(provider, modelId);
  if (capabilities.supportsReasoning === false) {
    delete options.thinkingEnabled;
    delete options.reasoning;
    return;
  }
  const enabled = resolveThinkingEnabled(provider, modelId, options);
  if (enabled !== undefined) options.thinkingEnabled = enabled;
  else if (capabilities.supportsThinkingToggle === false) delete options.thinkingEnabled;
  const mapped = mappedClientEffort(provider, modelId, options.reasoning);
  const preserveWirePolicy = capabilities.supportsThinkingToggle === true
    && (mapped === "adaptive" || isReasoningEffortOmitted(mapped));
  if (capabilities.supportsReasoningEffort === false && !preserveWirePolicy) delete options.reasoning;
}
