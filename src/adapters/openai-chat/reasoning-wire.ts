import { resolveThinkingEnabled } from "../../clients/reasoning-controls";
import { resolveReasoningCapabilities } from "../../providers/reasoning-capabilities";
import { modelInList, type OcxProviderConfig } from "../../types";
import type { AdapterRequest } from "../base";
import { declaresThinkingToggleWire, reasoningControlsAreUnsupported } from "../reasoning-controls";
import { isNativeOpenAIChatTarget } from "./wire";

export type ExplicitChatReasoningWireResult =
  | { handled: false }
  | { handled: true; reasoningLog?: AdapterRequest["reasoningLog"] };

function isThinkingToggleType(value: string | undefined): value is "enabled" | "disabled" | "adaptive" {
  return value === "enabled" || value === "disabled" || value === "adaptive";
}

/**
 * Apply provider-declared reasoning wire policy after the effective provider is resolved.
 * Unset declarations are a no-op so native Chat keeps forwarding the caller's raw field.
 */
export function applyExplicitChatReasoningWirePolicy(options: {
  provider: OcxProviderConfig;
  modelId: string;
  hasTools: boolean;
  thinkingEnabled: boolean | undefined;
  requestedEffort: string | undefined;
  wireEffort: string | undefined;
  reasoningDisabled: boolean;
  body: Record<string, unknown>;
}): ExplicitChatReasoningWireResult {
  const {
    provider,
    modelId,
    hasTools,
    thinkingEnabled,
    requestedEffort,
    wireEffort: mappedWireEffort,
    reasoningDisabled,
    body,
  } = options;

  const capabilities = resolveReasoningCapabilities(provider, modelId);
  if (reasoningDisabled || reasoningControlsAreUnsupported(provider, modelId)) {
    delete body.reasoning_effort;
    delete body.reasoning;
    delete body.thinking;
    return { handled: true };
  }
  const toggleWire = declaresThinkingToggleWire(provider, modelId);
  const toggleDisabled = toggleWire && capabilities.supportsThinkingToggle === false;
  // Ignore legacy toggle discriminators on a disabled toggle axis, but retain real effort
  // mappings (including omission) and run them through the shared effort policy below.
  const requestedStrength = requestedEffort === "ultra" ? "max" : requestedEffort;
  const wireEffort = toggleDisabled && isThinkingToggleType(mappedWireEffort) ? requestedStrength : mappedWireEffort;
  if (capabilities.supportsReasoningEffort === false && !toggleWire) {
    delete body.reasoning_effort;
    delete body.reasoning;
    if (capabilities.supportsThinkingToggle === false) delete body.thinking;
    return { handled: true };
  }
  if (toggleDisabled) {
    delete body.thinking;
    delete body.reasoning;
    delete body.reasoning_effort;
  } else if (toggleWire) {
    const resolvedThinkingEnabled = resolveThinkingEnabled(provider, modelId, { thinkingEnabled, reasoning: requestedEffort });
    // These values are the provider's declared thinking discriminator, never strengths. This
    // remains true when the catalog also advertises a separate, real effort axis.
    if (isThinkingToggleType(wireEffort)) {
      const thinkingType = resolvedThinkingEnabled === undefined
        ? wireEffort
        : resolvedThinkingEnabled ? "enabled" : "disabled";
      body.thinking = { type: thinkingType };
      delete body.reasoning_effort;
      delete body.reasoning;
      return {
        handled: true,
        reasoningLog: {
          effectiveEffort: thinkingType,
          wireField: "thinking.type",
          wireValue: thinkingType,
        },
      };
    }
    if (resolvedThinkingEnabled !== undefined) {
      const thinkingType = resolvedThinkingEnabled ? "enabled" : "disabled";
      body.thinking = { type: thinkingType };
      // Unknown and explicit strength support retain the established effort wire. Only an
      // explicit false says the toggle is the model's sole reasoning control.
      if (capabilities.supportsReasoningEffort !== false) {
        return { handled: false };
      }
      delete body.reasoning_effort;
      delete body.reasoning;
      return {
        handled: true,
        reasoningLog: {
          effectiveEffort: thinkingType,
          wireField: "thinking.type",
          wireValue: thinkingType,
        },
      };
    }
    if (capabilities.supportsReasoningEffort === false) {
      delete body.reasoning_effort;
      delete body.reasoning;
      return { handled: true };
    }
  }
  if (hasTools && modelInList(provider.omitReasoningEffortWithToolsModels, modelId)) {
    delete body.reasoning_effort;
    delete body.reasoning;
    return { handled: true };
  }
  if (provider.reasoningWireFormat !== "gateway-object") {
    if (!toggleDisabled) return { handled: false };
    if (wireEffort === undefined) return { handled: true };
    body.reasoning_effort = wireEffort;
    return {
      handled: true,
      reasoningLog: { effectiveEffort: wireEffort, wireField: "reasoning_effort", wireValue: wireEffort },
    };
  }

  const nativeOpenAI = isNativeOpenAIChatTarget(provider);
  if (requestedEffort === "none") {
    if (nativeOpenAI) {
      delete body.reasoning;
      body.reasoning_effort = "none";
      return {
        handled: true,
        reasoningLog: {
          effectiveEffort: "none",
          wireField: "reasoning_effort",
          wireValue: "none",
        },
      };
    }
    delete body.reasoning_effort;
    body.reasoning = { enabled: false };
    return {
      handled: true,
      reasoningLog: {
        effectiveEffort: "none",
        wireField: "reasoning.enabled",
        wireValue: false,
      },
    };
  }
  if (wireEffort === undefined) return { handled: toggleDisabled };

  if (nativeOpenAI) {
    delete body.reasoning;
    body.reasoning_effort = wireEffort;
    return {
      handled: true,
      reasoningLog: {
        effectiveEffort: wireEffort,
        wireField: "reasoning_effort",
        wireValue: wireEffort,
      },
    };
  }
  delete body.reasoning_effort;
  body.reasoning = { enabled: true, effort: wireEffort };
  return {
    handled: true,
    reasoningLog: {
      effectiveEffort: wireEffort,
      wireField: "reasoning.effort",
      wireValue: wireEffort,
    },
  };
}
