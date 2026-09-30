/**
 * The `/api/models` row list and its projection into export models.
 *
 * Extracted from model-routes.ts so `/api/client-config` and the integration
 * routes read the SAME visible-model list. Two callers computing "which models
 * does this user actually have" independently is how the export and the toggle
 * would quietly disagree about what a client was told.
 *
 * Bodies are unchanged from their previous home; only `export` was added.
 */
import type { CatalogModel } from "../../codex/catalog";
import { observeModelCacheRevision } from "../../codex/model-cache";
import {
  captureExportConfigAdmission,
  detachedConfigSnapshot,
  isExportConfigAdmissionCurrent,
  type ExportConfigAdmission,
} from "../../config/admitted-identity";
import {
  catalogModelSlug,
  filterCatalogVisibleModels,
  accountBoundNativeOpenAiSlugsBySelector,
  nativeDefaultReasoningEffort,
  NATIVE_OPENAI_MODELS,
  nativeInputModalities,
  nativeModelRows,
  nativeReasoningEfforts,
  uniqueCatalogModelsForPublicList,
  shouldIncludeAccountBoundNativeOpenAi,
  catalogModelEfforts,
} from "../../codex/catalog";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../../codex/catalog/native-models";
import type { ExportModel } from "../../clients/config-export";
import { providerContextCap } from "../../providers/context-cap";
import { isVisionReasoningEffort, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import type { OcxConfig } from "../../types";
import { enrichProviderFromRegistry } from "../../providers/derive";
import { ensureCodexEntitlementFreshness } from "../../codex/model-entitlements";
import { fetchAllModels } from "./shared";
import { CatalogGatherBusyError } from "../../codex/catalog/routed-gather";
import { captureModelDiscoveryBaseline, finalizeModelDiscovery } from "../../providers/new-model-policy-runtime";
import { reconcileSuccessfulModelDiscoveries } from "../../providers/new-model-policy";
import { initialModelSelectionPending, pendingModelSelectionProviders } from "../../providers/initial-model-selection";
import { catalogFastRowEligible, fastRowId } from "../fast-row";
import { knownEffortRowIds } from "../effort-row";

/**
 * One row of the `/api/models` list. Routed rows spread a `CatalogModel`, so the shape is
 * that model plus the identity/visibility fields this boundary computes for every row
 * regardless of source. `disabled` is always present; the rest vary by row origin.
 */
export type ManagementModelRow = Partial<CatalogModel> & {
  provider: string;
  id: string;
  namespaced: string;
  disabled: boolean;
  initialSelectionPending?: boolean;
  native?: boolean;
  custom?: boolean;
  customId?: string;
  manualPricing?: boolean;
  fastRowAvailable?: boolean;
  displayNameOverride?: string;
  displayNameSource?: "operator" | "provider" | "fallback";
  /**
   * The modality declaration a per-model editor writes, read from the same sources the runtime
   * consults. It is separate from the row's own `inputModalities` because that one is the
   * CATALOG value: an editor that pre-fills from the catalog while writing the declaration shows
   * one thing and saves another, so its own writes never appear to take.
   */
  inputModalitiesDeclared?: string[];
  /** Exact stored context override, distinct from the effective catalog window. */
  contextWindowDeclared?: number;
  /**
   * True when the provider config actually CHANGES reasoning for this model. A persisted key is
   * not proof of an operator edit — OpenCodex itself writes the registry ladder into the provider
   * config — so this compares values against what the model would inherit anyway.
   */
  reasoningOverridden?: boolean;
};

/** Resolve the exact text and source shown for one routed discovered model. */
export function effectiveManagementDisplayName(
  config: Pick<OcxConfig, "providers">,
  model: CatalogModel,
): Pick<ManagementModelRow, "displayName" | "displayNameOverride" | "displayNameSource"> {
  const provider = config.providers[model.provider];
  const configured = provider?.modelDisplayNames;
  if (configured && Object.hasOwn(configured, model.id)) {
    const displayName = configured[model.id]?.trim();
    if (displayName) {
      return { displayName, displayNameOverride: displayName, displayNameSource: "operator" };
    }
  }
  const providerDisplayName = model.displayName?.trim();
  if (providerDisplayName) return { displayName: providerDisplayName, displayNameSource: "provider" };
  return { displayName: catalogModelSlug(model), displayNameSource: "fallback" };
}

/**
 * The modality declaration an editor writes, resolved the way the runtime resolves it: an exact
 * `modelCapabilities` entry first, then the legacy `modelInputModalities` record, both after the
 * registry has filled in whatever the saved config predates.
 */
export function declaredModelInputModalities(
  config: OcxConfig,
  providerName: string,
  modelId: string,
): string[] | undefined {
  const provider = config.providers[providerName];
  if (!provider) return undefined;
  const enriched = {
    ...provider,
    ...(provider.modelInputModalities ? { modelInputModalities: { ...provider.modelInputModalities } } : {}),
    ...(provider.modelCapabilities ? { modelCapabilities: { ...provider.modelCapabilities } } : {}),
  };
  enrichProviderFromRegistry(providerName, enriched);
  const declared = enriched.modelCapabilities?.[modelId]?.inputModalities
    ?? modelRecordValue(enriched.modelInputModalities, modelId);
  return Array.isArray(declared) && declared.length > 0 ? [...declared] : undefined;
}

/**
 * The ladder that actually applies to this model: an explicit declaration wins, then the
 * registry-enriched provider map, then the pinned native OpenAI table for a resold native id,
 * then the catalog's own effort hints.
 *
 * The registry enrichment is not optional. The catalog reads the enriched provider, so a registry
 * declaration (google-antigravity's `gemini-3.8-flash`, for one) IS the model's ladder; reading
 * the saved config alone would report no ladder for a model that has one.
 *
 * The catalog's own hints are the one source that costs a file read per lookup. `catalogLadders`
 * is the batched form of it: a roster projection resolves every routed id once and passes the map
 * down, instead of asking `catalogModelEfforts` per row and re-parsing the same file each time.
 * Omitting it keeps the single-model behaviour for every other caller.
 */
export type CatalogLadderLookup = ReadonlyMap<string, string[]>;

/** Catalog entries for routed rows carry the Codex-facing `provider/model` slug, never the bare id. */
function catalogLadder(ladders: CatalogLadderLookup | undefined, providerName: string, modelId: string): string[] | undefined {
  const slug = routedSlug(providerName, modelId);
  return ladders ? ladders.get(slug) : catalogModelEfforts([slug]).get(slug);
}

export function effectiveModelReasoningEfforts(config: OcxConfig, providerName: string, modelId: string, declaredEfforts?: string[], catalogLadders?: CatalogLadderLookup): string[] | undefined {
  // An empty array is a declaration, not an absence: the operator stored "this model has no
  // reasoning rungs", and falling through to the inherited ladder here would report a ladder the
  // row does not have and hand it back to the editor on the next refresh.
  if (Array.isArray(declaredEfforts)) return declaredEfforts;
  const provider = config.providers[providerName];
  if (provider) {
    const enriched = {
      ...provider,
      ...(provider.modelReasoningEfforts ? { modelReasoningEfforts: { ...provider.modelReasoningEfforts } } : {}),
    };
    enrichProviderFromRegistry(providerName, enriched);
    const raw = modelRecordValue(enriched.modelReasoningEfforts, modelId) ?? enriched.reasoningEfforts;
    // Mirrors `configuredReasoningEfforts`, the reader the wire actually uses: a stored array is a
    // declaration even when it sanitizes down to nothing, and only a missing entry inherits.
    if (Array.isArray(raw)) return sanitizeCodexReasoningEfforts(raw) ?? [];
  }
  // A provider reselling a native OpenAI id inherits that model's pinned ladder.
  if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(modelId)) {
    const native = nativeReasoningEfforts(modelId);
    if (native.length > 0) return native;
  }
  const hits = catalogLadder(catalogLadders, providerName, modelId);
  if (hits && hits.length > 0) return hits;
  return undefined;
}

