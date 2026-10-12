/**
 * Effective export metadata for custom `/api/models` rows.
 *
 * A custom row's own fields are the operator's stored OVERRIDE. `/api/models` returns them
 * verbatim because the edit dialog must show what the user set — including an explicit empty
 * "no reasoning" ladder — not what the provider happens to advertise today. But a client
 * export has to serialize what the proxy will actually route: the canonical resolved catalog
 * metadata for the same `provider/modelId`. `listManagementModelRows` resolves that
 * projection here and attaches it additively, so the editor's raw fields and the exporter's
 * effective fields can never overwrite each other.
 *
 * Sources are the ones the routed-row projection already uses — the gathered catalog row for
 * the same slug (the gather materializes custom rows with provider/native inheritance), the
 * registry-enriched provider config, and the ladder resolution in `model-rows.ts`. No
 * independent provider fact tables, and no per-model fetch: everything comes from the roster
 * and config already in hand.
 */
import { enrichProviderFromRegistry } from "../../providers/derive";
import { modelRecordValue } from "../../reasoning-effort";
import { configuredReasoningSummarySupport } from "../../codex/catalog/model-hints";
import type { CatalogModel } from "../../codex/catalog";
import type { OcxConfig } from "../../types";
import {
  knownReasoningSupport,
  knownToolsSupport,
  type EffectiveModelExportMetadata,
} from "../../clients/config-export/contracts";

/** The stored-override fields a custom row carries, exactly as `config.customModels` writes them. */
export interface CustomRowOverrideSource {
  provider: string;
  id: string;
  contextWindow?: number;
  inputModalities?: string[];
  /** Explicit ladder; `[]` is a declaration ("no rungs"), not an absence. */
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

/**
 * Resolve the effective export metadata for one custom row.
 *
 * Explicit custom overrides win; resolved gathered facts precede provider-config fallbacks.
 * `effectiveReasoningEfforts` is
 * supplied by the caller because its resolution (declared ladder first, then the enriched
 * provider maps, then the pinned native table, then the catalog hints) lives with the other
 * ladder readers in `model-rows.ts`; here it is an input, resolved once per row.
 */
export function customRowExportMetadata(
  config: OcxConfig,
  source: CustomRowOverrideSource,
  catalogRow: CatalogModel | undefined,
  effectiveReasoningEfforts: string[] | undefined,
): EffectiveModelExportMetadata {
  const provider = config.providers[source.provider];
  // The same registry hydration the other per-model readers at this boundary perform, so a
  // custom row whose provider declares facts only in the registry still inherits them. The
  // per-model records are cloned first because the enrichment fills and folds them in place.
  const enriched = provider === undefined ? undefined : {
    ...provider,
    ...(provider.modelContextWindows ? { modelContextWindows: { ...provider.modelContextWindows } } : {}),
    ...(provider.modelInputModalities ? { modelInputModalities: { ...provider.modelInputModalities } } : {}),
    ...(provider.modelCapabilities ? { modelCapabilities: { ...provider.modelCapabilities } } : {}),
    ...(provider.modelReasoningEfforts ? { modelReasoningEfforts: { ...provider.modelReasoningEfforts } } : {}),
    ...(provider.modelDefaultReasoningEfforts
      ? { modelDefaultReasoningEfforts: { ...provider.modelDefaultReasoningEfforts } }
      : {}),
  };
  if (enriched) enrichProviderFromRegistry(source.provider, enriched);

  // Gathered resolved context first after the explicit override: the gather already ran the
  // canonical precedence (operator maps, registry, native clamps) and may have applied a
  // tighter cap than a config map read here would suggest. Re-reading the config maps ahead
  // of it would duplicate that policy and could widen past an observed tighter window.
  const contextWindow = source.contextWindow
    ?? catalogRow?.contextWindow
    ?? modelRecordValue(enriched?.modelContextWindows, source.id)
    ?? enriched?.contextWindow;
  // Same declaration chain `declaredModelInputModalities` reads, as the fallback when neither
  // the override nor the gathered row says anything.
  const declaredModalities = enriched === undefined ? undefined : (
    enriched.modelCapabilities?.[source.id]?.inputModalities
      ?? modelRecordValue(enriched.modelInputModalities, source.id)
  );
  const inputModalities = source.inputModalities ?? catalogRow?.inputModalities ?? declaredModalities;
  // The gathered row carries what the materializer already resolved; for a rosterless row the
  // same reader the materializer uses answers from the provider config, so both paths agree.
  const supportsReasoningSummaries = catalogRow?.supportsReasoningSummaries
    ?? configuredReasoningSummarySupport(provider, source.id);
  const defaultReasoningEffort = declaredDefaultWithin(
    effectiveReasoningEfforts,
    defaultEffort(source, catalogRow, provider),
  );
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(catalogRow?.maxInputTokens !== undefined ? { maxInputTokens: catalogRow.maxInputTokens } : {}),
    ...(catalogRow?.maxOutputTokens !== undefined ? { maxTokens: catalogRow.maxOutputTokens } : {}),
    ...(inputModalities !== undefined ? { inputModalities: [...inputModalities] } : {}),
    ...(effectiveReasoningEfforts !== undefined ? { reasoningEfforts: [...effectiveReasoningEfforts] } : {}),
    ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
    ...(knownToolsSupport({
      capabilities: catalogRow?.capabilities,
      parallelToolCalls: catalogRow?.parallelToolCalls,
    }) === true ? { supportsTools: true } : {}),
    ...(knownReasoningSupport({ reasoningEfforts: effectiveReasoningEfforts, supportsReasoningSummaries }) === true
      ? { supportsReasoning: true }
      : {}),
    ...(supportsReasoningSummaries !== undefined ? { supportsReasoningSummaries } : {}),
  };
}

/**
 * The declared default, suppressed unless it is a member of the effective ladder. An empty
 * ladder has no rung to default to, and a default the ladder does not contain describes an
 * effort the proxy would never send — the same rule the settings route applies when it
 * rejects a default "not in the declared reasoningEfforts ladder", applied here so an export
 * never ships a default the row cannot act on.
 */
function declaredDefaultWithin(
  effectiveReasoningEfforts: string[] | undefined,
  declared: string | undefined,
): string | undefined {
  if (declared === undefined) return undefined;
  if (effectiveReasoningEfforts === undefined) return declared;
  return effectiveReasoningEfforts.includes(declared) ? declared : undefined;
}

/**
 * The declared default, and nothing else. The ladder-preference fallback
 * (`effectiveModelDefaultReasoningEffort`'s medium → low → first) fabricates a default no
 * source declared; it is right for the picker's own preference order but wrong for an export
 * that claims to carry provider truth, so this projection stops at:
 *
 * 1. the explicit custom default (an override always wins),
 * 2. the gathered catalog row's declared default (the gather only lets it ride when it is a
 *    member of the effective ladder),
 * 3. the operator's per-model record — the same raw map the routed-row reader consults.
 *
 * `declaredDefaultWithin` then drops the answer when it is not a member of the effective
 * ladder, empty ladder included.
 */
function defaultEffort(
  source: CustomRowOverrideSource,
  catalogRow: CatalogModel | undefined,
  provider: { modelDefaultReasoningEfforts?: Record<string, string> } | undefined,
): string | undefined {
  if (source.defaultReasoningEffort) return source.defaultReasoningEffort;
  if (catalogRow?.defaultReasoningEffort) return catalogRow.defaultReasoningEffort;
  return modelRecordValue(provider?.modelDefaultReasoningEfforts, source.id) ?? undefined;
}
