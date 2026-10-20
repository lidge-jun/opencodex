/** Exact-model protocols from https://opencode.ai/v2/docs/console/go/#endpoints (2026-10-15).
 * Unknown models retain Chat. Responses entries are overridable registry defaults;
 * the native wires are hard pins because modelAdapters cannot select those adapters.
 */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export const OPENCODE_GO_MODEL_WIRES: Readonly<Record<string, "google" | "anthropic" | "openai-responses">> = Object.freeze({
  "gemini-4-argon-contributor": "google",
  "claude-haiku-5-5": "anthropic",
  "minimax-m2.7": "anthropic",
  "minimax-m3": "anthropic",
  "qwen3.7-plus": "anthropic",
  "qwen3.8-max": "anthropic",
  "qwen3.8-flash": "anthropic",
  "gpt-6-luna": "openai-responses",
  "gpt-5.6-luna": "openai-responses",
  "grok-4.6": "openai-responses",
  "grok-4.7": "openai-responses",
  "muse-spark-1.2-contributor": "openai-responses",
  "muse-spark-1.3-contributor": "openai-responses",
  // Retain previously supported Go models absent from the current endpoint table (#4847).
  "minimax-m2.5": "anthropic",
  "union-alpha": "anthropic",
});

/** Compatibility: these five pins predate destination scoping. New native pins require Go. */
export const OPENCODE_GO_LEGACY_NAME_PINS: ReadonlySet<string> = new Set([
  "claude-haiku-5-5", "minimax-m2.5", "minimax-m2.7", "minimax-m3", "union-alpha",
]);

export const OPENCODE_GO_RESPONSES_DEFAULTS = Object.freeze(Object.fromEntries(
  Object.entries(OPENCODE_GO_MODEL_WIRES).filter(([, wire]) => wire === "openai-responses"),
));

export interface OpenCodeGoDestination {
  readonly baseUrl?: unknown;
  readonly authMode?: unknown;
  readonly googleMode?: unknown;
}

/** A provider name alone must never authorize redirecting a credential to OpenCode. */
export function isOpenCodeGoGeminiDestination(provider: OpenCodeGoDestination | undefined): boolean {
  if (!provider || typeof provider.baseUrl !== "string") return false;
  if (provider.authMode !== undefined && provider.authMode !== "key") return false;
  if (provider.googleMode !== undefined && provider.googleMode !== "ai-studio") return false;
  try {
    const url = new URL(provider.baseUrl.trim());
    return url.origin === "https://opencode.ai"
      && !url.username && !url.password && !url.search && !url.hash
      && ["/zen/go/v1", "/inference/go/v1"].includes(url.pathname.replace(/\/+$/, ""));
  } catch {
    return false;
  }
}

/** Return the fixed Gemini endpoint only for the exact model and an eligible Go destination. */
export function openCodeGoGeminiEndpoint(provider: OpenCodeGoDestination, modelId: string): string | undefined {
  return Object.hasOwn(OPENCODE_GO_MODEL_WIRES, modelId) && OPENCODE_GO_MODEL_WIRES[modelId] === "google" && isOpenCodeGoGeminiDestination(provider)
    ? `https://opencode.ai/inference/go/v1/models/${encodeURIComponent(modelId)}`
    : undefined;
}
