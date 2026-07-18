import type { OcxProviderConfig } from "../types";
import { deriveKeyLoginMap, enrichProviderFromRegistry, type DerivedKeyLoginProvider } from "../providers/derive";

/**
 * API-key "login" providers: not OAuth — the flow opens the provider's dashboard so the user can
 * create/copy a key, then validates + stores it as the provider's `apiKey` (authMode "key").
 * Most use the OpenAI-compatible chat API (`openai-chat` adapter, `Authorization: Bearer <key>`); a
 * few expose only an Anthropic-compatible endpoint and set `adapter: "anthropic"` (`x-api-key`).
 */
export interface KeyLoginProvider extends DerivedKeyLoginProvider {}

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
          model: provider.defaultModel ?? "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return true;
      if (res.status === 401 || res.status === 403) return false;
      return "unknown";
    }

    if (provider.adapter === "google" && (provider.googleMode ?? "ai-studio") === "ai-studio") {
      // Generative Language API rejects Bearer-wrapped API keys; probe models.list with the
      // documented x-goog-api-key header instead (pageSize=1 — validation only needs a 200).
      const res = await fetch(`${provider.baseUrl}/v1beta/models?pageSize=1`, {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return true;
      if (res.status === 400 || res.status === 401 || res.status === 403) return false;
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
