import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { expandUserPath, loadConfig, readConfigDiagnostics, websocketsEnabled } from "../../config";
import { shouldSyncCodexOnStart } from "../desired-state";
import { legacyCustomModelCatalogSlugs } from "../custom-model-catalog-migration";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, getCodexHome, readRootTomlString, resolveCodexConfigPath } from "../paths";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals, slugEquivalenceKey, slugsEquivalent } from "../../providers/slug-codec";
import { identifyRoutedModel } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  listComboIds,
  targetKey,
} from "../../combos";
import type { NormalizedComboConfig } from "../../combos/types";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { redactSecretString } from "../../lib/redact";
import upstreamModelsSnapshot from "../data/upstream-models.json";
import { OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
import { providerCodexAccountMode } from "../../providers/registry";
import { codexAccountNamespaceEntries, isMainCodexAccountTarget } from "../account-namespaces";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import {
  availableAccountGatedNativeModels,
  isCodexModelEntitlementSnapshotCurrent,
  resolveCodexModelEntitlements,
  type CodexModelEntitlementSnapshot,
} from "../model-entitlements";


import { CODEX_CUSTOM_MODEL_CATALOG_KIND, CODEX_PROVIDER_MODEL_CATALOG_KIND, activeCodexModelsCachePath, applyCatalogMetadata, applyMultiAgentMode, applyNativeOpenAiContextOverride, applyRoutedCodexToolMode, catalogBackupPathFor, catalogHasRoutedEntries, catalogModelSlug, ensureStrictCatalogFields, findNativeTemplate, isDefaultCatalogPath, isRoutedModelCompatibilityExcluded, legacyCatalogBackupPath, normalizeRoutedCatalogEntry, normalizeServiceTiers, readCatalog, readCatalogBackup, readCodexCatalogPath, readCodexCatalogPathForHome, readConfiguredAutoReviewModel, readNativeBaseline } from "./parsing";
import type { CatalogModel, MultiAgentMode, RawCatalog, RawEntry } from "./parsing";
import { accountBoundNativeOpenAiSlugs, accountBoundNativeOpenAiSlugsBySelector, applyNativeVisibility, CODEX_NATIVE_ALIAS_CATALOG_KIND, desktopAllowlistSuppressedNativeSlugs, disabledNativeSlugs, isNativeAliasCatalogEntry, isUnsupportedOpenAiNativeSlug, NATIVE_OPENAI_MODELS, nativeContextLimits, observedAccountBoundNativeEntries, shouldIncludeAccountBoundNativeOpenAi, shouldIncludeNativeOpenAi, shouldUpgradeToUpstreamEntry, SUPPORTED_NATIVE_OPENAI_SLUGS, upstreamNativeEntry, type NativeContextLimitsInput } from "./metadata";
import {
  bundledCatalogCacheState,
  loadBundledCodexCatalog,
  resetBundledCatalogCacheForTests,
} from "./bundled";
import { isMultiAgentV2Enabled } from "../features";
import { applyCatalogModelMetadata, applyReasoningLevels, catalogEntryEfforts, clampCatalogModelsToCodexSupport, ensureGpt56ReasoningLevels, ensureUltraReasoningLevel, isGpt56NativeSlug } from "./effort";
import {
  clearGatherRoutedModelsInflight,
  filterCatalogVisibleModels,
  gatherRoutedModels,
  lastDropWarnSignature,
  type CatalogGatherProviderModelOutcome,
} from "./provider-fetch";
import { accountSelectorShadowCollisionWarnings, clearLastComboCatalogOmissions, comboCatalogWarningSignatures, comboMasqueradeCollisionWarnings, comboUnrestorableShadowWarnings, exactComboCatalogSlugs, openAiApiCollisionWarnings, resolveSlugAliasCollisions, slugAliasCollisionWarnings, warnAccountSelectorShadowedProviderOnce, warnComboMasqueradeCollisionOnce, warnComboUnrestorableShadowOnce } from "./aggregation";
import type { ComboCatalogOmission } from "./aggregation";
import {
  withCatalogWriteSerialization,
  type CatalogWritePermit,
} from "../catalog-write-serialization";
import {
  publishHashedCodexCatalogBackup,
  publishLegacyCodexCatalogBackup,
  replaceActiveCodexCatalog,
  replaceCodexModelsCache,
} from "../internal/catalog-writer";
import { codexRuntimeStatePath } from "../runtime";
import { accountBoundNativeDisplayName, CODEX_ACCOUNT_BOUND_CATALOG_KIND, trustedAccountBoundNativeCatalogSlug, visibleCodexAccountSelectors } from "./account-models";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "./native-models";

export const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5;

// Base for config.modelPickerOrder display priorities (#1649). modelPickerOrder is a DISPLAY-ONLY
// reordering of the Codex model picker: it rewrites a row's Codex-visible `priority` but never the
// spawn_agent candidate window. The window is derived from SPAWN_PRIORITY_FIELD (the natural
// priority captured before the override), so display order and spawn candidates are decoupled.
export const PICKER_ORDER_PRIORITY_BASE = 1_000;

// OpenCodex-private catalog field: the spawn_agent candidate priority a row would have WITHOUT
// modelPickerOrder. Codex ignores unknown catalog fields (same as opencodex_catalog_kind), so this
// is invisible to Codex; effectiveSubagentRoster reads it so a display reorder cannot change which
// rows are spawn_agent candidates. Absent on rows modelPickerOrder did not move.
export const SPAWN_PRIORITY_FIELD = "opencodex_spawn_priority";

export type SpawnAgentSurface = "v1" | "v2";

export type SubagentRosterExclusionReason =
  | "missing_catalog_entry"
  | "picker_hidden"
  | "surface_incompatible"
  | "outside_display_limit";

/**
 * Whether a catalog entry may be offered as a V2 subagent model.
 *
 * Upstream changed this rule in codex-rs `6d4d9442c` ("Support leaf models in
 * multi-agent v2"). `model_supports_multi_agent_backend`
 * (core/src/tools/handlers/multi_agents_common.rs:36-42) now admits EVERY model
 * except one explicitly marked `disabled`; the older `== Some(V2)` equality that
 * `92938d880` introduced is gone.
 *
 * The field no longer answers "may I be a delegation target". It answers "does the
 * CHILD get collaboration tools": `collab_tools_enabled`
 * (core/src/tools/spec_plan.rs:599-610) grants a child recursive tools only when its
 * own catalog value is exactly `Some(V2)`. The three-way distinction survives, but it
 * now means eligible-recursive / eligible-LEAF / excluded:
 *
 * - `"v2"`       -> eligible, and the child may itself delegate.
 * - `"v1"`       -> eligible LEAF worker. This is upstream's pin for `gpt-5.6-luna`
 *                   (models-manager/models.json); excluding it here is exactly what
 *                   kept Luna out of opencodex's roster.
 * - absent/null  -> eligible LEAF worker (routed or unpinned-native model).
 * - `"disabled"` -> the sole capability-based exclusion.
 *
 * This is the roster filter only. Catalog STAMPING is a separate concern owned by
 * `applyMultiAgentMode`, including the `keepNativeChatGptOnV1` policy (#1728) that
 * keeps ChatGPT-native rows on `v1` so a native parent can still spawn a routed child
 * despite backend-encrypted NEW_TASK bodies (#92). Recognizing those `v1` rows as
 * eligible leaves here is what makes that policy usable, not a contradiction of it.
 *
 * Devlog: 260816_codexrs_multiagent_v2_and_history_perf/011 (C1), superseding the
 * option-B decision in 260730_codex_rs_upstream_v2_live_handoff/060.
 */
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  return entry.multi_agent_version !== "disabled";
}

