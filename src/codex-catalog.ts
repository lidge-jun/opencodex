import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, websocketsEnabled } from "./config";
import { CODEX_CONFIG_PATH, CODEX_MODELS_CACHE_PATH, DEFAULT_CATALOG_PATH, readRootTomlString, resolveCodexConfigPath } from "./codex-paths";
import { DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, setCached } from "./model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "./oauth/index";
import type { OcxConfig, OcxProviderConfig } from "./types";
import { CODEX_REASONING_LEVELS, configuredReasoningEfforts, sanitizeCodexReasoningEfforts } from "./reasoning-effort";
import { getJawcodeModelMetadata, getJawcodeModelMetadataCaseInsensitive, listJawcodeModelMetadata, resolveJawcodeProvider } from "./generated/jawcode-model-metadata";
import { shouldCaseFoldMetadataModelId } from "./providers/derive";

const OCX_DIR = join(homedir(), ".opencodex");
const CATALOG_BACKUP_PATH = join(OCX_DIR, "catalog-backup.json");

/**
 * Native OpenAI / Codex models served via ChatGPT OAuth passthrough — FALLBACK only. The ChatGPT
 * backend has no `GET /models`, so the real set is read from the live Codex catalog (the slugs Codex
 * itself ships for the installed version) via nativeOpenAiSlugs(); this static list is used only when
 * no catalog is present. Keep it to ids ChatGPT actually accepts — advertising a phantom (e.g. an
 * old `gpt-5.2`/`gpt-5.3-codex` that a newer Codex dropped) makes it 400 "model is not supported".
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
];

/**
 * The native (passthrough) OpenAI slugs to advertise — the LIVE Codex catalog's own bare slugs when
 * available (always-latest: matches exactly what the installed Codex supports), else the static
 * fallback above. Single source for the /v1/models native list and the subagent-default seed.
 */
export function nativeOpenAiSlugs(): string[] {
  const live = listCatalogNativeSlugs();
  return live.length > 0 ? live : NATIVE_OPENAI_MODELS;
}

export interface CatalogModel { id: string; provider: string; owned_by?: string; reasoningEfforts?: string[]; contextWindow?: number; inputModalities?: string[]; }
type RawEntry = Record<string, unknown>;
const JAWCODE_CATALOG_AUGMENT_PROVIDERS = new Set(["opencode-go"]);

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

/** Resolve the `model_catalog_json` path from Codex config.toml, else the default. */
export function readCodexCatalogPath(): string {
  try {
    if (existsSync(CODEX_CONFIG_PATH)) {
      const toml = readFileSync(CODEX_CONFIG_PATH, "utf-8");
      const path = readRootTomlString(toml, "model_catalog_json");
      if (path) return resolveCodexConfigPath(path);
    }
  } catch { /* ignore */ }
  return DEFAULT_CATALOG_PATH;
}

function readCatalog(path: string): { models?: RawEntry[]; [k: string]: unknown } | null {
  try {
    if (!existsSync(path)) return null;
    const cat = JSON.parse(readFileSync(path, "utf-8"));
    return (cat && Array.isArray(cat.models)) ? cat : null;
  } catch { return null; }
}

