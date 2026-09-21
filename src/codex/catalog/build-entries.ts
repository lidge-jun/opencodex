import { CODEX_REASONING_LEVELS } from "../../reasoning-effort";
import { clearModelCache } from "../model-cache";
import { routedSlug, slugEquivalenceKey } from "../../providers/slug-codec";
import { COMBO_NAMESPACE } from "../../combos";
import {
  CODEX_CUSTOM_MODEL_CATALOG_KIND,
  CODEX_PROVIDER_MODEL_CATALOG_KIND,
  applyMultiAgentMode,
  applyNativeOpenAiContextOverride,
  catalogModelSlug,
  ensureStrictCatalogFields,
  isRoutedModelCompatibilityExcluded,
  normalizeServiceTiers,
} from "./parsing";
import type { CatalogModel, MultiAgentMode, RawEntry } from "./parsing";
import {
  CODEX_NATIVE_ALIAS_CATALOG_KIND,
  NATIVE_OPENAI_MODELS,
  SUPPORTED_NATIVE_OPENAI_SLUGS,
  applyNativeVisibility,
  isNativeAliasCatalogEntry,
  isUnsupportedOpenAiNativeSlug,
  shouldUpgradeToUpstreamEntry,
  upstreamNativeEntry,
  type NativeContextLimitsInput,
} from "./metadata";
import { resetBundledCatalogCacheForTests } from "./bundled";
import { isMultiAgentV2Enabled } from "../features";
import { clampedDefaultEffort, ensureUltraReasoningLevel, isGpt56NativeSlug } from "./effort";
import { clearGatherRoutedModelsInflight, lastDropWarnSignature } from "./provider-fetch";
import {
  accountSelectorShadowCollisionWarnings,
  clearLastComboCatalogOmissions,
  comboCatalogWarningSignatures,
  comboMasqueradeCollisionWarnings,
  comboUnrestorableShadowWarnings,
  openAiApiCollisionWarnings,
  resolveSlugAliasCollisions,
  slugAliasCollisionWarnings,
  warnAccountSelectorShadowedProviderOnce,
  warnComboMasqueradeCollisionOnce,
  warnComboUnrestorableShadowOnce,
} from "./aggregation";
import { accountBoundNativeDisplayName, CODEX_ACCOUNT_BOUND_CATALOG_KIND, trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { NATIVE_RESERVE_MODEL } from "./native-models";
import { isReserveCatalogProjection, type ReserveCatalogProjection } from "./reserve";
import { deriveEntry, finishUpstreamNativeEntry, isExactComboCatalogEntry } from "./derive-entry";
import { PICKER_ORDER_PRIORITY_BASE, SPAWN_PRIORITY_FIELD } from "./subagent-roster";

export interface ObservedCatalogEntryBuildInput {
  readonly template: RawEntry | null;
  readonly gptSlugs: readonly string[];
  readonly goModels: readonly CatalogModel[];
  readonly featured?: readonly string[];
  /** Optional full picker ordering (config.modelPickerOrder); orders non-featured rows. */
  readonly modelPickerOrder?: readonly string[];
  readonly wsEnabled: boolean;
  readonly multiAgentMode: MultiAgentMode;
  readonly exactComboSlugs: ReadonlySet<string>;
  readonly accountSelectors: readonly string[];
  readonly suppressedBareNativeSlugs: ReadonlySet<string>;
  readonly disabledNativeAccountSlugs: ReadonlySet<string>;
  readonly multiAgentV2Enabled: boolean;
  readonly keepNativeChatGptOnV1?: boolean;
  readonly openaiContextCap?: NativeContextLimitsInput;
  /** Additional native ids to clone under account selectors, without creating bare rows. */
  readonly accountNativeSlugs?: readonly string[];
  /** Per-selector account ids; unknown observations must not be copied to unrelated accounts. */
  readonly accountNativeSlugsBySelector?: ReadonlyMap<string, readonly string[]>;
  /** Codex-only manual selector metadata; deliberately independent of live permission. */
  readonly reserve?: ReserveCatalogProjection;
}

/** Build entries with the process-observed Codex feature state. */
export function buildCatalogEntries(
  template: RawEntry | null,
  gptSlugs: string[],
  goModels: CatalogModel[],
  featured?: string[],
  wsEnabled = false,
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  accountSelectors: readonly string[] = [],
  suppressedBareNativeSlugs: ReadonlySet<string> = new Set(),
  disabledNativeAccountSlugs: ReadonlySet<string> = new Set(),
  contextCap?: NativeContextLimitsInput,
  accountNativeSlugs?: readonly string[],
  accountNativeSlugsBySelector?: ReadonlyMap<string, readonly string[]>,
  keepNativeChatGptOnV1 = false,
  modelPickerOrder: readonly string[] = [],
): RawEntry[] {
  const entries = buildCatalogEntriesFromObservedState({
    template,
    gptSlugs,
    goModels,
    featured,
    modelPickerOrder,
    wsEnabled,
    multiAgentMode,
    exactComboSlugs,
    accountSelectors,
    suppressedBareNativeSlugs,
    disabledNativeAccountSlugs,
    multiAgentV2Enabled: isMultiAgentV2Enabled(),
    keepNativeChatGptOnV1,
    openaiContextCap: contextCap,
    accountNativeSlugs,
    accountNativeSlugsBySelector,
  });
  applyFullModelPickerOrder(entries, modelPickerOrder);
  return entries;
}

/** Build entries solely from caller-observed inputs, with no feature-state filesystem read. */
export function buildCatalogEntriesFromObservedState({
  template,
  gptSlugs,
  goModels,
  featured,
  modelPickerOrder,
  wsEnabled,
  multiAgentMode,
  exactComboSlugs,
  accountSelectors,
  suppressedBareNativeSlugs,
  disabledNativeAccountSlugs,
  multiAgentV2Enabled,
  keepNativeChatGptOnV1,
  openaiContextCap,
  accountNativeSlugs,
  accountNativeSlugsBySelector,
  reserve,
}: ObservedCatalogEntryBuildInput): RawEntry[] {
  // Codex's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const priorityStride = Math.max(accountSelectors.length, 1);
  // Optional full picker order (#1649). Independent of the 5-slot spawn_agent cap: it only
  // rewrites the Codex-visible display `priority` of listed non-featured routed rows so a >5
  // catalog stays put across rebuilds. Featured rows keep their existing 0..N-1 band; when
  // modelPickerOrder is unset the helper is a no-op and every priority below is byte-identical to
  // before. The spawn_agent candidate window is derived separately from SPAWN_PRIORITY_FIELD, so
  // this display reorder does not change OpenCodex's guidance candidate calculation.
  const pickerOrder = normalizeModelPickerOrder(modelPickerOrder);
  const pickerOrderRank = new Map(pickerOrder.map((slug, i) => [slug, i] as const));
  const pickerOrderActive = pickerOrder.length > 0;
  // The display band reuses the existing high priority tier (>= PICKER_ORDER_PRIORITY_BASE, the
  // same 1_000+ neighborhood account rows occupy), keeping listed rows visually after the featured
  // band. OpenCodex guidance membership does not depend on this — see SPAWN_PRIORITY_FIELD.
  /**
   * Priority for a non-featured routed row that is explicitly LISTED in modelPickerOrder. Listed
   * slugs sort in declared order within the high picker-order display tier
   * (>= PICKER_ORDER_PRIORITY_BASE). This sets the Codex-visible `priority` only; the caller records
   * the row's natural priority in SPAWN_PRIORITY_FIELD for OpenCodex's unchanged guidance window.
   * Returns undefined when the feature is off or the row is not listed, so those rows
   * keep their original assignment (default 5 / account 1_000+) untouched.
   *
   * Scope: only the generic routed `<provider>/<model>` rows call this (see the goModels loop
   * below). Native passthrough rows and account-qualified native rows keep their own priority
   * logic and are intentionally not reordered in this legacy builder pass. The final merge can
   * apply complete ordering when the configured list includes a bare id.
   */
  const pickerOrderPriority = (slug: string, altSlug?: string): number | undefined => {
    if (!pickerOrderActive) return undefined;
    const hit = pickerOrderRank.get(slug) ?? (altSlug !== undefined ? pickerOrderRank.get(altSlug) : undefined);
    if (hit === undefined) return undefined;
    return PICKER_ORDER_PRIORITY_BASE + hit * priorityStride;
  };
  const out: RawEntry[] = [];
  const nativeEntries: RawEntry[] = [];
  const collisionSkipped = resolveSlugAliasCollisions([...goModels]);
  const emittedNativeAliases = new Set<CatalogModel>();
  const emittedNativeAliasSlugs = new Set<string>();
  const nativeAliasesBySlug = new Map<string, CatalogModel>();
  for (const model of goModels) {
    if (model.provider !== COMBO_NAMESPACE
      || model.nativeAlias !== true
      || typeof model.alias !== "string"
      || model.alias.includes("/")) continue;
    if (nativeAliasesBySlug.has(model.alias)) {
      collisionSkipped.add(model);
      if (!slugAliasCollisionWarnings.has(model.alias)) {
        slugAliasCollisionWarnings.add(model.alias);
        console.warn(
          `[opencodex] native combo alias collision on "${model.alias}": keeping the first configured combo and omitting later duplicates from the catalog.`,
        );
      }
      continue;
    }
    nativeAliasesBySlug.set(model.alias, model);
  }
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  for (const slug of gptSlugs) {
    const native = deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9, undefined, new Set(), openaiContextCap);
    if (rank.has(slug)) native.priority = rank.get(slug)!;
    nativeEntries.push(native);
    const nativeAlias = nativeAliasesBySlug.get(slug);
    if (!nativeAlias || collisionSkipped.has(nativeAlias)) {
      if (!suppressedBareNativeSlugs.has(slug)) out.push(native);
      continue;
    }
    const routed = deriveEntry(
      template,
      slug,
      `Routed via opencodex → ${nativeAlias.provider} (${nativeAlias.owned_by ?? nativeAlias.provider}).`,
      5,
      nativeAlias,
      exactComboSlugs,
    );
    routed.opencodex_catalog_kind = CODEX_NATIVE_ALIAS_CATALOG_KIND;
    const rankHit = rank.get(slug) ?? rank.get(`${nativeAlias.provider}/${nativeAlias.id}`);
    if (rankHit !== undefined) routed.priority = rankHit * priorityStride;
    else if (accountSelectors.length > 0) routed.priority = 1_000 + (typeof routed.priority === "number" ? routed.priority : 5);
    out.push(routed);
    emittedNativeAliases.add(nativeAlias);
    emittedNativeAliasSlugs.add(slug);
  }
  const nativeEntriesBySlug = new Map(nativeEntries.map(entry => [String(entry.slug), entry] as const));
  for (const [selectorIndex, selector] of accountSelectors.entries()) {
    const selectorNativeSlugs = accountNativeSlugsBySelector?.get(selector)
      ?? accountNativeSlugs
      ?? gptSlugs;
    const accountNativeEntries = selectorNativeSlugs.filter(slug => slug !== NATIVE_RESERVE_MODEL).map(slug => (
      nativeEntriesBySlug.get(slug)
        ?? deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9, undefined, new Set(), openaiContextCap)
    ));
    if (reserve?.mainSelectors.includes(selector)) accountNativeEntries.push(reserve.source);
    for (const [nativeIndex, native] of accountNativeEntries.entries()) {
      const nativeSlug = String(native.slug);
      if (disabledNativeAccountSlugs.has(nativeSlug)) continue;
      const e = JSON.parse(JSON.stringify(native)) as RawEntry;
      const catalogSlug = `${selector}/${nativeSlug}`;
      if (nativeSlug === NATIVE_RESERVE_MODEL && disabledNativeAccountSlugs.has(catalogSlug)) continue;
      e.slug = catalogSlug;
      e.display_name = accountBoundNativeDisplayName(selector, native);
      // Codex ignores this OpenCodex extension; preserve the native comp_hash unchanged.
      e.opencodex_catalog_kind = CODEX_ACCOUNT_BOUND_CATALOG_KIND;
      const exactRank = rank.get(catalogSlug);
      // A bare featured id belongs to the compatibility combo once shadowed. Exact
      // account-qualified picks still rank normally, but the account clone must not
      // inherit the bare alias rank and consume another top spawn_agent slot.
      const inheritedRank = emittedNativeAliasSlugs.has(nativeSlug) ? undefined : rank.get(nativeSlug);
      const featuredRank = exactRank ?? inheritedRank;
      e.priority = featuredRank !== undefined
        ? featuredRank * priorityStride + selectorIndex
        : ((featured?.length ?? 0) + nativeIndex) * accountSelectors.length + selectorIndex;
      e.visibility = "list";
      out.push(e);
    }
  }
  for (const m of goModels) {
    if (collisionSkipped.has(m) || emittedNativeAliases.has(m)) continue;
    const slug = catalogModelSlug(m);
    if (m.provider !== COMBO_NAMESPACE && comboPublicSlugs.has(slug)) {
      warnComboMasqueradeCollisionOnce(slug);
      continue;
    }
    // Provider rows use the one-slash slug codec; combo aliases intentionally override that
    // public slug and may be bare.
    const e = deriveEntry(
      template,
      slug,
      `Routed via opencodex → ${m.provider} (${m.owned_by ?? m.provider}).`,
      5,
      m,
      exactComboSlugs,
    );
    if (m.provider === COMBO_NAMESPACE && m.nativeAlias === true && !slug.includes("/")) {
      e.opencodex_catalog_kind = CODEX_NATIVE_ALIAS_CATALOG_KIND;
    }
    // Featured picks may be stored raw (legacy) or encoded — honor both.
    const rankHit = rank.get(slug) ?? rank.get(`${m.provider}/${m.id}`);
    // Natural priority: what the row would get WITHOUT modelPickerOrder. This is the value the
    // spawn_agent candidate window is derived from (see effectiveSubagentRoster), so it must never
    // move when modelPickerOrder reorders the picker.
    if (rankHit !== undefined) e.priority = rankHit * priorityStride;
    else if (accountSelectors.length > 0) {
      // Keep the generated account rows together in Codex's priority-sorted flat picker.
      e.priority = 1_000 + (typeof e.priority === "number" ? e.priority : 5);
    }
    // The legacy routed-only builder pass keeps featured ranks and records natural priority
    // before changing non-featured display priority. The final complete-order pass may move
    // featured display rows too; OpenCodex guidance continues to use their natural ranks.
    if (rankHit === undefined) {
      const pickerPriority = pickerOrderPriority(slug, `${m.provider}/${m.id}`);
      if (pickerPriority !== undefined) {
        e[SPAWN_PRIORITY_FIELD] = typeof e.priority === "number" ? e.priority : 5;
        e.priority = pickerPriority;
      }
    }
    out.push(e);
  }
  // Central capability override (phase 120.4): the advertised flag must match the implemented WS
  // endpoint. Overrides both the routed strip (normalizeRoutedCatalogEntry) and any native template
  // leak (deriveEntry clones the template as-is for native slugs).
  for (const entry of out) {
    if (wsEnabled) entry.supports_websockets = true;
    else {
      delete entry.supports_websockets;
      // Snapshot-backed native entries carry prefer_websockets: never advertise a preference
      // for an endpoint ocx has disabled.
      delete entry.prefer_websockets;
    }
  }
  return applyMultiAgentMode(out, multiAgentMode, multiAgentV2Enabled, {
    keepNativeChatGptOnV1,
    preserveDefaultMultiAgentVersion: isReserveCatalogProjection,
  });
}