export interface EffectiveSubagentModel {
  model: string;
  efforts: string[];
}

export interface SubagentRosterExclusion {
  configured: string;
  reason: SubagentRosterExclusionReason;
  catalogModel?: string;
}

export interface EffectiveSubagentRoster {
  candidates: EffectiveSubagentModel[];
  advertised: EffectiveSubagentModel[];
  excluded: SubagentRosterExclusion[];
}

export function configuredCatalogEntry(entries: readonly RawEntry[], configured: string): RawEntry | undefined {
  return entries.find(entry => entry.slug === configured)
    ?? entries.find(entry => typeof entry.slug === "string" && slugsEquivalent(configured, entry.slug));
}

function configuredSubagentModelMatchesEntry(configured: string, entry: RawEntry): boolean {
  if (typeof entry.slug !== "string") return false;
  if (slugsEquivalent(configured, entry.slug)) return true;
  const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
  return !configured.includes("/")
    && nativeSlug !== undefined
    && SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)
    && slugsEquivalent(configured, nativeSlug);
}

export function effectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
  catalogEntries?: readonly RawEntry[],
): EffectiveSubagentRoster {
  const configured = configuredModels
    .filter(model => model.trim().length > 0)
    .filter((model, index, all) =>
      !all.slice(0, index).some(previous => slugsEquivalent(previous, model))
    );
  const entries = catalogEntries ?? readCatalog(readCodexCatalogPath())?.models ?? [];
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.slug === "string")
    .filter(({ entry }) => entry.visibility === "list")
    .filter(({ entry }) => surface !== "v2" || isEligibleV2SubagentEntry(entry))
    .sort((left, right) => {
      // Spawn candidates rank by the natural priority (SPAWN_PRIORITY_FIELD when present), so a
      // modelPickerOrder display reorder (#1649) can never change candidate membership. Rows the
      // override did not move fall back to their Codex-visible `priority`.
      const spawnPriorityOf = (entry: RawEntry): number => {
        const spawn = entry[SPAWN_PRIORITY_FIELD];
        if (typeof spawn === "number" && Number.isFinite(spawn)) return spawn;
        return typeof entry.priority === "number" && Number.isFinite(entry.priority)
          ? entry.priority : Number.MAX_SAFE_INTEGER;
      };
      const leftPriority = spawnPriorityOf(left.entry);
      const rightPriority = spawnPriorityOf(right.entry);
      return leftPriority - rightPriority || left.index - right.index;
    })
    .slice(0, MAX_SPAWN_AGENT_MODEL_OVERRIDES);
  const orderedEntries = new Set(ordered.map(({ entry }) => entry));

  const candidates = ordered.map(({ entry }) => ({
    model: entry.slug as string,
    efforts: catalogEntryEfforts(entry),
  }));
  const advertised = ordered
    .filter(({ entry }) => configured.some(model => configuredSubagentModelMatchesEntry(model, entry)))
    .map(({ entry }) => ({
      model: entry.slug as string,
      efforts: catalogEntryEfforts(entry),
    }));
  const excluded = configured.flatMap((model): SubagentRosterExclusion[] => {
    const matchingEntries = entries.filter(entry => configuredSubagentModelMatchesEntry(model, entry));
    if (matchingEntries.some(entry => orderedEntries.has(entry))) return [];
    if (matchingEntries.length === 0) return [{ configured: model, reason: "missing_catalog_entry" }];
    const visibleCompatible = matchingEntries.find(entry =>
      entry.visibility === "list"
      && (surface !== "v2" || isEligibleV2SubagentEntry(entry))
    );
    if (visibleCompatible) {
      return [{
        configured: model,
        catalogModel: visibleCompatible.slug as string,
        reason: "outside_display_limit",
      }];
    }
    const visible = matchingEntries.find(entry => entry.visibility === "list");
    if (visible) {
      return [{
        configured: model,
        catalogModel: visible.slug as string,
        reason: "surface_incompatible",
      }];
    }
    const hidden = configuredCatalogEntry(entries, model) ?? matchingEntries[0]!;
    return [{ configured: model, catalogModel: hidden.slug as string, reason: "picker_hidden" }];
  });
  return { candidates, advertised, excluded };
}

export function finishUpstreamNativeEntry(clone: RawEntry, priority: number, contextCap?: NativeContextLimitsInput): RawEntry {
  if (priority !== 9) clone.priority = priority;
  applyNativeOpenAiContextOverride(clone, contextCap);
  // GPT-5.6 natives keep their exact upstream ladders (e.g. luna has max but no ultra).
  // Older natives (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex-spark) get mock max + ultra
  // (wire-clamped to xhigh). Ultra is always advertised regardless of v2 toggle.
  if (!isGpt56NativeSlug(String(clone.slug ?? ""))) ensureUltraReasoningLevel(clone);
  return ensureStrictCatalogFields(normalizeServiceTiers(clone));
}

export function isExactComboCatalogModel(
  model: CatalogModel | undefined,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return model?.provider === COMBO_NAMESPACE && exactComboSlugs.has(catalogModelSlug(model));
}

function isExactComboCatalogEntry(
  entry: RawEntry,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return entry.owned_by === COMBO_NAMESPACE
    && typeof entry.slug === "string"
    && exactComboSlugs.has(entry.slug);
}

/**
 * Friendly Codex-picker label for a routed `provider/model` slug. Command Code's two config
 * ids differ by a single dash (`command-code` vs `commandcode`), so relabel them to the
 * lowercase-dash style the opencode presets use: `commandcode-auth/x` and `commandcode-api/x`.
 * The model-id portion also carries a redundant `<vendor>-` prefix (`deepseek-deepseek-v4-flash`)
 * that is dropped for display. All other providers keep the raw slug exactly as before.
 */
function routedDisplayName(slug: string): string {
  const slash = slug.indexOf("/");
  if (slash <= 0) return slug;
  const provider = slug.slice(0, slash);
  let model = slug.slice(slash + 1);
  if (provider === "command-code" || provider === "commandcode") {
    const m = model.match(/^([a-z0-9]+)-([a-z0-9]+(?:-[a-z0-9]+)+)$/i);
    if (m && model.startsWith(`${m[1]}-${m[1]}-`)) model = model.slice(m[1]!.length + 1);
    return `${provider === "command-code" ? "commandcode-auth" : "commandcode-api"}/${model}`;
  }
  return slug;
}

