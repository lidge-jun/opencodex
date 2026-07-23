import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { atomicWriteFile, expandUserPath, getConfigDir, websocketsEnabled } from "../config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "./paths";
import { clearModelCache, DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, isModelsFetchCoolingDown, markModelsFetchFailure, setCached } from "./model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "../oauth";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import { CODEX_REASONING_LEVELS, codexEffortRank, configuredReasoningEfforts, modelRecordValue, sanitizeCodexReasoningEfforts } from "../reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "../generated/jawcode-model-metadata";
import { enrichProviderFromRegistry, shouldCaseFoldMetadataModelId } from "../providers/derive";
import { getProviderRegistryEntry } from "../providers/registry";
import { applyProviderContextCap, providerContextCap } from "../providers/context-cap";
import { encodeRoutedModelId, routedSlug, slugEquals, slugsEquivalent } from "../providers/slug-codec";
import { CODEX_GPT5_IDENTITY_LINE } from "../adapters/identity";
import { filterCursorConfiguredModelsByLiveDiscovery } from "../adapters/cursor/discovery";
import { fetchCursorUsableModels } from "../adapters/cursor/live-models";
import { isCanonicalOpenAiForwardProvider, OPENAI_API_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID } from "../providers/openai-tiers";
import {
  COMBO_NAMESPACE,
  comboModelId,
  getCombo,
  listComboIds,
  targetKey,
} from "../combos";
import type { NormalizedComboConfig } from "../combos/types";
import { providerDestinationResolvedError } from "../lib/destination-policy";
import { redactSecretString } from "../lib/redact";
import upstreamModelsSnapshot from "./data/upstream-models.json";

const BUNDLED_CATALOG_CACHE_MS = 60_000;
let bundledCatalogCache: { expiresAt: number; value: RawCatalog | null } | null = null;

function legacyCatalogBackupPath(): string {
  return join(getConfigDir(), "catalog-backup.json");
}

function catalogBackupPathFor(catalogPath: string): string {
  const normalized = process.platform === "win32" ? resolve(catalogPath).toLowerCase() : resolve(catalogPath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `catalog-backup-${id}.json`);
}

function samePath(a: string, b: string): boolean {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function activeCodexHome(): string | null {
  const raw = process.env.CODEX_HOME?.trim();
  if (!raw) return null;
  const path = resolve(expandUserPath(raw));
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function activeCodexConfigPath(): string {
  const home = activeCodexHome();
  return home ? join(home, "config.toml") : CODEX_CONFIG_PATH;
}

function activeDefaultCatalogPath(): string {
  const home = activeCodexHome();
  return home ? join(home, "opencodex-catalog.json") : DEFAULT_CATALOG_PATH;
}

function activeCodexModelsCachePath(): string {
  const home = activeCodexHome();
  return home ? join(home, "models_cache.json") : CODEX_MODELS_CACHE_PATH;
}

function resolveActiveCodexConfigPath(path: string): string {
  const home = activeCodexHome();
  return home ? resolve(home, path) : resolveCodexConfigPath(path);
}

function isDefaultCatalogPath(path: string): boolean {
  return samePath(path, activeDefaultCatalogPath());
}

/**
 * Native OpenAI / Codex models served via ChatGPT OAuth passthrough — FALLBACK only. The ChatGPT
 * backend has no `GET /models`, so the real set is read from the live Codex catalog via
 * nativeOpenAiSlugs(); this static list is used when no catalog is present, plus selected documented
 * Codex-native additions that may lag in a user's installed Codex catalog.
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

const DOCUMENTED_NATIVE_OPENAI_ADDITIONS = [
  "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];

/**
 * The ONLY native OpenAI/Codex slugs opencodex advertises. A user's installed Codex ships extra
 * native models in its live catalog (e.g. `gpt-5.2`, `gpt-5.3-codex`, `codex-auto-review`); those
 * are legacy/internal and must never surface in `/v1/models` or the subagent picker. Live-catalog
 * native slugs are filtered against this allowlist so only the supported set is exposed.
 */
const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);

/**
 * True when a bare slug is an OpenAI/Codex-family native that opencodex does NOT support
 * (legacy/internal like `gpt-5.2`, `gpt-5.3-codex`, `codex-auto-review`). Used to drop these
 * from the ON-DISK catalog so the Codex file picker matches the live `/v1/models` filter,
 * WITHOUT removing genuine user-added natives (non gpt-/codex- slugs are preserved).
 */
function isUnsupportedOpenAiNativeSlug(slug: string): boolean {
  if (slug.includes("/")) return false;
  if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) return false;
  return /^(?:gpt|codex)-/.test(slug);
}

const NATIVE_GPT56_CONTEXT_WINDOW = 372_000;

const NATIVE_OPENAI_CONTEXT_OVERRIDES: Record<string, { contextWindow?: number; maxContextWindow?: number }> = {
  "gpt-5.5": { contextWindow: 272_000, maxContextWindow: 272_000 },
  "gpt-5.4": { contextWindow: 1_000_000, maxContextWindow: 1_000_000 },
  "gpt-5.3-codex-spark": { contextWindow: 100_000, maxContextWindow: 100_000 },
  "gpt-5.6-sol": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
  "gpt-5.6-terra": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
  "gpt-5.6-luna": { contextWindow: NATIVE_GPT56_CONTEXT_WINDOW, maxContextWindow: NATIVE_GPT56_CONTEXT_WINDOW },
};

/** Known context window for a supported native OpenAI slug (management API display). */
export function nativeOpenAiContextWindow(slug: string): number | undefined {
  return NATIVE_OPENAI_CONTEXT_OVERRIDES[slug]?.contextWindow
    ?? (typeof UPSTREAM_NATIVE_ENTRIES.get(slug)?.context_window === "number"
      ? UPSTREAM_NATIVE_ENTRIES.get(slug)!.context_window as number
      : undefined);
}

/* ── Native-slug capability helpers for combo member resolution (issue #268) ── */

/** Input modalities for a native OpenAI slug, defaulting to the GPT family baseline. */
function nativeInputModalities(slug: string): string[] {
  const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (Array.isArray(upstream?.input_modalities) && upstream!.input_modalities!.length > 0) {
    return [...upstream!.input_modalities as string[]];
  }
  // gpt-5.3-codex-spark is not in the upstream snapshot; all supported natives are
  // text+image capable, so default to the family baseline rather than text-only.
  return ["text", "image"];
}

/** Reasoning effort ladder for a native OpenAI slug, mirroring the catalog emission path. */
function nativeReasoningEfforts(slug: string): string[] {
  const upstream = UPSTREAM_NATIVE_ENTRIES.get(slug);
  const levels = Array.isArray(upstream?.supported_reasoning_levels)
    ? upstream!.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length > 0) {
    const efforts = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
    // gpt-5.6 natives get max+ultra restored (ensureGpt56ReasoningLevels catalog path does
    // the same); older natives (gpt-5.5/5.4/5.4-mini/5.3-codex-spark) stop at xhigh per
    // upstream snapshot.
    if (isGpt56NativeSlug(slug)) {
      const set = new Set(efforts);
      for (const e of ["max", "ultra"]) set.add(e);
      return [...set];
    }
    return efforts;
  }
  // gpt-5.3-codex-spark is not in upstream snapshot — use the standard old-ladder default.
  return ["low", "medium", "high", "xhigh"];
}

/** Whether a native OpenAI slug supports parallel tool calls (per upstream snapshot). */
function nativeParallelToolCalls(slug: string): boolean {
  return UPSTREAM_NATIVE_ENTRIES.get(slug)?.supports_parallel_tool_calls === true
    || false;
}

/** Quick check whether the config has any combo targets at all. */
function hasComboTargets(config: { combos?: Record<string, { targets?: unknown[] }> }): boolean {
  const combos = config.combos;
  if (!combos) return false;
  return Object.values(combos).some(c => Array.isArray(c?.targets) && c!.targets!.length > 0);
}

/**
 * Bare (slash-free) entries of `disabledModels` — the native GPT half of the single
 * enable/disable choke point. Routed ids are always namespaced `provider/id`, so bare
 * slugs can never collide with them.
 */
export function disabledNativeSlugs(config: Pick<OcxConfig, "disabledModels">): Set<string> {
  return new Set((config.disabledModels ?? []).filter(id => !id.includes("/")));
}

/**
 * Native slugs to expose on bare availability surfaces (the OpenAI list shape of
 * /v1/models): the advertised set minus config-disabled natives. Catalog-shaped
 * emissions keep disabled entries with `visibility: "hide"` instead (codex-rs hides
 * them from the picker itself), so sync/restore stays symmetric.
 */
export function visibleNativeSlugs(config: Pick<OcxConfig, "disabledModels">): string[] {
  const disabled = disabledNativeSlugs(config);
  return nativeOpenAiSlugs().filter(slug => !disabled.has(slug));
}

/**
 * Native GPT rows for the management dashboard. Sourced from the STATIC supported set —
 * independent of catalog visibility flips, so a disabled model stays listed and can be
 * re-enabled from the GUI.
 */
export function nativeModelRows(config: Pick<OcxConfig, "disabledModels">): Array<{ slug: string; disabled: boolean; contextWindow?: number }> {
  const disabled = disabledNativeSlugs(config);
  return NATIVE_OPENAI_MODELS.map(slug => {
    const contextWindow = nativeOpenAiContextWindow(slug);
    return { slug, disabled: disabled.has(slug), ...(contextWindow !== undefined ? { contextWindow } : {}) };
  });
}

/**
 * Central visibility flip for supported native entries in catalog-shaped output:
 * disabled -> "hide" (entry preserved for template/backup/restore), enabled -> "list".
 * Unsupported natives and routed entries are untouched.
 */
export function applyNativeVisibility(entries: RawEntry[], disabledNative: Set<string>): RawEntry[] {
  for (const entry of entries) {
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug || slug.includes("/") || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) continue;
    entry.visibility = disabledNative.has(slug) ? "hide" : "list";
  }
  return entries;
}

