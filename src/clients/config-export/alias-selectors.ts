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

/**
 * Whether `candidate` reaches exactly the concrete provider, model and account that the row's
 * canonical key reaches, through the read-only router of this exact configuration. Refused,
 * ambiguous, policy/combo or synthetic-suffix selectors are never proven.
 */
export function proveExportSelector(config: OcxConfig, model: ExportModel, candidate: string): boolean {
  try {
    // Ingress parses synthetic suffixes before routing. A successful direct
    // route cannot prove a literal selector that ingress interprets as effort/Fast.
    const parsed = parseSyntheticRowId(candidate, config);
    if (parsed.fastRow || parsed.effortRow) return false;
    const baseline = previewRouteModel(config, model.namespaced);
    const proposed = previewRouteModel(config, candidate);
    if (proposed.providerName !== model.provider || proposed.modelId !== model.id || !sameIdentity(baseline, proposed)) return false;
    if (model.fastRowAvailable) {
      const baselineFast = parseSyntheticRowId(`${model.namespaced}--fast`, config).fastRow;
      const proposedFast = parseSyntheticRowId(`${candidate}--fast`, config).fastRow;
      if (!baselineFast || !proposedFast || !sameIdentity(
        previewRouteModel(config, baselineFast.baseId), previewRouteModel(config, proposedFast.baseId),
      )) return false;
    }
    return true;
  } catch {
    // Refused or ambiguous selectors keep the canonical spelling, never a decoded guess.
    return false;
  }
}

/**
 * Keep only candidates that claim no selector another row also claims. Every canonical/native/combo
 * key, including its synthetic Fast row, is reserved, so a candidate never displaces a different row
 * through first-wins normalization.
 */
export function uniqueExportCandidates(
  models: readonly ExportModel[],
  candidates: readonly (string | undefined)[],
): (string | undefined)[] {
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
      || (model.fastRowAvailable && claims.get(`${candidate}--fast`)!.size !== 1)) return undefined;
    return candidate;
  });
}

/** One context per full roster, before visibility filtering; never a serializer lookup. */
export function attachExportAliasSelectors(config: OcxConfig, input: readonly ExportModel[]): ExportModel[] {
  // A roster may predate a config/cache change during discovery. Candidate
  // metadata is evidence to refresh, never authority to reuse across that change.
  const models = input.map(({ aliasNamespaced: _priorCandidate, ...model }) => model);
  // A minimal or partially repaired config can omit providers; it then has no aliases.
  const aliases = new Map(Object.entries(config.providers ?? {}).map(([name, provider]) => [name, {
    namespace: effectiveProviderAlias(name, provider, config) ?? name,
    models: effectiveModelAliases(config, provider, knownModelIdsForProvider(name, provider, config), name),
  }]));
  const candidates = models.map(model => {
    if (model.native || model.provider === "combo") return undefined;
    const provider = aliases.get(model.provider);
    const alias = provider?.models.get(model.id)?.alias;
    if (!provider || !alias || !MODEL_ALIAS_PATTERN.test(provider.namespace)) return undefined;
    const candidate = `${provider.namespace}/${alias}`;
    return proveExportSelector(config, model, candidate) ? candidate : undefined;
  });
  const unique = uniqueExportCandidates(models, candidates);
  return models.map((model, index) => {
    const candidate = unique[index];
    return candidate === undefined ? model : { ...model, aliasNamespaced: candidate };
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
