import { fallbackDecision, resolveJevDecision, type JevDecision, type ResolveJevDecisionOptions } from "./jev";
import type { JevLevelId } from "./jev-decision-contract";
import { resolveJevLevelDecision, type JevLevelDecision } from "./jev-level";
import type { NormalizedJevLevels } from "./jev-level-config";
import { resolveJevModelDecision, type JevModelInvoke } from "./jev-model-backend";

export interface ResolveJevComboDecisionOptions extends ResolveJevDecisionOptions {
  decisionModel?: string;
  invokeModel?: JevModelInvoke;
  /** Level mode: set only when the Combo's `decisionMode` is `"level"`. */
  levels?: NormalizedJevLevels;
  fallbackLevel?: JevLevelId;
  levelSelect?: "route";
  /** Level mode only: prefer healthier cached quota tiers within a level. */
  quotaAware?: boolean;
}

export async function resolveJevComboDecision(options: ResolveJevComboDecisionOptions & { levels: NormalizedJevLevels }): Promise<JevLevelDecision>;
export async function resolveJevComboDecision(options: ResolveJevComboDecisionOptions): Promise<JevDecision | JevLevelDecision>;
export async function resolveJevComboDecision(options: ResolveJevComboDecisionOptions): Promise<JevDecision | JevLevelDecision> {
  // Level mode classifies demand through whichever backend the Combo selects.
  if (options.levels) return resolveJevLevelDecision({ ...options, levels: options.levels });
  if (!options.decisionModel?.trim()) return resolveJevDecision(options);
  if (!options.invokeModel) {
    const now = options.now ?? Date.now;
    const startedAt = now();
    if (options.signal?.aborted) throw options.signal.reason;
    return fallbackDecision(options.fallback, "missing_key", Math.max(0, now() - startedAt), "model");
  }
  return resolveJevModelDecision({ ...options, decisionModel: options.decisionModel, invokeModel: options.invokeModel });
}
