import { baseProviderLabel } from "../providers/label";
import type { PriceResolutionOptions } from "./cost";
import type { PersistedUsageEntry } from "./log";

type TraceSource = Pick<PersistedUsageEntry, "routeDecision">;
type ModelTarget = Pick<PersistedUsageEntry, "provider" | "model">;

/** Saved routing provenance, not a claim about the model a remote endpoint ran. */
export function isUnresolvedRequestedModel(source: TraceSource, target: ModelTarget): boolean {
  const trace = source.routeDecision;
  return trace !== undefined
    && trace.routeKind === "default-provider"
    && trace.selected.reason === "default-provider"
    && trace.truncated?.strings !== true
    && trace.selected.model.length > 0
    && trace.requestedModel === trace.selected.model
    && target.model === trace.selected.model
    && baseProviderLabel(target.provider) === baseProviderLabel(trace.selected.provider);
}

/** Bare fallback rates remain eligible; unresolved slash IDs need a provider-specific rate. */
export function usageModelPriceOptions(source: TraceSource, target: ModelTarget): PriceResolutionOptions {
  return {
    allowModelLevelFallback: !target.model.includes("/") || !isUnresolvedRequestedModel(source, target),
  };
}
