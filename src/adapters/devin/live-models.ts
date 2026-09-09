/**
 * Live Devin / Cognition model discovery via GetCascadeModelConfigs.
 *
 * The live catalog is the source of truth for the model roster. The endpoint
 * returns effort-suffixed variants (e.g. `gpt-5-6-sol-high`); we collapse those
 * to base ids so the picker stays clean and the adapter appends the effort
 * suffix at request time. `DEVIN_STATIC_MODELS` is only a degraded-mode
 * fallback for when there is no API key or discovery fails.
 */
import { getCachedCatalog, type ModelCatalogEntry } from "./cloud-direct";

const DEFAULT_HOST = "https://server.codeium.com";

/**
 * Degraded-mode fallback shown when there is no API key or live discovery
 * fails. The live catalog overrides this whenever discovery succeeds.
 */
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

/**
 * Trailing tokens that the Cognition catalog appends as effort/variant
 * suffixes. Stripped to collapse suffixed UIDs to their base id.
 */
const EFFORT_TOKENS = new Set([
  "low", "medium", "high", "xhigh", "max", "none", "fast", "priority", "1m",
]);

/** Collapse an effort-suffixed UID to its base id (e.g. `gpt-5-6-sol-high` → `gpt-5-6-sol`). */
export function collapseDevinModelUid(uid: string): string {
  const parts = uid.split("-");
  while (parts.length > 1 && EFFORT_TOKENS.has(parts[parts.length - 1]!)) {
    parts.pop();
  }
  return parts.join("-");
}

export type DevinUsableModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: "auth" | "http" | "empty" | "unknown"; detail?: string };

/**
 * Fetch the live model roster from Cognition's `GetCascadeModelConfigs` and
 * collapse effort-suffixed variants to base ids. The returned list is the
 * authoritative model roster for the signed-in account.
 */
export async function fetchDevinUsableModels(opts: {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<DevinUsableModelsResult> {
  try {
    const host = (opts.baseUrl || DEFAULT_HOST).replace(/\/$/, "");
    const catalog = await getCachedCatalog(opts.apiKey, host, opts.signal);
    if (!catalog) return { ok: false, error: "empty" };
    const bases = new Set<string>();
    for (const entry of catalog.byUid.values()) {
      if (entry.disabled) continue;
      // Skip internal enum constants (e.g. MODEL_GPT_5_2_LOW, MODEL_PRIVATE_*).
      // Real chat model UIDs are lowercase dashed strings (swe-1-7, gpt-5-6-sol).
      if (entry.modelUid.startsWith("MODEL_")) continue;
      bases.add(collapseDevinModelUid(entry.modelUid));
    }
    if (bases.size === 0) return { ok: false, error: "empty" };
    return { ok: true, models: [...bases].sort() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauth|401|invalid token|login/i.test(message)) return { ok: false, error: "auth", detail: message };
    return { ok: false, error: "unknown", detail: message };
  }
}