export function deriveEntry(
  template: RawEntry | null,
  slug: string,
  desc: string,
  priority: number,
  model?: CatalogModel,
  exactComboSlugs: ReadonlySet<string> = new Set(),
  contextCap?: NativeContextLimitsInput,
): RawEntry {
  const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
  const codexForwardNativeCapabilityAlias = model?.codexForwardNativeCapabilityAlias === true
    ? upstreamNativeEntry(model.id)
    : null;
  const isRouted = model !== undefined;
  if (!isRouted && !slug.includes("/")) {
    // Supported native slug covered by the upstream snapshot: use the REAL entry (exact
    // reasoning ladder — e.g. luna has no ultra — default effort, identity, model_messages)
    // instead of cloning an older template.
    const upstream = upstreamNativeEntry(slug);
    if (upstream) return finishUpstreamNativeEntry(upstream, priority, contextCap);
  }
  if (template || codexForwardNativeCapabilityAlias) {
    const e = JSON.parse(JSON.stringify(codexForwardNativeCapabilityAlias ?? template)) as RawEntry;
    e.slug = slug;
    e.display_name = routedDisplayName(slug);
    e.description = desc;
    e.priority = priority;
    e.visibility = "list";
    if ("upgrade" in e) e.upgrade = null;
    delete e.availability_nux; // don't replay another model's "now available" NUX
    // Routed (namespaced) models inherit the gpt template — correct its OpenAI/GPT identity
    // and advertise the reasoning ladder Codex accepts.
    if (isRouted) {
      // A routed model is NOT the native template: never inherit its context
      // window when /models omits context metadata (#992). Known metadata
      // restores exact values below; an enabled Context cap fills the gap;
      // otherwise the strict-fields fallback supplies the 128k triple.
      if (!codexForwardNativeCapabilityAlias) {
        delete e.context_window;
        delete e.max_context_window;
        delete e.auto_compact_token_limit;
      }
      // Native id for identity text + metadata lookups — the slug may be an encoded
      // alias (`provider/vendor-model`); the model object carries the native id.
      const modelName = model?.id ?? slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        // Proxy-neutral: keep the GPT-5/OpenAI disclaimer but never advertise the opencodex proxy
        // (leaking that into base_instructions is a non-first-party signature → ToS risk).
        e.base_instructions = identifyRoutedModel(e.base_instructions, modelName);
      }
      applyReasoningLevels(
        e,
        model?.reasoningEfforts,
        model?.defaultReasoningEffort,
        preserveExact || codexForwardNativeCapabilityAlias !== null,
      );
      // This exact provider/model pair is the ChatGPT/Codex forward surface. Keep the pinned
      // native tool/search/responses-lite contract while preserving the routed slug and wire id.
      if (!codexForwardNativeCapabilityAlias) {
        normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true, model?.codexToolMode);
      } else if (model?.codexToolMode !== undefined) {
        applyRoutedCodexToolMode(e, model.codexToolMode);
      }
      if (model) applyCatalogMetadata(e, model.provider, model.id, model.contextCap);
      applyCatalogModelMetadata(e, model);
      if (model?.catalogKind) e.opencodex_catalog_kind = model.catalogKind;
    } else {
      applyNativeOpenAiContextOverride(e, contextCap);
      if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(e);
      else ensureUltraReasoningLevel(e);
     // Non-5.6 natives (5.5, 5.4, 5.4-mini, spark) do not support responses-lite;
     // the template may carry the flag from a 5.6 entry — strip it so codex-rs does
     // not inject reasoning.context: "all_turns" for models that reject it.
     if (!isGpt56NativeSlug(slug)) {
        // Spark NEEDS use_responses_lite: true — it controls the tool delivery format
        // (AdditionalTools in input vs top-level tools). The reasoning params that
        // use_responses_lite triggers (context: "all_turns", summary) are stripped
        // separately in the passthrough adapter (stripUnsupportedReasoningParams).
        if (!slug.includes("codex-spark")) delete e.use_responses_lite;
        delete e.supports_websockets;
      }
    }
    return ensureStrictCatalogFields(normalizeServiceTiers(e), {
      preserveExactInputModalities: preserveExact,
      isRouted,
    });
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  // Routed fallbacks default to code-mode tool exposure (or shell mode when codexToolMode === "shell");
  // otherwise the nested catalog expands into `exec.description` and can exceed Cursor's 120 KB serialized tool limit (#1830).
  // Cursor still omits hosted web-search metadata because runTurn bypasses that separate sidecar.
  const isCursorFallback = isRouted && model?.provider === "cursor";
  const entry: RawEntry = {
    slug, display_name: routedDisplayName(slug), description: desc,
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
    ...(isRouted
      ? isCursorFallback
        ? { supports_search_tool: true }
        : { web_search_tool_type: "text_and_image", supports_search_tool: true }
      : {}),
  };
  if (isRouted) {
    applyRoutedCodexToolMode(entry, model?.codexToolMode);
    applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
  }
  else {
    applyReasoningLevels(entry, isGpt56NativeSlug(slug) ? undefined : ["low", "medium", "high", "xhigh"]);
    if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(entry);
  }
  if (model && isRouted) applyCatalogMetadata(entry, model.provider, model.id, model.contextCap);
  applyCatalogModelMetadata(entry, model);
  if (model?.catalogKind) entry.opencodex_catalog_kind = model.catalogKind;
  if (!isRouted) applyNativeOpenAiContextOverride(entry, contextCap);
  return ensureStrictCatalogFields(normalizeServiceTiers(entry), {
    preserveExactInputModalities: preserveExact,
    isRouted,
  });
}

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
): RawEntry[] {
  return buildCatalogEntriesFromObservedState({
    template,
    gptSlugs,
    goModels,
    featured,
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
  // this display reorder cannot change which rows are spawn candidates.
  const pickerOrder = Array.isArray(modelPickerOrder)
    ? modelPickerOrder.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const pickerOrderRank = new Map(pickerOrder.map((slug, i) => [slug, i] as const));
  const pickerOrderActive = pickerOrder.length > 0;
  // The display band reuses the existing high priority tier (>= PICKER_ORDER_PRIORITY_BASE, the
  // same 1_000+ neighborhood account rows occupy), keeping listed rows visually after the featured
  // band. Candidate membership does not depend on this — see SPAWN_PRIORITY_FIELD.
  /**
   * Priority for a non-featured routed row that is explicitly LISTED in modelPickerOrder. Listed
   * slugs sort in declared order within the high picker-order display tier
   * (>= PICKER_ORDER_PRIORITY_BASE). This sets the Codex-visible `priority` only; the caller records
   * the row's natural priority in SPAWN_PRIORITY_FIELD so the spawn_agent candidate window is
   * unchanged. Returns undefined when the feature is off or the row is not listed, so those rows
   * keep their original assignment (default 5 / account 1_000+) untouched.
   *
   * Scope: only the generic routed `<provider>/<model>` rows call this (see the goModels loop
   * below). Native passthrough rows and account-qualified native rows keep their own priority
   * logic and are intentionally not reordered here — this matches the documented contract on
   * OcxConfig.modelPickerOrder (route native ordering through subagentModels instead).
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
    const accountNativeEntries = selectorNativeSlugs.map(slug => (
      nativeEntriesBySlug.get(slug)
        ?? deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9, undefined, new Set(), openaiContextCap)
    ));
    for (const [nativeIndex, native] of accountNativeEntries.entries()) {
      const nativeSlug = String(native.slug);
      if (disabledNativeAccountSlugs.has(nativeSlug)) continue;
      const e = JSON.parse(JSON.stringify(native)) as RawEntry;
      const catalogSlug = `${selector}/${nativeSlug}`;
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
    // #1649: modelPickerOrder is a DISPLAY-ONLY override. Record the natural priority spawn_agent
    // must keep using, then let modelPickerOrder move only the Codex-visible `priority`. Featured
    // rows are never overridden (their rank is authoritative for both display and spawn).
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

export interface ObservedCatalogMergeInput {
  readonly catalogModels: readonly RawEntry[];
  readonly baselineCatalogModels: readonly RawEntry[];
  readonly routedEntries: readonly RawEntry[];
  readonly baseline: ReadonlyMap<string, number>;
  readonly featured: readonly string[];
  readonly wsEnabled: boolean;
  readonly template: RawEntry | null;
  readonly disabledModels: ReadonlySet<string>;
  readonly selectedModelsByProvider: ReadonlyMap<string, ReadonlySet<string>>;
  readonly gatheredProviderNames: ReadonlySet<string>;
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
  readonly policy: ObservedCatalogMergePolicy;
  readonly openaiContextCap?: NativeContextLimitsInput;
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
  wsEnabled,
  template,
  disabledModels,
  selectedModelsByProvider,
  gatheredProviderNames,
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
  policy,
  openaiContextCap,
}: ObservedCatalogMergeInput): RawEntry[] {
  // Raw catalog rows contain nested arrays/objects that normalization mutates. Detach every row at
  // the observed-core boundary so callers can safely retain evidence objects or repeat the merge.
  const detachedCatalogModels = catalogModels.map(entry => structuredClone(entry) as RawEntry);
  const detachedBaselineCatalogModels = baselineCatalogModels
    .map(entry => structuredClone(entry) as RawEntry);
  const detachedRoutedEntries = routedEntries.map(entry => structuredClone(entry) as RawEntry);
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
      const preserved = normalizeServiceTiers({ ...m, priority: nativePriority(slug, m.priority) });
      // Older natives kept from disk still need the mock top tiers (max + ultra always
      // for subagent max spawns; wire-clamped to the model's real top rung).
      if (!isGpt56NativeSlug(slug)) ensureUltraReasoningLevel(preserved);
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
    const normalized = normalizeServiceTiers(m);
    if (!isNativeAliasCatalogEntry(normalized)) applyNativeOpenAiContextOverride(normalized, openaiContextCap);
    const exactCombo = isExactComboCatalogEntry(m, exactComboSlugs);
    const e = ensureStrictCatalogFields(normalized, {
      preserveExactInputModalities: exactCombo,
      isRouted: finalRoutedEntrySet.has(m),
    });
    // Mock-max universality (260709): preserved routed entries from disk may predate
    // the max rung — ensure it here so subagent max spawns validate on every
    // reasoning-capable entry. max only: 5.6 exact ladders (luna: no ultra) stay intact.
    if (!exactCombo) {
      const levels = Array.isArray(e.supported_reasoning_levels)
        ? e.supported_reasoning_levels as Array<{ effort?: string }>
        : [];
      if (levels.length > 0 && !levels.some(level => level.effort === "max")) {
        levels.push(CODEX_REASONING_LEVELS.find(level => level.effort === "max")
          ?? { effort: "max", description: "Maximum reasoning depth for the hardest problems" });
        e.supported_reasoning_levels = levels;
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
    { keepNativeChatGptOnV1 },
  );
  for (const entry of versionedEntries) {
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
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      warningPolicy: "emit",
    },
  });
}

interface RetainedCatalogSyncRead {
  readonly catalogPath: string;
  readonly catalog: RawCatalog;
  readonly onDiskCatalog: RawCatalog | null;
  readonly modelsCache: RawCatalog | null;
  readonly evidence: string;
  /**
   * Process-local epochs, baselined AFTER our own gather rather than with the
   * filesystem bytes above. See `retainedCatalogProcessEvidence`.
   */
  readonly processEvidence: string;
}

interface RetainedCatalogSyncResult {
  added: number;
  path: string;
  catalogWritten: boolean;
  comboOmissions: ComboCatalogOmission[];
  /** `desired_disabled` observed under K after the provider await; nothing was written. */
  skippedReason?: "desired_disabled";
}

/**
 * Catalog/cache commit overrides.
 *
 * An explicit `ocx sync` is also the refresh path for side profiles that consume
 * the OpenCodex catalog without injection (for example a custom `model_provider`
 * that routes to the proxy). In that mode the Codex integration toggle only
 * governs config/history injection; the catalog and models cache may still be
 * refreshed, so `allowWhenDesiredDisabled` lets the commit path ignore the OFF
 * gate that otherwise protects a fully native home.
 */
export interface CodexCatalogSyncOptions {
  allowWhenDesiredDisabled?: boolean;
}

interface RetainedCatalogSyncWrite {
  readonly config: OcxConfig;
  readonly goModels: CatalogModel[];
  readonly providerModelOutcomes: readonly CatalogGatherProviderModelOutcome[];
  readonly comboOmissions: ComboCatalogOmission[];
  readonly read: RetainedCatalogSyncRead;
  readonly permit: CatalogWritePermit;
  readonly owningCodexHome: string;
  readonly modelEntitlements: CodexModelEntitlementSnapshot;
}

function optionalFileBytes(path: string): string | null {
  try {
    return readFileSync(path).toString("base64");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
}

function loadCatalogForRetainedSync(path: string): RawCatalog | null {
  const bundled = isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null;
  if (bundled) return JSON.parse(JSON.stringify(bundled)) as RawCatalog;
  const active = readCatalog(path);
  // A valid configured custom file remains the content authority even when it has no bare native
  // template. The null-template builder is deliberate; a stale backup must not replace active
  // custom root metadata merely because the current file contains only routed rows.
  if (active && (!isDefaultCatalogPath(path) || findNativeTemplate(active))) return active;
  return readCatalog(catalogBackupPathFor(path))
    ?? (isDefaultCatalogPath(path) ? readCatalog(legacyCatalogBackupPath()) : null)
    ?? readCatalog(activeCodexModelsCachePath())
    ?? active;
}

function retainedCatalogSyncEvidence(
  config: OcxConfig,
  catalogPath: string,
  catalog: RawCatalog,
): string {
  return JSON.stringify({
    config,
    catalogPath,
    catalog,
    catalogBytes: optionalFileBytes(catalogPath),
    hashedBackupBytes: optionalFileBytes(catalogBackupPathFor(catalogPath)),
    legacyBackupBytes: isDefaultCatalogPath(catalogPath)
      ? optionalFileBytes(legacyCatalogBackupPath()) : null,
    modelsCacheBytes: optionalFileBytes(activeCodexModelsCachePath()),
    // The persisted runtime selection is a pre-await filesystem input, not a
    // process epoch: another PROCESS can move runtime authority by rewriting this
    // file, and that move is invisible to our in-process memo. Recorded PRESENT or
    // ABSENT, because its absence is what makes the resolver fall back.
    runtimeStateBytes: optionalFileBytes(codexRuntimeStatePath()),
  });
}

/**
 * The bundled-template half of the same evidence, observed separately.
 *
 * The runtime process memo is deliberately NOT here, and that exclusion took three
 * attempts to get honest. Gathering resolves the Codex runtime lazily and under its
 * own cache key, so this path cannot pre-settle that memo: baselining it before the
 * await always detected our own side effect and refused every write, and baselining
 * it after the await captured a runtime that ANOTHER process had moved as though it
 * were ours — a catalog prepared from R1 committing after authority reached R2.
 *
 * Runtime authority is covered where it is actually durable instead: the persisted
 * `codex-runtime.json` bytes sit in the pre-await filesystem evidence, PRESENT or
 * ABSENT, so a cross-process runtime move is caught. What is left uncovered, and is
 * written down rather than papered over, is a same-process in-memory runtime swap
 * that never touches that file — WP11 owns the lock that makes that case decidable.
 */
function retainedCatalogProcessEvidence(): string {
  return JSON.stringify({
    bundledCatalogCache: bundledCatalogCacheState(),
  });
}

/**
 * Capture every local catalog input the retained sync path consults before its
 * provider await. The exact evidence is compared after K acquisition; a newer
 * catalog/backup/cache or target selection makes this attempt a no-write.
 */
function readRetainedCatalogSync(config: OcxConfig): RetainedCatalogSyncRead | null {
  const catalogPath = readCodexCatalogPath();
  const catalog = loadCatalogForRetainedSync(catalogPath);
  if (!catalog) return null;

  // The bundled catalog is a reliable native template on the default path, but it is not the
  // merge source. Preservation must inspect the file that this sync is about to overwrite;
  // otherwise an empty/partial provider gather cannot see routed or user-native rows on disk.
  const onDiskCatalog = readCatalog(catalogPath);
  const modelsCache = readCatalog(activeCodexModelsCachePath());
  const evidence = retainedCatalogSyncEvidence(config, catalogPath, catalog);
  // `processEvidence` is filled in after the provider await, not here.
  return { catalogPath, catalog, onDiskCatalog, modelsCache, evidence, processEvidence: "" };
}

function revalidateRetainedCatalogSync(
  config: OcxConfig,
  prepared: RetainedCatalogSyncRead,
): RetainedCatalogSyncRead | null {
  const catalogPath = readCodexCatalogPath();
  if (catalogPath !== prepared.catalogPath) return null;
  const evidence = retainedCatalogSyncEvidence(config, catalogPath, prepared.catalog);
  if (evidence !== prepared.evidence) return null;
  if (retainedCatalogProcessEvidence() !== prepared.processEvidence) return null;
  return {
    catalogPath,
    catalog: JSON.parse(JSON.stringify(prepared.catalog)) as RawCatalog,
    onDiskCatalog: readCatalog(catalogPath),
    modelsCache: readCatalog(activeCodexModelsCachePath()),
    evidence,
    processEvidence: prepared.processEvidence,
  };
}

/**
 * Exact bytes currently on disk at `path`, or null when unreadable/absent.
 *
 * Deliberately a Buffer rather than a decoded string: `readFileSync(path, "utf8")`
 * substitutes U+FFFD for every invalid byte, so a file holding a raw 0x80 decodes
 * equal to prepared content holding a legitimately encoded U+FFFD. Comparing the
 * decoded strings would then classify a malformed catalog as identical, skip the
 * atomic repair write, and leave the corruption on disk while reporting
 * `catalogWritten: false`.
 */
function currentCatalogFileContent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function pristineCatalogBytes(read: RetainedCatalogSyncRead): string | null {
  if (read.onDiskCatalog && !catalogHasRoutedEntries(read.onDiskCatalog)) {
    try {
      return readFileSync(read.catalogPath, "utf8");
    } catch {
      return null;
    }
  }
  return catalogHasRoutedEntries(read.catalog)
    ? null
    : `${JSON.stringify(read.catalog, null, 2)}\n`;
}

function catalogModelsForMergeWithNativeRecovery(
  catalogPath: string,
  catalog: RawCatalog,
  onDiskCatalog: RawCatalog | null,
): RawEntry[] {
  const primaryCatalogModels = onDiskCatalog?.models ?? catalog.models ?? [];
  // Native-alias compatibility can omit disabled native rows from the effective catalog because
  // Desktop's remote allowlist ignores `visibility: "hide"`. Keep current/pristine native recovery
  // sources beside the on-disk rows so re-enabling a model restores its real metadata. Routed and
  // user-authored rows still come only from the on-disk catalog.
  return mergeCatalogModelsWithNativeRecovery(primaryCatalogModels, [
    catalog.models ?? [],
    readCatalogBackup(catalogPath)?.models ?? [],
  ]);
}

const AUTO_REVIEW_MODEL_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]/;

export function isValidAutoReviewModel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return Boolean(trimmed)
    && trimmed.length <= 1024
    && !AUTO_REVIEW_MODEL_CONTROL_CHARS.test(trimmed);
}

export type AutoReviewModelOverrideResult = "absent" | "applied" | "invalid" | "unresolved";

function isRoutedCatalogEntry(entry: RawEntry): boolean {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return slug.includes("/")
    || (typeof entry.description === "string" && entry.description.startsWith("Routed via opencodex → "));
}

function clearAutoReviewModelOverride(
  models: readonly RawEntry[],
  sourceModels: readonly RawEntry[] = [],
): void {
  const observedModels = [...models, ...sourceModels];
  const configuredValues = new Set(observedModels.flatMap(entry => {
    const value = entry?.auto_review_model_override;
    return typeof value === "string" && value.trim() ? [value] : [];
  }));
  const globalStamp = configuredValues.size === 1
    && observedModels.some(entry => {
      const value = entry.auto_review_model_override;
      return isRoutedCatalogEntry(entry)
        && typeof value === "string"
        && value.trim().length > 0
        && configuredValues.has(value);
    })
    && observedModels.every(entry => {
      const value = entry?.auto_review_model_override;
      return value === null
        || value === undefined
        || (typeof value === "string" && configuredValues.has(value));
    });
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const current = entry.auto_review_model_override;
    if (isRoutedCatalogEntry(entry)
      || (globalStamp && typeof current === "string" && configuredValues.has(current))) {
      entry.auto_review_model_override = null;
    }
  }
}

