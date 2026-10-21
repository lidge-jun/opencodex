import { fastRowBases } from "../fast-row";
import { previewRouteModel } from "../../router";
import type { OcxConfig } from "../../types";

/**
 * Build the alias promoter for one model listing. The Fast-base inventory walks
 * the configured catalog, so it is computed at most once per listing instead of
 * once per aliased row.
 */
export function modelAliasIdPromoter(config: OcxConfig) {
  let isFastBase: ((id: string) => boolean) | undefined;
  const fastBases = () => (isFastBase ??= fastRowBases(config));
  return (provider: string, model: string, alias: string, fastEligible: boolean) =>
    preferredModelAliasId(config, provider, model, alias, fastEligible, fastBases);
}

/** Promote only a short alias whose ordinary route is this exact upstream model. */
export function preferredModelAliasId(
  config: OcxConfig, provider: string, model: string, alias: string, fastEligible: boolean,
  fastBases: () => (id: string) => boolean = () => fastRowBases(config),
): string | undefined {
  if (config.preferModelAliasIds !== true) return undefined;
  // Built-in bare aliases are not stable Fast bases. Preserve the qualified ID
  // when promotion would publish a synthetic sibling that ingress cannot parse.
  if (config.fastRows !== false && fastEligible && !fastBases()(alias)) return undefined;
  try {
    // Preview cannot consume a combo's round-robin selection state. A policy/combo,
    // reserved native name or another provider's native id must keep its own meaning.
    const route = previewRouteModel(config, alias);
    return route.routeReason === "model-alias" && route.providerName === provider && route.modelId === model
      ? alias : undefined;
  } catch {
    // An ambiguous alias stays available through the existing qualified public id.
    return undefined;
  }
}