/**
 * Pinned upstream models.json snapshot (openai/codex PR #31684, codex-rs/models-manager/models.json)
 * providing the REAL catalog entries for supported native slugs the installed Codex binary may
 * predate (gpt-5.6-sol/terra/luna). Restricted to supported gpt-5.6 slugs ONLY: for
 * gpt-5.5/5.4/5.4-mini the installed catalog's live entries are RICHER than this bundled
 * fallback (the snapshot ships gpt-5.5 with tool_mode null / use_responses_lite false /
 * comp_hash 2911), so substituting them would downgrade real entries. gpt-5.6 has no real
 * installed entry to downgrade — the alternative is gpt-5.5-template synthesis, which this
 * snapshot strictly improves on (exact ladders: luna has NO ultra; sol defaults to low).
 */
const UPSTREAM_NATIVE_ENTRIES: Map<string, RawEntry> = new Map(
  ((upstreamModelsSnapshot as unknown as { models?: RawEntry[] }).models ?? [])
    .filter(m => typeof m.slug === "string"
      && SUPPORTED_NATIVE_OPENAI_SLUGS.has(m.slug as string)
      && (m.slug as string).startsWith("gpt-5.6-"))
    .map(m => [m.slug as string, m]),
);

/**
 * Deep clone of the pinned upstream entry for a native slug, adapted for ocx emission:
 * `minimal_client_version` is stripped (a pinned client-version gate would hide the model from
 * older installed clients; ocx targets whatever client is installed, matching the synthesis
 * path which never emits the field). `prefer_websockets` is left in place — the central
 * websocket overrides in buildCatalogEntries/mergeCatalogEntriesForSync gate it with
 * supports_websockets.
 */
export function upstreamNativeEntry(slug: string): RawEntry | null {
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  if (!entry) return null;
  const clone = JSON.parse(JSON.stringify(entry)) as RawEntry;
  delete clone.minimal_client_version;
  return clone;
}

/**
 * Mock-max wire clamp (devlog/260709_v2_gated_ultra): the catalog advertises `ultra`
 * on natives whose REAL upstream ladder stops below max (gpt-5.5/5.4/…); codex-rs
 * converts ultra -> max at its inference boundary, and the ChatGPT backend then
 * rejects `max` for those models ("Invalid value: 'max'"). Returns the model's
 * highest real effort when the requested top-tier effort (max/ultra) is not in the
 * native ladder; null when no clamp is needed (routed slugs, real-max natives,
 * ordinary efforts, unknown slugs).
 */
export function nativeEffortClamp(slug: string, effort: string | undefined): string | null {
  if (!effort || (effort !== "max" && effort !== "ultra")) return null;
  if (slug.includes("/")) return null; // routed models map efforts in their adapters
  const entry = UPSTREAM_NATIVE_ENTRIES.get(slug);
  const levels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length === 0) {
    // Not snapshot-covered. gpt-5.6 natives have a REAL max rung (ensureGpt56ReasoningLevels
    // restores it even off-snapshot) -> never clamp. Every other bare native (gpt-5.5/5.4/
    // 5.4-mini/5.3-codex-spark and future old-ladder slugs) really stops at xhigh — the
    // ChatGPT backend error names exactly none..xhigh — so clamp the synthetic top tier.
    return isGpt56NativeSlug(slug) ? null : "xhigh";
  }
  const supported = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
  if (supported.includes(effort)) return null;
  const rank = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const highest = supported
    .filter(e => rank.includes(e))
    .sort((a, b) => rank.indexOf(a) - rank.indexOf(b))
    .at(-1);
  return highest ?? null;
}

/**
 * Request-time guard for `nativeEffortClamp`: only the canonical built-in OpenAI/Codex
 * forward provider should ever use the native mock-max repair. Bare third-party
 * `defaultModel` selectors are still routed models whose adapters own effort mapping,
 * and explicit `provider/model` requests are routed by construction.
 */
export function shouldApplyNativeEffortClamp(
  providerName: string,
  provider: OcxProviderConfig,
  requestedModelId: string,
): boolean {
  return !requestedModelId.includes("/")
    && providerName === OPENAI_CODEX_PROVIDER_ID
    && isCanonicalOpenAiForwardProvider(provider);
}

/**
 * True when a preserved catalog entry for a snapshot-covered slug should be UPGRADED to the
 * pinned upstream entry. Discriminator: `display_name === slug` — both ocx synthesis and the
 * codex-rs model_info fallback stamp the bare slug as display name, while genuine upstream
 * entries always carry marketing names ("GPT-5.6-Sol"). Fallback-quality entries are
 * intentionally overwritten; a real newer catalog entry is preserved untouched.
 */
function shouldUpgradeToUpstreamEntry(entry: RawEntry): boolean {
  return typeof entry.slug === "string"
    && UPSTREAM_NATIVE_ENTRIES.has(entry.slug)
    && entry.display_name === entry.slug;
}

/**
 * Reasoning efforts each requested slug advertises in the INJECTED on-disk catalog —
 * the exact list codex-rs validates spawn_agent `reasoning_effort` arguments against
 * (unsupported rungs are then clamped on the wire, nativeEffortClamp/adapters).
 * Slugs missing from the catalog are omitted from the result. Used by the delegation
 * prompt to advertise the featured sub-agent roster with honest effort ladders.
 */
export function catalogModelEfforts(slugs: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (slugs.length === 0) return out;
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog) return out;
  for (const entry of catalog.models ?? []) {
    if (typeof entry.slug !== "string") continue;
    // Tolerate raw legacy config slugs (`provider/vendor/model`) against the
    // Codex-facing encoded catalog slug (`provider/vendor-model`).
    const callerSlug = slugs.find(s => slugsEquivalent(s, entry.slug as string));
    if (callerSlug === undefined) continue;
    const levels = Array.isArray(entry.supported_reasoning_levels)
      ? entry.supported_reasoning_levels as Array<{ effort?: string }>
      : [];
    const efforts = levels.flatMap(l => typeof l.effort === "string" ? [l.effort] : []);
    if (efforts.length > 0) out.set(callerSlug, efforts);
  }
  return out;
}

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

function catalogEntryEfforts(entry: RawEntry): string[] {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  return levels.flatMap(level => typeof level.effort === "string" ? [level.effort] : []);
}

function configuredCatalogEntry(entries: RawEntry[], configured: string): RawEntry | undefined {
  return entries.find(entry => entry.slug === configured)
    ?? entries.find(entry => typeof entry.slug === "string" && slugsEquivalent(configured, entry.slug));
}

/**
 * The effective sub-agent roster for a collaboration surface: Codex's picker-visible
 * (`visibility === "list"`), surface-compatible, priority-sorted first five catalog
 * entries (candidates), intersected with the configured subagentModels (advertised),
 * plus a reason for every configured entry that did not make the set (excluded).
 * Canonical `entry.slug` is returned; legacy raw aliases are matching inputs only.
 */
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

/**
 * The native (passthrough) OpenAI slugs to advertise — the LIVE Codex catalog's own bare slugs when
 * available, with documented Codex-native additions layered in, else the static fallback above.
 * Single source for the /v1/models native list and the subagent-default seed.
 */
export function nativeOpenAiSlugs(): string[] {
  const live = listCatalogNativeSlugs();
  return live.length > 0 ? unique([...live, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]) : NATIVE_OPENAI_MODELS;
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
  /** Whether Codex may request reasoning summaries for this routed model. */
  supportsReasoningSummaries?: boolean;
}

type RawEntry = Record<string, unknown>;
type RawCatalog = { models?: RawEntry[]; [k: string]: unknown };
const JAWCODE_CATALOG_AUGMENT_PROVIDERS = new Set(["opencode-go"]);

/**
 * Exact provider/model pairs whose discovery endpoint advertises them but whose inference backend
 * rejects them. Apply this after live/static/metadata sources converge so no source can resurrect
 * an uncallable picker row. Remove an entry once authenticated inference proves it usable again.
 */
const ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS = new Set([
  // Issue #82: Zen Go /models advertises HY3, but Console Go rejects it as outside the lite list.
  "opencode-go/hy3-preview",
]);

function isRoutedModelCompatibilityExcluded(slug: string): boolean {
  return ROUTED_MODEL_COMPATIBILITY_EXCLUSIONS.has(slug);
}

/**
 * Image/video GENERATION model families. opencodex routes chat/coding models into Codex; media-
 * generation models (Grok image/video, DALL·E, Imagen, Sora, Veo, …) are useless to a coding agent
 * and must never surface in the dashboard, /v1/models, or the routed catalog. The metadata has no
 * output-modality field, so we classify by id. Extend this list as providers add media models.
 */
const MEDIA_GEN_FAMILIES = [
  "dall-e", "dalle", "imagen", "sora", "veo", "flux", "kling",
  "seedance", "hailuo", "stable-diffusion", "sdxl", "midjourney",
];
const MEDIA_GEN_ID_RE = new RegExp(
  `(?:^|[/_-])(?:image|video)(?:[/_-]|$)|(?:^|[/_-])(?:${MEDIA_GEN_FAMILIES.join("|")})(?:[/_-]|$|\\d)`,
  "i",
);

/**
 * True when a model id denotes image/video GENERATION (so it should be hidden everywhere). Vision
 * *input* chat models — `grok-2-vision`, `qwen3-vl-*`, `gpt-4o`, `gemini-3-pro-preview` — are
 * intentionally NOT matched: they carry no `image`/`video` id segment and no generation-family token.
 */
export function isMediaGenerationModelId(id: string): boolean {
  return MEDIA_GEN_ID_RE.test(id);
}

function shouldExposeRoutedModel(model: CatalogModel): boolean {
  if (isRoutedModelCompatibilityExcluded(`${model.provider}/${model.id}`)) return false;
  if (model.provider === "cursor" && model.id === "gemini-3-pro-image-preview") return true;
  return !isMediaGenerationModelId(model.id);
}

/** Resolve the `model_catalog_json` path from Codex config.toml, else the default. */
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

function parseCatalogJson(raw: string): RawCatalog | null {
  try {
    const cat = JSON.parse(raw);
    return (cat && Array.isArray(cat.models)) ? cat : null;
  } catch { return null; }
}

