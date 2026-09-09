/**
 * Live Devin / Cognition model discovery via GetCascadeModelConfigs.
 */
import { getCachedCatalog, type ModelCatalogEntry } from "./cloud-direct";

const DEFAULT_HOST = "https://server.codeium.com";

export const DEVIN_STATIC_MODELS = [
  "swe-1-7",
  "swe-1-7-lightning",
  "gpt-5-6-sol",
  "gpt-5-6-luna",
  "gpt-5-6-terra",
  "claude-opus-4-8",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "glm-5-2",
  "kimi-k2-7",
  "grok-4-5",
] as const;

/** Per-model context windows for Devin/Cognition models. Source: Cognition model catalog. */
export const DEVIN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-1-7": 256_000,
  "swe-1-7-lightning": 256_000,
  "gpt-5-6-sol": 1_050_000,
  "gpt-5-6-luna": 1_050_000,
  "gpt-5-6-terra": 1_050_000,
  "claude-opus-4-8": 200_000,
  "claude-fable-5-1": 200_000,
  "claude-sonnet-5": 200_000,
  "glm-5-2": 200_000,
  "kimi-k2-7": 256_000,
  "grok-4-5": 256_000,
};

const WANTED_PREFIXES = [
  "swe-1-7",
  "gpt-5-6-sol",
  "gpt-5-6-luna",
  "gpt-5-6-terra",
  "claude-opus-4-8",
  "claude-fable-5-1",
  "claude-sonnet-5",
  "glm-5-2",
  "kimi-k2-7",
  "grok-4-5",
] as const;

function matchesWantedPrefix(uid: string): boolean {
  for (const prefix of WANTED_PREFIXES) {
    if (uid === prefix || uid.startsWith(prefix + "-") || uid.startsWith(prefix + "_")) return true;
  }
  return false;
}

export type DevinUsableModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "auth" | "http" | "empty" | "unknown"; detail?: string };

export async function fetchDevinUsableModels(opts: {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<DevinUsableModelsResult> {
  try {
    const host = (opts.baseUrl || DEFAULT_HOST).replace(/\/$/, "");
    const catalog = await getCachedCatalog(opts.apiKey, host, opts.signal);
    if (!catalog) return { ok: false, error: "empty" };
    const models = [...catalog.byUid.values()]
      .filter((entry: ModelCatalogEntry) => !entry.disabled && matchesWantedPrefix(entry.modelUid))
      .map((entry) => entry.modelUid);
    if (models.length === 0) return { ok: false, error: "empty" };
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauth|401|invalid token|login/i.test(message)) return { ok: false, error: "auth", detail: message };
    return { ok: false, error: "unknown", detail: message };
  }
}

export function filterDevinConfiguredModelsByLiveDiscovery<T extends { id: string }>(
  configured: T[],
  liveIds: string[],
): T[] {
  const live = new Set(liveIds);
  const liveByBase = new Map<string, string[]>();
  for (const id of liveIds) {
    // Group effort-suffixed variants by their base id (e.g. `gpt-5-6-sol-high` → `gpt-5-6-sol`).
    const parts = id.split("-");
    if (parts.length > 1) {
      const base = parts.slice(0, -1).join("-");
      const list = liveByBase.get(base);
      if (list) list.push(id); else liveByBase.set(base, [id]);
    }
  }
  const wanted: T[] = [];
  for (const model of configured) {
    const id = model.id.replace(/^devin\//, "");
    if (live.has(id)) {
      wanted.push(model);
    } else if (liveByBase.has(id)) {
      // Base model exists only as effort-suffixed variants; keep the base entry
      // so the picker stays clean and the adapter appends the effort suffix.
      wanted.push(model);
    }
  }
  if (wanted.length > 0) return wanted;
  return liveIds.map((id) => ({ id }) as T);
}

