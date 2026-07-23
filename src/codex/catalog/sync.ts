import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "../paths";
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
import { CODEX_GPT5_IDENTITY_LINE } from "../../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers";
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


import { activeCodexModelsCachePath, applyJawcodeCatalogMetadata, applyMultiAgentMode, applyNativeOpenAiContextOverride, catalogModelSlug, ensureCatalogBackup, ensureStrictCatalogFields, findNativeTemplate, isRoutedModelCompatibilityExcluded, normalizeRoutedCatalogEntry, normalizeServiceTiers, readCatalog, readCatalogBackup, readCodexCatalogPath, readNativeBaseline } from "./parsing";
import type { CatalogModel, MultiAgentMode, RawEntry } from "./parsing";
import { applyNativeVisibility, disabledNativeSlugs, isUnsupportedOpenAiNativeSlug, nativeOpenAiSlugs, shouldUpgradeToUpstreamEntry, upstreamNativeEntry } from "./metadata";
import { loadCatalogForSync, resetBundledCatalogCacheForTests } from "./bundled";
import { applyCatalogModelMetadata, applyReasoningLevels, catalogEntryEfforts, clampCatalogModelsToCodexSupport, ensureGpt56ReasoningLevels, ensureUltraReasoningLevel, isGpt56NativeSlug } from "./effort";
import { filterCatalogVisibleModels, gatherRoutedModels, lastDropWarnSignature } from "./provider-fetch";
import { comboCatalogWarningSignatures, comboMasqueradeCollisionWarnings, exactComboCatalogSlugs, openAiApiCollisionWarnings, resolveSlugAliasCollisions, slugAliasCollisionWarnings, warnComboMasqueradeCollisionOnce } from "./aggregation";

export const MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5;

export type SpawnAgentSurface = "v1" | "v2";

export type SubagentRosterExclusionReason =
  | "missing_catalog_entry"
  | "picker_hidden"
  | "surface_incompatible"
  | "outside_display_limit";

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

export function configuredCatalogEntry(entries: RawEntry[], configured: string): RawEntry | undefined {
  return entries.find(entry => entry.slug === configured)
    ?? entries.find(entry => typeof entry.slug === "string" && slugsEquivalent(configured, entry.slug));
}