function warnAutoReviewModelDiagnostic(
  reason: "invalid" | "unresolved",
  configured: string,
): void {
  const safeConfigured = JSON.stringify(redactSecretString(configured));
  const detail = reason === "unresolved"
    ? "the selector was not found in the final catalog"
    : "the selector format is invalid";
  console.warn(
    `[opencodex] auto_review_model ${detail} (${safeConfigured}); preserving normal upstream auto-review behavior.`,
  );
}

function preserveNativeAutoReviewModelOverrides(
  models: readonly RawEntry[],
  sourceModels: readonly RawEntry[],
): void {
  const existing = new Map<string, string | null>();
  for (const entry of sourceModels) {
    const slug = typeof entry.slug === "string" ? entry.slug : undefined;
    const value = entry.auto_review_model_override;
    if (!slug || isRoutedCatalogEntry(entry)) continue;
    if (typeof value === "string" || value === null) existing.set(slug, value);
  }
  for (const entry of models) {
    const slug = typeof entry.slug === "string" ? entry.slug : undefined;
    if (!slug || isRoutedCatalogEntry(entry) || !existing.has(slug)) continue;
    entry.auto_review_model_override = existing.get(slug) ?? null;
  }
}

export function applyAutoReviewModelOverride(
  models: RawEntry[] | undefined,
  autoReviewModel: string | null | undefined,
  sourceModels: readonly RawEntry[] = [],
): AutoReviewModelOverrideResult {
  if (!models || !Array.isArray(models)) return "absent";
  if (autoReviewModel === null || autoReviewModel === undefined) {
    clearAutoReviewModelOverride(models, sourceModels);
    return "absent";
  }
  const trimmed = autoReviewModel.trim();
  if (!trimmed) {
    clearAutoReviewModelOverride(models, sourceModels);
    return "absent";
  }
  if (!isValidAutoReviewModel(trimmed)) {
    clearAutoReviewModelOverride(models, sourceModels);
    warnAutoReviewModelDiagnostic("invalid", trimmed);
    return "invalid";
  }
  if (!configuredCatalogEntry(models, trimmed)) {
    clearAutoReviewModelOverride(models, sourceModels);
    warnAutoReviewModelDiagnostic("unresolved", trimmed);
    return "unresolved";
  }
  for (const entry of models) {
    if (entry && typeof entry === "object") {
      entry.auto_review_model_override = trimmed;
    }
  }
  return "applied";
}

