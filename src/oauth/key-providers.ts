import type { OcxProviderConfig } from "../types";
import { deriveKeyLoginMap, enrichProviderFromRegistry } from "../providers/derive";

/**
 * API-key "login" providers: not OAuth — the flow opens the provider's dashboard so the user can
 * create/copy a key, then validates + stores it as the provider's `apiKey` (authMode "key").
 * Most use the OpenAI-compatible chat API (`openai-chat` adapter, `Authorization: Bearer <key>`); a
 * few expose only an Anthropic-compatible endpoint and set `adapter: "anthropic"` (`x-api-key`).
 */
export interface KeyLoginProvider {
  label: string;
  baseUrl: string;
  adapter: string;
  /** Where the user creates/copies the API key. */
  dashboardUrl: string;
  models?: string[];
  liveModels?: boolean;
  defaultModel?: string;
  contextWindow?: number;
  modelContextWindows?: Record<string, number>;
  modelInputModalities?: Record<string, string[]>;
  /**
   * Model ids that do NOT accept image input (the vision sidecar describes images for them) / do NOT
   * accept a reasoning param. Copied into the created provider config by `enrichProviderFromCatalog`,
   * so the classification actually gates the sidecars (matching is tolerant of an Ollama ":size" tag).
   */
  reasoningEfforts?: string[];
  modelReasoningEfforts?: Record<string, string[]>;
  reasoningEffortMap?: Record<string, string>;
  modelReasoningEffortMap?: Record<string, Record<string, string>>;
  noVisionModels?: string[];
  noReasoningModels?: string[];
  noTemperatureModels?: string[];
  noTopPModels?: string[];
  noPenaltyModels?: string[];
  autoToolChoiceOnlyModels?: string[];
  preserveReasoningContentModels?: string[];
  escapeBuiltinToolNames?: boolean;
}

export const KEY_LOGIN_PROVIDERS: Record<string, KeyLoginProvider> = deriveKeyLoginMap();

/**
 * Copy a registry entry's seed/classification (`models`, `liveModels`, `noVisionModels`,
 * `noReasoningModels`, `defaultModel`) onto a provider config being created, for any field the
 * caller didn't already supply. Lets the vision/reasoning classification actually reach the saved
 * config (the GUI/API only send adapter/baseUrl/apiKey/defaultModel). No-op for unknown names.
 */
export function enrichProviderFromCatalog(name: string, prov: OcxProviderConfig): void {
  enrichProviderFromRegistry(name, prov);
}

export function isKeyLoginProvider(name: string): boolean {
  return name in KEY_LOGIN_PROVIDERS;
}

export function listKeyLoginProviders(): Array<{ id: string } & KeyLoginProvider> {
  return Object.entries(KEY_LOGIN_PROVIDERS).map(([id, p]) => ({ id, ...p }));
}

/** Best-effort key validation. Returns true/false/unknown; never persists the key itself. */
export async function validateApiKey(provider: KeyLoginProvider, key: string): Promise<boolean | "unknown"> {
  try {
    if (provider.adapter === "anthropic") {
      const base = provider.baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": key,
        },
        body: JSON.stringify({
          model: provider.defaultModel ?? "claude-sonnet-4-6",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) return false;
      return "unknown";
    }

    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}