function findNativeTemplate(catalog: { models?: RawEntry[] } | null): RawEntry | null {
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

function ensureStrictCatalogFields(entry: RawEntry): RawEntry {
  if (typeof entry.supports_reasoning_summaries !== "boolean") entry.supports_reasoning_summaries = true;
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
  if (!Array.isArray(entry.input_modalities)) entry.input_modalities = ["text"];
  if (typeof entry.context_window !== "number" || entry.context_window <= 0) entry.context_window = 128000;
  if (typeof entry.max_context_window !== "number" || entry.max_context_window <= 0) {
    entry.max_context_window = entry.context_window;
  }
  if (typeof entry.effective_context_window_percent !== "number") entry.effective_context_window_percent = 95;
  if (typeof entry.comp_hash !== "string") entry.comp_hash = "opencodex";
  return ensureAutoCompactTokenLimit(entry);
}

export function normalizeRoutedCatalogEntry(entry: RawEntry): RawEntry {
  delete entry.model_messages;
  delete entry.tool_mode;
  delete entry.multi_agent_version;
  delete entry.use_responses_lite;
  delete entry.supports_websockets;
  delete entry.additional_speed_tiers;
  delete entry.service_tier;
  delete entry.service_tiers;
  delete entry.default_service_tier;
  // Routed providers use opencodex sidecars and client-executed tool discovery. The sidecar
  // runs through native gpt-5.4-mini, so image search is available and verbalized for text-only models.
  entry.web_search_tool_type = "text_and_image";
  entry.supports_search_tool = true;
  entry.supports_parallel_tool_calls = false;
  return ensureStrictCatalogFields(entry);
}

function applyJawcodeCatalogMetadata(entry: RawEntry, slug: string): void {
  const slash = slug.indexOf("/");
  if (slash < 0) return;
  const provider = slug.slice(0, slash);
  const modelId = slug.slice(slash + 1);
  const jawcodeProvider = resolveJawcodeProvider(provider);
  if (!jawcodeProvider) return;
  const meta = getJawcodeModelMetadata(jawcodeProvider, modelId)
    ?? (shouldCaseFoldMetadataModelId(provider) ? getJawcodeModelMetadataCaseInsensitive(jawcodeProvider, modelId) : undefined);
  if (!meta) return;
  if (typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
    entry.context_window = meta.contextWindow;
    entry.max_context_window = meta.contextWindow;
    entry.auto_compact_token_limit = Math.floor(meta.contextWindow * 0.9);
  }
  if (Array.isArray(meta.input) && meta.input.length > 0) {
    entry.input_modalities = meta.input;
  }
}

function loadCatalogForSync(path: string): { models?: RawEntry[]; [k: string]: unknown } | null {
  const catalog = readCatalog(path);
  if (catalog && findNativeTemplate(catalog)) return catalog;
  return readCatalog(CATALOG_BACKUP_PATH) ?? readCatalog(CODEX_MODELS_CACHE_PATH) ?? catalog;
}

function readCurrentCatalogOrCache(): { models?: RawEntry[]; [k: string]: unknown } | null {
  return readCatalog(readCodexCatalogPath()) ?? readCatalog(CODEX_MODELS_CACHE_PATH);
}

/**
 * A full native entry from the on-disk catalog, used as a clone template so injected
 * entries carry EVERY field Codex's strict parser requires (e.g. `base_instructions`).
 * Returns a deep copy, or null if no catalog/native entry exists.
 */
export function loadCatalogTemplate(): RawEntry | null {
  const native = findNativeTemplate(readCatalog(readCodexCatalogPath()))
    ?? findNativeTemplate(readCatalog(CATALOG_BACKUP_PATH))
    ?? findNativeTemplate(readCatalog(CODEX_MODELS_CACHE_PATH));
  return native ? JSON.parse(JSON.stringify(native)) : null;
}

/**
 * Codex only accepts its native labels in the catalog. Provider-specific wire values (e.g. Z.AI
 * `max`) are mapped at request time by src/reasoning-effort.ts, never advertised directly here.
 */
const ROUTED_REASONING_LEVELS = CODEX_REASONING_LEVELS;

function applyCatalogModelMetadata(entry: RawEntry, model?: CatalogModel): void {
  if (!model) return;
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    entry.context_window = model.contextWindow;
    entry.max_context_window = model.contextWindow;
    entry.auto_compact_token_limit = Math.floor(model.contextWindow * 0.9);
  }
  if (Array.isArray(model.inputModalities) && model.inputModalities.length > 0) {
    entry.input_modalities = model.inputModalities;
  }
}

function applyReasoningLevels(entry: RawEntry, effortsOverride?: string[]): void {
  const efforts = sanitizeCodexReasoningEfforts(effortsOverride) ?? ROUTED_REASONING_LEVELS.map(l => l.effort);
  const byEffort = new Map(
    (Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : [])
      .map((l: { effort?: string }) => [l.effort, l]),
  );
  entry.supported_reasoning_levels = efforts.map(effort => {
    const native = byEffort.get(effort);
    if (native) return native;
    return ROUTED_REASONING_LEVELS.find(l => l.effort === effort) ?? { effort, description: `${effort} reasoning` };
  });
  if (efforts.length === 0) {
    delete entry.default_reasoning_level;
    return;
  }
  entry.default_reasoning_level = efforts.includes("medium") ? "medium" : efforts.includes("high") ? "high" : efforts[0];
}

