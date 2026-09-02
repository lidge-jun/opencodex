import { shadowCallTargetsIntersect, shadowSourceModels } from "../../lib/shadow-call";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { routeConcreteModel, routeModel } from "../../router";
import type { OcxConfig } from "../../types";

/** Validate a replacement target against its resolved source identities. */
export function shadowCallTargetError(config: OcxConfig, targetModel: string | undefined): string | null {
  if (!targetModel) return null;

  let target;
  try {
    target = routeModel(config, targetModel);
  } catch {
    return "model must resolve to a configured provider";
  }

  const intersectsSource = shadowSourceModels(config.shadowCallIntercept?.sourceModels).some(sourceModel => {
    let source = { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: sourceModel };
    try {
      const resolved = routeConcreteModel(config, sourceModel);
      source = { providerName: resolved.providerName, modelId: sourceModel };
    } catch { /* Unconfigured native Codex source models remain OpenAI-owned. */ }
    return shadowCallTargetsIntersect(source, target);
  });

  return intersectsSource
    ? "shadow-call target must not intersect a source model"
    : null;
}

/**
 * Validate every per-source replacement target in a modelMap. Returns the first
 * error found, or null. A target that intersects its own source is rejected so
 * a modelMap entry cannot create a self-interception loop (#2706).
 */
export function shadowCallModelMapErrors(config: OcxConfig, modelMap: Record<string, string> | undefined): string | null {
  if (!modelMap) return null;
 for (const [sourcePrefix, target] of Object.entries(modelMap)) {
    if (typeof target !== "string" || target.trim() === "") continue;
    let resolved;
    try {
      resolved = routeModel(config, target);
    } catch {
     return `modelMap[${sourcePrefix}] must resolve to a configured provider`;
   }
    let source = { providerName: OPENAI_CODEX_PROVIDER_ID, modelId: sourcePrefix };
    try {
      const resolved = routeConcreteModel(config, sourcePrefix);
      source = { providerName: resolved.providerName, modelId: sourcePrefix };
    } catch { /* Unconfigured native Codex source models remain OpenAI-owned. */ }
    if (shadowCallTargetsIntersect(source, resolved)) {
     return `modelMap[${sourcePrefix}] target must not intersect the source model`;
    }
  }
  return null;
}
