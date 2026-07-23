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
import { encodeRoutedModelId, routedSlug, slugEquals, slugsEquivalent } from "../../providers/slug-codec";
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


import { NATIVE_OPENAI_CONTEXT_OVERRIDES, SUPPORTED_NATIVE_OPENAI_SLUGS, UPSTREAM_NATIVE_ENTRIES } from "./metadata";

export function legacyCatalogBackupPath(): string {
  return join(getConfigDir(), "catalog-backup.json");
}

export function catalogBackupPathFor(catalogPath: string): string {
  const normalized = process.platform === "win32" ? resolve(catalogPath).toLowerCase() : resolve(catalogPath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `catalog-backup-${id}.json`);
}

export function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function activeCodexHome(): string | null {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return null;
  const path = resolve(expandUserPath(raw));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function activeCodexConfigPath(): string {
  const home = activeCodexHome();
  return home ? join(home, "config.toml") : CODEX_CONFIG_PATH;
}

export function activeDefaultCatalogPath(): string {
  const home = activeCodexHome();
  return home ? join(home, "opencodex-catalog.json") : DEFAULT_CATALOG_PATH;
}

export function activeCodexModelsCachePath(): string {
  const home = activeCodexHome();
  return home ? join(home, "models_cache.json") : CODEX_MODELS_CACHE_PATH;
}

export function resolveActiveCodexConfigPath(path: string): string {
  const home = activeCodexHome();
  return home ? resolve(home, path) : resolveCodexConfigPath(path);
}

export function isDefaultCatalogPath(path: string): boolean {
  return samePath(path, activeDefaultCatalogPath());
}

export interface CatalogModel {
  id: string;
  provider: string;
  /** Public Codex-facing slug override (used by combo aliases). */
  alias?: string;
  /**
   * Display-only Codex catalog `display_name` override. Relabels the picker row ONLY — it never
   * affects the routing slug, alias-collision order, native marketing-name precedence, or provider
   * behavior. When unset, the entry falls back to its Codex-facing slug (the historical behavior).
   * Native upstream entries (e.g. gpt-5.6-sol → "GPT-5.6-Sol") come from the pinned snapshot path
   * which carries no CatalogModel, so a configured displayName can never override a native name.
   */
  displayName?: string;
  owned_by?: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  contextWindow?: number;
  maxInputTokens?: number;
  contextCap?: number;
  contextCapped?: boolean;
  inputModalities?: string[];
  /** Provider opted into parallel tool calls (OcxProviderConfig.parallelToolCalls). */
  parallelToolCalls?: boolean;
  /** Whether Codex may send Responses text.verbosity for this routed model. */
  supportsVerbosity?: boolean;
  supportsReasoningSummaries?: boolean;
}

export type RawEntry = Record<string, unknown>;

export type RawCatalog = { models?: RawEntry[]; [k: string]: unknown };

export const JAWCODE_CATALOG_AUGMENT_PROVIDERS = new Set(["opencode-go"]);

export const ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS = new Set([
  // Issue #82: Zen Go /models advertises HY3, but Console Go rejects it as outside the lite list.
  "opencode-go/hy3-preview",
]);

export function isRoutedModelCompatibilityExcluded(slug: string): boolean {
  return ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS.has(slug);
}

export const MEDIA_GEN_FAMILIES = [
  "dall-e", "dalle", "imagen", "sora", "veo", "flux", "kling",
  "seedance", "hailuo", "stable-diffusion", "sdxl", "midjourney",
];

export const MEDIA_GEN_ID_RE = new RegExp(
  `(?:^|[/_-])(?:image|video)(?:[/_-]|$)|(?:^|[/_-])(?:${MEDIA_GEN_FAMILIES.join("|")})(?:[/_-]|$|\\d)`,
  "i",
);

export function isMediaGenerationModelId(id: string): boolean {
  return MEDIA_GEN_ID_RE.test(id);
}

export function shouldExposeRoutedModel(model: CatalogModel): boolean {
  if (isRoutedModelCompatibilityExcluded(`${model.provider}/${model.id}`)) return false;
  if (model.provider === "cursor" && model.id === "gemini-3-pro-image-preview") return true;
  return !isMediaGenerationModelId(model.id);
}

export function readCodexCatalogPath(): string {
  try {
    const configPath = activeCodexConfigPath();
    if (existsSync(configPath)) {
      const toml = readFileSync(configPath, "utf-8");
      const path = readRootTomlString(toml, "model_catalog_json");
      if (path) return resolveActiveCodexConfigPath(path);
    }
  } catch { /* ignore */ }
  return activeDefaultCatalogPath();
}

export function parseCatalogJson(raw: string): RawCatalog | null {
  try {
    const cat = JSON.parse(raw);
    return (cat && Array.isArray(cat.models)) ? cat : null;
  } catch { return null; }
}

export function readCatalog(path: string): RawCatalog | null {
  try {
    if (!existsSync(path)) return null;
    return parseCatalogJson(readFileSync(path, "utf-8"));
  } catch { return null; }
}

export function findNativeTemplate(catalog: RawCatalog | null): RawEntry | null {
  return catalog?.models?.find(
    m => typeof m.slug === "string" && !m.slug.includes("/") && "base_instructions" in m,
  ) ?? null;
}

/**
 * Native OpenAI slugs that do NOT support the Fast (priority) service tier.
 * Upstream may advertise service_tiers for these models, but the tier is not
 * actually available — strip it so the Codex UI does not offer a dead toggle.
 */
const NO_FAST_TIER_NATIVE_SLUGS = new Set([
  "gpt-5.3-codex-spark",
]);

export function normalizeServiceTiers(entry: RawEntry): RawEntry {
  // Strip service tiers for models that do not actually support the Fast tier.
  if (typeof entry.slug === "string" && NO_FAST_TIER_NATIVE_SLUGS.has(entry.slug)) {
    delete entry.service_tier;
    delete entry.service_tiers;
    delete entry.default_service_tier;
    delete entry.additional_speed_tiers;
    return entry;
  }
  // Codex stores the user-facing config spelling as "fast", but the catalog/request
  // service tier id is "priority" in current codex-rs. Keep legacy catalogs working.
  if (entry.service_tier === "fast") entry.service_tier = "priority";
  if (Array.isArray(entry.service_tiers)) {
    entry.service_tiers = entry.service_tiers.map(tier => {
      if (tier && typeof tier === "object" && "id" in tier && tier.id === "fast") {
        return { ...tier, id: "priority" };
      }
      return tier;
    });
  }
  return entry;
}

export function ensureAutoCompactTokenLimit(entry: RawEntry): RawEntry {
  if (
    typeof entry.context_window === "number"
    && entry.context_window > 0
    && typeof entry.auto_compact_token_limit !== "number"
  ) {
    entry.auto_compact_token_limit = Math.floor(entry.context_window * 0.9);
  }
  return entry;
}

export function isNativeOpenAiEntry(entry: RawEntry): boolean {
  return typeof entry.slug === "string" && !entry.slug.includes("/");
}

export function applyNativeOpenAiContextOverride(entry: RawEntry): void {
  if (!isNativeOpenAiEntry(entry)) return;
  const override = NATIVE_OPENAI_CONTEXT_OVERRIDES[entry.slug as string];
  if (!override) return;
  if (typeof override.contextWindow === "number") {
    entry.context_window = override.contextWindow;
    entry.auto_compact_token_limit = Math.floor(override.contextWindow * 0.9);
  }
  if (typeof override.maxContextWindow === "number") {
    entry.max_context_window = override.maxContextWindow;
  }
}

export function ensureStrictCatalogFields(
  entry: RawEntry,
  options: { preserveExactInputModalities?: boolean; isRouted?: boolean } = {},
): RawEntry {
  if (typeof entry.supports_reasoning_summaries !== "boolean") entry.supports_reasoning_summaries = false;
  if (typeof entry.default_reasoning_summary !== "string") entry.default_reasoning_summary = "none";
  if (typeof entry.support_verbosity !== "boolean") entry.support_verbosity = true;
  if (typeof entry.default_verbosity !== "string") entry.default_verbosity = "low";
  if (typeof entry.apply_patch_tool_type !== "string") entry.apply_patch_tool_type = "freeform";
  if (!entry.truncation_policy || typeof entry.truncation_policy !== "object" || Array.isArray(entry.truncation_policy)) {
    entry.truncation_policy = { mode: "tokens", limit: 10000 };
  }
  if (typeof entry.supports_parallel_tool_calls !== "boolean") entry.supports_parallel_tool_calls = true;
  if (typeof entry.supports_image_detail_original !== "boolean") entry.supports_image_detail_original = false;
  if (!Array.isArray(entry.experimental_supported_tools)) entry.experimental_supported_tools = [];
  if (!Array.isArray(entry.input_modalities) && !options.preserveExactInputModalities) {
    entry.input_modalities = ["text"];
  }
  const contextWindow = typeof entry.context_window === "number" && entry.context_window > 0 ? entry.context_window : 128000;
  entry.context_window = contextWindow;
  if (
    typeof entry.max_context_window !== "number"
    || entry.max_context_window <= 0
    || ((options.isRouted === true || !isNativeOpenAiEntry(entry)) && entry.max_context_window > contextWindow)
  ) {
    entry.max_context_window = contextWindow;
  }
  if (typeof entry.effective_context_window_percent !== "number") entry.effective_context_window_percent = 95;
  if (typeof entry.comp_hash !== "string") entry.comp_hash = "opencodex";
  return ensureAutoCompactTokenLimit(entry);
}

export type MultiAgentMode = "v1" | "default" | "v2";

export function applyMultiAgentMode(entries: RawEntry[], mode: MultiAgentMode): RawEntry[] {
  if (mode === "default") {
    // Restore upstream defaults: clear any stale forced multi_agent_version and
    // re-apply upstream pins from the snapshot for native entries that have one.
    for (const entry of entries) {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);
      const upstreamPin = upstream?.multi_agent_version;
      if (typeof upstreamPin === "string") {
        entry.multi_agent_version = upstreamPin;
      } else {
        delete entry.multi_agent_version;
      }
    }
    return entries;
  }
  for (const entry of entries) {
    entry.multi_agent_version = mode;
  }
  return entries;
}

