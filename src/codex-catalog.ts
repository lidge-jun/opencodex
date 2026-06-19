import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./config";
import { DEFAULT_MODEL_CACHE_TTL_MS, getFreshCached, getStaleCached, setCached } from "./model-cache";
import { buildModelsRequest, resolveModelsAuthToken } from "./oauth/index";
import type { OcxConfig, OcxProviderConfig } from "./types";

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const DEFAULT_CATALOG_PATH = join(homedir(), ".codex", "opencodex-catalog.json");
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

export interface CatalogModel { id: string; provider: string; owned_by?: string; }
type RawEntry = Record<string, unknown>;

/** Resolve the `model_catalog_json` path from Codex config.toml, else the default. */
export function readCodexCatalogPath(): string {
  try {
    if (existsSync(CODEX_CONFIG_PATH)) {
      const toml = readFileSync(CODEX_CONFIG_PATH, "utf-8");
      const m = toml.match(/^\s*model_catalog_json\s*=\s*"([^"]+)"/m);
      if (m) return m[1];
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

/**
 * A full native entry from the on-disk catalog, used as a clone template so injected
 * entries carry EVERY field Codex's strict parser requires (e.g. `base_instructions`).
 * Returns a deep copy, or null if no catalog/native entry exists.
 */
export function loadCatalogTemplate(): RawEntry | null {
  const cat = readCatalog(readCodexCatalogPath());
  const native = cat?.models?.find(
    m => typeof m.slug === "string" && !m.slug.includes("/") && "base_instructions" in m,
  );
  return native ? JSON.parse(JSON.stringify(native)) : null;
}

/**
 * The reasoning ladder advertised for routed models in Codex's picker: low → medium → high → xhigh.
 * This matches Codex's NATIVE catalog exactly — Codex's strict parser rejects an unknown effort like
 * `max`, so it must not be advertised here. (Previously routed models were clamped down to
 * low/medium/high, which dropped the `xhigh` that Codex does support.)
 */
const ROUTED_REASONING_LEVELS: { effort: string; description: string }[] = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extended reasoning for the hardest problems" },
];

function deriveEntry(template: RawEntry | null, slug: string, desc: string, priority: number): RawEntry {
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
      // Reuse the template's level objects where they exist (correct shape/fields), synthesize the rest.
      const byEffort = new Map(
        (Array.isArray(e.supported_reasoning_levels) ? e.supported_reasoning_levels : [])
          .map((l: { effort?: string }) => [l.effort, l]),
      );
      e.supported_reasoning_levels = ROUTED_REASONING_LEVELS.map(l => byEffort.get(l.effort) ?? { ...l });
      e.default_reasoning_level = "medium";
    }
    return e;
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  return {
    slug, display_name: slug, description: desc,
    default_reasoning_level: "medium",
    supported_reasoning_levels: ROUTED_REASONING_LEVELS.map(l => ({ ...l })),
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
  };
}

/**
 * Single source of truth for Codex-catalog-shaped entries, reused by both the on-disk
 * catalog sync and the proxy `/v1/models?client_version` branch.
 * Native gpt slugs stay bare; routed models are namespaced `<provider>/<model>`.
 */
export function buildCatalogEntries(template: RawEntry | null, gptSlugs: string[], goModels: CatalogModel[], featured?: string[]): RawEntry[] {
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
    const e = deriveEntry(template, slug, `Routed via opencodex → ${m.provider} (${m.owned_by ?? m.provider}).`, 5);
    if (rank.has(slug)) e.priority = rank.get(slug)!;
    out.push(e);
  }
  return out;
}

/** Bare picker-visible native slugs in the live Codex catalog (drives the subagent picker UI). */
export function listCatalogNativeSlugs(): string[] {
  const cat = readCatalog(readCodexCatalogPath());
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
  if (fresh) return fresh; // dedups Codex's frequent /v1/models polling within the TTL
  const configured: CatalogModel[] = (prov.models ?? []).map(id => ({ id, provider: name }));
  const { url, headers } = buildModelsRequest(prov, apiKey);
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return getStaleCached(name) ?? configured;
    const json = await res.json() as { data?: { id: string; owned_by?: string }[] };
    const live = (json.data ?? []).map(m => ({ id: m.id, provider: name, owned_by: m.owned_by }));
    const liveIds = new Set(live.map(m => m.id));
    // Merge explicit config additions (e.g. a model not in the provider's /models, like a new endpoint).
    const merged = [...live, ...configured.filter(m => !liveIds.has(m.id))];
    setCached(name, merged);
    return merged;
  } catch {
    return getStaleCached(name) ?? configured;
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
  const all = lists.flat();
  all.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
  return all;
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
  const catalog = readCatalog(catalogPath);
  if (!catalog) return { added: 0, path: catalogPath };

  const template = (catalog.models ?? []).find(
    m => typeof m.slug === "string" && !m.slug.includes("/") && "base_instructions" in m,
  ) ?? null;

  const goModels = await gatherRoutedModels(config);
  if (goModels.length === 0) return { added: 0, path: catalogPath };

  // Hide disabled models from Codex, then feature the chosen subagent models (native OR routed)
  // by giving them the lowest priority — see buildCatalogEntries for why priority, not array order.
  const disabled = new Set(config.disabledModels ?? []);
  const enabledGo = goModels.filter(m => !disabled.has(`${m.provider}/${m.id}`));
  const featured = config.subagentModels ?? [];
  const rank = new Map(featured.map((slug, i) => [slug, i] as const));
  const orderedGoModels = orderForSubagents(enabledGo, featured); // stable tie-break among equal priorities
  const goEntries = buildCatalogEntries(template ? JSON.parse(JSON.stringify(template)) : null, [], orderedGoModels, featured);
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
      return { ...m, priority };
    });
  catalog.models = [...native, ...goEntries];

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
 * Delete Codex's models cache (~/.codex/models_cache.json) so the next turn re-fetches /v1/models.
 * Codex caches the model list for 5 min (DEFAULT_MODEL_CACHE_TTL); invalidating makes catalog edits
 * (enable/disable, subagent reorder) apply on the next turn instead of waiting for the TTL.
 */
export function invalidateCodexModelsCache(): void {
  try {
    const p = join(homedir(), ".codex", "models_cache.json");
    if (existsSync(p)) unlinkSync(p);
  } catch { /* best-effort */ }
}