/** Apply the root Codex auto-review selector after the final catalog merge. */
export function finalizeAutoReviewModelOverride(
  models: RawEntry[] | undefined,
  sourceModels: readonly RawEntry[] = [],
): AutoReviewModelOverrideResult {
  if (models && sourceModels.length > 0) preserveNativeAutoReviewModelOverrides(models, sourceModels);
  return applyAutoReviewModelOverride(models, readConfiguredAutoReviewModel(), sourceModels);
}

function writeRetainedCatalogSync({
  config,
  goModels,
  providerModelOutcomes,
  comboOmissions,
  read,
  permit,
  owningCodexHome,
  modelEntitlements,
}: RetainedCatalogSyncWrite): RetainedCatalogSyncResult {
  const { catalogPath, catalog, onDiskCatalog } = read;
  const catalogModelsForMerge = catalogModelsForMergeWithNativeRecovery(
    catalogPath,
    catalog,
    onDiskCatalog,
  );
  const template = findNativeTemplate(catalog);

  try {
    // Once-only: preserve the PRISTINE pre-opencodex catalog as the native-priority baseline
    // (later syncs would otherwise overwrite it with featured-modified priorities).
    const pristine = pristineCatalogBytes(read);
    if (pristine !== null) {
      publishHashedCodexCatalogBackup(permit, owningCodexHome, {
        path: catalogBackupPathFor(catalogPath),
        content: pristine,
      });
      if (isDefaultCatalogPath(catalogPath)) {
        publishLegacyCodexCatalogBackup(permit, owningCodexHome, {
          path: legacyCatalogBackupPath(),
          content: pristine,
        });
      }
    }
  } catch { /* backup best-effort */ }

  // Hide disabled models from Codex, then feature the chosen subagent models (native OR routed)
  // by giving them the lowest priority — see buildCatalogEntries for why priority, not array order.
  const enabledGo = filterCatalogVisibleModels(goModels, config);
  const featured = config.subagentModels ?? [];
  const orderedGoModels = orderForSubagents(enabledGo, featured); // stable tie-break among equal priorities
  const modelPickerOrder = config.modelPickerOrder ?? [];
  const multiAgentMode: MultiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const bareEligibleAccountIds = providerCodexAccountMode(
    OPENAI_CODEX_PROVIDER_ID,
    config.providers[OPENAI_CODEX_PROVIDER_ID],
  ) === "direct" ? new Set([MAIN_CODEX_ACCOUNT_ID]) : undefined;
  const availableBareGatedNativeSlugs = availableAccountGatedNativeModels(
    modelEntitlements,
    bareEligibleAccountIds,
  );
  const availableAccountGatedNativeSlugs = availableAccountGatedNativeModels(modelEntitlements);
  const availableBareNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableBareGatedNativeSlugs.has(slug)
  ));
  const availableAccountNativeSlugs = NATIVE_OPENAI_MODELS.filter(slug => (
    !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || availableAccountGatedNativeSlugs.has(slug)
  ));
  const unavailableGatedNativeSlugs = new Set([...ACCOUNT_GATED_NATIVE_OPENAI_MODELS].filter(slug => (
    !availableBareGatedNativeSlugs.has(slug)
  )));
  const suppressedBareNativeSlugs = new Set([
    ...desktopAllowlistSuppressedNativeSlugs(config),
    ...unavailableGatedNativeSlugs,
  ]);
  const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
  const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
  const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
  // Both user levers. Passing only the cap here is what let a per-model window the dashboard
  // had accepted get written back at full width in the on-disk catalog.
  const openaiContextCap = nativeContextLimits(config);
  const accountSelectors = includeAccountBoundNativeOpenAi
    ? visibleCodexAccountSelectors(config)
    : [];
  const observedAccountNativeEntries = [
    ...(read.modelsCache?.models ?? []),
    ...(onDiskCatalog?.models ?? []).filter(entry =>
      trustedAccountBoundNativeCatalogSlug(entry) !== undefined),
  ];
  const accountTargets = new Map(codexAccountNamespaceEntries(config));
  const accountNativeSlugsBySelector = accountSelectors.length > 0
    ? new Map([...accountBoundNativeOpenAiSlugsBySelector(config, observedAccountNativeEntries)].map(([selector, slugs]) => {
      const target = accountTargets.get(selector);
      const accountId = target && isMainCodexAccountTarget(target) ? MAIN_CODEX_ACCOUNT_ID : target;
      const entitled = accountId ? modelEntitlements.modelsByAccount.get(accountId) : undefined;
      const confirmed = accountId ? modelEntitlements.confirmedAccountIds.has(accountId) : false;
      return [selector, slugs.filter(slug => (
        !ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug) || (confirmed && entitled?.has(slug) === true)
      ))] as const;
    }))
    : new Map<string, readonly string[]>();
  const accountNativeSlugs = accountSelectors.length > 0
    ? [...new Set([...accountNativeSlugsBySelector.values()].flatMap(slugs => [...slugs]))]
    : [];
  // Unknown account-native ids have no safe bare/global identity. They are only projected through
  // the selector map above; the no-selector catalog remains the static native/API-key surface.
  const observedNativeSlugs: string[] = [];
  const wsEnabled = websocketsEnabled(config);
  const multiAgentV2Enabled = isMultiAgentV2Enabled();
  const goEntries = buildCatalogEntriesFromObservedState({
    template: template ? JSON.parse(JSON.stringify(template)) : null,
    gptSlugs: [],
    goModels: orderedGoModels,
    featured,
    modelPickerOrder,
    wsEnabled,
    multiAgentMode,
    exactComboSlugs,
    accountSelectors,
    suppressedBareNativeSlugs,
    disabledNativeAccountSlugs: new Set(),
    multiAgentV2Enabled,
    openaiContextCap,
  });
  // Keep genuine native entries (gpt-*, codex-*) with their real per-model fields and append
  // routed providers as namespaced slugs. Cursor and other adopted providers can expose model ids
  // like `gpt-5.5`; those must not delete the native OpenAI/Codex base row.
  const baselineCatalog = readCatalogBackup(catalogPath);
  const baseline = readNativeBaseline(catalogPath);
  const gatheredProviderNames = new Set(
    Object.entries(config.providers ?? {})
      .filter(([, prov]) => prov.disabled !== true)
      .map(([name]) => name),
  );
  const degradedProviderNames = new Set(
    providerModelOutcomes
      .filter(outcome => outcome.state === "degraded")
      .map(outcome => outcome.provider),
  );
  const selectedModelsByProvider = new Map<string, ReadonlySet<string>>(
    Object.entries(config.providers ?? {}).flatMap(([name, provider]) => (
      provider.disabled !== true
        && Array.isArray(provider.selectedModels)
        && provider.selectedModels.length > 0
        ? [[name, new Set(provider.selectedModels)] as const]
        : []
    )),
  );
  // Central WS capability override on the FINAL on-disk catalog (the file Codex reads). Applies to
  // native AND routed so the advertised flag matches the implemented endpoint (phase 120.4) and a
  // native template can never leak supports_websockets while the flag is off.
  // #636: when the user only configured non-OpenAI providers (e.g. kimi), do not advertise
  // bare gpt-* rows that hard-404 via NoEnabledOpenAiProviderError. Keep natives when no
  // providers are configured yet (fresh install / catalog bootstrap tests).
  const accountBoundEntries = includeAccountBoundNativeOpenAi && accountSelectors.length > 0
    ? buildCatalogEntriesFromObservedState({
      template: template ? JSON.parse(JSON.stringify(template)) : null,
      gptSlugs: availableAccountNativeSlugs,
      goModels: [],
      featured,
      wsEnabled,
      multiAgentMode,
      exactComboSlugs,
      accountSelectors,
      suppressedBareNativeSlugs,
      disabledNativeAccountSlugs: new Set([...disabledNativeSlugs(config)].filter(slug => suppressedBareNativeSlugs.has(slug))),
      multiAgentV2Enabled,
      keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
      openaiContextCap,
      accountNativeSlugs,
      accountNativeSlugsBySelector,
    }).filter(entry => trustedAccountBoundNativeCatalogSlug(entry) !== undefined)
    : [];
  catalog.models = mergeCatalogEntriesFromObservedState({
    catalogModels: catalogModelsForMerge,
    baselineCatalogModels: baselineCatalog?.models ?? [],
    routedEntries: goEntries,
    baseline,
    featured,
    wsEnabled,
    template,
    disabledModels: new Set(config.disabledModels ?? []),
    selectedModelsByProvider,
    gatheredProviderNames,
    degradedProviderNames,
    legacyCustomModelSlugs: legacyCustomModelCatalogSlugs(config),
    multiAgentMode,
    multiAgentV2Enabled,
    keepNativeChatGptOnV1: config.keepNativeChatGptOnV1 === true,
    exactComboSlugs,
    hasPhysicalComboProvider,
    includeNativeOpenAi,
    accountBoundEntries,
    suppressedBareNativeSlugs,
    openaiContextCap,
    policy: {
      ...CANONICAL_NATIVE_CATALOG_CONTENT_POLICY,
      nativeBackfillSlugs: [...availableBareNativeSlugs, ...observedNativeSlugs],
      warningPolicy: "emit",
    },
  });
  clampCatalogModelsToCodexSupport(catalog.models);
  finalizeAutoReviewModelOverride(catalog.models, catalogModelsForMerge);

  const added = goEntries.length + accountBoundEntries.length;
  const content = `${JSON.stringify(catalog, null, 2)}\n`;
  // A byte-identical rewrite is not a catalog change, but every mtime-keyed reader
  // has to treat it as one. The app-server staleness classifier (#857) is the one
  // that matters: it compares this file's mtime against each running Codex's start
  // time, so an ordinary `ocx start` — or any dashboard action that re-syncs an
  // unchanged model set — marked every already-running Codex as holding an outdated
  // in-memory catalog. Since #1407 that verdict silences opencodex's own model
  // guidance entirely (no preferred model, no roster) for the rest of that Codex's
  // lifetime, so a configured injectionModel stops reaching the session even though
  // nothing about the catalog changed. Skipping the no-op write keeps both the mtime
  // and `catalogWritten` honest; `added` still reports the routed rows the catalog
  // carries, because they are on disk either way.
  const onDiskBytes = currentCatalogFileContent(catalogPath);
  if (onDiskBytes !== null && onDiskBytes.equals(Buffer.from(content, "utf8"))) {
    return { added, path: catalogPath, catalogWritten: false, comboOmissions };
  }

  replaceActiveCodexCatalog(permit, owningCodexHome, {
    path: catalogPath,
    content,
  });
  return {
    added,
    path: catalogPath,
    catalogWritten: true,
    comboOmissions,
  };
}