export function normalizeRoutedCatalogEntry(entry: RawEntry, parallelToolCalls = false): RawEntry {
  delete entry.model_messages;
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  // Routed rows cloned from native templates must not inherit OpenAI-only summary delivery.
  // Per-model routed opt-ins can be added once provider metadata exposes this capability.
  delete entry.supports_reasoning_summaries;
  const isCursorEntry = typeof entry.slug === "string" && entry.slug.startsWith("cursor/");
  // Routed providers use opencodex sidecars and client-executed tool discovery. The sidecar
  // runs through native gpt-5.4-mini, so image search is available and verbalized for text-only
  // models. EXCEPT cursor: its runTurn transport bypasses the web-search plan entirely and
  // rejects server search queries — advertising the tool would make models call into a void.
  if (isCursorEntry) {
    delete entry.web_search_tool_type;
    entry.supports_search_tool = false;
  } else {
    entry.web_search_tool_type = "text_and_image";
    entry.supports_search_tool = true;
  }
  // Cursor's transport already serializes overlapping tool calls into atomic Responses tool events.
  // Advertising parallel calls lets Codex send the same native capability bit it sends for OpenAI.
  // Opt-in providers (OcxProviderConfig.parallelToolCalls, e.g. xAI) advertise it too: the
  // openai-chat adapter stops forcing parallel_tool_calls:false and the buffered stream parser
  // assembles multi-call turns (devlog/_plan/260709_parallel_tool_calls).
  entry.supports_parallel_tool_calls = isCursorEntry || parallelToolCalls === true;
  return ensureStrictCatalogFields(entry, { isRouted: true });
}

