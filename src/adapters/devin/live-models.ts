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

/**
 * Degraded-mode context windows, used only when live discovery cannot run.
 *
 * Every number here was read from a live `GetCascadeModelConfigs` response
 * (`ClientModelConfig` field #18) rather than from documentation, because
 * Cognition publishes none: the Devin CLI and Desktop model pages, the SWE-2
 * and SWE-1.7 announcements, and the Windsurf model reference all state model
 * names without a context window. The only published numbers are long-context
 * pricing thresholds, which are a different quantity and were not used.
 *
 * The previous copy of this table was wrong for nine of its eleven rows — the
 * three Claude models were listed at 200k against an actual 1M, `grok-4-5` at
 * 256k against 500k, and the GPT rows at 1.05M against 1M — because it was
 * assembled from each model's upstream vendor window instead of what Cognition
 * actually serves. Measure the catalog when updating this; do not carry a
 * number over from the model's original vendor.
 */
export const DEVIN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "swe-2": 262_000,
  "swe-1-7": 262_000,
  "swe-1-7-lightning": 202_752,
  "swe-1-6": 200_000,
  "gpt-5-6-sol": 1_000_000,
  "gpt-5-6-luna": 1_000_000,
  "gpt-5-6-terra": 1_000_000,
  "gpt-6-astra": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-5": 1_000_000,
  "claude-fable-5-1": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "glm-5-2": 200_000,
  "glm-5-3": 1_048_576,
  "kimi-k2-7": 262_144,
  "kimi-k3": 1_048_576,
  "gemini-3-8-flash": 1_048_576,
  "grok-4-5": 500_000,
  "grok-4-6": 500_000,
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
  | { ok: true; models: string[]; contextWindows: Record<string, number> }
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
    const contextWindows: Record<string, number> = {};
    for (const entry of catalog.byUid.values()) {
      if (entry.disabled) continue;
      // Skip internal enum constants (e.g. MODEL_GPT_5_2_LOW, MODEL_PRIVATE_*).
      // Real chat model UIDs are lowercase dashed strings (swe-1-7, gpt-5-6-sol).
      if (entry.modelUid.startsWith("MODEL_")) continue;
      const base = collapseDevinModelUid(entry.modelUid);
      bases.add(base);
      if (entry.contextWindow && entry.contextWindow > 0) {
        // Variants of one base can disagree: the opt-in `-1m` rows report a
        // larger window than the plain row of the same base, and both collapse
        // here because `1m` is an effort token. Keep the smallest, because the
        // base id routes to the plain variant — advertising the long-context
        // number would promise a window the request the picker actually sends
        // cannot use.
        const seen = contextWindows[base];
        contextWindows[base] = seen === undefined ? entry.contextWindow : Math.min(seen, entry.contextWindow);
      }
    }
    if (bases.size === 0) return { ok: false, error: "empty" };
    return { ok: true, models: [...bases].sort(), contextWindows };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauth|401|invalid token|login/i.test(message)) return { ok: false, error: "auth", detail: message };
    return { ok: false, error: "unknown", detail: message };
  }
}
