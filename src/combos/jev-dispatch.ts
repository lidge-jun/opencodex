import { fallbackDecision, resolveJevDecision, type JevDecision, type ResolveJevDecisionOptions } from "./jev";
import { resolveJevModelDecision, type JevModelInvoke } from "./jev-model-backend";

export interface ResolveJevComboDecisionOptions extends ResolveJevDecisionOptions {
  decisionModel?: string;
  invokeModel?: JevModelInvoke;
}

export async function resolveJevComboDecision(options: ResolveJevComboDecisionOptions): Promise<JevDecision> {
  if (!options.decisionModel?.trim()) return resolveJevDecision(options);
  if (!options.invokeModel) {
    const now = options.now ?? Date.now;
    const startedAt = now();
    if (options.signal?.aborted) throw options.signal.reason;
    return fallbackDecision(options.fallback, "missing_key", Math.max(0, now() - startedAt), "model");
  }
  return resolveJevModelDecision({ ...options, decisionModel: options.decisionModel, invokeModel: options.invokeModel });
}
