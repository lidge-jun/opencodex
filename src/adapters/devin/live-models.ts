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
  "claude-fable-5",
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
  "claude-fable-5": 200_000,
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
  "claude-fable-5",
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
  const wanted = configured.filter((model) => live.has(model.id) || live.has(model.id.replace(/^devin\//, "")));
  if (wanted.length > 0) return wanted;
  return liveIds.map((id) => ({ id }) as T);
}