function readCatalog(path: string): RawCatalog | null {
  try {
    if (!existsSync(path)) return null;
    return parseCatalogJson(readFileSync(path, "utf-8"));
  } catch { return null; }
}

function findNativeTemplate(catalog: RawCatalog | null): RawEntry | null {
  return catalog?.models?.find(
    m => typeof m.slug === "string" && !m.slug.includes("/") && "base_instructions" in m,
  ) ?? null;
}

function normalizeServiceTiers(entry: RawEntry): RawEntry {
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

function ensureAutoCompactTokenLimit(entry: RawEntry): RawEntry {
  if (
    typeof entry.context_window === "number"
    && entry.context_window > 0
    && typeof entry.auto_compact_token_limit !== "number"
  ) {
    entry.auto_compact_token_limit = Math.floor(entry.context_window * 0.9);
  }
  return entry;
}

function isNativeOpenAiEntry(entry: RawEntry): boolean {
  return typeof entry.slug === "string" && !entry.slug.includes("/");
}

function applyNativeOpenAiContextOverride(entry: RawEntry): void {
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

function ensureStrictCatalogFields(
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

/** Multi-agent surface mode — see OcxConfig.multiAgentMode. */
export type MultiAgentMode = "v1" | "default" | "v2";

/**
 * Apply the 3-state multi-agent surface override to catalog entries.
 * - "v1": force multi_agent_version = "v1" on ALL entries (override upstream pins)
 * - "default": RESTORE upstream pins — clear stale forced values so entries that were
 *   previously forced to v1/v2 revert to their natural state (upstream-pinned natives
 *   get their snapshot pin, others get null so the codex feature flag decides)
 * - "v2": force multi_agent_version = "v2" on ALL entries (override upstream pins)
 */
function applyMultiAgentMode(entries: RawEntry[], mode: MultiAgentMode): RawEntry[] {
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
  const catalog = readCatalog(readCodexCatalogPath()) ?? readCatalog(activeCodexModelsCachePath());
  const models = catalog?.models ?? [];
  const exact = models.find(entry => entry.slug === modelId || entry.id === modelId);
  if (typeof exact?.supports_reasoning_summaries === "boolean") {
    return exact.supports_reasoning_summaries;
  }

  // Routing removes the provider namespace before adapter dispatch. Recover a unique routed
  // catalog match by its Codex-facing encoded suffix; disagreement fails open and preserves input.
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

// provider + NATIVE model id are passed separately: the Codex-facing slug may carry an
// encoded alias (`provider/vendor-model`) that must never reach the metadata lookup,
// whose keys are native ids (openrouter `anthropic/...`, nvidia `moonshotai/...`).
function applyJawcodeCatalogMetadata(entry: RawEntry, provider: string, modelId: string, contextCap?: number): void {
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

type ExecFile = (
  file: string,
  args: string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
    shell?: boolean;
  },
) => string;

interface BundledCatalogDeps {
  commandCandidates?: () => string[];
  execFileSync?: ExecFile;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function codexCommandCandidates(): string[] {
  const envPath = process.env.CODEX_CLI_PATH?.trim();
  const candidates = envPath ? [envPath] : [];
  candidates.push(...codexShimCommandCandidates());
  if (process.platform === "win32") {
    for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      candidates.push(join(dir, "codex.exe"), join(dir, "codex.cmd"));
    }
  }
  candidates.push("codex");
  return unique(candidates);
}

/**
 * Windows probe guard: only PE/batch launchers can be spawned as processes. Anything
 * else pulled from the shim state (the extensionless Git-Bash sh backup
 * `codex.opencodex-real`, `.ps1` scripts) risks falling through to the cmd/ShellExecute
 * document-association path — Windows then OPENS the file in the user's editor
 * (e.g. VS Code) on every `codex` launch instead of executing it.
 */
export function isSpawnableCodexCandidate(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return true;
  return /\.(cmd|bat|exe|com)$/i.test(path);
}

function codexShimCommandCandidates(): string[] {
  try {
    const state = JSON.parse(readFileSync(join(getConfigDir(), "codex-shim.json"), "utf8")) as {
      wrapperPath?: unknown;
      originalPath?: unknown;
      backupPath?: unknown;
      wrappers?: Array<{ wrapperPath?: unknown; originalPath?: unknown; backupPath?: unknown }>;
    };
    const files = Array.isArray(state.wrappers) && state.wrappers.length > 0 ? state.wrappers : [state];
    const out: string[] = [];
    for (const file of files) {
      for (const value of [file.backupPath, file.originalPath, file.wrapperPath]) {
        if (typeof value !== "string" || value.length === 0) continue;
        if (!isSpawnableCodexCandidate(value)) continue;
        out.push(value);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `.cmd`/`.bat` launchers (npm's `codex.cmd`) cannot be spawned shell-less — Node ≥18.20
 * and Bun refuse with EINVAL (CVE-2024-27980 hardening), which the probe loop silently
 * swallowed, so npm-only Codex installs never loaded the bundled catalog on Windows.
 * Route those through the shell (repo convention — see src/update/index.ts, bin/ocx.mjs) and
 * pre-quote the path: shell:true joins file+args verbatim, so an unquoted path with
 * spaces (`C:\Users\John Doe\...`) would split. Windows paths cannot contain `"`.
 */
export function codexExecInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; shell: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return { file: `"${command.replace(/"/g, "")}"`, shell: true };
  }
  return { file: command, shell: false };
}

function runCodexDebugModels(command: string, execFile: ExecFile): string {
  const args = ["debug", "models", "--bundled"];
  const invocation = codexExecInvocation(command);
  return execFile(invocation.file, args, {
    encoding: "utf8" as const,
    stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    windowsHide: true,
    shell: invocation.shell,
  });
}

export function loadBundledCodexCatalog(deps: BundledCatalogDeps = {}): RawCatalog | null {
  const useCache = !deps.commandCandidates && !deps.execFileSync;
  if (useCache && bundledCatalogCache && bundledCatalogCache.expiresAt > Date.now()) {
    return bundledCatalogCache.value;
  }
  const candidates = deps.commandCandidates?.() ?? codexCommandCandidates();
  const execFile = deps.execFileSync ?? (execFileSync as unknown as ExecFile);
  for (const command of candidates) {
    try {
      const catalog = parseCatalogJson(runCodexDebugModels(command, execFile));
      if (catalog && findNativeTemplate(catalog)) {
        if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: catalog };
        return catalog;
      }
    } catch { /* try next candidate */ }
  }
  if (useCache) bundledCatalogCache = { expiresAt: Date.now() + BUNDLED_CATALOG_CACHE_MS, value: null };
  return null;
}

export function materializeBundledCodexCatalog(path: string, deps: BundledCatalogDeps = {}): RawCatalog | null {
  const catalog = loadBundledCodexCatalog(deps);
  if (!catalog) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFile(path, JSON.stringify(catalog, null, 2) + "\n");
  } catch {
    return null;
  }
  return catalog;
}

function loadCatalogForSync(path: string): RawCatalog | null {
  const bundled = isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null;
  if (bundled) return JSON.parse(JSON.stringify(bundled)) as RawCatalog;
  const catalog = readCatalog(path);
  if (catalog && findNativeTemplate(catalog)) return catalog;
  return readCatalog(catalogBackupPathFor(path))
    ?? (isDefaultCatalogPath(path) ? readCatalog(legacyCatalogBackupPath()) : null)
    ?? readCatalog(activeCodexModelsCachePath())
    ?? materializeBundledCodexCatalog(path)
    ?? catalog;
}

function readCurrentCatalogOrCache(): RawCatalog | null {
  const path = readCodexCatalogPath();
  return (isDefaultCatalogPath(path) ? loadBundledCodexCatalog() : null)
    ?? readCatalog(path)
    ?? readCatalog(activeCodexModelsCachePath());
}

/**
 * A full native entry from the on-disk catalog, used as a clone template so injected
 * entries carry EVERY field Codex's strict parser requires (e.g. `base_instructions`).
 * Returns a deep copy, or null if no catalog/native entry exists.
 */
export function loadCatalogTemplate(): RawEntry | null {
  const catalogPath = readCodexCatalogPath();
  const native = findNativeTemplate(readCatalog(catalogPath))
    ?? findNativeTemplate(readCatalogBackup(catalogPath))
    ?? findNativeTemplate(readCatalog(activeCodexModelsCachePath()))
    ?? findNativeTemplate(loadBundledCodexCatalog());
  return native ? JSON.parse(JSON.stringify(native)) : null;
}

/**
 * Codex accepts its native labels plus model-defined effort strings such as `max` in current builds.
 * Provider-specific aliases still map at request time by src/reasoning-effort.ts.
 */
// Routed models default to the low..max ladder: upstream bundled catalogs advertise no "ultra"
// either — but opencodex exposes ultra universally so routed models can use the auto-delegation
// mode (codex-rs converts ultra → max on the wire before any provider request).
const ROUTED_REASONING_LEVELS = [...CODEX_REASONING_LEVELS];

function applyCatalogModelMetadata(entry: RawEntry, model?: CatalogModel): void {
  if (!model) return;
  // This marker survives strict catalog normalization and lets sync distinguish a stale
  // bare combo alias from a genuine native model row.
  if (model.provider === COMBO_NAMESPACE) entry.owned_by = model.owned_by ?? COMBO_NAMESPACE;
  // displayName is DISPLAY-ONLY: it relabels the picker row but never touches the routing
  // slug, alias, or provider. deriveEntry already stamped the slug as display_name; a
  // configured displayName overrides just the label. The `/` separator is rejected at every
  // input boundary (CLI `ocx models add`, management API), so the catalog trusts its source.
  // Combos carry no displayName, and natives never reach here (no CatalogModel), so genuine
  // upstream marketing names and combo alias labels are preserved untouched.
  const displayName = typeof model.displayName === "string" ? model.displayName.trim() : "";
  if (displayName) entry.display_name = displayName;
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    entry.context_window = model.contextWindow;
    entry.max_context_window = model.contextWindow;
    entry.auto_compact_token_limit = Math.min(
      Math.floor(model.contextWindow * 0.9),
      model.maxInputTokens ?? Number.POSITIVE_INFINITY,
    );
  }
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    entry.input_modalities = model.inputModalities;
  }
  if (typeof model.supportsVerbosity === "boolean") {
    entry.support_verbosity = model.supportsVerbosity;
  }
  if (typeof model.supportsReasoningSummaries === "boolean") {
    entry.supports_reasoning_summaries = model.supportsReasoningSummaries;
  }
}

function applyReasoningLevels(
  entry: RawEntry,
  effortsOverride?: string[],
  defaultOverride?: string,
  preserveExact = false,
): void {
  let efforts = sanitizeCodexReasoningEfforts(effortsOverride) ?? ROUTED_REASONING_LEVELS.map(l => l.effort);
  // Mock top tiers (user decision 260709): every reasoning-capable model advertises `max`
  // even when the provider ladder stops lower — subagent spawns pass `max` DIRECTLY
  // (no ultra->max client conversion) and codex-rs validates it by catalog membership,
  // so a missing max rung hard-fails spawn_agent effort overrides. The wire stays honest:
  // routed adapters clamp via clampToSupportedCodexEffort and natives via
  // nativeEffortClamp (max -> the model's real top rung).
  if (!preserveExact && efforts.length > 0) {
    const additions: string[] = [];
    if (!efforts.includes("max")) additions.push("max");
    if (!efforts.includes("ultra")) additions.push("ultra");
    if (additions.length > 0) efforts = sanitizeCodexReasoningEfforts([...efforts, ...additions]) ?? efforts;
  }
  const byEffort = new Map(
    (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .map((l: { effort?: string }) => [l.effort, l]),
  );
  entry.supported_reasoning_levels = efforts.map(effort => {
    const native = byEffort.get(effort);
    if (native) return native;
    // Description lookup uses the FULL ladder so an opt-in effort outside the routed default
    // (e.g. "ultra") still renders its canonical description.
    return CODEX_REASONING_LEVELS.find(l => l.effort === effort) ?? { effort, description: `${effort} reasoning` };
  });
  if (efforts.length === 0) {
    delete entry.default_reasoning_level;
    return;
  }
  entry.default_reasoning_level = defaultOverride && efforts.includes(defaultOverride)
    ? defaultOverride
    : efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0];
}

function isGpt56NativeSlug(slug: string): boolean {
  return !slug.includes("/") && slug.startsWith("gpt-5.6-");
}

/**
 * Fallback ladder fix for a gpt-5.6 native slug NOT covered by the upstream snapshot (a future
 * variant the snapshot predates): entries cloned from an older template (gpt-5.5) stop at xhigh,
 * so append max+ultra in upstream rank order when absent. Snapshot-covered slugs never reach
 * this — deriveEntry returns their real entry first.
 */
function ensureGpt56ReasoningLevels(entry: RawEntry): void {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  const out = [...levels];
  // max is a real native rung on the 5.6 family — always restored; ultra always advertised.
  for (const effort of ["max", "ultra"]) {
    if (out.some(level => level.effort === effort)) continue;
    out.push(CODEX_REASONING_LEVELS.find(level => level.effort === effort)
      ?? { effort, description: `${effort} reasoning` });
  }
  entry.supported_reasoning_levels = out;
}

/**
 * Ensure the mock top tiers on a native model's advertised ladder: `max` and `ultra`
 * are always advertised (subagent spawns pass max directly and codex-rs validates by
 * catalog membership — the ocx wire clamp routes it to the model's real top rung).
 */
function ensureUltraReasoningLevel(entry: RawEntry): void {
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : [];
  if (levels.length === 0) return;
  const wanted = ["max", "ultra"];
  for (const effort of wanted) {
    if (levels.some(level => level.effort === effort)) continue;
    levels.push(
      CODEX_REASONING_LEVELS.find(level => level.effort === effort)
        ?? { effort, description: `${effort} reasoning` },
    );
  }
  entry.supported_reasoning_levels = levels;
}

/** Reasoning-effort labels accepted by the installed Codex binary's bundled catalog. */
export function codexSupportedReasoningEfforts(deps: BundledCatalogDeps = {}): Set<string> | null {
  const bundled = loadBundledCodexCatalog(deps);
  if (!bundled) return null;
  const efforts = new Set<string>();
  for (const model of bundled.models ?? []) {
    if (typeof model.slug !== "string" || model.slug.includes("/")) continue;
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
    for (const level of levels) {
      const effort = (level as { effort?: unknown })?.effort;
      if (typeof effort === "string") efforts.add(effort);
    }
    if (typeof model.default_reasoning_level === "string") efforts.add(model.default_reasoning_level);
  }
  return efforts.size > 0 ? efforts : null;
}

/** Highest surviving rung at or below the original default, with a conservative empty fallback. */
export function clampedDefaultEffort(original: string, surviving: readonly string[]): string {
  if (surviving.length === 0) return "medium";
  const ranked = [...surviving]
    .map(effort => ({ effort, rank: codexEffortRank(effort) }))
    .sort((a, b) => a.rank - b.rank);
  const originalRank = codexEffortRank(original);
  const atOrBelow = ranked.filter(item => item.rank >= 0 && item.rank <= originalRank);
  return (atOrBelow.at(-1) ?? ranked[0]!).effort;
}

/** Remove reasoning efforts the installed Codex binary cannot deserialize from one entry. */
export function clampEntryToCodexSupportedEfforts(entry: RawEntry, supported: Set<string> | null): void {
  if (!supported) return;
  const levels = Array.isArray(entry.supported_reasoning_levels)
    ? entry.supported_reasoning_levels as Array<{ effort?: string }>
    : null;
  if (levels && levels.length > 0) {
    const kept = levels.filter(level => typeof level?.effort === "string" && supported.has(level.effort));
    entry.supported_reasoning_levels = kept.length > 0
      ? kept
      : CODEX_REASONING_LEVELS
        .filter(level => level.effort === "low" || level.effort === "medium" || level.effort === "high")
        .map(level => ({ ...level }));
  }
  const currentDefault = entry.default_reasoning_level;
  if (typeof currentDefault === "string" && !supported.has(currentDefault)) {
    const surviving = (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .flatMap(level => typeof (level as { effort?: string })?.effort === "string"
        ? [(level as { effort: string }).effort]
        : []);
    entry.default_reasoning_level = clampedDefaultEffort(currentDefault, surviving);
  }
}

/** Clamp every catalog entry to the reasoning ladder accepted by the installed Codex binary. */
export function clampCatalogModelsToCodexSupport(models: RawEntry[], deps: BundledCatalogDeps = {}): RawEntry[] {
  const supported = codexSupportedReasoningEfforts(deps);
  if (!supported) return models;
  for (const entry of models) clampEntryToCodexSupportedEfforts(entry, supported);
  return models;
}

/**
 * Native entry from the pinned upstream snapshot, finished for emission. Keeps the entry's
 * OWN identity (display_name, description, priority, availability_nux — it is the model's own
 * NUX, not another model's) instead of the caller's generic passthrough blurb. The caller's
 * `priority` wins only when it is a deliberate override (featured rank / push-down), i.e. not
 * the native default 9.
 */
function finishUpstreamNativeEntry(clone: RawEntry, priority: number): RawEntry {
  if (priority !== 9) clone.priority = priority;
  applyNativeOpenAiContextOverride(clone);
  // GPT-5.6 natives keep their exact upstream ladders (e.g. luna has max but no ultra).
  // Older natives (gpt-5.5 / 5.4 / 5.4-mini / 5.3-codex-spark) get mock max + ultra
  // (wire-clamped to xhigh). Ultra is always advertised regardless of v2 toggle.
  if (!isGpt56NativeSlug(String(clone.slug ?? ""))) ensureUltraReasoningLevel(clone);
  return ensureStrictCatalogFields(normalizeServiceTiers(clone));
}

function isExactComboCatalogModel(
  model: CatalogModel | undefined,
  exactComboSlugs: ReadonlySet<string>,
): boolean {
  return model !== undefined && exactComboSlugs.has(catalogModelSlug(model));
}

export function catalogModelSlug(model: CatalogModel): string {
  return model.alias ?? routedSlug(model.provider, model.id);
}

function deriveEntry(
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

/**
 * Single source of truth for Codex-catalog-shaped entries, reused by both the on-disk
 * catalog sync and the proxy `/v1/models?client_version` branch.
 * Native gpt slugs stay bare; routed models are namespaced `<provider>/<model>`.
 */
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

/** Bare picker-visible native slugs in the live Codex catalog (drives the subagent picker UI). */
export function listCatalogNativeSlugs(): string[] {
  const cat = readCurrentCatalogOrCache();
  const live = filterSupportedNativeSlugs(cat?.models ?? []);
  // Ensure documented additions (e.g. gpt-5.3-codex-spark) appear even when the bundled catalog
  // predates the slug — mirrors nativeOpenAiSlugs() which already merges them for /v1/models.
  return unique([...live, ...DOCUMENTED_NATIVE_OPENAI_ADDITIONS]);
}

/**
 * Keep only picker-visible, bare (non-routed) native slugs that opencodex actually supports.
 * A user's installed Codex may list legacy/internal natives (`gpt-5.2`, `gpt-5.3-codex`,
 * `codex-auto-review`, …); the allowlist drops them so `/v1/models` and the subagent picker
 * never advertise an unsupported native. Exported for regression coverage.
 */
export function filterSupportedNativeSlugs(models: RawEntry[]): string[] {
  return models
    .filter(m => typeof m.slug === "string" && !(m.slug as string).includes("/") && m.visibility === "list" && SUPPORTED_NATIVE_OPENAI_SLUGS.has(m.slug as string))
    .map(m => m.slug as string);
}

/**
 * Native-model priority baseline read from the PRISTINE backup, so featuring stays reversible:
 * a featured native gets its low rank, and un-featuring restores its original catalog priority
 * (rather than the modified value left in the live catalog by a previous sync).
 */
function readCatalogBackup(catalogPath: string): RawCatalog | null {
  return readCatalog(catalogBackupPathFor(catalogPath))
    ?? (isDefaultCatalogPath(catalogPath) ? readCatalog(legacyCatalogBackupPath()) : null);
}

function catalogHasRoutedEntries(catalog: RawCatalog | null): boolean {
  return (catalog?.models ?? []).some(m => typeof m.slug === "string" && m.slug.includes("/"));
}

function writePristineCatalogBackup(backupPath: string, catalogPath: string, catalog: RawCatalog): void {
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

function ensureCatalogBackup(catalogPath: string, catalog: RawCatalog): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePristineCatalogBackup(catalogBackupPathFor(catalogPath), catalogPath, catalog);
  if (isDefaultCatalogPath(catalogPath)) writePristineCatalogBackup(legacyCatalogBackupPath(), catalogPath, catalog);
}

function readNativeBaseline(catalogPath: string): Map<string, number> {
  const backup = readCatalogBackup(catalogPath);
  const out = new Map<string, number>();
  for (const e of backup?.models ?? []) {
    if (typeof e.slug === "string" && !e.slug.includes("/") && typeof e.priority === "number") {
      out.set(e.slug, e.priority);
    }
  }
  return out;
}


type ProviderModelsApiItem = {
  id: string;
  owned_by?: string;
  context_length?: number;
  max_model_len?: number;
  metadata?: {
    capabilities?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  };
};

function isProviderModelsApiItems(value: unknown): value is ProviderModelsApiItem[] {
  return Array.isArray(value) && value.every(item =>
    item !== null
    && typeof item === "object"
    && !Array.isArray(item)
    && typeof (item as { id?: unknown }).id === "string"
    && (item as { id: string }).id.trim().length > 0
  );
}

function configuredContextWindow(prov: OcxProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelContextWindows, id) ?? prov.contextWindow;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

function configuredInputModalities(prov: OcxProviderConfig, id: string): string[] | undefined {
  const modalities = modelRecordValue(prov.modelInputModalities, id);
  return Array.isArray(modalities) && modalities.length > 0 ? [...modalities] : undefined;
}

function configuredMaxInputTokens(prov: OcxProviderConfig, id: string): number | undefined {
  const configured = modelRecordValue(prov.modelMaxInputTokens, id);
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}

export function applyProviderConfigHints(name: string, prov: OcxProviderConfig, model: CatalogModel, providerCap?: number): CatalogModel {
  void name;
  const configuredCap = configuredContextWindow(prov, model.id);
  const configuredMaxInput = configuredMaxInputTokens(prov, model.id);
  let inputModalities = configuredInputModalities(prov, model.id);
  // Vision-sidecar coverage: `noVisionModels` marks models whose images the PROXY describes
  // (src/vision/index.ts). The catalog must still advertise image input for them — the Codex app
  // gates attachments client-side on input_modalities, and a text-only entry would block images
  // before the sidecar ever runs ("This model does not support image inputs").
  if (modelInList(prov.noVisionModels, model.id)) {
    const base = inputModalities ?? model.inputModalities ?? ["text"];
    inputModalities = base.includes("image") ? [...base] : [...base, "image"];
  }
  const reasoningEfforts = configuredReasoningEfforts(prov, model.id);
  const defaultReasoningEffort = modelRecordValue(prov.modelDefaultReasoningEfforts, model.id) ?? model.defaultReasoningEffort;
  const supportsReasoningSummaries = modelRecordValue(prov.modelSupportsReasoningSummaries, model.id);
  const hinted = {
    ...model,
    ...(configuredCap !== undefined
      ? {
        contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0
          ? Math.min(model.contextWindow, configuredCap)
          : configuredCap,
      }
      : {}),
    ...(inputModalities ? { inputModalities } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(configuredMaxInput !== undefined
      ? {
        maxInputTokens: typeof model.maxInputTokens === "number" && model.maxInputTokens > 0
          ? Math.min(model.maxInputTokens, configuredMaxInput)
          : configuredMaxInput,
      }
      : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof supportsReasoningSummaries === "boolean" ? { supportsReasoningSummaries } : {}),
    ...(prov.adapter === "kiro" ? { supportsVerbosity: false } : {}),
    // Default-on for openai-chat providers (explicit false opts out); other adapters
    // advertise only on explicit opt-in.
    ...(prov.parallelToolCalls === true || (prov.adapter === "openai-chat" && prov.parallelToolCalls !== false)
      ? { parallelToolCalls: true }
      : {}),
  };
  const capped = applyProviderContextCap(hinted.contextWindow, providerCap);
  if (providerCap !== undefined && capped !== hinted.contextWindow) {
    return { ...hinted, contextWindow: capped, contextCap: providerCap, contextCapped: true };
  }
  return providerCap !== undefined ? { ...hinted, contextCap: providerCap, contextCapped: false } : hinted;
}

function catalogHintsFromProviderConfig(name: string, prov: OcxProviderConfig, id: string, contextCap?: number): Partial<CatalogModel> {
  const hinted = applyProviderConfigHints(name, prov, { id, provider: name }, contextCap);
  const { provider: _provider, id: _id, ...hints } = hinted;
  return hints;
}

function applyConfigHintsToCachedModels(name: string, prov: OcxProviderConfig, models: CatalogModel[], contextCap?: number): CatalogModel[] {
  return models.map(model => applyProviderConfigHints(name, prov, model, contextCap));
}

/**
 * TRUE when `liveId` is a dated release of the configured alias `configuredId`:
 * `<configuredId>-YYYYMMDD` (Anthropic's convention for superseded-but-callable models).
 */
export function isDatedVariantId(liveId: string, configuredId: string): boolean {
  if (!liveId.startsWith(`${configuredId}-`)) return false;
  return /^\d{8}$/.test(liveId.slice(configuredId.length + 1));
}

// Same-signature dedupe: Codex polls /v1/models frequently, and an unchanged drop list
// repeated on every poll is pure noise. Warn once per provider until the id set changes.
const lastDropWarnSignature = new Map<string, string>();
// These managed providers intentionally carry compatibility fallback ids while treating their
// authenticated live catalogs as canonical. A non-empty live response already hides stale ids;
// repeating that expected reconciliation on every startup only adds noise.
const QUIET_AUTHORITATIVE_CATALOG_PROVIDERS = new Set(["kimi", "xai"]);
// Direct OAuth chat-completions probes on 260718 confirmed these account-scoped ids still work
// even though the providers omit them from `/models`. Preserve only the proven compatibility
// ids; unknown configured ids and xAI's chat-incompatible multi-agent model remain hidden.
const CALLABLE_CONFIGURED_COMPATIBILITY_MODELS: Readonly<Record<string, ReadonlySet<string>>> = {
  kimi: new Set([
    "k3[1m]",
    "kimi-k2.7-code",
    "kimi-k2.7-code-highspeed",
    "kimi-k2.6",
    "kimi-k2.5",
  ]),
  xai: new Set([
    "grok-4.3",
    "grok-4.20-0309-reasoning",
    "grok-4.20-0309-non-reasoning",
    "grok-build-0.1",
    "grok-composer-2.5-fast",
  ]),
};
function warnDroppedConfiguredIdsOnce(name: string, droppedConfiguredIds: string[]): void {
  const signature = [...droppedConfiguredIds].sort().join(",");
  if (lastDropWarnSignature.get(name) === signature) return;
  lastDropWarnSignature.set(name, signature);
  console.warn(
    `[opencodex] Provider model discovery for "${name}" omitted configured model ids; dropping them from the authoritative live catalog: ${droppedConfiguredIds.join(", ")}.`,
  );
}

function isGlm52ModelId(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized === "glm-5.2" || normalized === "glm-5.2[1m]";
}

function catalogHintsFromModelsApiItem(providerName: string, item: ProviderModelsApiItem): Partial<CatalogModel> {
  const capabilities = item.metadata?.capabilities;
  const limits = item.metadata?.limits;
  const contextWindow =
    typeof limits?.max_context_length === "number" ? limits.max_context_length
      : typeof item.context_length === "number" ? item.context_length
      : typeof item.max_model_len === "number" ? item.max_model_len
        : undefined;
 const reasoningEfforts = capabilities && typeof capabilities.reasoning_effort === "boolean"
   ? (capabilities.reasoning_effort
     ? ((providerName === "neuralwatt" || providerName === "zai") && isGlm52ModelId(item.id)
       ? ["low", "medium", "high", "xhigh", "max"]
       : ["low", "medium", "high", "xhigh"])
     : [])
   : undefined;
 const inputModalities = capabilities && typeof capabilities.vision === "boolean"
    ? (capabilities.vision ? ["text", "image"] : ["text"])
    : undefined;
  return {
    ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(inputModalities ? { inputModalities } : {}),
  };
}

/**
 * Fetch a provider's `/models` (openai-chat style) with a TTL cache + stale fallback. Skips
 * forward-auth providers. Fresh cache → no network; schema-valid live fetch → cache the
 * authoritative result; fetch failure or malformed data → last-known-good cache (so a provider
 * blip doesn't drop its models), else the static config list. This is the per-provider half of
 * jawcode's "always latest" resolver.
 */
async function fetchProviderModels(name: string, prov: OcxProviderConfig, ttlMs: number, contextCap?: number): Promise<CatalogModel[]> {
  if (prov.authMode === "forward") return []; // ChatGPT backend has no /models
  const apiKey = await resolveModelsAuthToken(name, prov);
  const seedVertexDefault = prov.adapter === "google"
    && prov.googleMode === "vertex"
    && (prov.models?.length ?? 0) === 0
    && Boolean(prov.defaultModel);
  const configuredIds = seedVertexDefault && prov.defaultModel ? [prov.defaultModel] : (prov.models ?? []);
  const configured: CatalogModel[] = configuredIds.map(id => ({
    id,
    provider: name,
    ...catalogHintsFromProviderConfig(name, prov, id, contextCap),
  }));
  // A configured default is a real callable selector and must remain discoverable when a
  // compatible provider's live /models request fails (issue #308). Keep this separate from the
  // explicit static list: `liveModels: false` + empty `models[]` intentionally publishes zero
  // rows, while a failed live discovery may degrade to the default selector.
  const failedDiscoveryConfigured = configured.length > 0 || !prov.defaultModel || prov.adapter !== "anthropic"
    ? configured
    : [{
      id: prov.defaultModel,
      provider: name,
      ...catalogHintsFromProviderConfig(name, prov, prov.defaultModel, contextCap),
    }];
  const vertexDefaultSeed = seedVertexDefault ? configured[0] : undefined;
  const withVertexDefaultSeed = (models: CatalogModel[]): CatalogModel[] => (
    vertexDefaultSeed && !models.some(model => model.id === vertexDefaultSeed.id)
      ? [...models, vertexDefaultSeed]
      : models
  );
  if (prov.adapter === "cursor") {
    if (prov.liveModels === false || !apiKey) return configured;
    // Cursor uses a bespoke GetUsableModels RPC (not /models), returning the full effort-suffixed
    // variants this PLAN can use. Keep the base-model UX (the request builder appends the effort
    // suffix) but filter the static seed to the bases the account actually has — so models not on the
    // plan (e.g. claude-fable-5) drop out instead of failing ERROR_BAD_MODEL_NAME. Fall back to the seed.
    const cachedCursor = getFreshCached(name, ttlMs);
    if (cachedCursor) return applyConfigHintsToCachedModels(name, prov, cachedCursor);
    const liveResult = await fetchCursorUsableModels({ apiKey, baseUrl: prov.baseUrl });
    if (liveResult.ok) {
      const available = filterCursorConfiguredModelsByLiveDiscovery(configured, liveResult.models);
      const result = available.length > 0 ? available : configured;
      setCached(name, result);
      return result;
    }
    console.warn(
      `[opencodex] Cursor model discovery for "${name}" failed [${liveResult.error}]${liveResult.detail ? `: ${liveResult.detail}` : ""}; using stale/static catalog degradation.`,
    );
    const staleCursor = getStaleCached(name);
    return staleCursor ? applyConfigHintsToCachedModels(name, prov, staleCursor) : configured;
  }
  if (prov.authMode === "oauth" && !apiKey) {
    // No usable token (logged out, or account marked needsReauth). Still surface the
    // configured static catalog so the GUI Models tab / rail counts are not empty —
    // matching Cursor's !apiKey → configured degradation and fetch-failure fallback.
    return configured;
  }
  if (prov.liveModels === false) {
    return configured;
  }
  const fresh = getFreshCached(name, ttlMs);
  if (fresh) return withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, fresh, contextCap)); // dedups Codex's frequent /v1/models polling within the TTL
  if (isModelsFetchCoolingDown(name)) {
    // A recently-failed provider (unreachable API, missing proxy, bad key) must not re-pay the
    // fetch timeout on every catalog poll — the dashboard polls this path per page load.
    const stale = getStaleCached(name);
    return stale ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap)) : failedDiscoveryConfigured;
  }
  const { url, headers } = buildModelsRequest(prov, apiKey, name);
  const urlClass = new URL(url).hostname.endsWith("aiplatform.googleapis.com")
    ? "vertex-aiplatform"
    : "provider-models";
  const failedDiscoveryFallback = (): { models: CatalogModel[]; fallback: "stale" | "configured" } => {
    markModelsFetchFailure(name);
    const stale = getStaleCached(name);
    return {
      models: stale
        ? withVertexDefaultSeed(applyConfigHintsToCachedModels(name, prov, stale, contextCap))
        : failedDiscoveryConfigured,
      fallback: stale ? "stale" : "configured",
    };
  };
  try {
    const destinationError = await providerDestinationResolvedError(name, {
      baseUrl: url,
      allowPrivateNetwork: prov.allowPrivateNetwork,
    });
    if (destinationError) {
      const { models, fallback } = failedDiscoveryFallback();
      console.warn(
        `[opencodex] Provider model discovery for "${name}" was blocked by destination policy: ${destinationError} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const { models, fallback } = failedDiscoveryFallback();
      console.warn(
        `[opencodex] Provider model discovery for "${name}" failed with HTTP ${res.status} [urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }

    const contentType = (
      res.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "missing"
    ).slice(0, 80);
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      const { models, fallback } = failedDiscoveryFallback();
      const diagnostic = contentType === "application/json" || contentType.endsWith("+json")
        ? "returned invalid JSON in a 2xx response"
        : "returned a non-JSON 2xx response";
      console.warn(
        `[opencodex] Provider model discovery for "${name}" ${diagnostic} [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }
    const data = json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as { data?: unknown }).data
      : undefined;
    if (!isProviderModelsApiItems(data)) {
      const { models, fallback } = failedDiscoveryFallback();
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned malformed 2xx data [status=${res.status}, contentType=${contentType}, urlClass=${urlClass}, fallback=${fallback}].`,
      );
      return models;
    }
    const items = data;
    const live = items.map(m => applyProviderConfigHints(name, prov, {
      id: m.id,
      provider: name,
      owned_by: m.owned_by,
      ...catalogHintsFromModelsApiItem(name, m),
    }, contextCap))
      .filter(m => shouldExposeProviderModel(name, m.id));
    const liveIds = new Set(live.map(m => m.id));
    // Dated-release aliases (Anthropic pattern): older models may appear in the live catalog
    // ONLY under their dated id (claude-haiku-4-5-20251001) while the config names the
    // API-valid alias (claude-haiku-4-5). Such aliases are real, callable models — keep them
    // in the authoritative catalog (alias id, hints from the dated live entry) instead of
    // dropping them and warning on every poll.
    const droppedConfiguredIds: string[] = [];
    for (const m of configured) {
      if (liveIds.has(m.id)) continue;
      const dated = live.find(l => isDatedVariantId(l.id, m.id));
      if (dated) {
        // Reapply config hints so alias-keyed overrides (modelContextWindows etc.) win.
        live.push(applyProviderConfigHints(name, prov, { ...dated, id: m.id }, contextCap));
      } else if (seedVertexDefault || shouldRetainConfiguredProviderModel(name, m.id)) {
        live.push(m);
      } else {
        droppedConfiguredIds.push(m.id);
      }
    }
    if (live.length === 0 && name !== OPENAI_API_PROVIDER_ID) {
      console.warn(
        `[opencodex] Provider model discovery for "${name}" returned an authoritative empty catalog; ${droppedConfiguredIds.length > 0 ? `dropping configured model ids: ${droppedConfiguredIds.join(", ")}` : "no models will be exposed"}.`,
      );
    } else if (droppedConfiguredIds.length > 0
      && name !== OPENAI_API_PROVIDER_ID
      && !QUIET_AUTHORITATIVE_CATALOG_PROVIDERS.has(name)) {
      warnDroppedConfiguredIdsOnce(name, droppedConfiguredIds);
    }
    setCached(name, live);
    return live;
  } catch (error) {
    const { models, fallback } = failedDiscoveryFallback();
    console.warn(
      `[opencodex] Provider model discovery for "${name}" threw ${error instanceof Error ? error.name : "unknown"} [urlClass=${urlClass}, fallback=${fallback}].`,
    );
    return models;
  }
}

function shouldExposeProviderModel(providerName: string, modelId: string): boolean {
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  return true;
}

function shouldRetainConfiguredProviderModel(providerName: string, modelId: string): boolean {
  if (CALLABLE_CONFIGURED_COMPATIBILITY_MODELS[providerName]?.has(modelId)) return true;
  if (providerName === "opencode-free") return modelId === "big-pickle" || modelId.endsWith("-free");
  return false;
}

/**
 * Narrow a raw routed-model list to what Codex's catalog / clients should see: drop the
 * `disabledModels` blocklist AND, for any provider with a non-empty `selectedModels` allowlist, keep
 * only those ids. This is the single choke point applied at every CATALOG emission point (on-disk
 * sync + /v1/models); the admin `/api/models` list stays unfiltered so the picker can show the full
 * set. Live discovery is unaffected — this only decides what ships. See issue_052.
 */
export function filterCatalogVisibleModels(
  models: CatalogModel[],
  config: Pick<OcxConfig, "disabledModels" | "providers">,
): CatalogModel[] {
  const disabled = new Set(config.disabledModels ?? []);
  const allowByProvider = new Map<string, Set<string>>();
  for (const [name, prov] of Object.entries(config.providers)) {
    const sel = prov.selectedModels;
    if (Array.isArray(sel) && sel.length > 0) allowByProvider.set(name, new Set(sel));
  }
  return models.filter(m => {
    // disabledModels may be stored raw (canonical) or encoded (legacy UI writes).
    for (const stored of disabled) {
      // Combo management stores the public alias, while canonical `combo/<id>` references
      // remain valid for backward compatibility through slugEquals below.
      if (m.alias !== undefined && stored === catalogModelSlug(m)) return false;
      if (slugEquals(stored, m.provider, m.id)) return false;
    }
    const allow = allowByProvider.get(m.provider);
    return !allow || allow.has(m.id);
  });
}

/**
 * Gather routed (non-forward) provider models across the config — the single source of truth for
 * the live model list, used by both the on-disk catalog sync and the proxy's /api/* + /v1/models
 * endpoints. Providers are fetched in parallel; the result is sorted (provider, then id) for a
 * stable listing. TTL comes from `config.modelCacheTtlMs` (default 5 min).
 */
export async function gatherRoutedModels(config: OcxConfig): Promise<CatalogModel[]> {
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  // Persisted provider entries can predate newer registry fields (noVisionModels,
  // modelInputModalities, ...). The ROUTER merges registry seeds at request time
  // (routedProviderConfig), so the proxy behaves correctly — the catalog listing must see the
  // same merged view or its advertisements drift from actual proxy behavior (e.g. a
  // vision-sidecar model advertised text-only, blocking image attachments app-side).
  // Enrich a CLONE: hydrated defaults must never leak into the persisted config.
  const activeProviders = Object.entries(config.providers)
    .filter(([, prov]) => prov.disabled !== true)
    .map(([name, prov]): [string, OcxProviderConfig] => {
      const enriched = { ...prov };
      enrichProviderFromRegistry(name, enriched);
      return [name, enriched];
    });
  const lists = await Promise.all(
    activeProviders.map(([name, prov]) => fetchProviderModels(name, prov, ttlMs, providerContextCap(config, name))),
  );
  const apiAugmented = augmentRoutedModelsWithRegistryOpenAiApiRows(lists.flat(), config);
  const all = augmentRoutedModelsWithJawcodeMetadata(apiAugmented, activeProviders.map(([name]) => name), config.providers, config)
    // Drop image/video generation models (e.g. Grok image/video) by default. Cursor's static catalog
    // intentionally mirrors Cursor's public model table, including Gemini image preview, so the
    // exposure decision goes through shouldExposeRoutedModel (single choke point).
    .filter(shouldExposeRoutedModel);
  const memberByKey = new Map(all.map(model => [`${model.provider}/${model.id}`, model]));
  // [Decision Log]
  // - 목적과 의도: 콤보 타겟에 native OpenAI(Codex login) 모델이 포함될 때 카탈로그에서
  //   누락되는 버그(issue #268)를 수정. "openai" provider는 forward-auth(Codex login
  //   passthrough)이므로 fetchProviderModels가 항상 []를 반환하고, native slugs는
  //   별도 정적 경로(nativeOpenAiSlugs)로만 노출됨. 따라서 memberByKey에
  //   openai/<slug> 키가 존재하지 않아 콤보가 조용히 drop됨.
  // - 기존 구현 및 제약 조건: memberByKey는 routed provider /models fetch 결과로만 구성.
  // - 검토한 주요 대안: (A) native slugs를 all 배열에 직접 push — /v1/models와 온디스크
  //   카탈로그에서 native 모델이 중복 노출되는 부작용 발생. (B) memberByKey에만 synthetic
  //   CatalogModel을 주입 — 콤보 멤버 해석에만 사용하고 all에는 추가하지 않으므로 기존
  //   노출 경로에 영향 없음.
  // - 선택한 방식: (B) — synthetic entries를 memberByKey에만 주입.
  // - 다른 대안 대신 이 방식을 선택한 이유: 기존 native 모델 노출 경로(/v1/models, 온디스크
  //   카탈로그 sync, management API)를 전혀 변경하지 않고 콤보 resolution만 수선하기 때문.
  // - 장점, 단점 및 영향: 장점 — 최소 수정, 기존 경로 무변경. 단점 — synthetic entries의
  //   capability 데이터가 static/upstream snapshot 기반이므로, 사용자가 커스텀 config
  //   힌트(modelContextWindows 등)로 native 모델의 context window를 오버라이드한 경우
  //   반영되지 않음. 하지만 nativeOpenAiContextWindow가 이미 config 오버라이드를
  //   우선시하므로 실제 충돌 가능성은 낮음.
  if (!hasComboTargets(config)) {
    // Skip the native slug injection entirely when no combos are configured — avoids
    // calling nativeOpenAiSlugs() (which reads the live Codex catalog from disk) for
    // configs that will never need it.
  } else {
    const disabled = disabledNativeSlugs(config);
    for (const slug of nativeOpenAiSlugs()) {
      if (disabled.has(slug)) continue;
      const contextWindow = nativeOpenAiContextWindow(slug);
      if (contextWindow === undefined) continue;
      const synthetic: CatalogModel = {
        provider: "openai",
        id: slug,
        owned_by: "openai",
        contextWindow,
        maxInputTokens: contextWindow,
        inputModalities: nativeInputModalities(slug),
        reasoningEfforts: nativeReasoningEfforts(slug),
        ...(nativeParallelToolCalls(slug) ? { parallelToolCalls: true } : {}),
      };
      const key = `openai/${slug}`;
      // Only inject when not already present from a routed provider (an API-key
      // "openai" provider could shadow the native one).
      if (!memberByKey.has(key)) memberByKey.set(key, synthetic);
    }
  }
  for (const id of listComboIds(config)) {
    const combo = getCombo(config, id);
    if (!combo) continue;
    const members = combo.targets
      .map(target => memberByKey.get(targetKey(target)))
      .filter((member): member is CatalogModel => member !== undefined);
    const derived = deriveComboCatalogModel(id, combo, members);
    if (derived) all.push(derived);
    else warnUncataloguedComboOnce(id, combo, members);
  }
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  const customModels = (config.customModels ?? []).map(cm => ({
    id: cm.modelId,
    provider: cm.provider,
    // Display-only label: never feeds routing (customModels are keyed by routedSlug below).
    ...(cm.displayName ? { displayName: cm.displayName } : {}),
    ...(cm.contextWindow ? { contextWindow: cm.contextWindow } : {}),
    ...(cm.inputModalities ? { inputModalities: cm.inputModalities } : {}),
    ...(typeof modelRecordValue(config.providers[cm.provider]?.modelSupportsReasoningSummaries, cm.modelId) === "boolean"
      ? { supportsReasoningSummaries: modelRecordValue(config.providers[cm.provider]?.modelSupportsReasoningSummaries, cm.modelId) }
      : {}),
  }));
  // Custom rows override discovered rows that encode to the same Codex-facing slug.
  const customKeys = new Set(customModels.map(c => routedSlug(c.provider, c.id)));
  const deduped = all.filter(m => !customKeys.has(routedSlug(m.provider, m.id)));
  return [...deduped, ...customModels];
}

const openAiApiCollisionWarnings = new Set<string>();
const comboCatalogWarningSignatures = new Map<string, string>();

function intersectStrings(values: readonly string[][]): string[] {
  if (values.length === 0) return [];
  const rest = values.slice(1).map(value => new Set(value));
  return [...new Set(values[0])].filter(value => rest.every(set => set.has(value)));
}

function effectiveComboDefault(
  configured: string | null | undefined,
  common: readonly string[],
): string | undefined {
  if (!configured) return undefined;
  if (configured && common.includes(configured)) return configured;
  const requestedRank = codexEffortRank(configured);
  const ranked = common
    .map(effort => ({ effort, rank: codexEffortRank(effort) }))
    .filter(item => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  if (ranked.length === 0) return undefined;
  const atOrBelow = ranked.filter(item => item.rank <= requestedRank);
  return atOrBelow.at(-1)?.effort ?? ranked[0]!.effort;
}

export function deriveComboCatalogModel(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): CatalogModel | null {
  if (combo.targets.length === 0) return null;
  if (new Set(combo.targets.map(targetKey)).size !== combo.targets.length) return null;
  if (members.length !== combo.targets.length) return null;
  if (!members.every((member, index) => (
    `${member.provider}/${member.id}` === targetKey(combo.targets[index]!)
  ))) return null;
  const contexts = members.map(member => member.contextWindow);
  if (contexts.some(value => typeof value !== "number" || value <= 0)) return null;

  const inputModalities = intersectStrings(
    members.map(member => member.inputModalities ?? ["text"]),
  );
  if (inputModalities.length === 0) return null;
  const reasoningEfforts = intersectStrings(
    members.map(member => member.reasoningEfforts ?? []),
  );
  const contextWindow = Math.min(...contexts as number[]);
  const maxInputTokens = Math.min(
    ...members.map(member => member.maxInputTokens ?? member.contextWindow!),
  );
  const defaultReasoningEffort = effectiveComboDefault(
    combo.defaultEffort,
    reasoningEfforts,
  );

  return {
    provider: COMBO_NAMESPACE,
    id,
    owned_by: COMBO_NAMESPACE,
    contextWindow,
    maxInputTokens,
    inputModalities,
    reasoningEfforts,
    ...(combo.alias ? { alias: combo.alias } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(members.every(member => member.parallelToolCalls === true)
      ? { parallelToolCalls: true }
      : {}),
    ...(members.some(member => member.supportsReasoningSummaries === false)
      ? { supportsReasoningSummaries: false }
      : {}),
  };
}

function safeCatalogWarningLabel(value: string): string {
  return redactSecretString(value)
    .replace(/[\u0000-\u001f\u007f]/g, "?")
    .slice(0, 200);
}

function comboCatalogWarningSignature(
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): string {
  const discovered = new Map<string, CatalogModel>(members.map(member => [
    `${member.provider}/${member.id}`,
    member,
  ] as const));
  return JSON.stringify(combo.targets.map(target => {
    const key = targetKey(target);
    const member = discovered.get(key);
    return {
      key,
      contextWindow: member?.contextWindow ?? null,
      maxInputTokens: member?.maxInputTokens ?? null,
      inputModalities: [...new Set(member?.inputModalities ?? [])].sort(),
      reasoningEfforts: [...new Set(member?.reasoningEfforts ?? [])].sort(),
      parallelToolCalls: member?.parallelToolCalls === true,
      supportsReasoningSummaries: member?.supportsReasoningSummaries !== false,
    };
  }).sort((a, b) => a.key.localeCompare(b.key)));
}

function warnUncataloguedComboOnce(
  id: string,
  combo: NormalizedComboConfig,
  members: readonly CatalogModel[],
): void {
  const signature = comboCatalogWarningSignature(combo, members);
  if (comboCatalogWarningSignatures.get(id) === signature) return;
  comboCatalogWarningSignatures.set(id, signature);
  const targets = combo.targets
    .map(target => safeCatalogWarningLabel(targetKey(target)))
    .sort((a, b) => a.localeCompare(b));
  console.warn(
    `[opencodex] Combo "${safeCatalogWarningLabel(id)}" is omitted from the catalog because member capabilities are incomplete: ${targets.join(", ")}.`,
  );
}

export function exactComboCatalogSlugs(
  config: Pick<OcxConfig, "combos" | "disabledModels">,
): Set<string> {
  const disabled = new Set(config.disabledModels ?? []);
  return new Set(listComboIds(config).flatMap(id => {
    const alias = typeof config.combos?.[id]?.alias === "string"
      ? config.combos[id]!.alias!.trim()
      : "";
    const canonical = comboModelId(id);
    const publicSlug = alias || canonical;
    return disabled.has(publicSlug) || disabled.has(canonical) ? [] : [publicSlug];
  }));
}

function normalizedOpenAiApiSignature(model: CatalogModel): string {
  const normalized = {
    provider: model.provider,
    id: model.id,
    contextWindow: model.contextWindow ?? null,
    maxInputTokens: model.maxInputTokens ?? null,
    inputModalities: [...new Set(model.inputModalities ?? [])].sort(),
    reasoningEfforts: [...new Set(model.reasoningEfforts ?? [])].sort(),
    ownedBy: model.owned_by ?? null,
  };
  return JSON.stringify(normalized);
}

export function resetOpenAiApiCatalogWarningStateForTests(): void {
  openAiApiCollisionWarnings.clear();
}

/**
 * Encode-collision guard (slug-codec): two DISTINCT native ids of one provider mapping
 * to the same Codex-facing alias (`a/b` vs `a-b`) cannot be decoded bijectively and must
 * not emit duplicate catalog slugs. The plain-hyphen native id wins (matching decode
 * precedence: exact native match first); the loser is dropped from the catalog — it stays
 * callable via its raw full-slash selector — and we warn once per provider+alias.
 */
const slugAliasCollisionWarnings = new Set<string>();
const comboMasqueradeCollisionWarnings = new Set<string>();

function warnComboMasqueradeCollisionOnce(slug: string): void {
  if (comboMasqueradeCollisionWarnings.has(slug)) return;
  comboMasqueradeCollisionWarnings.add(slug);
  console.warn(
    `[opencodex] combo alias collision on "${safeCatalogWarningLabel(slug)}": the combo wins and the shadowed provider model is omitted from the catalog.`,
  );
}

function resolveSlugAliasCollisions(goModels: CatalogModel[]): Set<CatalogModel> {
  const skipped = new Set<CatalogModel>();
  const winnerByAlias = new Map<string, CatalogModel>();
  for (const m of goModels) {
    // Combo aliases have their own collision policy below: they always shadow provider rows.
    if (m.provider === COMBO_NAMESPACE) continue;
    const key = catalogModelSlug(m);
    const winner = winnerByAlias.get(key);
    if (!winner) {
      winnerByAlias.set(key, m);
      continue;
    }
    const winnerIsPlainAlias = !winner.id.includes("/");
    const currentIsPlainAlias = !m.id.includes("/");
    if (currentIsPlainAlias && !winnerIsPlainAlias) {
      skipped.add(winner);
      winnerByAlias.set(key, m);
    } else {
      skipped.add(m);
    }
    if (!slugAliasCollisionWarnings.has(key)) {
      slugAliasCollisionWarnings.add(key);
      console.warn(
        `[opencodex] slug alias collision on "${key}": multiple native ids encode to the same Codex-facing slug; `
        + "the plain-hyphen native id is cataloged, the slash id remains callable via its raw selector.",
      );
    }
  }
  return skipped;
}

/** Apply Codex-facing encoded-slug collision policy to management and picker rows. */
export function uniqueCatalogModelsForPublicList(goModels: CatalogModel[]): CatalogModel[] {
  const collisionSkipped = resolveSlugAliasCollisions(goModels);
  const comboPublicSlugs = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(catalogModelSlug));
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of goModels) {
    if (collisionSkipped.has(model)) continue;
    const slug = catalogModelSlug(model);
    if (model.provider !== COMBO_NAMESPACE && comboPublicSlugs.has(slug)) {
      warnComboMasqueradeCollisionOnce(slug);
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(model);
  }
  return out;
}

/**
 * Deduplicate the ordinary OpenAI `/v1/models` list by the exact id emitted by that
 * endpoint. Raw selectors that merely encode to the same Codex slug remain independently
 * callable and visible; an exact combo alias collision still resolves in favor of the combo.
 */
export function uniqueCatalogModelsForRawPublicList(goModels: CatalogModel[]): CatalogModel[] {
  const publicId = (model: CatalogModel): string => model.alias ?? `${model.provider}/${model.id}`;
  const comboPublicIds = new Set(goModels
    .filter(model => model.provider === COMBO_NAMESPACE)
    .map(publicId));
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const model of goModels) {
    const id = publicId(model);
    if (model.provider !== COMBO_NAMESPACE && comboPublicIds.has(id)) {
      warnComboMasqueradeCollisionOnce(id);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(model);
  }
  return out;
}

/** Test-only reset for every process-global catalog cache/warning owner. */
export function resetCatalogRuntimeStateForTests(): void {
  bundledCatalogCache = null;
  lastDropWarnSignature.clear();
  openAiApiCollisionWarnings.clear();
  comboCatalogWarningSignatures.clear();
  slugAliasCollisionWarnings.clear();
  comboMasqueradeCollisionWarnings.clear();
  clearModelCache();
}

export function augmentRoutedModelsWithRegistryOpenAiApiRows(
  models: CatalogModel[],
  config: OcxConfig,
): CatalogModel[] {
  const configured = config.providers[OPENAI_API_PROVIDER_ID];
  if (!configured || configured.disabled === true) return models;
  const entry = getProviderRegistryEntry(OPENAI_API_PROVIDER_ID);
  if (!entry?.models) return models;

  const existingById = new Map(
    models.filter(model => model.provider === OPENAI_API_PROVIDER_ID).map(model => [model.id, model]),
  );
  const trustedRows = entry.models.map((id): CatalogModel => {
    const officialContext = entry.modelContextWindows?.[id];
    const officialMaxInput = entry.modelMaxInputTokens?.[id];
    const userContext = configured.modelContextWindows?.[id] ?? configured.contextWindow;
    const userMaxInput = configured.modelMaxInputTokens?.[id];
    const providerCap = providerContextCap(config, OPENAI_API_PROVIDER_ID);
    const contextWindow = typeof officialContext === "number"
      ? Math.min(officialContext, userContext ?? officialContext, providerCap ?? officialContext)
      : undefined;
    const maxInputTokens = typeof officialMaxInput === "number"
      ? Math.min(officialMaxInput, userMaxInput ?? officialMaxInput)
      : undefined;
    return {
      provider: OPENAI_API_PROVIDER_ID,
      id,
      owned_by: OPENAI_API_PROVIDER_ID,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxInputTokens ? { maxInputTokens } : {}),
      ...(entry.modelInputModalities?.[id] ? { inputModalities: [...entry.modelInputModalities[id]!] } : {}),
      ...(entry.modelReasoningEfforts?.[id] ? { reasoningEfforts: [...entry.modelReasoningEfforts[id]!] } : {}),
    };
  });

  for (const trusted of trustedRows) {
    const live = existingById.get(trusted.id);
    if (!live) continue;
    const liveSignature = normalizedOpenAiApiSignature(live);
    const trustedSignature = normalizedOpenAiApiSignature(trusted);
    if (liveSignature === trustedSignature) continue;
    const warningKey = `${trusted.provider}/${trusted.id}\n${liveSignature}\n${trustedSignature}`;
    if (openAiApiCollisionWarnings.has(warningKey)) continue;
    openAiApiCollisionWarnings.add(warningKey);
    console.warn(`[opencodex] replacing conflicting live OpenAI API metadata for ${trusted.provider}/${trusted.id} with trusted registry metadata`);
  }

  return [
    ...models.filter(model => model.provider !== OPENAI_API_PROVIDER_ID),
    ...trustedRows,
  ];
}

export function augmentRoutedModelsWithJawcodeMetadata(
  models: CatalogModel[],
  providerNames: string[],
  providers?: Record<string, OcxProviderConfig>,
  caps?: Pick<OcxConfig, "providerContextCaps">,
): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map(m => `${m.provider}/${m.id}`));
  for (const provider of providerNames) {
    if (!JAWCODE_CATALOG_AUGMENT_PROVIDERS.has(provider)) continue;
    if (providers?.[provider]?.liveModels === false) continue;
    const jawcodeProvider = resolveJawcodeProvider(provider);
    if (!jawcodeProvider) continue;
    for (const meta of listJawcodeModelMetadata(jawcodeProvider)) {
      const key = `${provider}/${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const contextCap = caps ? providerContextCap(caps, provider) : undefined;
      const model: CatalogModel = {
        provider,
        id: meta.id,
        owned_by: provider,
        ...(typeof meta.contextWindow === "number" && meta.contextWindow > 0 ? { contextWindow: meta.contextWindow } : {}),
        ...(Array.isArray(meta.input) && meta.input.length > 0 ? { inputModalities: [...meta.input] } : {}),
      };
      out.push({
        ...model,
        ...(providers?.[provider] ? applyProviderConfigHints(provider, providers[provider], model, contextCap) : {}),
      });
    }
  }
  return out;
}

/**
 * Reorder routed models so the configured subagent picks come FIRST (in the chosen order).
 * Codex's spawn_agent advertises only the first 5 routed catalog entries, so putting the chosen
 * ones first makes exactly them appear as overrides. Non-featured keep their relative order (stable
 * sort) and stay visibility:"list" — so they remain in the main /model picker and callable by name.
 */
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

/**
 * Merge namespaced routed-model entries into the on-disk Codex catalog.
 * Idempotent + non-destructive:
 *  - native entries (slug without "/") are preserved untouched,
 *  - previously injected entries (slug containing "/") are dropped and re-added,
 *  - each injected entry is CLONED from a native template so it has all required fields,
 *  - the catalog is backed up to ~/.opencodex/catalog-backup.json before writing.
 * No-op if the catalog file does not exist.
 */
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

/**
 * Restore the Codex catalog to native-only by dropping every opencodex-injected
 * "<provider>/<model>" entry (those route through the proxy). Native gpt/codex slugs (no "/")
 * are kept, so plain `codex` works when the proxy is stopped. Idempotent; no-op if nothing injected.
 */
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

/**
 * Refresh Codex's models cache ($CODEX_HOME/models_cache.json) from the active catalog.
 * Codex caches the model list for 5 min (DEFAULT_MODEL_CACHE_TTL); copying the injected catalog
 * makes catalog edits (enable/disable, subagent reorder) apply on the next turn instead of waiting.
 */
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
