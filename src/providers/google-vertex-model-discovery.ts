import { getModelMetadata, getModelMetadataCaseInsensitive } from "../generated/model-metadata";
import {
  GCP_CREDENTIAL_MARKER_PREFIX,
  gcpCredentialMarkerAccount,
  getVertexAccessTokenWithAuthority,
} from "../lib/gcp-adc";
import type { OcxProviderConfig } from "../types";
import { resolveProviderApiKey } from "./api-key-resolve";
import { extractGoogleAiStudioModelItems } from "./google-ai-studio-model-discovery";
import {
  extractModelEnvelopeRows,
  isValidModelDiscoveryModelId,
  resolveProviderModelDiscoveryUrl,
  type ProviderModelItemsResult,
  type ProviderModelsApiItem,
} from "./model-discovery";
import {
  effectiveGoogleMode,
  getProviderRegistryEntry,
  mergeRegistryStaticHeaders,
  providerMatchesRegistryTransport,
} from "./registry";
import { resolveProviderTransport } from "./xai-transport";

const VERTEX_PUBLISHER_MODEL_PREFIX = "publishers/google/models/";
const VERTEX_GENERATIVE_MODEL_ID = /^(?:gemini|gemma)-/i;
const VERTEX_NON_CHAT_SKU = /(?:^|-)embedding(?:-|$)|-tts(?:-|$)|-transcribe(?:-|$)|(?:^|-)live(?:-|$)/i;
const VERTEX_TRAILING_API_VERSION = /\/v1(?:beta1?)?$/i;

/**
 * Whether every configured API key (or the actively selected pool key) is paused on a Vertex row.
 */
function isVertexApiKeyPoolPaused(provider: OcxProviderConfig | undefined): boolean {
  if (!provider || provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") {
    return false;
  }
  const pool = provider.apiKeyPool;
  if (!pool?.length) return false;
  if (pool.every(entry => entry.disabled === true)) return true;
  const ref = provider._apiKeyAttempt?.reference ?? provider.apiKey;
  if (!ref?.trim()) return false;
  return pool.some(entry => entry.disabled === true && entry.key === ref)
    && !pool.some(entry => !entry.disabled && entry.key === ref);
}

/**
 * Whether a Vertex provider row authenticates discovery with an API key rather than GCP ADC.
 *
 * Mirrors `resolveVertexApiKey` in `src/adapters/google.ts`: an explicit `gcp-sa:<account>`
 * marker opts into OS-store ADC and never falls back to `GOOGLE_CLOUD_API_KEY`.
 */
export function usesVertexApiKeyForDiscovery(provider: OcxProviderConfig): boolean {
  if (typeof provider.apiKey === "string" && provider.apiKey.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)) {
    return false;
  }
  const resolved = resolveProviderApiKey(provider.apiKey)?.trim();
  if (resolved && resolved !== "N/A" && !resolved.startsWith("<")) {
    return true;
  }
  return Boolean(process.env.GOOGLE_CLOUD_API_KEY?.trim());
}

/**
 * Synchronous Vertex discovery credential snapshot for passive (`observed`) catalog gathers.
 *
 * ADC token exchange is async, so passive gathers without an API key return `undefined` and
 * either reuse a fresh model cache or degrade cleanly without sending an unauthenticated GET.
 */
export function resolveObservedVertexDiscoveryToken(provider: OcxProviderConfig): string | undefined {
  if (provider.authMode === "forward" || isVertexApiKeyPoolPaused(provider)) return undefined;
  if (!usesVertexApiKeyForDiscovery(provider)) return undefined;
  const resolved = resolveProviderApiKey(provider.apiKey)?.trim();
  if (resolved && resolved !== "N/A" && !resolved.startsWith("<")) return resolved;
  return process.env.GOOGLE_CLOUD_API_KEY?.trim() || undefined;
}

/**
 * Resolve the Vertex model-discovery credential (API key or GCP ADC access token).
 *
 * Paused key pools never fall back to `GOOGLE_CLOUD_API_KEY` or ambient host ADC.
 */
export async function resolveVertexDiscoveryToken(provider: OcxProviderConfig): Promise<string | undefined> {
  if (provider.authMode === "forward" || isVertexApiKeyPoolPaused(provider)) return undefined;
  if (usesVertexApiKeyForDiscovery(provider)) {
    return resolveObservedVertexDiscoveryToken(provider);
  }
  try {
    const markerAccount = gcpCredentialMarkerAccount(provider.apiKey);
    const { token } = await getVertexAccessTokenWithAuthority(
      markerAccount ? { markerAccount } : undefined,
    );
    return token;
  } catch {
    return undefined;
  }
}

/**
 * Build the Vertex AI Publisher Models discovery request (`GET /v1beta1/publishers/google/models`).
 *
 * URL construction is strictly independent of `apiKey` so `captureModelsRequest` sentinel checks
 * remain invariant across `undefined` and `REQUEST_CREDENTIAL_SENTINEL`.
 */
export function buildVertexModelsDiscoveryRequest(
  effectiveProvider: OcxProviderConfig,
  apiKey: string | undefined,
  headers: Record<string, string>,
  resolveUrl: (defaultUrl: string) => string,
): { url: string; headers: Record<string, string> } {
  const base = effectiveProvider.baseUrl.replace(/\/+$/, "").replace(VERTEX_TRAILING_API_VERSION, "");
  if (usesVertexApiKeyForDiscovery(effectiveProvider)) {
    if (apiKey) headers["x-goog-api-key"] = apiKey;
  } else {
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const project = effectiveProvider.project?.trim()
      || process.env.GOOGLE_CLOUD_PROJECT?.trim()
      || process.env.GCLOUD_PROJECT?.trim();
    if (project && project.toLowerCase() !== "auto") {
      headers["x-goog-user-project"] = project;
    }
  }
  // Vertex ModelGardenService.ListPublisherModels enforces a maximum pageSize of 300
  // (values > 300 return HTTP 400 INVALID_ARGUMENT).
  return {
    url: resolveUrl(`${base}/v1beta1/publishers/google/models?pageSize=300`),
    headers,
  };
}

