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
import {
  catalogModelSlug,
  accountBoundNativeOpenAiSlugsBySelector,
  nativeDefaultReasoningEffort,
  NATIVE_OPENAI_MODELS,
  nativeInputModalities,
  nativeModelRows,
  nativeReasoningEfforts,
  uniqueCatalogModelsForPublicList,
  shouldIncludeAccountBoundNativeOpenAi,
} from "../../codex/catalog";
import type { ExportModel } from "../../clients/config-export";
import { providerContextCap } from "../../providers/context-cap";
import { isVisionReasoningEffort } from "../../reasoning-effort";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import type { OcxConfig } from "../../types";
import { ensureCodexEntitlementFreshness } from "../../codex/model-entitlements";
import { fetchAllModels } from "./shared";

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
  native?: boolean;
  custom?: boolean;
  customId?: string;
};

/**
 * The exact row list `/api/models` returns. Extracted so `/api/client-config` exports the
 * models the GUI's Models tab shows — including this function's `disabled` computation,
 * which the export core (src/clients/config-export.ts) deliberately does not perform.
 */
export async function listManagementModelRows(
  config: OcxConfig,
  options: { entitlementWaitMs?: number } = {},
): Promise<ManagementModelRow[]> {
  const [models] = await Promise.all([
    fetchAllModels(config),
    ensureCodexEntitlementFreshness(config, {
      waitMs: options.entitlementWaitMs ?? 3_000,
    }),
  ]);
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
  const comboNamespaced = new Set(
    publicModels.filter(model => model.provider === "combo").map(catalogModelSlug),
  );
  const visibleCustomModels = customModels.filter(model => !comboNamespaced.has(model.namespaced));
  // Custom metadata wins when a physical live/static row resolves to the same Codex-facing
  // slug, while a combo keeps the same precedence it has in routing and /v1/models.
  const customNamespaced = new Set(visibleCustomModels.map(c => c.namespaced));
  const dedupedRouted = publicModels.map((m): ManagementModelRow | null => {
    // Codex-facing slug (one "/", slug-codec); disabledModels compares tolerate both forms.
    const namespaced = catalogModelSlug(m);
    if (m.provider !== "combo" && customNamespaced.has(namespaced)) return null;
    const contextCap = providerContextCap(config, m.provider);
    const nativeAlias = m.provider === "combo" && m.nativeAlias === true;
    return {
      ...m,
      namespaced,
      disabled: [...disabled].some(stored => (
        (!nativeAlias && stored === namespaced) || slugEquals(stored, m.provider, m.id)
      )),
      ...(contextCap !== undefined ? { contextCap, contextCapped: m.contextCapped === true } : {}),
    };
  }).filter((row): row is ManagementModelRow => row !== null);
  return [...native, ...dedupedRouted, ...visibleCustomModels];
}

/** `/api/models` row → the narrower input the client-config serializers accept. */
export function toExportModel(row: ManagementModelRow): ExportModel {
  return {
    namespaced: row.namespaced,
    provider: row.provider,
    id: row.id,
    ...(row.native ? { native: true } : {}),
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
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
export async function loadExportModels(config: OcxConfig): Promise<ExportModel[]> {
  const rows = await listManagementModelRows(config);
  return rows.filter(row => !row.disabled).map(toExportModel);
}