function deriveEntry(template: RawEntry | null, slug: string, desc: string, priority: number, model?: CatalogModel): RawEntry {
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
    // and advertise the reasoning ladder Codex accepts (low/medium/high/xhigh).
    if (slug.includes("/")) {
      const modelName = slug.slice(slug.indexOf("/") + 1);
      if (typeof e.base_instructions === "string") {
        e.base_instructions = e.base_instructions.replace(
          "You are Codex, a coding agent based on GPT-5.",
          `You are a coding agent powered by the ${modelName} model, served through the opencodex proxy. Do not claim to be GPT-5 or made by OpenAI.`,
        );
      }
      applyReasoningLevels(e, model?.reasoningEfforts);
      normalizeRoutedCatalogEntry(e);
      applyJawcodeCatalogMetadata(e, slug);
      applyCatalogModelMetadata(e, model);
    }
    return ensureStrictCatalogFields(normalizeServiceTiers(e));
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  const entry: RawEntry = {
    slug, display_name: slug, description: desc,
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
    ...(slug.includes("/") ? { web_search_tool_type: "text_and_image", supports_search_tool: true } : {}),
  };
  if (slug.includes("/")) applyReasoningLevels(entry, model?.reasoningEfforts);
  else applyReasoningLevels(entry);
  applyJawcodeCatalogMetadata(entry, slug);
  applyCatalogModelMetadata(entry, model);
  return ensureStrictCatalogFields(normalizeServiceTiers(entry));
}

/**
 * Single source of truth for Codex-catalog-shaped entries, reused by both the on-disk
 * catalog sync and the proxy `/v1/models?client_version` branch.
 * Native gpt slugs stay bare; routed models are namespaced `<provider>/<model>`.
 */
export function buildCatalogEntries(template: RawEntry | null, gptSlugs: string[], goModels: CatalogModel[], featured?: string[], wsEnabled = false): RawEntry[] {
  // Codex's models-manager sorts by `priority` ASC and advertises the first 5 picker-visible
  // models to spawn_agent (sort_by_key(priority) + MAX_MODEL_OVERRIDES_IN_SPAWN_AGENT=5). Catalog
  // ARRAY order is discarded — so "featuring" a model = giving it the LOWEST priority (0..N-1) so
  // it sorts to the front. This works for native gpt slugs AND routed slugs alike.
  const rank = new Map((featured ?? []).map((slug, i) => [slug, i] as const));
  const out: RawEntry[] = [];
  for (const slug of gptSlugs) {
    const e = deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
  }
  for (const m of goModels) {
    const slug = `${m.provider}/${m.id}`;
    const e = deriveEntry(template, slug, `Routed via opencodex → ${m.provider} (${m.owned_by ?? m.provider}).`, 5, m);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
  }
  // Central capability override (phase 120.4): the advertised flag must match the implemented WS
  // endpoint. Overrides both the routed strip (normalizeRoutedCatalogEntry) and any native template
  // leak (deriveEntry clones the template as-is for native slugs).
  for (const entry of out) {
    if (wsEnabled) entry.supports_websockets = true;
    else delete entry.supports_websockets;
  }
  return out;
}

/** Bare picker-visible native slugs in the live Codex catalog (drives the subagent picker UI). */
export function listCatalogNativeSlugs(): string[] {
  const cat = readCurrentCatalogOrCache();
  return (cat?.models ?? [])
    .filter(m => typeof m.slug === "string" && !(m.slug as string).includes("/") && m.visibility === "list")
    .map(m => m.slug as string);
}

/**
 * Native-model priority baseline read from the PRISTINE backup, so featuring stays reversible:
 * a featured native gets its low rank, and un-featuring restores its original catalog priority
 * (rather than the modified value left in the live catalog by a previous sync).
 */
function readNativeBaseline(): Map<string, number> {
  const backup = readCatalog(CATALOG_BACKUP_PATH);
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
  max_model_len?: number;
  metadata?: {
    capabilities?: Record<string, unknown>;
    limits?: Record<string, unknown>;
  };
};

function configuredContextWindow(prov: OcxProviderConfig, id: string): number | undefined {
  const modelContextWindow = prov.modelContextWindows?.[id];
  if (typeof modelContextWindow === "number" && modelContextWindow > 0) return modelContextWindow;
  return typeof prov.contextWindow === "number" && prov.contextWindow > 0 ? prov.contextWindow : undefined;
}