export function resetCatalogRuntimeStateForTests(): void {
  resetBundledCatalogCacheForTests();
  lastDropWarnSignature.clear();
  openAiApiCollisionWarnings.clear();
  comboCatalogWarningSignatures.clear();
  slugAliasCollisionWarnings.clear();
  comboMasqueradeCollisionWarnings.clear();
  comboUnrestorableShadowWarnings.clear();
  accountSelectorShadowCollisionWarnings.clear();
  clearLastComboCatalogOmissions();
  clearModelCache(undefined, "eviction");
  clearGatherRoutedModelsInflight();
}

export function orderForSubagents(goModels: CatalogModel[], featured?: string[]): CatalogModel[] {
  if (!featured || featured.length === 0) return goModels;
  const rank = new Map(featured.map((id, i) => [id, i]));
  // Featured picks may be stored raw (legacy) or encoded — match both forms.
  const rankOf = (m: CatalogModel) =>
    (m.alias ? rank.get(m.alias) : undefined)
      ?? rank.get(`${m.provider}/${m.id}`)
      ?? rank.get(routedSlug(m.provider, m.id))
      ?? Number.MAX_SAFE_INTEGER;
  return [...goModels].sort((a, b) => {
    return rankOf(a) - rankOf(b);
  });
}

/** Routed discovery projection; native groups and alias ownership belong to the caller. */
export function orderForModelPicker(
  models: readonly CatalogModel[],
  order: readonly string[] = [],
  featured: readonly string[] = [],
): CatalogModel[] {
  const pickerOrder = normalizeModelPickerOrder(order);
  if (pickerOrder.length === 0) return [...models];
  const pickerRank = modelPickerRank(pickerOrder);
  const featuredRank = modelPickerRank(featured);
  const complete = pickerOrder.some(slug => !slug.includes("/"));
  const rank = (model: CatalogModel): number => {
    const slug = catalogModelSlug(model);
    const featuredIndex = featuredRank(slug) ?? featuredRank(`${model.provider}/${model.id}`);
    const natural = featuredIndex ?? 5;
    const index = pickerRank(slug) ?? pickerRank(`${model.provider}/${model.id}`);
    if (complete) return index ?? pickerOrder.length + natural;
    // Preserve the legacy featured/alias bands, including unlisted rows before listed rows.
    if (featuredIndex !== undefined || model.nativeAlias === true) return natural;
    return index === undefined ? natural : PICKER_ORDER_PRIORITY_BASE + index;
  };
  return [...models].sort((a, b) => rank(a) - rank(b));
}