function visibleAccountReplacementNatives(
  models: readonly RawEntry[],
  disabledModels: ReadonlySet<string> | null,
): Map<string, boolean> {
  const replacements = new Map<string, boolean>();
  for (const entry of models) {
    const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
    if (nativeSlug === undefined || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(nativeSlug)) continue;
    const exactSlug = typeof entry.slug === "string" ? entry.slug : "";
    const visible = entry.visibility === "list"
      || (disabledModels !== null
        && (disabledModels.has(nativeSlug) || disabledModels.has(exactSlug)));
    replacements.set(nativeSlug, (replacements.get(nativeSlug) ?? true) && visible);
  }
  return replacements;
}

function restoreAccountHiddenBareNatives(
  entries: readonly RawEntry[],
  replacementVisibility: ReadonlyMap<string, boolean>,
  disabledModels: ReadonlySet<string> | null,
): RawEntry[] {
  return entries.map(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (
      entry.visibility !== "hide"
      || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)
      || replacementVisibility.get(slug) !== true
      || disabledModels === null
      || disabledModels.has(slug)
    ) {
      return entry;
    }
    return { ...entry, visibility: "list" };
  });
}

function currentDisabledModelsForRestore(): Set<string> | null {
  try {
    const diagnostics = readConfigDiagnostics();
    if (diagnostics.source === "fallback" || diagnostics.error !== null) return null;
    return new Set(diagnostics.config.disabledModels ?? []);
  } catch {
    // An unreadable config cannot safely authorize a visibility change during restore.
    return null;
  }
}