/**
 * Build a Vertex AI Publisher Models request when the provider row resolves to non-OAuth `vertex` mode,
 * or return `undefined` so callers delegate to the default `buildModelsRequest` builder.
 */
export function buildVertexProviderModelsRequest(
  providerName: string,
  prov: OcxProviderConfig,
  apiKey: string | undefined,
): { method?: "POST"; url: string; headers: Record<string, string> } | undefined {
  if (prov.authMode === "oauth") return undefined;
  const effectiveProvider = resolveProviderTransport(providerName, prov);
  if (effectiveGoogleMode(providerName, effectiveProvider) !== "vertex") return undefined;
  const registryStaticHeaders = providerMatchesRegistryTransport(providerName, effectiveProvider)
    ? getProviderRegistryEntry(providerName)?.staticHeaders
    : undefined;
  const headers: Record<string, string> = {
    ...(mergeRegistryStaticHeaders(registryStaticHeaders, effectiveProvider.headers) ?? {}),
  };
  const resolveUrl = (defaultUrl: string): string => resolveProviderModelDiscoveryUrl(
    providerName,
    prov,
    effectiveProvider.baseUrl,
    defaultUrl,
  );
  return buildVertexModelsDiscoveryRequest(effectiveProvider, apiKey, headers, resolveUrl);
}

/**
 * Supported reasoning effort levels for known Vertex AI Gemini model IDs.
 */
function vertexGeminiReasoningEfforts(modelId: string): readonly string[] | undefined {
  const lower = modelId.toLowerCase();
  if (lower.includes("image")) return undefined;
  if (lower === "gemini-4-hydrogen") {
    return ["low", "medium", "high", "xhigh"];
  }
  if (
    lower === "gemini-4-carbon"
    || lower === "gemini-4-argon"
    || lower === "gemini-3.8-flash"
    || lower === "gemini-3.7-flash"
    || lower.startsWith("gemini-3.1-pro")
    || lower === "gemini-3-pro"
    || lower === "gemini-3-pro-preview"
  ) {
    return ["low", "medium", "high"];
  }
  if (lower === "gemini-3.6-flash" || lower === "gemini-3.5-flash") {
    return ["minimal", "low", "medium", "high"];
  }
  return undefined;
}

/**
 * Extracts and normalizes generative Gemini/Gemma model items from a Vertex AI
 * `/v1beta1/publishers/google/models` response payload (`{ publisherModels: [...] }`).
 *
 * Strips the `publishers/google/models/` prefix, filters out non-`generateContent` SKUs
 * (embeddings, TTS, transcription, Live API, Imagen/Veo), and enriches known Gemini rows
 * with vendored token/modality/reasoning metadata.
 */
export function extractGoogleVertexModelItems(
  value: unknown,
  maxModels: number,
): ProviderModelItemsResult {
  const envelope = extractModelEnvelopeRows(value, maxModels, ["publisherModels"]);
  if (!envelope.ok) return envelope;

  const items: ProviderModelsApiItem[] = [];
  const seen = new Set<string>();
  for (const raw of envelope.rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const name = Reflect.get(raw, "name");
    if (!isValidModelDiscoveryModelId(name)) continue;
    const id = name.startsWith(VERTEX_PUBLISHER_MODEL_PREFIX)
      ? name.slice(VERTEX_PUBLISHER_MODEL_PREFIX.length)
      : name;
    if (!isValidModelDiscoveryModelId(id) || seen.has(id)) continue;
    if (!VERTEX_GENERATIVE_MODEL_ID.test(id) || VERTEX_NON_CHAT_SKU.test(id)) continue;
    seen.add(id);

    const meta = getModelMetadata("google", id) ?? getModelMetadataCaseInsensitive("google", id);
    const efforts = vertexGeminiReasoningEfforts(id);
    items.push({
      id,
      owned_by: "google",
      ...(meta?.contextWindow !== undefined
        ? { context_length: meta.contextWindow, max_input_tokens: meta.contextWindow }
        : {}),
      ...(meta?.maxTokens !== undefined ? { max_output_tokens: meta.maxTokens } : {}),
      ...(meta?.input?.length ? { input_modalities: [...meta.input] } : {}),
      ...(efforts ? { reasoning_efforts: [...efforts] } : {}),
    });
  }
  return { ok: true, items, rawCount: envelope.rows.length };
}

/**
 * Dispatch native Google model-list extraction for AI Studio (`models[]`) or Vertex AI
 * (`publisherModels[]`), returning `undefined` when the payload uses an OpenAI-compatible
 * gateway envelope (`data[]` or top-level array) so callers fall back cleanly.
 */
export function extractGoogleNativeModelItems(
  googleMode: "ai-studio" | "vertex" | "cloud-code-assist" | null,
  value: unknown,
  maxModels: number,
): ProviderModelItemsResult | undefined {
  const result = googleMode === "ai-studio"
    ? extractGoogleAiStudioModelItems(value, maxModels)
    : googleMode === "vertex"
      ? extractGoogleVertexModelItems(value, maxModels)
      : undefined;
  if (!result) return undefined;
  return result.ok || result.reason === "too_many_models" ? result : undefined;
}
