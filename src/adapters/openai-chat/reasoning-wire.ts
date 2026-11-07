import { resolveThinkingEnabled } from "../../clients/reasoning-controls";
import { declaredModelCapabilities, resolveReasoningCapabilities } from "../../providers/reasoning-capabilities";
import { registryEntryForProviderDestination } from "../../providers/registry";
import { configuredReasoningEfforts, isDeclaredReasoningEffort, isReasoningEffortOmitted, mapReasoningEffort, reasoningEffortMapFor, resolveEffortAtOrBelow } from "../../reasoning-effort";
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

/** A legacy ladder alone must not opt a translated toggle wire into a second control. */
export function declaresIndependentChatReasoningEffort(provider: OcxProviderConfig, modelId: string): boolean {
  const explicit = declaredModelCapabilities(provider.modelCapabilities, modelId)?.supportsReasoningEffort;
  const registry = declaredModelCapabilities(registryEntryForProviderDestination(provider)?.modelCapabilities, modelId)?.supportsReasoningEffort;
  return (explicit ?? registry) === true;
}

/** Only explicit control axes opt legacy Chat destinations into independent projection. */
export function declaresIndependentChatReasoningControls(provider: OcxProviderConfig, modelId: string): boolean {
  const explicit = declaredModelCapabilities(provider.modelCapabilities, modelId);
  const registry = declaredModelCapabilities(registryEntryForProviderDestination(provider)?.modelCapabilities, modelId);
  return (["supportsThinkingToggle", "supportsReasoningEffort"] as const)
    .some(axis => typeof (explicit?.[axis] ?? registry?.[axis]) === "boolean");
}

/**
 * Wire value for a native Chat caller's `ultra`. It is a Codex picker level, not an upstream
 * Chat value: codex-rs folds it to `max` before every provider request and the translated path
 * does the same in `mapReasoningEffort`, but OpenCode and Kilo send it verbatim, and Mistral
 * answers it with HTTP 422 (#8254). The fold lands on `max`, clamped at or below it to the
 * model's declared ladder (Mistral Large 4 tops out at `high`). A declared ladder that lists
 * `ultra` itself is the provider's own claim and keeps it. Like a pin or cap rewrite, the folded
 * value goes through the provider's wire alias map; `undefined` means omit the field.
 * A thinking-toggle wire is the exception: its map holds thinking discriminators, which
 * `applyExplicitChatReasoningWirePolicy` resolves itself, so it receives the plain strength.
 */
export function nativeChatUltraWireEffort(provider: OcxProviderConfig, modelId: string): string | undefined {
  const ladder = configuredReasoningEfforts(provider, modelId);
  if (ladder?.includes("ultra")) return "ultra";
  if (declaresThinkingToggleWire(provider, modelId)) {
    // Keep the original alias for the independent policy to omit effort and select thinking.
    if (declaresIndependentChatReasoningEffort(provider, modelId)
      && isReasoningEffortOmitted(reasoningEffortMapFor(provider, modelId)?.max)) return "max";
    return ladder ? resolveEffortAtOrBelow("max", ladder) ?? "max" : "max";
  }
  return mapReasoningEffort(provider, modelId, "ultra");
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
  // Legacy tool omission precedes discriminator mapping; independent switches are separate
  // from strength omission and retain their declared behavior below.
  if (hasTools && modelInList(provider.omitReasoningEffortWithToolsModels, modelId)
    && !declaresIndependentChatReasoningControls(provider, modelId)) {
    delete body.reasoning_effort;
    delete body.reasoning;
    return { handled: true };
  }
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
  const omitIndependentEffort = toggleWire && declaresIndependentChatReasoningEffort(provider, modelId)
    && requestedStrength !== undefined
    && isReasoningEffortOmitted(reasoningEffortMapFor(provider, modelId)?.[requestedStrength]);
  // A native caller's ultra stays on the wire when the provider explicitly advertises it.
  // In that case the max alias belongs to a different value, even though the shared mapper folds ultra.
  if (omitIndependentEffort && !(requestedEffort === "ultra" && body.reasoning_effort === "ultra")) {
    delete body.reasoning_effort;
  }
  const resolvedThinkingEnabled = toggleWire && !toggleDisabled
    ? resolveThinkingEnabled(provider, modelId, {
      thinkingEnabled: thinkingEnabled ?? (omitIndependentEffort && requestedStrength !== undefined && isDeclaredReasoningEffort(requestedStrength)
        ? requestedStrength !== "none" : undefined),
      reasoning: requestedEffort,
    })
    : undefined;
  if (toggleDisabled) {
    delete body.thinking;
    delete body.reasoning;
    delete body.reasoning_effort;
  } else if (toggleWire) {
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
      // A second control still goes through tool omission and gateway projection below.
      if (capabilities.supportsReasoningEffort === false) {
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
    if (omitIndependentEffort) {
      delete body.reasoning_effort;
      delete body.reasoning;
      return { handled: true };
    }
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
    const enabled = resolvedThinkingEnabled ?? false;
    body.reasoning = { enabled };
    return {
      handled: true,
      reasoningLog: {
        effectiveEffort: enabled ? "enabled" : "none",
        wireField: "reasoning.enabled",
        wireValue: enabled,
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
  body.reasoning = { enabled: resolvedThinkingEnabled ?? true, effort: wireEffort };
  return {
    handled: true,
    reasoningLog: {
      effectiveEffort: wireEffort,
      wireField: "reasoning.effort",
      wireValue: wireEffort,
    },
  };
}