function cappedContextWindow(reported: unknown, configuredCap: unknown): number | undefined {
  const live = typeof reported === "number" && reported > 0 ? reported : undefined;
  const cap = typeof configuredCap === "number" && configuredCap > 0 ? configuredCap : undefined;
  if (live !== undefined && cap !== undefined) return Math.min(live, cap);
  return live ?? cap;
}

function catalogHintsFromProviderConfig(name: string, prov: OcxProviderConfig, id: string): Partial<CatalogModel> {
  void name;
  const reasoningEfforts = configuredReasoningEfforts(prov, id);
  const contextWindow = configuredContextWindow(prov, id);
  return {
    ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function applyConfigHintsToCachedModels(name: string, prov: OcxProviderConfig, models: CatalogModel[]): CatalogModel[] {
  return models.map(model => {
    const configHints = catalogHintsFromProviderConfig(name, prov, model.id);
    const contextWindow = cappedContextWindow(model.contextWindow, configHints.contextWindow);
    return {
      ...model,
      ...configHints,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  });
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
      : typeof item.max_model_len === "number" ? item.max_model_len
        : undefined;
  const reasoningEfforts = capabilities && typeof capabilities.reasoning_effort === "boolean"
    ? (capabilities.reasoning_effort
      ? ((providerName === "neuralwatt" || providerName === "zai") && isGlm52ModelId(item.id)
        ? ["low", "medium", "high", "xhigh"]
        : ["low", "medium", "high"])
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
 * forward-auth providers. Fresh cache → no network; live fetch → cache the merged result;
 * fetch failure → last-known-good cache (so a provider blip doesn't drop its models), else the
 * static config list. This is the per-provider half of jawcode's "always latest" resolver.
 */
async function fetchProviderModels(name: string, prov: OcxProviderConfig, ttlMs: number): Promise<CatalogModel[]> {
  if (prov.authMode === "forward") return []; // ChatGPT backend has no /models
  const apiKey = await resolveModelsAuthToken(name, prov);
  if (prov.authMode === "oauth" && !apiKey) return []; // not logged in → skip
  const fresh = getFreshCached(name, ttlMs);
  if (fresh) return applyConfigHintsToCachedModels(name, prov, fresh); // dedups Codex's frequent /v1/models polling within the TTL
  const configured: CatalogModel[] = (prov.models ?? []).map(id => ({
    id,
    provider: name,
    ...catalogHintsFromProviderConfig(name, prov, id),
  }));
  const { url, headers } = buildModelsRequest(prov, apiKey);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      const stale = getStaleCached(name);
      return stale ? applyConfigHintsToCachedModels(name, prov, stale) : configured;
    }
    const json = await res.json() as { data?: ProviderModelsApiItem[] };
    const live = (json.data ?? []).map(m => {
      const liveHints = catalogHintsFromModelsApiItem(name, m);
      const configHints = catalogHintsFromProviderConfig(name, prov, m.id);
      const contextWindow = cappedContextWindow(liveHints.contextWindow, configHints.contextWindow);
      return {
        id: m.id,
        provider: name,
        owned_by: m.owned_by,
        ...liveHints,
        ...configHints,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    });
    const liveIds = new Set(live.map(m => m.id));
    // Merge explicit config additions (e.g. a model not in the provider's /models, like a new endpoint).
    const merged = [...live, ...configured.filter(m => !liveIds.has(m.id))];
    setCached(name, merged);
    return merged;
  } catch {
    const stale = getStaleCached(name);
    return stale ? applyConfigHintsToCachedModels(name, prov, stale) : configured;
  }
}

/**
 * Gather routed (non-forward) provider models across the config — the single source of truth for
 * the live model list, used by both the on-disk catalog sync and the proxy's /api/* + /v1/models
 * endpoints. Providers are fetched in parallel; the result is sorted (provider, then id) for a
 * stable listing. TTL comes from `config.modelCacheTtlMs` (default 5 min).
 */
export async function gatherRoutedModels(config: OcxConfig): Promise<CatalogModel[]> {
  const ttlMs = config.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  const lists = await Promise.all(
    Object.entries(config.providers).map(([name, prov]) => fetchProviderModels(name, prov, ttlMs)),
  );
  const all = augmentRoutedModelsWithJawcodeMetadata(lists.flat(), Object.keys(config.providers), config.providers)
    // Drop image/video generation models (e.g. Grok image/video) — they are not usable by Codex and
    // must not surface in the dashboard, /v1/models, or the routed catalog. Single choke point.
    .filter(m => !isMediaGenerationModelId(m.id));
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  return all;
}

export function augmentRoutedModelsWithJawcodeMetadata(models: CatalogModel[], providerNames: string[], providers?: Record<string, OcxProviderConfig>): CatalogModel[] {
  const out = [...models];
  const seen = new Set(out.map(m => `${m.provider}/${m.id}`));
  for (const provider of providerNames) {
    if (!JAWCODE_CATALOG_AUGMENT_PROVIDERS.has(provider)) continue;
    const jawcodeProvider = resolveJawcodeProvider(provider);
    if (!jawcodeProvider) continue;
    for (const meta of listJawcodeModelMetadata(jawcodeProvider)) {
      const key = `${provider}/${meta.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider, id: meta.id, owned_by: provider, ...(providers?.[provider] ? catalogHintsFromProviderConfig(provider, providers[provider], meta.id) : {}) });
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
  const keyOf = (m: CatalogModel) => `${m.provider}/${m.id}`;
  return [...goModels].sort((a, b) => {
    const ra = rank.has(keyOf(a)) ? rank.get(keyOf(a))! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(keyOf(b)) ? rank.get(keyOf(b))! : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
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
  if (goModels.length === 0) return { added: 0, path: catalogPath };

  // Hide disabled models from Codex, then feature the chosen subagent models (native OR routed)
  // by giving them the lowest priority — see buildCatalogEntries for why priority, not array order.
  const disabled = new Set(config.disabledModels ?? []);
  const enabledGo = goModels.filter(m => !disabled.has(`${m.provider}/${m.id}`));
  const featured = config.subagentModels ?? [];
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const orderedGoModels = orderForSubagents(enabledGo, featured); // stable tie-break among equal priorities
  const goEntries = buildCatalogEntries(template ? JSON.parse(JSON.stringify(template)) : null, [], orderedGoModels, featured, websocketsEnabled(config));
  // Keep genuine native entries (gpt-*, codex-*) with their real per-model fields, but drop bare
  // duplicates of routed models (replaced by namespaced entries) + any prior "/" entries. Re-derive
  // each native's priority from the pristine baseline so featuring a native is reversible.
  const baseline = readNativeBaseline();
  const goIds = new Set(enabledGo.map(m => m.id));
  const native = (catalog.models ?? [])
    .filter(m => typeof m.slug === "string" && !(m.slug as string).includes("/") && !goIds.has(m.slug as string))
    .map(m => {
      const slug = m.slug as string;
      const priority = rank.has(slug) ? rank.get(slug)! : (baseline.get(slug) ?? (m.priority as number));
      return normalizeServiceTiers({ ...m, priority });
    });
  // Central WS capability override on the FINAL on-disk catalog (the file Codex reads). Applies to
  // native AND routed so the advertised flag matches the implemented endpoint (phase 120.4) and a
  // native template can never leak supports_websockets while the flag is off.
  const wsEnabled = websocketsEnabled(config);
  catalog.models = [...native, ...goEntries].map(m => {
    const e = ensureStrictCatalogFields(normalizeServiceTiers(m));
    if (wsEnabled) e.supports_websockets = true;
    else delete e.supports_websockets;
    return e;
  });

  try {
    if (!existsSync(OCX_DIR)) mkdirSync(OCX_DIR, { recursive: true });
    // Once-only: preserve the PRISTINE pre-opencodex catalog as the native-priority baseline
    // (later syncs would otherwise overwrite it with featured-modified priorities).
    if (!existsSync(CATALOG_BACKUP_PATH)) copyFileSync(catalogPath, CATALOG_BACKUP_PATH);
  } catch { /* backup best-effort */ }
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
    const catalog = readFileSync(catalogPath, "utf8");
    atomicWriteFile(CODEX_MODELS_CACHE_PATH, catalog.endsWith("\n") ? catalog : `${catalog}\n`);
  } catch { /* best-effort */ }
}