export function effectiveModelDefaultReasoningEffort(config: OcxConfig, providerName: string, modelId: string, declaredDefault?: string, efforts?: string[]): string | undefined {
  if (declaredDefault) return declaredDefault;
  const provider = config.providers[providerName];
  if (provider) {
    const stored = modelRecordValue(provider.modelDefaultReasoningEfforts, modelId);
    if (stored) return stored;
  }
  if (efforts && efforts.length > 0) {
    // The default is the ladder's own preference order, not its first entry: a model offering
    // low..high defaults to medium, and only a ladder that omits it falls back to low.
    if (efforts.includes("medium")) return "medium";
    if (efforts.includes("low")) return "low";
    return efforts[0];
  }
  return undefined;
}

/**
 * Whether the saved config really overrides reasoning for this model, decided by VALUE rather
 * than by key presence.
 *
 * The distinction is the whole point: OpenCodex writes the registry ladder (and its default) into
 * the provider config itself, so a bare `hasOwnProperty` test reports every registry-declared
 * model as hand-edited. An entry that resolves to the same ladder and default the model would
 * inherit anyway is not an override, and an editor that pre-fills an "override" checkbox from one
 * claims an edit nobody made.
 */
export function reasoningOverrideFor(config: OcxConfig, providerName: string, modelId: string, catalogLadders?: CatalogLadderLookup): boolean {
  const provider = config.providers[providerName];
  if (!provider) return false;
  const owns = (record: Record<string, unknown> | undefined) =>
    !!record && Object.prototype.hasOwnProperty.call(record, modelId);
  const ownsEfforts = owns(provider.modelReasoningEfforts as Record<string, unknown> | undefined);
  const ownsDefault = owns(provider.modelDefaultReasoningEfforts as Record<string, unknown> | undefined);
  if (!ownsEfforts && !ownsDefault) return false;
  if (ownsEfforts) {
    // `undefined` (nothing known) and `[]` (pinned to no rungs) are different facts, and joining
    // both to "" would report a pinned-empty ladder as no override at all.
    const ladderKey = (values: string[] | undefined) => (values === undefined ? null : values.join(","));
    const effective = effectiveModelReasoningEfforts(config, providerName, modelId, undefined, catalogLadders);
    const inherited = inheritedModelReasoningEfforts(config, providerName, modelId, catalogLadders);
    if (ladderKey(effective) !== ladderKey(inherited)) return true;
  }
  if (ownsDefault) {
    const effective = effectiveModelDefaultReasoningEffort(config, providerName, modelId);
    const inherited = inheritedModelDefaultReasoningEffort(config, providerName, modelId, catalogLadders);
    if (effective !== inherited) return true;
  }
  return false;
}