/**
 * True when an existing catalog row was authored by OpenCodex routing (#855).
 * Every generated routed row — current full-slug form, the June–July 2026
 * provider-name form, and legacy combo aliases — carries the stable
 * description prefix `Routed via opencodex → `; foreign rows from Cursor or
 * user tooling do not. `owned_by` cannot serve as the signal (upstream
 * ownership), and `comp_hash` defaults to "opencodex" for every normalized
 * row.
 */
function isOcxAuthoredRoutedEntry(entry: RawEntry): boolean {
  if (isNativeAliasCatalogEntry(entry)) return true;
  const desc = typeof entry.description === "string" ? entry.description : "";
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return slug.includes("/") && desc.startsWith("Routed via opencodex → ");
}

function recoverableNativeSlug(entry: RawEntry): string | null {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
    && !isNativeAliasCatalogEntry(entry)
    && entry.owned_by !== COMBO_NAMESPACE
    ? slug
    : null;
}

/** Undo our display overlay before native metadata normalization and template reuse. */
function restoreNativeDisplayName(entry: RawEntry): RawEntry {
  const saved = entry.opencodex_native_display_name;
  delete entry.opencodex_native_display_name;
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    const label = saved as Record<string, unknown>;
    if (recoverableNativeSlug(entry) === label.slug
      && typeof label.original === "string" && entry.display_name === label.applied) {
      entry.display_name = label.original;
    }
  }
  return entry;
}

