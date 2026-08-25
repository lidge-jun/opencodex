import type { OcxProviderConfig } from "../types";
import { deriveKeyLoginMap, enrichProviderFromRegistry, type DerivedKeyLoginProvider } from "../providers/derive";
import { resolveProviderModelDiscoveryUrl } from "../providers/model-discovery";

/**
 * API-key "login" providers: not OAuth — the flow opens the provider's dashboard so the user can
 * create/copy a key, then validates + stores it as the provider's `apiKey` (authMode "key").
 * Most use the OpenAI-compatible chat API (`openai-chat` adapter, `Authorization: Bearer <key>`); a
 * few expose only an Anthropic-compatible endpoint and set `adapter: "anthropic"` (default
 * `x-api-key`, optional bearer via `apiKeyTransport`).
 */
export interface KeyLoginProvider extends DerivedKeyLoginProvider {}

export const KEY_LOGIN_PROVIDERS: Record<string, KeyLoginProvider> = deriveKeyLoginMap();

/**
 * Copy a registry entry's seed/classification (`models`, `liveModels`, `noVisionModels`,
 * `noReasoningModels`, `defaultModel`) onto a provider config being created, for any field the
 * caller didn't already supply. Lets the vision/reasoning classification actually reach the saved
 * config (the GUI/API only send adapter/baseUrl/apiKey/defaultModel). No-op for unknown names.
 *
 * `modelSupportsReasoningSummaries` and the verbosity capability are deliberately excluded from
 * what gets persisted. They are
 * registry-only metadata resolved at runtime, and this function feeds a config that is about to
 * be written to disk. Persisting today's registry defaults would freeze them as the user's own
 * overrides: a later registry correction — say we learn a model's backend rejects summary
 * delivery — would never reach anyone who created their provider before the correction, and they
 * would keep getting upstream 400s with no way to know why. Catalog gathering enriches a
 * detached runtime clone, so the defaults still apply where they matter.
 */
export function enrichProviderFromCatalog(name: string, prov: OcxProviderConfig): void {
  const hadOwnSummaries = Object.hasOwn(prov, "modelSupportsReasoningSummaries");
  const submittedSummaries = prov.modelSupportsReasoningSummaries;
  const hadOwnVerbosity = Object.hasOwn(prov, "modelSupportsVerbosity");
  const submittedVerbosity = prov.modelSupportsVerbosity;
  const hadOwnProviderVerbosity = Object.hasOwn(prov, "supportsVerbosity");
  const submittedProviderVerbosity = prov.supportsVerbosity;
  enrichProviderFromRegistry(name, prov);
  if (hadOwnSummaries) prov.modelSupportsReasoningSummaries = submittedSummaries;
  else delete prov.modelSupportsReasoningSummaries;
  if (hadOwnVerbosity) prov.modelSupportsVerbosity = submittedVerbosity;
  else delete prov.modelSupportsVerbosity;
  if (hadOwnProviderVerbosity) prov.supportsVerbosity = submittedProviderVerbosity;
  else delete prov.supportsVerbosity;
}

export function isKeyLoginProvider(name: string): boolean {
  return name in KEY_LOGIN_PROVIDERS;
}

export function listKeyLoginProviders(): Array<{ id: string } & KeyLoginProvider> {
  return Object.entries(KEY_LOGIN_PROVIDERS).map(([id, p]) => ({ id, ...p }));
}

function anthropicKeyValidationHeaders(provider: Pick<KeyLoginProvider, "apiKeyTransport">, key: string): HeadersInit {
  return provider.apiKeyTransport === "bearer"
    ? {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "Authorization": `Bearer ${key}`,
    }
    : {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": key,
    };
}

/** Best-effort key validation. Returns true/false/unknown; never persists the key itself. */
export async function validateApiKey(
  providerName: string,
  provider: KeyLoginProvider,
  key: string,
): Promise<boolean | "unknown"> {
  try {
    // A public model catalog cannot prove that the supplied key is valid. Returning unknown keeps
    // the best-effort login flow available without persisting a false-positive validation result.
    if (provider.apiKeyValidation === "unknown") return "unknown";

    if (provider.adapter === "anthropic") {
      const base = provider.baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: anthropicKeyValidationHeaders(provider, key),
        body: JSON.stringify({
          model: provider.defaultModel ?? "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        redirect: "error",
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
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return true;
      if (res.status === 400 || res.status === 401 || res.status === 403) return false;
      return "unknown";
    }

    const configuredProvider: OcxProviderConfig = {
      adapter: provider.adapter,
      baseUrl: provider.baseUrl,
      authMode: "key",
    };
    const modelsUrl = resolveProviderModelDiscoveryUrl(
      providerName,
      configuredProvider,
      provider.baseUrl,
      `${provider.baseUrl}/models`,
    );
    const res = await fetch(modelsUrl, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    return "unknown";
  } catch {
    return "unknown";
  }
}