/** The ladder this model inherits when no per-model override exists. */
export function inheritedModelReasoningEfforts(config: OcxConfig, providerName: string, modelId: string, catalogLadders?: CatalogLadderLookup): string[] | undefined {
  const provider = config.providers[providerName];
  if (!provider) return undefined;
  const record = provider.modelReasoningEfforts;
  if (!record || !Object.prototype.hasOwnProperty.call(record, modelId)) {
    return effectiveModelReasoningEfforts(config, providerName, modelId, undefined, catalogLadders);
  }
  const next = { ...record };
  delete next[modelId];
  const stripped = { ...provider, modelReasoningEfforts: next };
  const view = { ...config, providers: { ...config.providers, [providerName]: stripped } };
  return effectiveModelReasoningEfforts(view, providerName, modelId, undefined, catalogLadders);
}

/** The default this model inherits when no per-model default override exists. */
export function inheritedModelDefaultReasoningEffort(config: OcxConfig, providerName: string, modelId: string, catalogLadders?: CatalogLadderLookup): string | undefined {
  const provider = config.providers[providerName];
  if (!provider) return undefined;
  const record = provider.modelDefaultReasoningEfforts;
  if (!record || !Object.prototype.hasOwnProperty.call(record, modelId)) {
    return effectiveModelDefaultReasoningEffort(
      config, providerName, modelId, undefined, effectiveModelReasoningEfforts(config, providerName, modelId, undefined, catalogLadders),
    );
  }
  const next = { ...record };
  delete next[modelId];
  const stripped = { ...provider, modelDefaultReasoningEfforts: next };
  const view = { ...config, providers: { ...config.providers, [providerName]: stripped } };
  return effectiveModelDefaultReasoningEffort(
    view, providerName, modelId, undefined, effectiveModelReasoningEfforts(view, providerName, modelId, undefined, catalogLadders),
  );
}

/**
 * The exact row list `/api/models` returns. Extracted so `/api/client-config` exports the
 * models the GUI's Models tab shows — including this function's `disabled` computation,
 * which the export core (src/clients/config-export.ts) deliberately does not perform.
 */