/** Append missing supported native rows from trusted catalog sources only. */
export function mergeCatalogModelsWithNativeRecovery(
  primaryCatalogModels: readonly RawEntry[],
  nativeRecoverySources: readonly (readonly RawEntry[])[],
): RawEntry[] {
  const merged = [...primaryCatalogModels];
  const recoveredNativeSlugs = new Set(primaryCatalogModels.flatMap(entry => {
    const slug = recoverableNativeSlug(entry);
    return slug === null ? [] : [slug];
  }));
  for (const source of nativeRecoverySources) {
    for (const entry of source) {
      const slug = recoverableNativeSlug(entry);
      if (slug === null || recoveredNativeSlugs.has(slug)) continue;
      merged.push(structuredClone(entry) as RawEntry);
      recoveredNativeSlugs.add(slug);
    }
  }
  return merged;
}

export interface ObservedCatalogMergePolicy {
  /** Required observed/fixed set; the core merge never consults ambient catalog state. */
  readonly nativeBackfillSlugs: readonly string[];
  /** Whether unsupported OpenAI-family bare rows survive the merge. */
  readonly unsupportedNativeEntries: "preserve" | "drop";
  /** Whether merge-policy collision/preservation warnings belong to this caller's flow. */
  readonly warningPolicy: "emit" | "suppress";
}

/** Content policy shared by every writer of the canonical Codex model catalog. */
export const CANONICAL_NATIVE_CATALOG_CONTENT_POLICY: Readonly<
  Pick<ObservedCatalogMergePolicy, "nativeBackfillSlugs" | "unsupportedNativeEntries">
> = Object.freeze({
  nativeBackfillSlugs: Object.freeze([...NATIVE_OPENAI_MODELS]),
  unsupportedNativeEntries: "drop",
});

function normalizeModelPickerOrder(order: unknown): string[] {
  return Array.isArray(order)
    ? order.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
}

/** Preserve exact-id precedence while accepting the existing raw/encoded slug spellings. */
function modelPickerRank(order: readonly string[]): (slug: string) => number | undefined {
  const exact = new Map(order.map((slug, index) => [slug, index]));
  const equivalent = new Map(order.map((slug, index) => [slugEquivalenceKey(slug), index]));
  return slug => exact.get(slug) ?? equivalent.get(slugEquivalenceKey(slug));
}

/** Complete display ordering retains natural ranks for OpenCodex's separate guidance projection. */
export function applyFullModelPickerOrder(entries: RawEntry[], order: readonly string[]): void {
  const pickerOrder = normalizeModelPickerOrder(order);
  if (!pickerOrder.some(slug => !slug.includes("/"))) return;
  const rankOf = modelPickerRank(pickerOrder);
  for (const entry of entries) {
    const natural = entry[SPAWN_PRIORITY_FIELD] ?? entry.priority ?? 9;
    entry[SPAWN_PRIORITY_FIELD] = natural;
    entry.priority = rankOf(String(entry.slug)) ?? pickerOrder.length + Number(natural);
  }
}

export interface ObservedCatalogMergeInput {
  readonly catalogModels: readonly RawEntry[];
  readonly baselineCatalogModels: readonly RawEntry[];
  readonly routedEntries: readonly RawEntry[];
  readonly baseline: ReadonlyMap<string, number>;
  readonly featured: readonly string[];
  readonly modelPickerOrder?: readonly string[];
  readonly accountSelectors?: readonly string[];
  readonly wsEnabled: boolean;
  readonly template: RawEntry | null;
  readonly disabledModels: ReadonlySet<string>;
  readonly selectedModelsByProvider: ReadonlyMap<string, ReadonlySet<string>>;
  readonly gatheredProviderNames: ReadonlySet<string>;
  readonly pendingProviderNames?: ReadonlySet<string>;
  readonly degradedProviderNames: ReadonlySet<string>;
  readonly legacyCustomModelSlugs: ReadonlySet<string>;
  readonly multiAgentMode: MultiAgentMode;
  readonly multiAgentV2Enabled: boolean;
  readonly keepNativeChatGptOnV1?: boolean;
  readonly exactComboSlugs: ReadonlySet<string>;
  readonly hasPhysicalComboProvider: boolean;
  readonly includeNativeOpenAi: boolean;
  readonly accountBoundEntries: readonly RawEntry[];
  readonly suppressedBareNativeSlugs?: ReadonlySet<string>;
  /** Routed slugs that must not gain a missing synthetic max rung during retained-row repair. */
  readonly suppressedSyntheticMaxSlugs?: ReadonlySet<string>;
  readonly policy: ObservedCatalogMergePolicy;
  readonly openaiContextCap?: NativeContextLimitsInput;
  /** Exact display-only labels for bare native OpenAI models. */
  readonly nativeDisplayNames?: Readonly<Record<string, string>>;
  /** Pristine installed-catalog multi-agent pins; see MultiAgentModeOptions.nativeDefaults. */
  readonly nativeMultiAgentDefaults?: ReadonlyMap<string, string | null>;
}

/**
 * Deterministically merge one fully observed catalog state.
 *
 * Every non-catalog input is explicit so evidence-bound convergence cannot
 * accidentally fall back to process-ambient catalog discovery or merge-policy warnings.
 */
