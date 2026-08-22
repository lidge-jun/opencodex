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
import { getModelMetadata, getModelMetadataCaseInsensitive, listModelMetadata, resolveMetadataProvider } from "../../generated/model-metadata";
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


import { NATIVE_OPENAI_CONTEXT_OVERRIDES, SUPPORTED_NATIVE_OPENAI_SLUGS, UPSTREAM_NATIVE_ENTRIES, isNativeOpenAiCapabilityAliasModel, nativeMultiAgentVersion, nativeOpenAiContextWindow, nativeOpenAiMaxInputTokens, type NativeContextLimitsInput } from "./metadata";
import { trustedAccountBoundNativeCatalogSlug } from "./account-models";
import { CODEX_NATIVE_ALIAS_CATALOG_KIND } from "./kinds";

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

/** Stable nonsemantic ownership marker for rows projected from config.customModels. */
export const CODEX_CUSTOM_MODEL_CATALOG_KIND = "custom-model-v1";
/** A formerly ambiguous slug was authoritatively observed as an ordinary provider row. */
export const CODEX_PROVIDER_MODEL_CATALOG_KIND = "provider-model-v1";

export interface CatalogModel {
  id: string;
  provider: string;
  /** Public Codex-facing slug override (used by combo aliases). */
  alias?: string;
  /** Explicit combo takeover of a bare OpenAI-native catalog id. */
  nativeAlias?: boolean;
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
  /**
   * This routed row is an explicitly configured account-native alias on the canonical ChatGPT
   * forward provider. It may inherit pinned native Codex metadata without changing its wire id.
   */
  codexForwardNativeCapabilityAlias?: boolean;
  /** Whether Codex may send Responses text.verbosity for this routed model. */
  supportsVerbosity?: boolean;
  /** Whether this exact routed model has a verified OpenAI-compatible service tier. */
  supportsServiceTier?: boolean;
  supportsReasoningSummaries?: boolean;
  /**
   * Codex tool calling mode for this routed model.
   * "code_mode_only" (default) sets entry.tool_mode = "code_mode_only".
   * "shell" leaves tool_mode unset so Codex declares top-level shell tools (exec_command).
   */
  codexToolMode?: "code_mode_only" | "shell";
  /** Normalized upstream capability names retained for management/API consumers (#485 follow-up). */
  capabilities?: string[];
  /** OpenCodex-only catalog ownership marker; Codex ignores the serialized extension field. */
  catalogKind?: typeof CODEX_CUSTOM_MODEL_CATALOG_KIND | typeof CODEX_PROVIDER_MODEL_CATALOG_KIND;
}

export type RawEntry = Record<string, unknown>;

export type RawCatalog = { models?: RawEntry[]; [k: string]: unknown };

export const JAWCODE_CATALOG_AUGMENT_PROVIDERS = new Set(["opencode-go", "deepseek"]);

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

/**
 * Gemini image-capable chat models produce inline images within text responses
 * via the Responses API. Explicit allowlist only — a broad `/gemini/ && /image/`
 * heuristic resurrects standalone media-gen IDs (e.g. gemini-3-pro-image).
 */
const GEMINI_IMAGE_CHAT_MODEL_IDS = new Set([
  "gemini-3.1-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-3-pro-image-preview",
]);

function isGeminiImageChatModel(id: string): boolean {
  return GEMINI_IMAGE_CHAT_MODEL_IDS.has(id);
}