/** Resolve reasoning-summary support from the active Codex catalog for wire sanitization. */
export function catalogModelSupportsReasoningSummaries(modelId: string): boolean | undefined {
  if (typeof modelId !== "string" || modelId.length === 0) return undefined;
  const catalog = readCatalog(readCodexCatalogPath()) ?? readCatalog(activeCodexModelsCachePath());
  const models = catalog?.models ?? [];
  const exact = models.find(entry => entry.slug === modelId || entry.id === modelId);
  if (typeof exact?.supports_reasoning_summaries === "boolean") {
    return exact.supports_reasoning_summaries;
  }
  const encodedModelId = encodeRoutedModelId(modelId);
  const matches = models.filter(entry => (
    typeof entry.slug === "string"
    && entry.slug.includes("/")
    && entry.slug.slice(entry.slug.indexOf("/") + 1) === encodedModelId
    && typeof entry.supports_reasoning_summaries === "boolean"
  ));
  const values = new Set(matches.map(entry => entry.supports_reasoning_summaries as boolean));
  return values.size === 1 ? values.values().next().value : undefined;
}

export function applyJawcodeCatalogMetadata(entry: RawEntry, provider: string, modelId: string, contextCap?: number): void {
  const jawcodeProvider = resolveJawcodeProvider(provider);
  if (!jawcodeProvider) return;
  const meta = getJawcodeModelMetadata(jawcodeProvider, modelId)
    ?? (shouldCaseFoldMetadataModelId(provider) ? getJawcodeModelMetadataCaseInsensitive(jawcodeProvider, modelId) : undefined);
  if (!meta) return;
  if (typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
    const contextWindow = applyProviderContextCap(meta.contextWindow, contextCap) ?? meta.contextWindow;
    entry.context_window = contextWindow;
    entry.max_context_window = contextWindow;
    entry.auto_compact_token_limit = Math.floor(contextWindow * 0.9);
  }
  if (Array.isArray(meta.input) && meta.input.length > 0) {
    entry.input_modalities = meta.input;
  }
}