export async function listManagementModelRows(
  config: OcxConfig,
  options: {
    entitlementWaitMs?: number;
    models?: readonly CatalogModel[];
    /** Filled with each provider's content revision as of the moment its rows were chosen. */
    providerContentRevisions?: Map<string, string>;
  } = {},
): Promise<ManagementModelRow[]> {
  /*
   * A supplied roster skips the gather, and that is the point rather than an optimization.
   * `fetchAllModels` reaches providers and can persist an initial model selection, which a
   * read-only caller must not do. Everything below this line is the projection — the disabled
   * computation, native and account-bound rows, custom rows and the public list — so a caller
   * that brings its own roster still sees exactly what a writer would, and the two cannot
   * disagree about the roster for any reason except the roster itself.
   */
  const models = options.models === undefined
    ? (await Promise.all([
      fetchAllModels(config, options.providerContentRevisions),
      ensureCodexEntitlementFreshness(config, {
        waitMs: options.entitlementWaitMs ?? 3_000,
      }),
    ]))[0]
    : [...options.models];
  const disabled = new Set(config.disabledModels ?? []);
  // Native GPT passthrough rows lead (provider "openai", bare-slug namespaced ids): sourced
  // from the static supported set so a disabled model stays listed and re-enableable.
  const nativeRows = nativeModelRows(config).map(row => ({ ...row, metadataSlug: row.slug }));
  const accountNativeRows = shouldIncludeAccountBoundNativeOpenAi(config)
    ? [...accountBoundNativeOpenAiSlugsBySelector(config).entries()].flatMap(([selector, slugs]) =>
      slugs
        .filter(slug => !NATIVE_OPENAI_MODELS.includes(slug))
        .map(slug => ({
          slug: `${selector}/${slug}`,
          metadataSlug: slug,
          disabled: disabled.has(`${selector}/${slug}`) || disabled.has(slug),
          contextWindow: undefined,
          maxInputTokens: undefined,
          autoCompactTokenLimit: undefined,
        })))
    : [];
  const native: ManagementModelRow[] = [...nativeRows, ...accountNativeRows].map(row => {
    const reasoningEfforts = nativeReasoningEfforts(row.metadataSlug).filter(isVisionReasoningEffort);
    const defaultReasoningEffort = nativeDefaultReasoningEffort(row.metadataSlug);
    return {
      provider: "openai",
      id: row.slug,
      namespaced: row.slug,
      disabled: row.disabled,
      native: true,
      reasoningEfforts,
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      inputModalities: nativeInputModalities(row.slug),
      ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
      // The input ceiling is a separate number from the window for GPT-5.6 (922k under
      // 1.05M). Dropping it here made /api/models describe a native row as if the whole
      // window were usable as input, which is the claim the measurement disproved.
      ...(row.maxInputTokens !== undefined ? { maxInputTokens: row.maxInputTokens } : {}),
      ...(row.autoCompactTokenLimit !== undefined
        ? { autoCompactTokenLimit: row.autoCompactTokenLimit }
        : {}),
    };
  });
  const customModels: ManagementModelRow[] = (config.customModels ?? []).map(cm => {
    const namespaced = routedSlug(cm.provider, cm.modelId);
    return {
      provider: cm.provider,
      id: cm.modelId,
      namespaced,
      disabled: [...disabled].some(stored => slugEquals(stored, cm.provider, cm.modelId)),
      custom: true,
      customId: cm.id,
      displayName: cm.displayName,
      ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
      ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
      // Stored override, not the inherited ladder: the edit dialog must show what the user
      // set (including an explicit empty "no reasoning" ladder), not what the provider row
      // happens to advertise today.
      ...(Array.isArray(cm.reasoningEfforts) ? { reasoningEfforts: [...cm.reasoningEfforts] } : {}),
      // The stored default rides along so a client reloading /api/models can restore the
      // full edit state; the GUI has no default-effort control today, but dropping it here
      // would make any future PUT-based edit lose it silently.
      ...(cm.defaultReasoningEffort ? { defaultReasoningEffort: cm.defaultReasoningEffort } : {}),
    };
  });
  const publicModels = uniqueCatalogModelsForPublicList(models);
  // Custom rows below are REBUILT from config.customModels rather than spread from a
  // CatalogModel, so every field gather computed for the same slug has to be carried across by
  // hand. Without this a custom model whose provider is out of credit would be the one row on
  // the page that never shows as inactive (#1711), because the gather-derived row it replaces
  // is dropped by the slug dedup below.
  const quotaInactiveByNamespaced = new Map(
    publicModels
      .filter(model => model.quotaInactiveReason !== undefined)
      .map(model => [catalogModelSlug(model), model.quotaInactiveReason!] as const),
  );
  const comboNamespaced = new Set(
    publicModels.filter(model => model.provider === "combo").map(catalogModelSlug),
  );
  const visibleCustomModels = customModels
    .filter(model => !comboNamespaced.has(model.namespaced))
    .map(model => {
      const quotaInactiveReason = quotaInactiveByNamespaced.get(model.namespaced);
      return quotaInactiveReason ? { ...model, quotaInactiveReason } : model;
    });
  // Custom metadata wins when a physical live/static row resolves to the same Codex-facing
  // slug, while a combo keeps the same precedence it has in routing and /v1/models.
  const customNamespaced = new Set(visibleCustomModels.map(c => c.namespaced));
  // One catalog read for the whole roster. Every `catalogModelEfforts` call parses the catalog
  // file and scans it once per requested slug, so resolving these per row (and twice per row, as
  // the guard and the value) re-read the same file thousands of times on a large roster.
  const routedSlugs = publicModels.filter(m => m.provider !== "combo").map(m => routedSlug(m.provider, m.id));
  const catalogLadders = catalogModelEfforts([...new Set(routedSlugs)]);
  const dedupedRouted = publicModels.map((m): ManagementModelRow | null => {
    // Codex-facing slug (one "/", slug-codec); disabledModels compares tolerate both forms.
    const namespaced = catalogModelSlug(m);
    if (m.provider !== "combo" && customNamespaced.has(namespaced)) return null;
    const contextCap = providerContextCap(config, m.provider);
    const nativeAlias = m.provider === "combo" && m.nativeAlias === true;
    const displayName = effectiveManagementDisplayName(config, m);
    const routed = m.provider !== "combo";
    // Resolved once each: the spread below used to evaluate the same helpers again for the guard.
    const reasoningEfforts = routed
      ? effectiveModelReasoningEfforts(config, m.provider, m.id, m.reasoningEfforts, catalogLadders)
      : undefined;
    const defaultReasoningEffort = routed
      ? effectiveModelDefaultReasoningEffort(config, m.provider, m.id, m.defaultReasoningEffort, reasoningEfforts)
      : undefined;
    const inputModalitiesDeclared = routed ? declaredModelInputModalities(config, m.provider, m.id) : undefined;
    const contextWindowDeclared = routed ? config.providers[m.provider]?.modelContextWindows?.[m.id] : undefined;
    return {
      ...m,
      ...displayName,
      namespaced,
      disabled: [...disabled].some(stored => (
        (!nativeAlias && stored === namespaced) || slugEquals(stored, m.provider, m.id)
      )),
      ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
      // A routed row inherits nothing about reasoning or modalities from the row spread above:
      // the catalog only carries what discovery reported, so the effective answers are resolved
      // here, where the config and the registry are both in hand.
      ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
      ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
      ...(routed ? { reasoningOverridden: reasoningOverrideFor(config, m.provider, m.id, catalogLadders) } : {}),
      ...(inputModalitiesDeclared !== undefined ? { inputModalitiesDeclared } : {}),
      ...(contextWindowDeclared !== undefined ? { contextWindowDeclared } : {}),
    };
  }).filter((row): row is ManagementModelRow => row !== null);
  // Manual OpenAI rows retain their routed selector but replace the bare dashboard row.
  // Account-qualified rows remain distinct, explicitly selected routes.
  const visibleNative = native.filter(model => model.id.includes("/")
    || !customNamespaced.has(routedSlug(model.provider, model.id)));
  const rows = [...visibleNative, ...dedupedRouted, ...visibleCustomModels];
  // Include disabled rows and configured aliases before the export visibility filter:
  // a hidden real `x--fast` must never become a synthetic selector for another model.
  const knownIds = config.fastRows === false ? new Set<string>() : knownEffortRowIds(config);
  for (const row of rows) knownIds.add(row.namespaced);
  return rows.map(row => {
    const pending = initialModelSelectionPending(config.providers[row.provider]);
    const modelCosts = Object.hasOwn(config.providers, row.provider)
      ? config.providers[row.provider]?.modelCosts : undefined;
    return {
      ...row,
      ...(!row.native && modelCosts !== undefined && Object.hasOwn(modelCosts, row.id)
        ? { manualPricing: true } : {}),
      ...(pending ? { disabled: true, initialSelectionPending: true } : {}),
      fastRowAvailable: !row.disabled && !pending
        && !knownIds.has(fastRowId(row.namespaced)) && catalogFastRowEligible(config, row),
    };
  });
}