export function mergeCatalogEntriesFromObservedState({
  catalogModels,
  baselineCatalogModels,
  routedEntries,
  baseline,
  featured,
  modelPickerOrder = [],
  accountSelectors = [],
  wsEnabled,
  template,
  disabledModels,
  selectedModelsByProvider,
  gatheredProviderNames,
  pendingProviderNames = new Set(),
  degradedProviderNames,
  legacyCustomModelSlugs,
  multiAgentMode,
  multiAgentV2Enabled,
  keepNativeChatGptOnV1,
  exactComboSlugs,
  hasPhysicalComboProvider,
  includeNativeOpenAi,
  accountBoundEntries,
  suppressedBareNativeSlugs = new Set(),
  suppressedSyntheticMaxSlugs = new Set(),
  policy,
  openaiContextCap,
  nativeDisplayNames,
  nativeMultiAgentDefaults,
}: ObservedCatalogMergeInput): RawEntry[] {
  // Raw catalog rows contain nested arrays/objects that normalization mutates. Detach every row at
  // the observed-core boundary so callers can safely retain evidence objects or repeat the merge.
  const detachedCatalogModels = catalogModels
    .map(entry => restoreNativeDisplayName(structuredClone(entry) as RawEntry));
  const detachedBaselineCatalogModels = baselineCatalogModels
    .map(entry => restoreNativeDisplayName(structuredClone(entry) as RawEntry));
  const detachedRoutedEntries = routedEntries.map(entry => structuredClone(entry) as RawEntry);
  // Track this invocation's generated custom rows, not ownership markers read from disk.
  // Their builder already finalized exact native ladders and ordinary routed mock tiers.
  const freshCustomEntries = new Set(detachedRoutedEntries.filter(entry =>
    entry.opencodex_catalog_kind === CODEX_CUSTOM_MODEL_CATALOG_KIND));
  const detachedAccountBoundEntries = accountBoundEntries
    .map(entry => structuredClone(entry) as RawEntry);
  const disabledModelKeys = new Set([...disabledModels].map(slugEquivalenceKey));
  const legacyCustomModelKeys = new Set(
    [...legacyCustomModelSlugs].map(slugEquivalenceKey),
  );
  const selectedModelKeysByProvider = new Map([...selectedModelsByProvider].map(([provider, models]) => (
    [provider, new Set([...models].map(model => slugEquivalenceKey(routedSlug(provider, model))))] as const
  )));
  const freshAccountKeys = new Set(detachedAccountBoundEntries.flatMap(entry => (
    typeof entry.slug === "string" ? [slugEquivalenceKey(entry.slug)] : []
  )));
  const wouldSurviveUnreplaced = (entry: RawEntry): boolean => {
    if (entry.owned_by === COMBO_NAMESPACE
      || trustedAccountBoundNativeCatalogSlug(entry) !== undefined
      || entry.opencodex_catalog_kind === CODEX_CUSTOM_MODEL_CATALOG_KIND
      || isOcxAuthoredRoutedEntry(entry)
      || typeof entry.slug !== "string") return false;
    const slug = entry.slug;
    if (!slug.includes("/")) {
      if (!includeNativeOpenAi || policy.nativeBackfillSlugs.includes(slug)) return false;
      return policy.unsupportedNativeEntries === "preserve" || !isUnsupportedOpenAiNativeSlug(slug);
    }
    if (isRoutedModelCompatibilityExcluded(slug)) return false;
    if (!hasPhysicalComboProvider && slug.startsWith(`${COMBO_NAMESPACE}/`)) return false;
    const key = slugEquivalenceKey(slug);
    if (freshAccountKeys.has(key)) return false;
    if (disabledModelKeys.has(key)) return false;
    const slash = slug.indexOf("/");
    const provider = slug.slice(0, slash);
    if (pendingProviderNames.has(provider)) return false;
    const selected = selectedModelKeysByProvider.get(provider);
    if (selected !== undefined && !selected.has(key)) return false;
    return !gatheredProviderNames.has(provider) || degradedProviderNames.has(provider);
  };
  const validRoutedEntries = detachedRoutedEntries.filter(entry => {
    return !isExactComboCatalogEntry(entry, exactComboSlugs)
      || (Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0);
  });
  const restorableCatalogKeys = new Set(detachedBaselineCatalogModels.flatMap(entry => (
    wouldSurviveUnreplaced(entry) && typeof entry.slug === "string"
      ? [slugEquivalenceKey(entry.slug)]
      : []
  )));
  const unrestorableCatalogKeys = new Set(detachedCatalogModels.flatMap(entry => {
    if (!wouldSurviveUnreplaced(entry) || typeof entry.slug !== "string") return [];
    const key = slugEquivalenceKey(entry.slug);
    return restorableCatalogKeys.has(key) ? [] : [key];
  }));
  const admittedRoutedEntries = validRoutedEntries.filter(entry => {
    if (!isExactComboCatalogEntry(entry, exactComboSlugs)) return true;
    const slug = entry.slug as string;
    const key = slugEquivalenceKey(slug);
    if (!unrestorableCatalogKeys.has(key)) return true;
    if (policy.warningPolicy === "emit") warnComboUnrestorableShadowOnce(slug);
    return false;
  });
  // A fresh non-custom row authoritatively resolves a historically ambiguous slug as a normal
  // provider model. Persist that classification so the durable deletion evidence cannot remove
  // the legitimate row during a later degraded refresh.
  for (const entry of admittedRoutedEntries) {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug
      || entry.opencodex_catalog_kind !== undefined
      || entry.owned_by === COMBO_NAMESPACE
      || !isOcxAuthoredRoutedEntry(entry)
      || !legacyCustomModelKeys.has(slugEquivalenceKey(slug))) continue;
    entry.opencodex_catalog_kind = CODEX_PROVIDER_MODEL_CATALOG_KIND;
  }
  const freshExactComboEntries = new Set(admittedRoutedEntries.filter(entry => (
    isExactComboCatalogEntry(entry, exactComboSlugs)
    && typeof entry.description === "string"
    && entry.description.startsWith(`Routed via opencodex → ${COMBO_NAMESPACE} (`)
  )));
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const freshEquivalentKeys = new Set(admittedRoutedEntries.flatMap(entry => (
    typeof entry.slug === "string" ? [slugEquivalenceKey(entry.slug)] : []
  )));
  const freshEquivalent = (slug: string): boolean => (
    freshEquivalentKeys.has(slugEquivalenceKey(slug))
  );
  const freshBareComboAliases = new Set(admittedRoutedEntries.flatMap(entry => (
    typeof entry.slug === "string"
      && !entry.slug.includes("/")
      && entry.owned_by === COMBO_NAMESPACE
      ? [entry.slug]
      : []
  )));
  const staleComboKeys = new Set(detachedCatalogModels.flatMap(entry => (
    typeof entry.slug === "string"
      && entry.owned_by === COMBO_NAMESPACE
      && !freshEquivalent(entry.slug)
      ? [slugEquivalenceKey(entry.slug)]
      : []
  )));
  const currentNonComboKeys = new Set(detachedCatalogModels.flatMap(entry => (
    entry.owned_by !== COMBO_NAMESPACE && typeof entry.slug === "string"
      ? [slugEquivalenceKey(entry.slug)]
      : []
  )));
  const restoredComboShadows = detachedBaselineCatalogModels.filter(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug || entry.owned_by === COMBO_NAMESPACE) return false;
    const key = slugEquivalenceKey(slug);
    return staleComboKeys.has(key) && !currentNonComboKeys.has(key);
  });
  const catalogModelsForMerge = [...detachedCatalogModels, ...restoredComboShadows];
  const nativePriority = (slug: string, fallback: unknown): number => {
    const base = baseline.get(slug)
      ?? (typeof fallback === "number" ? fallback : 9);
    if (rank.has(slug)) return rank.get(slug)!;
    return featured.length > 0 ? Math.max(base, featured.length + 100) : base;
  };
  const nativeSourceEntries = includeNativeOpenAi
    ? catalogModelsForMerge
    .filter(m => typeof m.slug === "string"
      && !(m.slug as string).includes("/")
      && m.owned_by !== COMBO_NAMESPACE
      && (policy.unsupportedNativeEntries === "preserve"
        || policy.nativeBackfillSlugs.includes(m.slug as string)
        || !isUnsupportedOpenAiNativeSlug(m.slug as string)))
    .map(m => {
      const slug = m.slug as string;
      // Fallback-quality entries (ocx synthesis / codex-rs model_info fallback: display_name
      // stamped with the bare slug) are upgraded to the pinned upstream snapshot entry so a
      // previously synthesized ladder (e.g. luna advertising ultra) self-heals on sync. A
      // genuine catalog entry (real display name) is preserved untouched.
      if (shouldUpgradeToUpstreamEntry(m)) {
        const upstream = upstreamNativeEntry(slug)!;
        const finished = finishUpstreamNativeEntry(upstream, 9, openaiContextCap);
        finished.priority = nativePriority(slug, upstream.priority);
        return finished;
      }
      const preserved = normalizeServiceTiers({ ...m, priority: nativePriority(slug, m[SPAWN_PRIORITY_FIELD] ?? m.priority) });
      // Recompute spawn rank from current featured models, not a prior picker override.
      delete preserved[SPAWN_PRIORITY_FIELD];
      // Older natives kept from disk still need the mock top tiers (max + ultra always
      // for subagent max spawns; wire-clamped to the model's real top rung).
      if (!isGpt56NativeSlug(slug) && slug !== NATIVE_RESERVE_MODEL) ensureUltraReasoningLevel(preserved);
      return preserved;
    })
    : [];
  const native = nativeSourceEntries.filter(entry =>
    typeof entry.slug !== "string"
      || (!freshBareComboAliases.has(entry.slug) && !suppressedBareNativeSlugs.has(entry.slug))
  );

  // Backfill any native OpenAI slug that the on-disk catalog is missing (e.g. gpt-5.5), so a
  // routed provider exposing the same id can never delete the native OpenAI/Codex base row.
  // Skip when no enabled canonical openai provider exists (#636) — bare gpt-* would 404.
  const nativeSlugs = new Set(native.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
  if (includeNativeOpenAi) {
    for (const slug of policy.nativeBackfillSlugs) {
      if (nativeSlugs.has(slug) || freshBareComboAliases.has(slug) || suppressedBareNativeSlugs.has(slug)) continue;
      nativeSlugs.add(slug);
      const entry = deriveEntry(
        template ? JSON.parse(JSON.stringify(template)) : null,
        slug,
        "OpenAI native model (Codex OAuth passthrough).",
        nativePriority(slug, upstreamNativeEntry(slug)?.priority),
        undefined,
        new Set(),
        openaiContextCap,
      );
      entry.priority = nativePriority(slug, upstreamNativeEntry(slug)?.priority);
      native.push(entry);
    }
  }

  const nativeSourceBySlug = new Map([...nativeSourceEntries, ...native].flatMap(entry =>
    typeof entry.slug === "string" ? [[entry.slug, entry] as const] : []
  ));
  const alignedAccountBoundEntries = detachedAccountBoundEntries.map(entry => {
    // The explicit Reserve source is already chosen (actual row or documented Luna adaptation).
    // A generic native merge must not replace its provenance or capability ladder.
    if (isReserveCatalogProjection(entry)) return entry;
    const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const source = nativeSlug === undefined ? undefined : nativeSourceBySlug.get(nativeSlug);
    if (!source) return entry;
    const aligned = JSON.parse(JSON.stringify(source)) as RawEntry;
    aligned.slug = entry.slug;
    aligned.display_name = entry.display_name;
    aligned.priority = entry.priority;
    aligned.visibility = "list";
    aligned.opencodex_catalog_kind = CODEX_ACCOUNT_BOUND_CATALOG_KIND;
    return aligned;
  });

  const freshSlugs = new Set(
    admittedRoutedEntries.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []),
  );
  const existingRoutedEntries = catalogModelsForMerge.filter(m =>
    typeof m.slug === "string"
    && (m.slug.includes("/") || isNativeAliasCatalogEntry(m))
    && trustedAccountBoundNativeCatalogSlug(m) === undefined
  );
  const preservedRoutedEntries = existingRoutedEntries.filter(entry => {
    const slug = entry.slug as string;
    if (freshEquivalent(slug)) return false;
    if (isNativeAliasCatalogEntry(entry)) return exactComboSlugs.has(slug);
    // Current custom rows are always regenerated from config, even while provider discovery is
    // degraded. A marked row absent from the fresh projection is therefore an intentional delete.
    if (entry.opencodex_catalog_kind === CODEX_CUSTOM_MODEL_CATALOG_KIND) return false;
    // Before custom rows had a marker, a config deletion could otherwise be mistaken for a
    // provider outage. Only explicit save-boundary evidence may classify an unmarked OpenCodex
    // row; foreign and future-marked rows fail closed and remain preserved.
    if (entry.opencodex_catalog_kind === undefined
      && entry.owned_by !== COMBO_NAMESPACE
      && isOcxAuthoredRoutedEntry(entry)
      && legacyCustomModelKeys.has(slugEquivalenceKey(slug))) return false;
    const provider = slug.slice(0, slug.indexOf("/"));
    if (gatheredProviderNames.has(provider)) {
      // A provider-local degraded observation preserves only that namespace. Authoritative empty
      // catalogs and successful removals still delete stale rows even when another provider fails.
      return degradedProviderNames.has(provider);
    }
    // Deleted/disabled providers cannot retain OpenCodex-authored ghosts. Foreign catalog rows
    // remain outside provider ownership and survive unless a fresh row replaces their exact slug.
    return !isOcxAuthoredRoutedEntry(entry);
  });
  // Retained rows bypass the builder. Recompute managed spawn ranks from current config
  // before either display-order mode; a saved display override is not current roster authority.
  const pickerOrder = normalizeModelPickerOrder(modelPickerOrder);
  const fullPickerOrder = pickerOrder.some(slug => !slug.includes("/"));
  const rankOf = modelPickerRank(pickerOrder);
  const featuredRankOf = modelPickerRank(featured);
  const priorityStride = Math.max(accountSelectors.length, 1);
  for (const entry of preservedRoutedEntries) {
    const natural = entry[SPAWN_PRIORITY_FIELD];
    if (typeof natural === "number") {
      entry.priority = natural;
      delete entry[SPAWN_PRIORITY_FIELD];
    }
    const slug = String(entry.slug);
    if (!isOcxAuthoredRoutedEntry(entry) || isNativeAliasCatalogEntry(entry)) continue;
    const featuredRank = featuredRankOf(slug);
    entry.priority = featuredRank !== undefined
      ? featuredRank * priorityStride
      : (accountSelectors.length > 0 ? 1_000 : 0) + 5;
    if (featuredRank !== undefined || fullPickerOrder) continue;
    const pickerIndex = rankOf(slug);
    if (pickerIndex !== undefined) {
      entry[SPAWN_PRIORITY_FIELD] = entry.priority;
      entry.priority = PICKER_ORDER_PRIORITY_BASE + pickerIndex * priorityStride;
    }
  }
  let finalRoutedEntries = [...admittedRoutedEntries, ...preservedRoutedEntries];
  finalRoutedEntries = finalRoutedEntries.filter(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug.includes("/")) return true;
    if (disabledModelKeys.has(slugEquivalenceKey(slug))) return false;
    // Provider allowlists own provider rows, not a current combo's public alias. Exempt only an
    // identity from this gather's generated combo projection: provider discovery may supply a
    // spoofed `owned_by`, and persisted combo-shaped rows are not fresh authority.
    if (freshExactComboEntries.has(entry)) return true;
    const slash = slug.indexOf("/");
    const provider = slug.slice(0, slash);
    if (pendingProviderNames.has(provider)) return false;
    const selected = selectedModelKeysByProvider.get(provider);
    return selected === undefined || selected.has(slugEquivalenceKey(slug));
  });
  if (!hasPhysicalComboProvider) {
    finalRoutedEntries = finalRoutedEntries.filter(entry => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const comboOwned = slug.startsWith(`${COMBO_NAMESPACE}/`) || entry.owned_by === COMBO_NAMESPACE;
      const retainedNativeAlias = isNativeAliasCatalogEntry(entry) && exactComboSlugs.has(slug);
      return !comboOwned || freshSlugs.has(slug) || retainedNativeAlias;
    });
  }
  finalRoutedEntries = finalRoutedEntries.filter(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const retainedNativeAlias = isNativeAliasCatalogEntry(entry) && exactComboSlugs.has(slug);
    return retainedNativeAlias
      || !isExactComboCatalogEntry(entry, exactComboSlugs)
      || (Array.isArray(entry.input_modalities) && entry.input_modalities.length > 0);
  });
  // Reapply final catalog policy to rows preserved from disk. Those rows bypass
  // gatherRoutedModels, so filtering only the freshly gathered list can resurrect an excluded id.
  finalRoutedEntries = finalRoutedEntries.filter(entry =>
    typeof entry.slug !== "string" || !isRoutedModelCompatibilityExcluded(entry.slug)
  );
  const accountBoundSlugs = new Set(alignedAccountBoundEntries.flatMap(entry =>
    typeof entry.slug === "string" ? [entry.slug] : []
  ));
  finalRoutedEntries = finalRoutedEntries.filter(entry => {
    if (typeof entry.slug !== "string" || !accountBoundSlugs.has(entry.slug)) return true;
    if (freshSlugs.has(entry.slug) && policy.warningPolicy === "emit") {
      warnAccountSelectorShadowedProviderOnce(entry.slug);
    }
    return false;
  });
  const finalRoutedEntrySet = new Set(finalRoutedEntries);
  const degradedPreservedCount = preservedRoutedEntries.filter(entry => {
    if (!finalRoutedEntrySet.has(entry)) return false;
    const slug = entry.slug as string;
    const provider = slug.slice(0, slug.indexOf("/"));
    return gatheredProviderNames.has(provider) && degradedProviderNames.has(provider);
  }).length;
  if (degradedPreservedCount > 0 && policy.warningPolicy === "emit") {
    console.warn(`[opencodex] catalog sync: provider discovery degraded; preserving ${degradedPreservedCount} existing routed entr${degradedPreservedCount === 1 ? "y" : "ies"} on disk.`);
  }

  const managedEntries = [...finalRoutedEntries, ...alignedAccountBoundEntries];
  const observedNativeSlugs = new Set(alignedAccountBoundEntries.flatMap(entry => {
    const slug = trustedAccountBoundNativeCatalogSlug(entry);
    return slug === undefined ? [] : [slug];
  }));
  for (const slug of policy.nativeBackfillSlugs) observedNativeSlugs.add(slug);
  const mergedEntries = [...native, ...managedEntries].map(m => {
    const reserveProjection = isReserveCatalogProjection(m);
    const normalized = reserveProjection ? m : normalizeServiceTiers(m);
    if (!reserveProjection && !isNativeAliasCatalogEntry(normalized)) applyNativeOpenAiContextOverride(normalized, openaiContextCap);
    const exactCombo = isExactComboCatalogEntry(m, exactComboSlugs);
    const e = reserveProjection ? normalized : ensureStrictCatalogFields(normalized, {
      preserveExactInputModalities: exactCombo,
      isRouted: finalRoutedEntrySet.has(m),
    });
    // Mock-max universality (260709): preserved routed entries from disk may predate
    // the max rung — ensure it here so subagent max spawns validate on every
    // reasoning-capable entry. A suppressed preserved row that already contains max keeps it;
    // without persisted provenance, only a healthy provider rebuild can distinguish and remove
    // an older synthetic rung from a real provider-declared rung. max only: 5.6 exact ladders
    // (luna: no ultra) stay intact.
    if (!freshCustomEntries.has(m) && !exactCombo && !reserveProjection && !String(e.slug ?? "").startsWith("opencode-go/")) {
      const levels = Array.isArray(e.supported_reasoning_levels)
        ? e.supported_reasoning_levels as Array<{ effort?: string }>
        : [];
      if (levels.length > 0
        && !suppressedSyntheticMaxSlugs.has(String(e.slug ?? ""))
        && !levels.some(level => level.effort === "max")) {
        levels.push(CODEX_REASONING_LEVELS.find(level => level.effort === "max")
          ?? { effort: "max", description: "Maximum reasoning depth for the hardest problems" });
        e.supported_reasoning_levels = levels;
      }
      if (suppressedSyntheticMaxSlugs.has(String(e.slug ?? ""))
        && typeof e.default_reasoning_level === "string"
        && !levels.some(level => level.effort === e.default_reasoning_level)) {
        e.default_reasoning_level = clampedDefaultEffort(
          e.default_reasoning_level,
          levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []),
        );
      }
    }
    if (wsEnabled) e.supports_websockets = true;
    else {
      delete e.supports_websockets;
      // Match buildCatalogEntries: never advertise a websocket preference while WS is off.
      delete e.prefer_websockets;
    }
    return e;
  });
  // Native enable/disable runs as the LAST pass so the upstream-upgrade branch above can never
  // clobber a hide flag back to list. Bare ids disable every account clone; qualified ids disable
  // only their generated account row.
  const versionedEntries = applyMultiAgentMode(
    applyNativeVisibility(mergedEntries, disabledModels, alignedAccountBoundEntries.length > 0, observedNativeSlugs),
    multiAgentMode,
    multiAgentV2Enabled,
    { keepNativeChatGptOnV1, preserveDefaultMultiAgentVersion: isReserveCatalogProjection, nativeDefaults: nativeMultiAgentDefaults },
  );
  applyFullModelPickerOrder(versionedEntries, modelPickerOrder);
  for (const entry of versionedEntries) {
    // Templates and account clones must not inherit the native row's overlay marker.
    delete entry.opencodex_native_display_name;
    const slug = recoverableNativeSlug(entry);
    if (slug !== null) {
      const label = nativeDisplayNames && Object.hasOwn(nativeDisplayNames, slug)
        ? nativeDisplayNames[slug]?.trim() : undefined;
      if (label && label !== entry.display_name) {
        entry.opencodex_native_display_name = { slug, original: entry.display_name, applied: label };
        entry.display_name = label;
      }
    }
    const kind = entry.opencodex_catalog_kind;
    if (trustedAccountBoundNativeCatalogSlug(entry) === undefined
      && kind !== CODEX_CUSTOM_MODEL_CATALOG_KIND
      && kind !== CODEX_PROVIDER_MODEL_CATALOG_KIND) continue;
    // Canonicalize extension-field order after every normalizer. This keeps an unchanged catalog
    // byte-idempotent whether an owned row was freshly built or retained from the prior pass.
    delete entry.opencodex_catalog_kind;
    entry.opencodex_catalog_kind = kind;
  }
  return versionedEntries;
}

