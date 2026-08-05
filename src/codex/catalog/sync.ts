import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { expandUserPath, readConfigDiagnostics, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, getCodexHome, readRootTomlString, resolveCodexConfigPath } from "../paths";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "../model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../../oauth";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { modelInList } from "../../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../../reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../../generated/jawcode-model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../../providers/derive";
import { getProviderRegistryEntry } from "../../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../../providers/context-cap";
import { routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
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


import { activeCodexModelsCachePath, applyJawcodeCatalogMetadata, applyMultiAgentMode, applyNativeOpenAiContextOverride, catalogBackupPathFor, catalogHasRoutedEntries, catalogModelSlug, ensureStrictCatalogFields, findNativeTemplate, isDefaultCatalogPath, isRoutedModelCompatibilityExcluded, legacyCatalogBackupPath, normalizeRoutedCatalogEntry, normalizeServiceTiers, readCatalog, readCatalogBackup, readCodexCatalogPath, readNativeBaseline } from "./parsing";
import type { CatalogModel, MultiAgentMode, RawCatalog, RawEntry } from "./parsing";
import { applyNativeVisibility, disabledNativeSlugs, isUnsupportedOpenAiNativeSlug, nativeOpenAiSlugs, NATIVE_OPENAI_MODELS, shouldIncludeAccountBoundNativeOpenAi, shouldIncludeNativeOpenAi, shouldUpgradeToUpstreamEntry, SUPPORTED_NATIVE_OPENAI_SLUGS, upstreamNativeEntry } from "./metadata";
import {
  bundledCatalogCacheState,
  loadBundledCodexCatalog,
  resetBundledCatalogCacheForTests,
} from "./bundled";
import { isMultiAgentV2Enabled } from "../features";
import { applyCatalogModelMetadata, applyReasoningLevels, catalogEntryEfforts, clampCatalogModelsToCodexSupport, ensureGpt56ReasoningLevels, ensureUltraReasoningLevel, isGpt56NativeSlug } from "./effort";
import { clearGatherRoutedModelsInflight, filterCatalogVisibleModels, gatherRoutedModels, lastDropWarnSignature } from "./provider-fetch";
import { accountSelectorShadowCollisionWarnings, clearLastComboCatalogOmissions, comboCatalogWarningSignatures, comboMasqueradeCollisionWarnings, exactComboCatalogSlugs, openAiApiCollisionWarnings, resolveSlugAliasCollisions, slugAliasCollisionWarnings, warnAccountSelectorShadowedProviderOnce, warnComboMasqueradeCollisionOnce } from "./aggregation";
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

export const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5;

export type SpawnAgentSurface = "v1" | "v2";

export type SubagentRosterExclusionReason =
  | "missing_catalog_entry"
  | "picker_hidden"
  | "surface_incompatible"
  | "outside_display_limit";

/**
 * Whether a catalog entry may be offered as a V2 subagent model.
 *
 * Upstream (codex-rs 92938d880) requires `multi_agent_version === "v2"` exactly,
 * because upstream assumes a single backend serves every model. opencodex routes
 * many providers, so that equality would reject the cross-provider spawns this
 * proxy exists to enable.
 *
 * Decision (option B, devlog 260730_codex_rs_upstream_v2_live_handoff/060): any
 * model opencodex actually routes is eligible. An entry pinned to a DIFFERENT
 * multi-agent backend (`v1`) stays excluded, because that pin is a real capability
 * statement rather than an absence of information. An unpinned entry (null or
 * absent) is a routed or unpinned-native model and is allowed. The three-way
 * distinction is the substance; do not flatten it into a truthiness check.
 */
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  const pinned = entry.multi_agent_version;
  return pinned === "v2" || pinned === null || pinned === undefined;
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
      const leftPriority = typeof left.entry.priority === "number" && Number.isFinite(left.entry.priority)
        ? left.entry.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.entry.priority === "number" && Number.isFinite(right.entry.priority)
        ? right.entry.priority : Number.MAX_SAFE_INTEGER;
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

export function finishUpstreamNativeEntry(clone: RawEntry, priority: number): RawEntry {
  if (priority !== 9) clone.priority = priority;
  applyNativeOpenAiContextOverride(clone);
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
  return model !== undefined && exactComboSlugs.has(catalogModelSlug(model));
}

export function deriveEntry(
  template: RawEntry | null,
  slug: string,
  desc: string,
  priority: number,
  model?: CatalogModel,
  exactComboSlugs: ReadonlySet<string> = new Set(),
): RawEntry {
  const preserveExact = isExactComboCatalogModel(model, exactComboSlugs);
  const isRouted = model !== undefined;
  if (!isRouted && !slug.includes("/")) {
    // Supported native slug covered by the upstream snapshot: use the REAL entry (exact
    // reasoning ladder — e.g. luna has no ultra — default effort, identity, model_messages)
    // instead of cloning an older template.
    const upstream = upstreamNativeEntry(slug);
    if (upstream) return finishUpstreamNativeEntry(upstream, priority);
  }
  if (template) {
    const e = JSON.parse(JSON.stringify(template)) as RawEntry;
    e.slug = slug;
    e.display_name = slug;
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
      // restores exact values below; otherwise the strict-fields fallback
      // supplies the conservative 128k triple.
      delete e.context_window;
      delete e.max_context_window;
      delete e.auto_compact_token_limit;
      // Native id for identity text + metadata lookups — the slug may be an encoded
      // alias (`provider/vendor-model`); the model object carries the native id.
      const modelName = model?.id ?? slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        // Proxy-neutral: keep the GPT-5/OpenAI disclaimer but never advertise the opencodex proxy
        // (leaking that into base_instructions is a non-first-party signature → ToS risk).
        e.base_instructions = identifyRoutedModel(e.base_instructions, modelName);
      }
      applyReasoningLevels(e, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
      normalizeRoutedCatalogEntry(e, model?.parallelToolCalls === true);
      if (model) applyJawcodeCatalogMetadata(e, model.provider, model.id, model.contextCap);
      applyCatalogModelMetadata(e, model);
    } else {
      applyNativeOpenAiContextOverride(e);
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
  const entry: RawEntry = {
    slug, display_name: slug, description: desc,
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
    ...(isRouted ? { web_search_tool_type: "text_and_image", supports_search_tool: true } : {}),
  };
  if (isRouted) {
    applyReasoningLevels(entry, model?.reasoningEfforts, model?.defaultReasoningEffort, preserveExact);
  }
  else {
    applyReasoningLevels(entry, isGpt56NativeSlug(slug) ? undefined : ["low", "medium", "high", "xhigh"]);
    if (isGpt56NativeSlug(slug)) ensureGpt56ReasoningLevels(entry);
  }
  if (model && isRouted) applyJawcodeCatalogMetadata(entry, model.provider, model.id, model.contextCap);
  applyCatalogModelMetadata(entry, model);
  if (!isRouted) applyNativeOpenAiContextOverride(entry);
  return ensureStrictCatalogFields(normalizeServiceTiers(entry), {
    preserveExactInputModalities: preserveExact,
    isRouted,
  });
}

export function buildCatalogEntries(
  template: RawEntry | null,
  gptSlugs: string[],
  goModels: CatalogModel[],
  featured?: string[],
  wsEnabled = false,
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  accountSelectors: readonly string[] = [],
): RawEntry[] {
  // Codex's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const priorityStride = Math.max(accountSelectors.length, 1);
  const out: RawEntry[] = [];
  const nativeEntries: RawEntry[] = [];
  const collisionSkipped = resolveSlugAliasCollisions(goModels);
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  for (const slug of gptSlugs) {
    const e = deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
    nativeEntries.push(e);
  }
  for (const [selectorIndex, selector] of accountSelectors.entries()) {
    for (const [nativeIndex, native] of nativeEntries.entries()) {
      const e = JSON.parse(JSON.stringify(native)) as RawEntry;
      const nativeSlug = String(native.slug);
      const catalogSlug = `${selector}/${nativeSlug}`;
      e.slug = catalogSlug;
      e.display_name = accountBoundNativeDisplayName(selector, native);
      // Codex ignores this OpenCodex extension; preserve the native comp_hash unchanged.
      e.opencodex_catalog_kind = CODEX_ACCOUNT_BOUND_CATALOG_KIND;
      const exactRank = rank.get(catalogSlug);
      const inheritedRank = rank.get(nativeSlug);
      const featuredRank = exactRank ?? inheritedRank;
      e.priority = featuredRank !== undefined
        ? featuredRank * priorityStride + selectorIndex
        : ((featured?.length ?? 0) + nativeIndex) * accountSelectors.length + selectorIndex;
      e.visibility = "list";
      out.push(e);
    }
  }
  for (const m of goModels) {
    if (collisionSkipped.has(m)) continue;
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
    // Featured picks may be stored raw (legacy) or encoded — honor both.
    const rankHit = rank.get(slug) ?? rank.get(`${m.provider}/${m.id}`);
    if (rankHit !== undefined) e.priority = rankHit * priorityStride;
    else if (accountSelectors.length > 0) {
      // Keep the generated account rows together in Codex's priority-sorted flat picker.
      e.priority = 1_000 + (typeof e.priority === "number" ? e.priority : 5);
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
  return applyMultiAgentMode(out, multiAgentMode, isMultiAgentV2Enabled());
}

export function resetCatalogRuntimeStateForTests(): void {
  resetBundledCatalogCacheForTests();
  lastDropWarnSignature.clear();
  openAiApiCollisionWarnings.clear();
  comboCatalogWarningSignatures.clear();
  slugAliasCollisionWarnings.clear();
  comboMasqueradeCollisionWarnings.clear();
  accountSelectorShadowCollisionWarnings.clear();
  clearLastComboCatalogOmissions();
  clearModelCache();
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
  const desc = typeof entry.description === "string" ? entry.description : "";
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  return slug.includes("/") && desc.startsWith("Routed via opencodex → ");
}

export function mergeCatalogEntriesForSync(
  catalogModels: RawEntry[],
  routedEntries: RawEntry[],
  baseline: Map<string, number>,
  featured: string[],
  wsEnabled: boolean,
  goIds: Set<string> = new Set(),
  template: RawEntry | null = null,
  disabledModels: ReadonlySet<string> = new Set(),
  gatheredProviderNames: Set<string> = new Set(routedEntries.flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const slash = slug.indexOf("/");
    return slash > 0 ? [slug.slice(0, slash)] : [];
  })),
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  hasPhysicalComboProvider = false,
  includeNativeOpenAi = true,
  accountBoundEntries: readonly RawEntry[] = [],
): RawEntry[] {
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const native = includeNativeOpenAi
    ? catalogModels
    .filter(m => typeof m.slug === "string"
      && !(m.slug as string).includes("/")
      && m.owned_by !== COMBO_NAMESPACE
      && !goIds.has(m.slug as string)
      && !isUnsupportedOpenAiNativeSlug(m.slug as string))
    .map(m => {
      const slug = m.slug as string;
      // Featured models rank first (rank order); non-featured natives are pushed below the featured
      // block when any model is featured, else keep their pristine baseline priority.
      const baselinePriority = baseline.get(slug) ?? (m.priority as number);
      const priority = rank.has(slug)
        ? rank.get(slug)!
        : featured.length > 0
          ? Math.max(typeof baselinePriority === "number" ? baselinePriority : 9, featured.length + 100)
          : baselinePriority;
      // Fallback-quality entries (ocx synthesis / codex-rs model_info fallback: display_name
      // stamped with the bare slug) are upgraded to the pinned upstream snapshot entry so a
      // previously synthesized ladder (e.g. luna advertising ultra) self-heals on sync. A
      // genuine catalog entry (real display name) is preserved untouched.
      if (shouldUpgradeToUpstreamEntry(m)) {
        const upstream = upstreamNativeEntry(slug)!;
        const upgradePriority = rank.has(slug)
          ? rank.get(slug)!
          : featured.length > 0
            ? Math.max(typeof upstream.priority === "number" ? upstream.priority : 9, featured.length + 100)
            : typeof upstream.priority === "number" ? upstream.priority : priority;
        const finished = finishUpstreamNativeEntry(upstream, 9);
        finished.priority = upgradePriority;
        return finished;
      }
      const preserved = normalizeServiceTiers({ ...m, priority });
      // Older natives kept from disk still need the mock top tiers (max + ultra always
      // for subagent max spawns; wire-clamped to the model's real top rung).
      if (!isGpt56NativeSlug(slug)) ensureUltraReasoningLevel(preserved);
      return preserved;
    })
    : [];

  // Backfill any native OpenAI slug that the on-disk catalog is missing (e.g. gpt-5.5), so a
  // routed provider exposing the same id can never delete the native OpenAI/Codex base row.
  // Skip when no enabled canonical openai provider exists (#636) — bare gpt-* would 404.
  const nativeSlugs = new Set(native.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
  if (includeNativeOpenAi) {
  for (const slug of nativeOpenAiSlugs()) {
    if (nativeSlugs.has(slug)) continue;
    nativeSlugs.add(slug);
    const priority = rank.has(slug)
      ? rank.get(slug)!
      : featured.length > 0
        ? featured.length + 100
        : 9;
    native.push(deriveEntry(template ? JSON.parse(JSON.stringify(template)) : null, slug, "OpenAI native model (Codex OAuth passthrough).", priority));
  }
  }

  const nativeBySlug = new Map(native.flatMap(entry =>
    typeof entry.slug === "string" ? [[entry.slug, entry] as const] : []
  ));
  const alignedAccountBoundEntries = accountBoundEntries.map(entry => {
    const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry);
    const source = nativeSlug === undefined ? undefined : nativeBySlug.get(nativeSlug);
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
    routedEntries.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []),
  );
  let finalRoutedEntries = routedEntries;
  const existingRoutedEntries = catalogModels.filter(m =>
    typeof m.slug === "string"
    && m.slug.includes("/")
    && trustedAccountBoundNativeCatalogSlug(m) === undefined
  );
  const preservingExistingRouted = routedEntries.length === 0
    && existingRoutedEntries.length > 0;
  if (preservingExistingRouted) {
    // #855: transient-fetch protection keeps existing rows, but rows OpenCodex
    // itself authored for a provider that is no longer configured are ghosts,
    // not protected foreign entries.
    finalRoutedEntries = existingRoutedEntries.filter(m => {
      const provider = (m.slug as string).slice(0, (m.slug as string).indexOf("/"));
      return !(isOcxAuthoredRoutedEntry(m) && !gatheredProviderNames.has(provider));
    });
  } else {
    const preservedForeignRouted = catalogModels.filter(m => {
      if (typeof m.slug !== "string" || !m.slug.includes("/")) return false;
      if (trustedAccountBoundNativeCatalogSlug(m) !== undefined) return false;
      const provider = m.slug.slice(0, m.slug.indexOf("/"));
      if (gatheredProviderNames.has(provider) || freshSlugs.has(m.slug)) return false;
      // #855: an OpenCodex-authored row whose provider was deleted is a ghost;
      // only genuinely foreign rows (Cursor, user tooling) are preserved.
      return !isOcxAuthoredRoutedEntry(m);
    });
    finalRoutedEntries = [...routedEntries, ...preservedForeignRouted];
  }
  if (!hasPhysicalComboProvider) {
    finalRoutedEntries = finalRoutedEntries.filter(entry => {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const comboOwned = slug.startsWith(`${COMBO_NAMESPACE}/`) || entry.owned_by === COMBO_NAMESPACE;
      return !comboOwned || freshSlugs.has(slug);
    });
  }
  finalRoutedEntries = finalRoutedEntries.filter(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    return !exactComboSlugs.has(slug)
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
    if (freshSlugs.has(entry.slug)) warnAccountSelectorShadowedProviderOnce(entry.slug);
    return false;
  });
  if (preservingExistingRouted) {
    console.warn(`[opencodex] catalog sync: routed model fetch returned empty; preserving ${finalRoutedEntries.length} existing routed entr${finalRoutedEntries.length === 1 ? "y" : "ies"} on disk.`);
  }

  const managedEntries = [...finalRoutedEntries, ...alignedAccountBoundEntries];
  const mergedEntries = [...native, ...managedEntries].map(m => {
    const normalized = normalizeServiceTiers(m);
    applyNativeOpenAiContextOverride(normalized);
    const exactCombo = typeof m.slug === "string" && exactComboSlugs.has(m.slug);
    const e = ensureStrictCatalogFields(normalized, {
      preserveExactInputModalities: exactCombo,
      isRouted: finalRoutedEntries.includes(m),
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
  return applyMultiAgentMode(
    applyNativeVisibility(mergedEntries, disabledModels, alignedAccountBoundEntries.length > 0),
    multiAgentMode,
    isMultiAgentV2Enabled(),
  );
}

interface RetainedCatalogSyncRead {
  readonly catalogPath: string;
  readonly catalog: RawCatalog;
  readonly onDiskCatalog: RawCatalog | null;
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
}

interface RetainedCatalogSyncWrite {
  readonly config: OcxConfig;
  readonly goModels: CatalogModel[];
  readonly comboOmissions: ComboCatalogOmission[];
  readonly read: RetainedCatalogSyncRead;
  readonly permit: CatalogWritePermit;
  readonly owningCodexHome: string;
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
  if (active && findNativeTemplate(active)) return active;
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
  const evidence = retainedCatalogSyncEvidence(config, catalogPath, catalog);
  // `processEvidence` is filled in after the provider await, not here.
  return { catalogPath, catalog, onDiskCatalog, evidence, processEvidence: "" };
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
    evidence,
    processEvidence: prepared.processEvidence,
  };
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

function writeRetainedCatalogSync({
  config,
  goModels,
  comboOmissions,
  read,
  permit,
  owningCodexHome,
}: RetainedCatalogSyncWrite): RetainedCatalogSyncResult {
  const { catalogPath, catalog, onDiskCatalog } = read;
  const catalogModelsForMerge = onDiskCatalog?.models ?? catalog.models ?? [];
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
  const multiAgentMode: MultiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
  const includeNativeOpenAi = shouldIncludeNativeOpenAi(config);
  const includeAccountBoundNativeOpenAi = shouldIncludeAccountBoundNativeOpenAi(config);
  const accountSelectors = includeAccountBoundNativeOpenAi
    ? visibleCodexAccountSelectors(config)
    : [];
  const wsEnabled = websocketsEnabled(config);
  const goEntries = buildCatalogEntries(
    template ? JSON.parse(JSON.stringify(template)) : null,
    [],
    orderedGoModels,
    featured,
    wsEnabled,
    multiAgentMode,
    exactComboSlugs,
    accountSelectors,
  );
  // Keep genuine native entries (gpt-*, codex-*) with their real per-model fields and append
  // routed providers as namespaced slugs. Cursor and other adopted providers can expose model ids
  // like `gpt-5.5`; those must not delete the native OpenAI/Codex base row.
  const baseline = readNativeBaseline(catalogPath);
  const goIds = new Set(enabledGo.map(m => m.id));
  const gatheredProviderNames = new Set(
    Object.entries(config.providers ?? {})
      .filter(([, prov]) => prov.disabled !== true)
      .map(([name]) => name),
  );
  // Central WS capability override on the FINAL on-disk catalog (the file Codex reads). Applies to
  // native AND routed so the advertised flag matches the implemented endpoint (phase 120.4) and a
  // native template can never leak supports_websockets while the flag is off.
  // #636: when the user only configured non-OpenAI providers (e.g. kimi), do not advertise
  // bare gpt-* rows that hard-404 via NoEnabledOpenAiProviderError. Keep natives when no
  // providers are configured yet (fresh install / catalog bootstrap tests).
  const accountBoundEntries = includeAccountBoundNativeOpenAi && accountSelectors.length > 0
    ? buildCatalogEntries(
      template ? JSON.parse(JSON.stringify(template)) : null,
      NATIVE_OPENAI_MODELS,
      [],
      featured,
      wsEnabled,
      multiAgentMode,
      exactComboSlugs,
      accountSelectors,
    ).filter(entry => trustedAccountBoundNativeCatalogSlug(entry) !== undefined)
    : [];
  catalog.models = mergeCatalogEntriesForSync(
    catalogModelsForMerge,
    goEntries,
    baseline,
    featured,
    wsEnabled,
    goIds,
    template,
    new Set(config.disabledModels ?? []),
    gatheredProviderNames,
    multiAgentMode,
    exactComboSlugs,
    hasPhysicalComboProvider,
    includeNativeOpenAi,
    accountBoundEntries,
  );
  clampCatalogModelsToCodexSupport(catalog.models);

  replaceActiveCodexCatalog(permit, owningCodexHome, {
    path: catalogPath,
    content: `${JSON.stringify(catalog, null, 2)}\n`,
  });
  return {
    added: goEntries.length + accountBoundEntries.length,
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

export async function syncCatalogModels(config: OcxConfig): Promise<RetainedCatalogSyncResult> {
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
  const goModels = await gatherRoutedModels(config, { comboOmissions });
  const committed = withCatalogWriteSerialization(owningCodexHome, permit => {
    const current = revalidateRetainedCatalogSync(config, prepared);
    if (current === null) return null;
    return writeRetainedCatalogSync({
      config,
      goModels,
      comboOmissions,
      read: current,
      permit,
      owningCodexHome,
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
): { removed: number; kept: number; path: string } {
  const catalogPath = readCodexCatalogPath();
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
): boolean {
  try {
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return false;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const models = catalog.models ?? catalog;
    const wrapper = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models,
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

export function invalidateCodexModelsCache(): boolean {
  const owningCodexHome = getCodexHome();
  const outcome = withCatalogWriteSerialization(
    owningCodexHome,
    permit => invalidateCodexModelsCacheWithPermit(permit, owningCodexHome),
  );
  return outcome.kind === "completed" && outcome.value;
}