export async function syncCatalogModels(
  config: OcxConfig,
  options?: CodexCatalogSyncOptions,
): Promise<RetainedCatalogSyncResult> {
  const owningCodexHome = getCodexHome();
  const preflightRead = readRetainedCatalogSync(config);
  if (preflightRead === null) {
    return {
      added: 0,
      path: readCodexCatalogPath(),
      catalogWritten: false,
      comboOmissions: [],
    };
  }

  const comboOmissions: ComboCatalogOmission[] = [];
  const providerModelOutcomes: CatalogGatherProviderModelOutcome[] = [];
  // Settle the bundled template, then baseline, and only then await. Reading it
  // here makes the memo ours before anyone else can move it, so a bundled swap
  // during the await is an outside change rather than our own side effect.
  //
  // The persisted runtime selection is covered by the filesystem evidence above
  // rather than by a process epoch; see `retainedCatalogProcessEvidence` for why
  // the in-memory runtime memo cannot be baselined honestly from this path.
  loadBundledCodexCatalog();
  const prepared: RetainedCatalogSyncRead = {
    ...preflightRead,
    evidence: retainedCatalogSyncEvidence(config, preflightRead.catalogPath, preflightRead.catalog),
    processEvidence: retainedCatalogProcessEvidence(),
  };
  const [goModels, modelEntitlements] = await Promise.all([
    gatherRoutedModels(config, {
      comboOmissions,
      providerModelOutcomes,
    }),
    resolveCodexModelEntitlements(config),
  ]);
  const committed = withCatalogWriteSerialization(owningCodexHome, permit => {
    // Desired state can flip OFF during the provider await above. The catalog
    // evidence revalidation below cannot see that — intent lives in our config,
    // not in the catalog files — so the policy is re-read here, under K, right
    // before the only write. A lost race becomes the discriminated skip instead
    // of a routed catalog/cache surviving a completed disable. An explicit
    // catalog-only sync opts out of that gate: the user asked for a refresh even
    // when injection is OFF, and the toggle only protects config/history writes.
    if (!shouldSyncCodexOnStart(loadConfig()) && options?.allowWhenDesiredDisabled !== true) {
      return {
        added: 0,
        path: prepared.catalogPath,
        catalogWritten: false,
        comboOmissions,
        skippedReason: "desired_disabled" as const,
      };
    }
    const current = revalidateRetainedCatalogSync(config, prepared);
    if (current === null) return null;
    if (!isCodexModelEntitlementSnapshotCurrent(modelEntitlements)) return null;
    return writeRetainedCatalogSync({
      config,
      goModels,
      providerModelOutcomes,
      comboOmissions,
      read: current,
      permit,
      owningCodexHome,
      modelEntitlements,
    });
  });
  if (committed.kind === "completed" && committed.value !== null) return committed.value;
  return {
    added: 0,
    path: prepared.catalogPath,
    catalogWritten: false,
    comboOmissions,
  };
}

export function restoreCodexCatalogWithPermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  /**
   * The catalog this injection actually wrote, when it is known (#1798).
   *
   * Re-resolving from the CURRENT config is wrong after a Codex app rewrite that dropped
   * `model_catalog_json`: that sends restore to the default catalog while the routed file we
   * really wrote is left untouched. The recorded path is the file whose routing is ours.
   */
  injectedCatalogPath?: string | null,
): { removed: number; kept: number; path: string } {
  const catalogPath = injectedCatalogPath ?? readCodexCatalogPath();
  const catalog = readCatalog(catalogPath);
  if (!catalog || !Array.isArray(catalog.models)) return { removed: 0, kept: 0, path: catalogPath };
  const disabledModels = currentDisabledModelsForRestore();
  const replacementVisibility = visibleAccountReplacementNatives(catalog.models, disabledModels);
  const backup = readCatalogBackup(catalogPath);
  if (backup && Array.isArray(backup.models)) {
    const removed = (catalog.models ?? []).filter(m => typeof m.slug === "string" && m.slug.includes("/")).length;
    const backupSlugs = new Set(backup.models.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
    const userNativeAdditions = restoreAccountHiddenBareNatives(
      (catalog.models ?? []).filter(m =>
        typeof m.slug === "string" && !m.slug.includes("/") && !backupSlugs.has(m.slug)
      ),
      replacementVisibility,
      disabledModels,
    );
    const restored = {
      ...backup,
      models: [...backup.models, ...userNativeAdditions],
    };
    replaceActiveCodexCatalog(permit, owningCodexHome, {
      path: catalogPath,
      content: `${JSON.stringify(restored, null, 2)}\n`,
    });
    return { removed, kept: restored.models.length, path: catalogPath };
  }
  const before = catalog.models.length;
  const native = restoreAccountHiddenBareNatives(
    catalog.models.filter(m => !(typeof m.slug === "string" && m.slug.includes("/"))),
    replacementVisibility,
    disabledModels,
  );
  const removed = before - native.length;
  if (removed > 0) {
    catalog.models = native;
    replaceActiveCodexCatalog(permit, owningCodexHome, {
      path: catalogPath,
      content: `${JSON.stringify(catalog, null, 2)}\n`,
    });
  }
  return { removed, kept: native.length, path: catalogPath };
}

export function restoreCodexCatalog(): { removed: number; kept: number; path: string } {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => restoreCodexCatalogWithPermit(permit, owningCodexHome),
  );
  return outcome.kind === "completed"
    ? outcome.value
    : { removed: 0, kept: 0, path: readCodexCatalogPath() };
}

/** Force Codex's models_cache stale from the on-disk catalog. Returns whether a cache write occurred. */
export function invalidateCodexModelsCacheWithPermit(
  permit: CatalogWritePermit,
  owningCodexHome: string,
  options?: CodexCatalogSyncOptions,
): boolean {
  try {
    // This permit is a REACQUISITION: refreshCodexModelCatalog's commit released
    // K before this rewrite runs, so the commit-path desired-state check cannot
    // cover it. A disable landing in that gap must not be overwritten by a
    // routed cache write — re-read intent under this permit, same as the commit.
    // The catalog-only sync override applies here too so an explicit refresh
    // keeps the cache consistent with the catalog it just wrote.
    if (!shouldSyncCodexOnStart(loadConfig()) && options?.allowWhenDesiredDisabled !== true) return false;
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return false;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const models = catalog.models ?? catalog;
    const currentCache = readCatalog(activeCodexModelsCachePath());
    const existingSlugs = new Set(models.flatMap((entry: RawEntry) =>
      typeof entry.slug === "string" ? [entry.slug] : []));
    const currentConfig = loadConfig();
    const mainSelectors = visibleCodexAccountSelectors(currentConfig).filter(selector => {
      const target = new Map(codexAccountNamespaceEntries(currentConfig)).get(selector);
      return isMainCodexAccountTarget(target ?? "");
    });
    const observedAccountModels = observedAccountBoundNativeEntries(currentCache?.models ?? [])
      .filter(entry => {
        const slug = typeof entry.slug === "string" ? entry.slug : "";
        return !existingSlugs.has(slug);
      })
      .map(entry => ({
        ...entry,
        // Keep the observation in Codex's cache without advertising a new bare picker row. The
        // next OpenCodex catalog sync consumes this marker and creates only selector-qualified
        // rows for the currently configured public account selectors.
        visibility: "hide",
        opencodex_account_observed_native: true,
        opencodex_account_observed_selectors: mainSelectors,
      }));
    const wrapper = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models: [...models, ...observedAccountModels],
    };
    replaceCodexModelsCache(permit, owningCodexHome, {
      path: activeCodexModelsCachePath(),
      content: `${JSON.stringify(wrapper, null, 2)}\n`,
    });
    return true;
  } catch {
    return false;
  }
}

export function invalidateCodexModelsCache(options?: CodexCatalogSyncOptions): boolean {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => invalidateCodexModelsCacheWithPermit(permit, owningCodexHome, options),
  );
  return outcome.kind === "completed" && outcome.value;
}