/** Merge retained-sync rows using the process-observed Codex feature state. */
export function mergeCatalogEntriesForSync(
  catalogModels: RawEntry[],
  routedEntries: RawEntry[],
  baseline: Map<string, number>,
  featured: string[],
  wsEnabled: boolean,
  _goIds: Set<string> = new Set(),
  template: RawEntry | null = null,
  disabledModels: ReadonlySet<string> = new Set(),
  gatheredProviderNames?: Set<string>,
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  hasPhysicalComboProvider = false,
  includeNativeOpenAi = true,
  accountBoundEntries: readonly RawEntry[] = [],
  legacyCustomModelSlugs: ReadonlySet<string> = new Set(),
  suppressedBareNativeSlugs: ReadonlySet<string> = new Set(
    routedEntries.flatMap(entry => (
      isNativeAliasCatalogEntry(entry) && typeof entry.slug === "string" ? [entry.slug] : []
    )),
  ),
  openaiContextCap?: NativeContextLimitsInput,
  keepNativeChatGptOnV1 = false,
  nativeMultiAgentDefaults?: ReadonlyMap<string, string | null>,
): RawEntry[] {
  // Retained for source compatibility with the original helper contract. Raw provider ids must
  // not suppress same-named native rows; actual admitted combo entries own that decision now.
  void _goIds;
  const effectiveGatheredProviderNames = gatheredProviderNames ?? new Set(
    routedEntries.flatMap(entry => {
      // A slashed combo alias is not evidence that its public prefix is an authoritative provider
      // namespace. Treating it as one would let the combo replace an unrestorable foreign row.
      if (isExactComboCatalogEntry(entry, exactComboSlugs)) return [];
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const slash = slug.indexOf("/");
      return slash > 0 ? [slug.slice(0, slash)] : [];
    }),
  );
  return mergeCatalogEntriesFromObservedState({
    catalogModels,
    baselineCatalogModels: [],
    routedEntries,
    baseline,
    featured,
    wsEnabled,
    template,
    disabledModels,
    selectedModelsByProvider: new Map(),
    gatheredProviderNames: effectiveGatheredProviderNames,
    degradedProviderNames: new Set(),
    legacyCustomModelSlugs,
    multiAgentMode,
    multiAgentV2Enabled: isMultiAgentV2Enabled(),
    keepNativeChatGptOnV1,
    exactComboSlugs,
    hasPhysicalComboProvider,
    includeNativeOpenAi,
    accountBoundEntries,
    suppressedBareNativeSlugs,
    openaiContextCap,
    nativeMultiAgentDefaults,
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      warningPolicy: "emit",
    },
  });
}
