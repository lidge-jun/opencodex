import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveEnvValue } from "./config";
import type { OcxConfig, OcxProviderConfig } from "./types";

const CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");
const DEFAULT_CATALOG_PATH = join(homedir(), ".codex", "opencodex-catalog.json");
const OCX_DIR = join(homedir(), ".opencodex");
const CATALOG_BACKUP_PATH = join(OCX_DIR, "catalog-backup.json");

/**
 * Native OpenAI / Codex models served via ChatGPT OAuth passthrough.
 * The ChatGPT backend has no `GET /models`, so these are listed statically.
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.3-codex", "gpt-5.3-codex-spark",
];

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
    return e;
  }
  // Fallback when no template is available (best-effort; strict parser may need more).
  return {
    slug, display_name: slug, description: desc,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "medium", description: "Balances speed and reasoning depth" },
      { effort: "high", description: "Greater reasoning depth for complex problems" },
    ],
    shell_type: "shell_command", visibility: "list", supported_in_api: true,
    priority, base_instructions: "You are a helpful coding assistant.",
  };
}

/**
 * Single source of truth for Codex-catalog-shaped entries, reused by both the on-disk
 * catalog sync and the proxy `/v1/models?client_version` branch.
 * Native gpt slugs stay bare; routed models are namespaced `<provider>/<model>`.
 */
export function buildCatalogEntries(template: RawEntry | null, gptSlugs: string[], goModels: CatalogModel[]): RawEntry[] {
  const out: RawEntry[] = [];
  for (const slug of gptSlugs) {
    out.push(deriveEntry(template, slug, "OpenAI native model (Codex OAuth passthrough).", 9));
  }
  for (const m of goModels) {
    out.push(deriveEntry(template, `${m.provider}/${m.id}`, `Routed via opencodex → ${m.provider} (${m.owned_by ?? m.provider}).`, 5));
  }
  return out;
}

/** Fetch a provider's `/models` (openai-chat style). Skips forward-auth providers. */
async function fetchProviderModels(name: string, prov: OcxProviderConfig): Promise<CatalogModel[]> {
  if (prov.authMode === "forward") return []; // ChatGPT backend has no /models
  const apiKey = resolveEnvValue(prov.apiKey);
  const headers: Record<string, string> = { ...(prov.headers ?? {}) };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  try {
    const res = await fetch(`${prov.baseUrl}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const json = await res.json() as { data?: { id: string; owned_by?: string }[] };
    return (json.data ?? []).map(m => ({ id: m.id, provider: name, owned_by: m.owned_by }));
  } catch {
    return [];
  }
}

/** Gather routed (non-forward) provider models across the config. */
export async function gatherRoutedModels(config: OcxConfig): Promise<CatalogModel[]> {
  const all: CatalogModel[] = [];
  for (const [name, prov] of Object.entries(config.providers)) {
    all.push(...await fetchProviderModels(name, prov));
  }
  return all;
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

  const goEntries = buildCatalogEntries(template ? JSON.parse(JSON.stringify(template)) : null, [], goModels);
  const native = (catalog.models ?? []).filter(m => typeof m.slug === "string" && !m.slug.includes("/"));
  catalog.models = [...native, ...goEntries];

  try {
    if (!existsSync(OCX_DIR)) mkdirSync(OCX_DIR, { recursive: true });
    copyFileSync(catalogPath, CATALOG_BACKUP_PATH);
  } catch { /* backup best-effort */ }
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  return { added: goEntries.length, path: catalogPath };
}