export function effectiveSubagentRoster(
  configuredModels: readonly string[],
  surface: SpawnAgentSurface,
): EffectiveSubagentRoster {
  const configured = configuredModels
    .filter(model => model.trim().length > 0)
    .filter((model, index, all) =>
      !all.slice(0, index).some(previous => slugsEquivalent(previous, model))
    );
  const entries = readCatalog(readCodexCatalogPath())?.models ?? [];
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => typeof entry.slug === "string")
    .filter(({ entry }) => entry.visibility === "list")
    .filter(({ entry }) => surface !== "v2" || entry.multi_agent_version === "v2")
    .sort((left, right) => {
      const leftPriority = typeof left.entry.priority === "number" && Number.isFinite(left.entry.priority)
        ? left.entry.priority : Number.MAX_SAFE_INTEGER;
      const rightPriority = typeof right.entry.priority === "number" && Number.isFinite(right.entry.priority)
        ? right.entry.priority : Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority || left.index - right.index;
    })
    .slice(0, MAX_SPAWN_AGENT_MODEL_OVERRIDES);

  const candidates = ordered.map(({ entry }) => ({
    model: entry.slug as string,
    efforts: catalogEntryEfforts(entry),
  }));
  const advertised = candidates.filter(candidate =>
    configured.some(model => slugsEquivalent(model, candidate.model))
  );
  const excluded = configured.flatMap((model): SubagentRosterExclusion[] => {
    const entry = configuredCatalogEntry(entries, model);
    if (!entry) return [{ configured: model, reason: "missing_catalog_entry" }];
    const catalogModel = entry.slug as string;
    if (entry.visibility !== "list") {
      return [{ configured: model, catalogModel, reason: "picker_hidden" }];
    }
    if (surface === "v2" && entry.multi_agent_version !== "v2") {
      return [{ configured: model, catalogModel, reason: "surface_incompatible" }];
    }
    if (!candidates.some(candidate => candidate.model === catalogModel)) {
      return [{ configured: model, catalogModel, reason: "outside_display_limit" }];
    }
    return [];
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
      // Native id for identity text + metadata lookups — the slug may be an encoded
      // alias (`provider/vendor-model`); the model object carries the native id.
      const modelName = model?.id ?? slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        // Proxy-neutral: keep the GPT-5/OpenAI disclaimer but never advertise the opencodex proxy
        // (leaking that into base_instructions is a non-first-party signature → ToS risk).
        e.base_instructions = e.base_instructions.replace(
          CODEX_GPT5_IDENTITY_LINE,
          `You are a coding agent powered by the ${modelName} model. Do not claim to be GPT-5 or made by OpenAI.`,
        );
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
): RawEntry[] {
  // Codex's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const out: RawEntry[] = [];
  const collisionSkipped = resolveSlugAliasCollisions(goModels);
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  for (const slug of gptSlugs) {
    const e = deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
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
    if (rankHit !== undefined) e.priority = rankHit;
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
  return applyMultiAgentMode(out, multiAgentMode);
}

export function resetCatalogRuntimeStateForTests(): void {
  resetBundledCatalogCacheForTests();
  lastDropWarnSignature.clear();
  openAiApiCollisionWarnings.clear();
  comboCatalogWarningSignatures.clear();
  slugAliasCollisionWarnings.clear();
  comboMasqueradeCollisionWarnings.clear();
  clearModelCache();
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

export function mergeCatalogEntriesForSync(
  catalogModels: RawEntry[],
  routedEntries: RawEntry[],
  baseline: Map<string, number>,
  featured: string[],
  wsEnabled: boolean,
  goIds: Set<string> = new Set(),
  template: RawEntry | null = null,
  disabledNative: Set<string> = new Set(),
  gatheredProviderNames: Set<string> = new Set(routedEntries.flatMap(entry => {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    const slash = slug.indexOf("/");
    return slash > 0 ? [slug.slice(0, slash)] : [];
  })),
  multiAgentMode: MultiAgentMode = "default",
  exactComboSlugs: ReadonlySet<string> = new Set(),
  hasPhysicalComboProvider = false,
): RawEntry[] {
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const native = catalogModels
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
    });

  // Backfill any native OpenAI slug that the on-disk catalog is missing (e.g. gpt-5.5), so a
  // routed provider exposing the same id can never delete the native OpenAI/Codex base row.
  const nativeSlugs = new Set(native.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
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

  const freshSlugs = new Set(
    routedEntries.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []),
  );
  let finalRoutedEntries = routedEntries;
  const preservingExistingRouted = routedEntries.length === 0
    && catalogModels.some(m => typeof m.slug === "string" && (m.slug as string).includes("/"));
  if (preservingExistingRouted) {
    finalRoutedEntries = catalogModels.filter(m => typeof m.slug === "string" && (m.slug as string).includes("/"));
  } else {
    const preservedForeignRouted = catalogModels.filter(m => {
      if (typeof m.slug !== "string" || !m.slug.includes("/")) return false;
      const provider = m.slug.slice(0, m.slug.indexOf("/"));
      return !gatheredProviderNames.has(provider) && !freshSlugs.has(m.slug);
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
  if (preservingExistingRouted) {
    console.warn(`[opencodex] catalog sync: routed model fetch returned empty; preserving ${finalRoutedEntries.length} existing routed entr${finalRoutedEntries.length === 1 ? "y" : "ies"} on disk.`);
  }

  const mergedEntries = [...native, ...finalRoutedEntries].map(m => {
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
  // Native enable/disable (single choke point: bare slugs in `disabledModels`). Runs as the
  // LAST pass so the upstream-upgrade branch above can never clobber a hide flag back to list.
  return applyMultiAgentMode(applyNativeVisibility(mergedEntries, disabledNative), multiAgentMode);
}

export async function syncCatalogModels(config: OcxConfig): Promise<{ added: number; path: string }> {
  const catalogPath = readCodexCatalogPath();
  const catalog = loadCatalogForSync(catalogPath);
  if (!catalog) return { added: 0, path: catalogPath };

  const template = findNativeTemplate(catalog);

  const goModels = await gatherRoutedModels(config);
  try {
    // Once-only: preserve the PRISTINE pre-opencodex catalog as the native-priority baseline
    // (later syncs would otherwise overwrite it with featured-modified priorities).
    ensureCatalogBackup(catalogPath, catalog);
  } catch { /* backup best-effort */ }

  // Hide disabled models from Codex, then feature the chosen subagent models (native OR routed)
  // by giving them the lowest priority — see buildCatalogEntries for why priority, not array order.
  const enabledGo = filterCatalogVisibleModels(goModels, config);
  const featured = config.subagentModels ?? [];
  const orderedGoModels = orderForSubagents(enabledGo, featured); // stable tie-break among equal priorities
  const multiAgentMode: MultiAgentMode = config.multiAgentMode === "v1" || config.multiAgentMode === "v2" ? config.multiAgentMode : "default";
  const exactComboSlugs = exactComboCatalogSlugs(config);
  const hasPhysicalComboProvider = Object.hasOwn(config.providers, COMBO_NAMESPACE);
  const goEntries = buildCatalogEntries(template ? JSON.parse(JSON.stringify(template)) : null, [], orderedGoModels, featured, websocketsEnabled(config), multiAgentMode, exactComboSlugs);
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
  const wsEnabled = websocketsEnabled(config);
  catalog.models = mergeCatalogEntriesForSync(catalog.models ?? [], goEntries, baseline, featured, wsEnabled, goIds, template, disabledNativeSlugs(config), gatheredProviderNames, multiAgentMode, exactComboSlugs, hasPhysicalComboProvider);
  clampCatalogModelsToCodexSupport(catalog.models);

  atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  return { added: goEntries.length, path: catalogPath };
}

export function restoreCodexCatalog(): { removed: number; kept: number; path: string } {
  const catalogPath = readCodexCatalogPath();
  const catalog = readCatalog(catalogPath);
  if (!catalog || !Array.isArray(catalog.models)) return { removed: 0, kept: 0, path: catalogPath };
  const backup = readCatalogBackup(catalogPath);
  if (backup && Array.isArray(backup.models)) {
    const removed = (catalog.models ?? []).filter(m => typeof m.slug === "string" && m.slug.includes("/")).length;
    const backupSlugs = new Set(backup.models.flatMap(m => typeof m.slug === "string" ? [m.slug] : []));
    const userNativeAdditions = (catalog.models ?? []).filter(m =>
      typeof m.slug === "string" && !m.slug.includes("/") && !backupSlugs.has(m.slug)
    );
    const restored = {
      ...backup,
      models: [...backup.models, ...userNativeAdditions],
    };
    atomicWriteFile(catalogPath, JSON.stringify(restored, null, 2) + "\n");
    return { removed, kept: restored.models.length, path: catalogPath };
  }
  const before = catalog.models.length;
  const native = catalog.models.filter(m => !(typeof m.slug === "string" && m.slug.includes("/")));
  const removed = before - native.length;
  if (removed > 0) {
    catalog.models = native;
    atomicWriteFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n");
  }
  return { removed, kept: native.length, path: catalogPath };
}

export function invalidateCodexModelsCache(): void {
  try {
    const catalogPath = readCodexCatalogPath();
    if (!existsSync(catalogPath)) return;
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const models = catalog.models ?? catalog;
    const wrapper = {
      fetched_at: "2000-01-01T00:00:00Z",
      client_version: "0.0.0",
      models,
    };
    atomicWriteFile(activeCodexModelsCachePath(), JSON.stringify(wrapper, null, 2) + "\n");
  } catch { /* best-effort */ }
}