export function catalogModelSlug(model: CatalogModel): string {
  return model.alias ?? routedSlug(model.provider, model.id);
}

export function filterSupportedNativeSlugs(models: RawEntry[]): string[] {
  return models
    .filter(m => typeof m.slug === "string" && !(m.slug as string).includes("/") && m.visibility === "list" && SUPPORTED_NATIVE_OPENAI_SLUGS.has(m.slug as string))
    .map(m => m.slug as string);
}

export function readCatalogBackup(catalogPath: string): RawCatalog | null {
  return readCatalog(catalogBackupPathFor(catalogPath))
    ?? (isDefaultCatalogPath(catalogPath) ? readCatalog(legacyCatalogBackupPath()) : null);
}

export function catalogHasRoutedEntries(catalog: RawCatalog | null): boolean {
  return (catalog?.models ?? []).some(m => typeof m.slug === "string" && m.slug.includes("/"));
}

export function writePristineCatalogBackup(backupPath: string, catalogPath: string, catalog: RawCatalog): void {
  if (existsSync(backupPath)) return;
  const onDisk = readCatalog(catalogPath);
  if (onDisk && !catalogHasRoutedEntries(onDisk)) {
    copyFileSync(catalogPath, backupPath);
    return;
  }
  if (!catalogHasRoutedEntries(catalog)) {
    atomicWriteFile(backupPath, JSON.stringify(catalog, null, 2) + "\n");
  }
}

export function ensureCatalogBackup(catalogPath: string, catalog: RawCatalog): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePristineCatalogBackup(catalogBackupPathFor(catalogPath), catalogPath, catalog);
  if (isDefaultCatalogPath(catalogPath)) writePristineCatalogBackup(legacyCatalogBackupPath(), catalogPath, catalog);
}

export function readNativeBaseline(catalogPath: string): Map<string, number> {
  const backup = readCatalogBackup(catalogPath);
  const out = new Map<string, number>();
  for (const e of backup?.models ?? []) {
    if (typeof e.slug === "string" && !e.slug.includes("/") && typeof e.priority === "number") {
      out.set(e.slug, e.priority);
    }
  }
  return out;
}