export function shouldExposeRoutedModel(model: CatalogModel): boolean {
  if (isRoutedModelCompatibilityExcluded(`${model.provider}/${model.id}`)) return false;
  if (isGeminiImageChatModel(model.id)) return true;
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
    m => typeof m.slug === "string"
      && !m.slug.includes("/")
      && "base_instructions" in m
      && m.opencodex_catalog_kind !== CODEX_NATIVE_ALIAS_CATALOG_KIND
      && m.owned_by !== COMBO_NAMESPACE
      && !(typeof m.description === "string" && m.description.startsWith("Routed via opencodex → ")),
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

/**
 * Auto-compaction threshold for a native row.
 *
 * The usual rule is 90% of the window, but a row whose input ceiling sits below that has to
 * clamp to the ceiling instead — otherwise the client keeps filling until upstream answers
 * `context_length_exceeded` and compaction never gets a chance to run. Native GPT-5.6 no
 * longer trips this (922,000 window, 829,800 at 90%), but the routed and API-key rows carry
 * the same family at a 1,050,000 window where 90% would be 945,000 — past the ceiling.
 */
function nativeAutoCompactLimit(contextWindow: number, maxInputTokens: number | undefined, contextCap?: number): number {
  const ninety = Math.floor(contextWindow * 0.9);
  if (typeof maxInputTokens !== "number" || maxInputTokens <= 0) return ninety;
  const cappedMaxInput = applyProviderContextCap(maxInputTokens, contextCap) ?? maxInputTokens;
  return Math.min(ninety, cappedMaxInput, contextWindow);
}

/**
 * Narrow any already-resolved native window by the user levers.
 *
 * Used for the fields the accessors do not own (`max_context_window`, and preserved rows
 * that carry no static override) so every field on a row lands at the same width.
 */
function narrowNativeMaxContextWindow(
  slug: string,
  value: number | undefined,
  limits?: NativeContextLimitsInput,
): number | undefined {
  if (typeof value !== "number" || value <= 0) return value;
  const resolved = nativeOpenAiContextWindow(slug, limits);
  const authoritative = nativeOpenAiContextWindow(slug);
  // The accessor pair tells us how far the levers moved this slug; apply the same delta to a
  // field the accessor does not model, without ever raising it.
  if (resolved === undefined || authoritative === undefined) return value;
  return Math.min(value, Math.max(resolved, 1));
}

export function applyNativeOpenAiContextOverride(entry: RawEntry, limits?: NativeContextLimitsInput): void {
  const nativeSlug = trustedAccountBoundNativeCatalogSlug(entry)
    ?? (isNativeOpenAiEntry(entry) ? entry.slug as string : undefined);
  if (!nativeSlug) return;
  const override = NATIVE_OPENAI_CONTEXT_OVERRIDES[nativeSlug];
  if (override) {
    // Read the effective values through the accessors rather than re-deriving them from the
    // static table: this function used to apply only the provider cap, so a per-model window
    // the dashboard had already accepted was silently written back at full width here.
    if (typeof override.contextWindow === "number") {
      const contextWindow = nativeOpenAiContextWindow(nativeSlug, limits) ?? override.contextWindow;
      entry.context_window = contextWindow;
      entry.auto_compact_token_limit = nativeAutoCompactLimit(
        contextWindow,
        nativeOpenAiMaxInputTokens(nativeSlug, limits) ?? override.maxInputTokens,
        undefined,
      );
    }
    if (typeof override.maxContextWindow === "number") {
      const maxContextWindow = narrowNativeMaxContextWindow(nativeSlug, override.maxContextWindow, limits);
      entry.max_context_window = maxContextWindow;
    }
  }
  // providerContextCaps.openai is a ceiling for native OpenAI rows regardless of where the
  // advertised window came from (#1430): preserved rows without a hardcoded override (e.g.
  // gpt-5.4-mini) must stay under the cap too, and auto-compaction follows the capped window.
  // The per-model window narrows the same rows for the same reason.
  const currentContext = typeof entry.context_window === "number" ? entry.context_window : undefined;
  const cappedContext = narrowNativeMaxContextWindow(nativeSlug, currentContext, limits);
  if (cappedContext !== currentContext && typeof cappedContext === "number") {
    entry.context_window = cappedContext;
    entry.auto_compact_token_limit = nativeAutoCompactLimit(
      cappedContext,
      nativeOpenAiMaxInputTokens(nativeSlug, limits) ?? override?.maxInputTokens,
      undefined,
    );
  }
  const currentMax = typeof entry.max_context_window === "number" ? entry.max_context_window : undefined;
  const cappedMax = narrowNativeMaxContextWindow(nativeSlug, currentMax, limits);
  if (cappedMax !== currentMax) {
    entry.max_context_window = cappedMax;
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
  // Codex parses `input_modalities` as a closed enum. One out-of-enum value (zenmux advertises
  // "video") makes its config loader reject the entire catalog, which takes down plugins, apps and
  // MCP servers — not just that model. Normalize at the single point every entry passes through,
  // because provider metadata, jawcode metadata and effort sync each write this field.
  if (Array.isArray(entry.input_modalities)) {
    const accepted = entry.input_modalities.filter(value =>
      value === "text" || value === "image" || value === "audio");
    // Never leave it empty: an entry with no modality at all is worse than a text-only one.
    entry.input_modalities = accepted.length > 0 ? accepted : ["text"];
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

export interface MultiAgentModeOptions {
  /**
   * When the catalog is in v2 mode, stamp ChatGPT-native rows as v1 instead.
   * Routed parents get v2 (plaintext child tasks). Native Sol/Terra stay on v1
   * so they can still spawn Grok/Claude — ChatGPT encrypts v2 NEW_TASK bodies.
   */
  keepNativeChatGptOnV1?: boolean;
}

/** Catalog rows that run on the ChatGPT backend (encrypt v2 child tasks). */
export function catalogEntryIsNativeChatGpt(entry: RawEntry): boolean {
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  // combo-native-alias-v1 occupies a bare native slug but is routed through
  // OpenCodex. Keep those on v2 unless the row still carries the ChatGPT-forward
  // contract (`use_responses_lite`).
  if (entry.opencodex_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND) {
    return entry.use_responses_lite === true;
  }
  if (trustedAccountBoundNativeCatalogSlug(entry)) return true;
  const routedNativeSlug = slug.startsWith(`${OPENAI_CODEX_PROVIDER_ID}/`)
    ? slug.slice(OPENAI_CODEX_PROVIDER_ID.length + 1)
    : "";
  if (
    entry.opencodex_catalog_kind === CODEX_CUSTOM_MODEL_CATALOG_KIND
    && entry.use_responses_lite === true
    && isNativeOpenAiCapabilityAliasModel(routedNativeSlug)
  ) return true;
  if (UPSTREAM_NATIVE_ENTRIES.has(slug) || SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) return true;
  return false;
}

export const ROUTED_CODEX_TOOL_MODE = "code_mode_only";

export function applyRoutedCodexToolMode(
  entry: RawEntry,
  toolMode?: "code_mode_only" | "shell" | string,
): RawEntry {
  if (toolMode === "shell") {
    delete entry.tool_mode;
    return entry;
  }
  entry.tool_mode = ROUTED_CODEX_TOOL_MODE;
  return entry;
}

/**
 * @param v2FeatureEnabled When the native multi_agent_v2 feature is on, "default"
 *   mode stamps unpinned entries as "v2" instead of deleting the key. The native
 *   binary validates spawn_agent models against THIS catalog with its own
 *   `multi_agent_version == Some(V2)` test (codex-rs multi_agents_common.rs), so an
 *   absent pin means a clean refusal at spawn time — exactly the cross-provider
 *   spawns opencodex exists to enable (option B, devlog
 *   260730_codex_rs_upstream_v2_live_handoff/060). Upstream pins are always
 *   preserved: a genuine "v1" pin is a real capability statement and stays excluded.
 *   With the feature off the output is byte-identical to the historical behavior.
 *
 * `keepNativeChatGptOnV1` only applies when `mode === "v2"`. It leaves Sol/Terra
 * (and other ChatGPT-native rows) on v1 so a native parent can still spawn a
 * routed child. See issue #92.
 */
export function applyMultiAgentMode(
  entries: RawEntry[],
  mode: MultiAgentMode,
  v2FeatureEnabled = false,
  options: MultiAgentModeOptions = {},
): RawEntry[] {
  if (mode === "v2" && options.keepNativeChatGptOnV1 === true) {
    for (const entry of entries) {
      entry.multi_agent_version = catalogEntryIsNativeChatGpt(entry) ? "v1" : "v2";
    }
    return entries;
  }
  if (mode === "default") {
    // Restore upstream defaults: clear any stale forced multi_agent_version and
    // re-apply upstream pins from the snapshot for native entries that have one.
    for (const entry of entries) {
      const slug = typeof entry.slug === "string" ? entry.slug : "";
      const nativeAlias = entry.opencodex_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND;
      const routedNativeSlug = slug.startsWith(`${OPENAI_CODEX_PROVIDER_ID}/`)
        ? slug.slice(OPENAI_CODEX_PROVIDER_ID.length + 1)
        : "";
      const codexForwardCapabilityAlias = entry.opencodex_catalog_kind === CODEX_CUSTOM_MODEL_CATALOG_KIND
        && entry.use_responses_lite === true
        && isNativeOpenAiCapabilityAliasModel(routedNativeSlug)
        ? routedNativeSlug
        : undefined;
      const upstreamPin = nativeAlias
        ? nativeMultiAgentVersion(slug)
        : codexForwardCapabilityAlias
          ? nativeMultiAgentVersion(codexForwardCapabilityAlias)
          : UPSTREAM_NATIVE_ENTRIES.get(trustedAccountBoundNativeCatalogSlug(entry) ?? slug)?.multi_agent_version;
      if (typeof upstreamPin === "string") {
        entry.multi_agent_version = upstreamPin;
      } else if (v2FeatureEnabled) {
        entry.multi_agent_version = "v2";
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

export function normalizeRoutedCatalogEntry(
  entry: RawEntry,
  parallelToolCalls = false,
  toolMode?: "code_mode_only" | "shell" | string,
): RawEntry {
  delete entry.model_messages;
  delete entry.tool_mode;
  applyRoutedCodexToolMode(entry, toolMode);
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  // Routed rows cloned from native templates must not inherit OpenAI-only summary delivery.
  // Explicit provider/model metadata is re-applied after this normalization step.
  delete entry.supports_reasoning_summaries;
  const isCursorEntry = typeof entry.slug === "string" && entry.slug.startsWith("cursor/");
  // `supports_search_tool` selects Codex's deferred tool-discovery surface; it is not the hosted
  // web-search capability. Routed rows also carry tool_mode=code_mode_only (below), and under code
  // mode DEFERRED MCP tools remain callable through exec's `tools` global / ALL_TOOLS without any
  // tool_search round-trip (upstream codex-rs code_mode suite; live canary 2026-08-13: routed
  // kimi/k3 called tools.mcp__node_repl__js → isError:false). Stamping false here instead forces
  // every MCP declaration into exec.description — a measured 2.7x turn-1 payload regression
  // (96,699 → 258,929 chars; devlog/_plan/260813_tool_catalog_deferral/010). So every routed
  // code-mode row advertises deferred discovery. Cursor still omits hosted web-search metadata below,
  // but disabling this separate exposure bit can inflate `exec` past Cursor's 120 KB wire cap (#1830).
  if (isCursorEntry) {
    delete entry.web_search_tool_type;
  } else {
    entry.web_search_tool_type = "text_and_image";
  }
  entry.supports_search_tool = true;
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

/**
 * Resolve the generated jawcode metadata row for a provider/model pair.
 *
 * Exported because it is the SECOND source of real capability assertions:
 * `applyCatalogMetadata` writes context/modalities from it without ever
 * touching a `CatalogModel`, so the routing-evidence provenance stamp in
 * `applyCatalogModelMetadata` has to consult the same table. Both callers share
 * this one lookup rather than duplicating the resolve/case-fold rules, which is
 * what keeps the serialized entry and its provenance from drifting apart.
 */
export function generatedModelMetadata(provider: string, modelId: string) {
  const jawcodeProvider = resolveMetadataProvider(provider);
  if (!jawcodeProvider) return undefined;
  return getModelMetadata(jawcodeProvider, modelId)
    ?? (shouldCaseFoldMetadataModelId(provider) ? getModelMetadataCaseInsensitive(jawcodeProvider, modelId) : undefined);
}

export function applyCatalogMetadata(entry: RawEntry, provider: string, modelId: string, contextCap?: number): void {
  const meta = generatedModelMetadata(provider, modelId);
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
  return (catalog?.models ?? []).some(m => typeof m.slug === "string"
    && (m.slug.includes("/") || m.opencodex_catalog_kind === CODEX_NATIVE_ALIAS_CATALOG_KIND));
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