/** `/api/models` row → the narrower input the client-config serializers accept. */
export function toExportModel(row: ManagementModelRow): ExportModel {
  return {
    namespaced: row.namespaced,
    provider: row.provider,
    id: row.id,
    fastRowAvailable: row.fastRowAvailable === true,
    ...(row.native ? { native: true } : {}),
    ...(row.displayName && row.displayNameSource !== "fallback" ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
    ...(row.maxOutputTokens !== undefined ? { maxTokens: row.maxOutputTokens } : {}),
    ...(row.inputModalities ? { inputModalities: row.inputModalities } : {}),
    ...(row.reasoningEfforts ? { reasoningEfforts: row.reasoningEfforts } : {}),
    ...(row.defaultReasoningEffort ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
  };
}

/**
 * Visible (non-disabled) rows as export models — the ONE loader both
 * `/api/client-config` and the integration routes use, so the two can never
 * disagree about which models a client is told about.
 *
 * The visibility filter lives HERE rather than at each call site: the export
 * core serializes what it is given, so a model the user disabled in the Models
 * tab is absent from `/v1/models` and exporting it would hand the client a
 * selector the proxy refuses to route.
 */
export async function loadExportModels(
  config: OcxConfig,
  models?: readonly CatalogModel[],
): Promise<ExportModel[]> {
  // Initial selection adopts into the live configuration and persists it, so it has to finish
  // before anything is admitted. Admitting first would bind this roster to bytes the same load is
  // about to rewrite, and finalizing against a detached copy would adopt the choices into the copy
  // while leaving the live configuration pending.
  if (models === undefined && pendingModelSelectionProviders(config).size > 0) {
    const { resolvePendingInitialModelSelection } = await import("../../providers/initial-model-selection-runtime");
    await resolvePendingInitialModelSelection(config);
  }
  // The configuration this pass will use from beginning to end, proved to be the one on disk.
  // Without it there is nothing that may be retained, and the caller still gets its rows: only the
  // preview authority is withheld.
  let admission = captureExportConfigAdmission(config);
  let admitted = admission?.config ?? config;
  const discoveryBaseline = models === undefined ? captureModelDiscoveryBaseline(admitted) : null;
  const outcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
  // The gather stamps each provider as it chooses its rows, so the roster and the revisions that
  // vouch for it come from the same moment. Sampling afterwards would let a concurrent flight's
  // publication be recorded against rows it never produced.
  const gathered = new Map<string, string>();
  // Gathering here rather than through the shared fetch is what keeps the detached copy out of the
  // initial-selection finalizer: the projection below takes a roster, and that branch performs no
  // discovery and no configuration write. The entitlement refresh keeps the budget it has always
  // had, and runs alongside as it did inside the projection.
  const roster = models === undefined
    ? (await Promise.all([
      (await import("../../codex/catalog")).gatherRoutedModels(admitted, {
        providerContentRevisions: gathered, providerModelOutcomes: outcomes,
      }),
      ensureCodexEntitlementFreshness(admitted, { waitMs: 3_000 }),
    ]))[0]
    : models;
  if (discoveryBaseline !== null) {
    const authoritative = outcomes.filter(outcome => outcome.state === "authoritative").map(outcome => outcome.provider);
    if (admission !== null && isExportConfigAdmissionCurrent(admission, config)
      && [...gathered].every(([provider, revision]) => observeModelCacheRevision(provider) === revision)) {
      if (!finalizeModelDiscovery(config, discoveryBaseline, roster, authoritative, gathered)) {
        lastExportSnapshot = null;
        throw new CatalogGatherBusyError();
      }
      // Only our scoped discovery decision moved: bind the projection to the committed state.
      admission = captureExportConfigAdmission(config);
      admitted = admission?.config ?? config;
    } else {
      // Preserve the old-response contract after a race, without persisting stale evidence or
      // retaining it as a current preview. Apply visibility policy only to a detached projection.
      const projection = detachedConfigSnapshot(admitted);
      if (projection === null) throw new CatalogGatherBusyError();
      reconcileSuccessfulModelDiscoveries({ config: projection, models: roster,
        authoritativeProviders: authoritative, now: new Date().toISOString(), mode: "discovery" });
      admitted = projection;
      admission = null;
    }
  }
  const rows = await listManagementModelRows(admitted, { models: roster });
  // Management deliberately lists the full roster so hidden models can be enabled.
  // A client picker must also honor the provider selection, not just its blocklist.
  const visibleRouted = new Set(filterCatalogVisibleModels(rows.filter(row => !row.native), admitted));
  const exported = rows.filter(row => !row.disabled && (row.native || visibleRouted.has(row))).map(toExportModel);
  // Retain the FINAL projection, not an input to it. A preview that rebuilt from raw provider
  // caches would miss static and forward providers, which never populate one, and would skip the
  // retention, metadata, combo and filtering this function applies afterwards.
  // A deep clone, not a frozen view of the caller's array. Freezing the array alone left the model
  // objects shared, so a caller mutating one in place would have silently rewritten the roster a
  // later preview plans against, and the fingerprint would have moved with it.
  // Still the configuration these rows were chosen under, on disk and in hand alike. Revalidating
  // rather than re-reading an identity is what makes this fail closed: a configuration that moved
  // during the load leaves no snapshot rather than one recorded under a state its rows never had.
  if (admission === null || !isExportConfigAdmissionCurrent(admission, config)) {
    lastExportSnapshot = null;
    return exported;
  }
  // Prefer the revisions the gather stamped; fall back to observing only when the roster was
  // supplied and no gather happened, where there is nothing tighter to use.
  const cacheStamp = gathered.size > 0 ? stampFrom(admitted, gathered) : modelCacheStamp(admitted);
  const retained = lastExportSnapshot;
  /*
   * An identical roster keeps the identity it already had.
   *
   * The generation moved on every load, so an ordinary read that rebuilt the same rows, which the
   * Integrations collection does, invalidated a confirmation an operator was in the middle of
   * submitting. Nothing about the roster had changed; only the counter had. The rows themselves
   * are compared rather than assumed equal from the configuration and the cache stamp, because a
   * projection also reads entitlement state neither of those two describes.
   */
  const projection = Object.freeze(structuredClone(exported));
  if (retained !== null
    && retained.cacheStamp === cacheStamp
    && isExportConfigAdmissionCurrent(retained.admission, config)
    && JSON.stringify(retained.models) === JSON.stringify(projection)) {
    return exported;
  }
  lastExportSnapshot = { admission, cacheStamp, generation: ++exportSnapshotGeneration, models: projection };
  return exported;
}

/**
 * The completed export roster from the last ordinary load, if it still describes this config.
 *
 * A preview may not gather, so it reads only what an authoritative load already finished. The
 * admission it carries proved, when the roster was built, that the configuration in hand was the
 * one on disk; a later read repeats that proof, so a rewritten file, an edited resident object or
 * a mutated working copy each retire the snapshot rather than letting a preview plan against a
 * configuration nobody has.
 *
 * A cold process has no snapshot and the caller answers a bounded refusal, and an ordinary load
 * populates one: the Integrations collection read calls `loadExportModels`, so the page an
 * operator opens before confirming anything is usually the page that fills this in. That is not a
 * repair for every refusal. A configuration that disagrees with its file keeps refusing however
 * many times the page is opened, because nothing here reloads or reconciles anything; once the
 * two agree again the next ordinary read rebuilds the snapshot by itself.
 */
let lastExportSnapshot:
  | { admission: ExportConfigAdmission; cacheStamp: string; generation: number; models: readonly ExportModel[] }
  | null = null;
let exportSnapshotGeneration = 0;

/**
 * A process-local prefix for the roster identity a caller carries between a preview and the
 * mutation that confirms it.
 *
 * The identity used to be the configuration digest with a counter appended, which handed a
 * dashboard an opaque-looking string that was in fact a fingerprint of the operator's
 * configuration file. It only has to be unforgeable within this process and distinct across
 * restarts, so it says nothing about the configuration at all.
 */
const rosterIdentityPrefix = `r${Math.trunc(Math.random() * 0xffffffff).toString(36)}`;

function rosterIdentity(generation: number): string {
  return `${rosterIdentityPrefix}:${generation}`;
}

/**
 * Where the gathered half of the roster stands, observed without changing it.
 *
 * The config key cannot see a provider's models changing underneath an unchanged configuration,
 * which is exactly what discovery does. This reads the cache's own generation for each configured
 * provider through the passive observer, so a completed discovery retires the snapshot and a
 * preview stops planning against a roster that no longer reflects the provider.
 */
function modelCacheStamp(config: OcxConfig): string {
  return Object.keys(config.providers ?? {})
    .sort()
    .map(provider => `${provider}=${observeModelCacheRevision(provider)}`)
    .join(",");
}

/**
 * The same stamp shape, built from revisions the gather recorded rather than from observation.
 *
 * A provider the gather did not report falls back to observation so the stamp stays total; that
 * happens for a provider configured after the rows were chosen, and it retires the snapshot on
 * the next read rather than pretending the roster covered it.
 */
function stampFrom(config: OcxConfig, gathered: ReadonlyMap<string, string>): string {
  return Object.keys(config.providers ?? {})
    .sort()
    .map(provider => `${provider}=${gathered.get(provider) ?? observeModelCacheRevision(provider)}`)
    .join(",");
}

/**
 * Opaque identity of the snapshot a caller is holding, or null when there is none for this config.
 *
 * A fingerprint check that rebuilt its own roster could validate against one snapshot while the
 * mutation wrote from another, because an ordinary load can replace the snapshot at any moment and
 * nothing about that is serialised against the writer lock. Carrying this identity alongside the
 * captured roster lets a revalidation prove the snapshot it captured is still the current one
 * without ever swapping the roster the mutation is about to use.
 */
export function exportSnapshotIdentity(config: OcxConfig): string | null {
  const snapshot = lastExportSnapshot;
  if (snapshot === null) return null;
  if (!isExportConfigAdmissionCurrent(snapshot.admission, config)) return null;
  if (snapshot.cacheStamp !== modelCacheStamp(config)) return null;
  return rosterIdentity(snapshot.generation);
}

/** Test seam: a fresh process has no snapshot, and suites must be able to reproduce that. */
export function resetExportSnapshotForTests(): void {
  lastExportSnapshot = null;
}

/**
 * The export roster for a read that must change nothing at all, or null when there is not one.
 *
 * Skipping the initial-selection finalizer was not enough. Discovery itself refreshes credentials
 * and writes the provider model cache, so a preview that gathered would still be a write dressed
 * as a read, and "the models list already does this" describes what a GET happens to do rather
 * than what a preview is allowed to do.
 *
 * So this reads already-captured per-provider cache entries and never fetches. When no provider
 * has a cached roster there is no honest snapshot to plan against, and the caller reports a
 * bounded refusal rather than triggering a gather to manufacture one.
 */
export function previewExportSnapshot(
  config: OcxConfig,
): { models: readonly ExportModel[]; identity: string } | null {
  // One synchronous read of one const. Taking the roster and its identity in two steps let a
  // concurrent load publish a new snapshot between them, so a caller could hold one roster while
  // believing it held the identity of another.
  const snapshot = lastExportSnapshot;
  if (snapshot === null) return null;
  // The roster was built from a configuration proved to be the one on disk; this asks whether both
  // are still that same configuration, and reads nothing but the file to answer.
  if (!isExportConfigAdmissionCurrent(snapshot.admission, config)) return null;
  // A completed discovery retires the snapshot: the configuration is unchanged, but the models it
  // resolves to are not the ones this roster was built from.
  if (snapshot.cacheStamp !== modelCacheStamp(config)) return null;
  // Cloned on the way out as well as on the way in. The retained copy is the authority, and a
  // reader holding its objects could edit the roster every later preview plans against without
  // going anywhere near this module.
  return {
    models: structuredClone(snapshot.models) as readonly ExportModel[],
    identity: rosterIdentity(snapshot.generation),
  };
}

export function previewExportModels(config: OcxConfig): readonly ExportModel[] | null {
  return previewExportSnapshot(config)?.models ?? null;
}
