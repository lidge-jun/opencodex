import { shadowCallTargetsIntersect, shadowSourceModels } from "../../lib/shadow-call";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { routeConcreteModel, routeModel } from "../../router";
import type { OcxConfig } from "../../types";

/** Keep a persisted override small enough for the per-request prefix scan. */
export const SHADOW_SOURCE_MODEL_LIMIT = 32;
export const SHADOW_SOURCE_PREFIX_MAX_LENGTH = 128;

/** Validate a prospective persisted shadow-call target against its resolved source identities. */
export function shadowCallTargetError(
  config: OcxConfig,
  targetModel: string | undefined,
  sourceModels: unknown = config.shadowCallIntercept?.sourceModels,
): string | null {
  if (!targetModel) return null;

  let target;
  try {
    target = routeModel(config, targetModel);
  } catch {
    return "model must resolve to a configured provider";
  }
  // A qualified target that only the router's last-resort default-provider fallback accepts names
  // nothing configured; saving it would leave the same dead target the request path refuses (#5618).
  if (target.routeKind === "default-provider" && targetModel.includes("/")) {
    return "model must resolve to a configured provider";
  }

  const intersectsSource = shadowSourceModels(sourceModels).some(sourceModel => {
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
 * Validate a new `sourceModels` list before it reaches persisted config.
 * Matching is by bare-model prefix, so provider-qualified entries can never
 * match and a slash is rejected rather than stored as a dead rule.
 */
export function shadowCallSourceModelsError(value: unknown): string | null {
  if (!Array.isArray(value)) return "sourceModels must be an array";
  if (value.length === 0) return "sourceModels must contain at least one model prefix";
  if (value.length > SHADOW_SOURCE_MODEL_LIMIT) {
    return `sourceModels must contain at most ${SHADOW_SOURCE_MODEL_LIMIT} model prefixes`;
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      return `sourceModels.${index} must be a nonblank model prefix`;
    }
    if (/\s/.test(entry)) return `sourceModels.${index} must not contain whitespace`;
    if (entry.length > SHADOW_SOURCE_PREFIX_MAX_LENGTH) {
      return `sourceModels.${index} must be at most ${SHADOW_SOURCE_PREFIX_MAX_LENGTH} characters`;
    }
    const prefix = entry;
    if (prefix.includes("/")) return `sourceModels.${index} must be a bare model prefix, not a provider-qualified model`;
    if (seen.has(prefix)) return "sourceModels must not contain duplicate prefixes";
    seen.add(prefix);
  }
  return null;
}

/** Trim and deduplicate only after `shadowCallSourceModelsError` accepted the list. */
export function normalizeShadowCallSourceModels(value: readonly string[]): string[] {
  return [...new Set(value.map(entry => entry.trim()))];
}

/** The shadow-call reference a provider change leaves behind, reported by disable and delete. */
export interface ShadowInterceptDependency {
  model: string;
  enabled: boolean;
}

/**
 * Whether `shadowCallIntercept.model` depends on `providerName` (#5618). Call it before the
 * mutation. A `provider/model` or `alias/model` target naming the provider counts, and so does
 * any other target the router currently resolves to it. Combo and routing-profile targets do not:
 * their pickers already skip a disabled or missing member, and deleting a provider a combo uses is
 * refused outright.
 */
export function shadowInterceptProviderDependency(config: OcxConfig, providerName: string): ShadowInterceptDependency | null {
  const shadow = config.shadowCallIntercept;
  const model = shadow?.model?.trim();
  if (!model) return null;
  const dependency = { model, enabled: shadow?.enabled === true };
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash).toLowerCase();
    const alias = config.providers[providerName]?.alias?.trim().toLowerCase();
    if (prefix === providerName.toLowerCase() || (alias && prefix === alias)) return dependency;
  }
  let target;
  try {
    target = routeModel(config, model);
  } catch {
    return null;
  }
  if (target.routeKind === "combo" || target.routeKind === "policy") return null;
  return target.providerName === providerName ? dependency : null;
}
