import type { ExportClientId, ExportContext, ExportModel } from "./contracts";
import { resolveModelNames, selectExportModelNames } from "./model-names";
import { effectiveModelAliases, effectiveProviderAlias, MODEL_ALIAS_PATTERN } from "../../providers/default-aliases";
import { knownModelIdsForProvider, previewRouteModel, type RouteResult } from "../../router";
import type { OcxConfig } from "../../types";
import { parseSyntheticRowId } from "../../server/fast-row";

function concrete(route: RouteResult): boolean {
  return !route.combo && route.routeKind !== "policy" && route.policyEligibility === undefined;
}

function sameIdentity(left: RouteResult, right: RouteResult): boolean {
  return concrete(left) && concrete(right) && left.providerName === right.providerName && left.modelId === right.modelId
    && left.codexAccountId === right.codexAccountId && left.codexAccountMode === right.codexAccountMode;
}

/** One context per full roster, before visibility filtering; never a serializer lookup. */
export function attachExportAliasSelectors(config: OcxConfig, input: readonly ExportModel[]): ExportModel[] {
  // A roster may predate a config/cache change during discovery. Candidate
  // metadata is evidence to refresh, never authority to reuse across that change.
  const models = input.map(({ aliasNamespaced: _priorCandidate, ...model }) => model);
  // A minimal or partially repaired config can omit providers; it then has no aliases.
  const aliases = new Map(Object.entries(config.providers ?? {}).map(([name, provider]) => [name, {
    namespace: effectiveProviderAlias(name, provider, config) ?? name,
    models: effectiveModelAliases(config, provider, knownModelIdsForProvider(name, provider, config)),
  }]));
  const candidates = models.map(model => {
    if (model.native || model.provider === "combo") return undefined;
    const provider = aliases.get(model.provider);
    const alias = provider?.models.get(model.id)?.alias;
    if (!provider || !alias || !MODEL_ALIAS_PATTERN.test(provider.namespace)) return undefined;
    const candidate = `${provider.namespace}/${alias}`;
    try {
      // Ingress parses synthetic suffixes before routing. A successful direct
      // route cannot prove a literal alias that ingress interprets as effort/Fast.
      const parsed = parseSyntheticRowId(candidate, config);
      if (parsed.fastRow || parsed.effortRow) return undefined;
      const baseline = previewRouteModel(config, model.namespaced);
      const proposed = previewRouteModel(config, candidate);
      if (proposed.providerName !== model.provider || proposed.modelId !== model.id || !sameIdentity(baseline, proposed)) return undefined;
      if (model.fastRowAvailable) {
        const baselineFast = parseSyntheticRowId(`${model.namespaced}--fast`, config).fastRow;
        const proposedFast = parseSyntheticRowId(`${candidate}--fast`, config).fastRow;
        if (!baselineFast || !proposedFast || !sameIdentity(
          previewRouteModel(config, baselineFast.baseId), previewRouteModel(config, proposedFast.baseId),
        )) return undefined;
      }
      return candidate;
    } catch {
      // Refused or ambiguous selectors keep the canonical spelling, never a decoded guess.
      return undefined;
    }
  });
  // Reserve every canonical/native/combo selector, including synthetic Fast rows.
  // A candidate must never displace a different row through first-wins normalization.
  const claims = new Map<string, Set<number>>();
  const claim = (key: string, index: number) => {
    const owners = claims.get(key) ?? new Set<number>();
    owners.add(index);
    claims.set(key, owners);
  };
  models.forEach((model, index) => {
    for (const key of [model.namespaced, candidates[index]]) {
      if (key === undefined) continue;
      claim(key, index);
      if (model.fastRowAvailable) claim(`${key}--fast`, index);
    }
  });
  return models.map((model, index) => {
    const candidate = candidates[index];
    if (!candidate || claims.get(candidate)!.size !== 1
      || (model.fastRowAvailable && claims.get(`${candidate}--fast`)!.size !== 1)) return model;
    return { ...model, aliasNamespaced: candidate };
  });
}

export function namedExportContext(client: ExportClientId, ctx: ExportContext): ExportContext {
  const mode = resolveModelNames(client, ctx.modelNames);
  if (mode === "routed") return ctx;
  // Use the caller's exact captured configuration. Discovery may have returned
  // an old projection, or caches may have changed since the retained proof.
  const models = ctx.config ? attachExportAliasSelectors(ctx.config, ctx.models)
    : ctx.models.map(({ aliasNamespaced: _priorCandidate, ...model }) => model);
  return { ...ctx, models: selectExportModelNames(models, mode) };
}
