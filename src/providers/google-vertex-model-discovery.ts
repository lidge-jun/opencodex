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
  readBoundedDiscoveryJson,
  resolveProviderModelDiscoveryUrl,
  type ProviderModelItemsResult,
  type ProviderModelsApiItem,
} from "./model-discovery";
import { MODEL_DISCOVERY_MAX_MODELS, MODEL_DISCOVERY_MAX_RESPONSE_BYTES } from "./model-discovery-limits";
import {
  effectiveGoogleMode,
  getProviderRegistryEntry,
  mergeRegistryStaticHeaders,
  providerMatchesRegistryTransport,
  registryEntryForProviderDestination,
} from "./registry";
import { resolveProviderTransport } from "./xai-transport";

const VERTEX_PUBLISHER_MODEL_PREFIX = "publishers/google/models/";
const VERTEX_GENERATIVE_MODEL_ID = /^(?:gemini|gemma)-/i;
const VERTEX_NON_CHAT_SKU = /(?:^|-)embedding(?:-|$)|-tts(?:-|$)|-transcribe(?:-|$)|(?:^|-)live(?:-|$)/i;
const VERTEX_TRAILING_API_VERSION = /\/v1(?:beta1?)?$/i;

/** Time budget for one Vertex discovery: ADC token resolution, then every follow-up page. */
export const VERTEX_DISCOVERY_TIMEOUT_MS = 8_000;
/** Request ceiling for one listing, first page included (pageSize=300, so 1,500 rows). */
export const VERTEX_DISCOVERY_MAX_PAGES = 5;
const VERTEX_PAGE_TOKEN_MAX_LENGTH = 4_096;

/**
 * Vertex SKUs whose model card lists function calling as "Not supported". An agent client sends
 * function declarations on every turn, so publishing one of these rows offers a model that cannot
 * finish a tool loop. Checked 2026-11-13 against the Gemini Enterprise Agent Platform model cards:
 * gemini-3.1-flash-lite-image, gemini-3.1-flash-image, gemini-3-pro-image(-preview) and
 * gemini-2.5-flash-image (docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/*).
 */
const VERTEX_NO_FUNCTION_CALLING_MODELS = new Set([
  "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-3-pro-image-preview",
  "gemini-2.5-flash-image",
  "gemini-2.5-flash-image-preview",
  "gemini-2.0-flash-preview-image-generation",
]);

/**
 * Image-output Gemini SKUs (`-image` / `-image-generation` segments). Every such card checked
 * above lists function calling as unsupported, so an unlisted one stays out until its card says
 * otherwise; publishing it would be a guess about tool support rather than evidence.
 */
const VERTEX_IMAGE_OUTPUT_SKU = /-image(?:-|$)/i;

/** Whether a discovered Vertex publisher model can run a client's function-calling loop. */
export function vertexModelSupportsFunctionCalling(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return !VERTEX_NO_FUNCTION_CALLING_MODELS.has(lower) && !VERTEX_IMAGE_OUTPUT_SKU.test(lower);
}

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

/** A `keychain:` or `$ENV` reference names one credential; it never widens to ambient ones. */
function isExplicitKeyReference(value: string | undefined): value is string {
  return typeof value === "string" && (value.startsWith("keychain:") || value.startsWith("$"));
}

/**
 * The credential a Vertex discovery request uses, chosen in the same order and on the same bytes
 * as inference, so discovery can never publish another account's roster under this provider:
 *
 * 1. `usableResolvedApiKey` (routed-config): a `gcp-sa:` marker passes through verbatim; anything
 *    else is resolved (`keychain:` / `$ENV`) and a blank result counts as no key. No trimming.
 * 2. `snapshotVertexEnvironment` (routed-config): an explicit `keychain:` / `$ENV` reference that
 *    resolved to nothing usable fails closed (`key` undefined), never reaching
 *    `GOOGLE_CLOUD_API_KEY` or host ADC. A value that is a `gcp-sa:` marker, configured directly
 *    or reached through a reference, selects ADC for that stored service account.
 * 3. `resolveVertexApiKey` (Google adapter): `N/A` and `<...>` placeholders are not keys; then
 *    `GOOGLE_CLOUD_API_KEY`, then host ADC.
 *
 * `tests/adapters/google/vertex-model-discovery.test.ts` checks this against the credential the
 * inference adapter actually sends for the same rows.
 */
export type VertexDiscoveryCredential =
  | { kind: "api-key"; key: string | undefined }
  | { kind: "adc"; marker?: string };

export function selectVertexDiscoveryCredential(provider: OcxProviderConfig): VertexDiscoveryCredential {
  const configured = provider.apiKey;
  const reference = provider._apiKeyAttempt?.reference ?? configured;
  // A routed row already carries the resolved value beside its reference; never resolve it twice.
  const alreadyResolved = provider._apiKeyAttempt !== undefined && reference !== configured;
  let value: string | undefined;
  if (alreadyResolved || (typeof configured === "string" && configured.startsWith(GCP_CREDENTIAL_MARKER_PREFIX))) {
    value = configured;
  } else {
    const resolved = resolveProviderApiKey(configured);
    value = typeof resolved === "string" && resolved.trim().length > 0 ? resolved : undefined;
  }
  if (isExplicitKeyReference(reference)
    && (!value?.trim() || value === "N/A" || value.startsWith("<") || reference === "keychain:")) {
    return { kind: "api-key", key: undefined };
  }
  if (value?.startsWith(GCP_CREDENTIAL_MARKER_PREFIX)) return { kind: "adc", marker: value };
  const key = value && !value.startsWith("<") && value !== "N/A" ? value : undefined;
  if (key) return { kind: "api-key", key };
  const ambientKey = process.env.GOOGLE_CLOUD_API_KEY;
  return ambientKey ? { kind: "api-key", key: ambientKey } : { kind: "adc" };
}

/** Whether a Vertex provider row authenticates discovery with an API key rather than GCP ADC. */
export function usesVertexApiKeyForDiscovery(provider: OcxProviderConfig): boolean {
  return selectVertexDiscoveryCredential(provider).kind === "api-key";
}

/**
 * Synchronous Vertex discovery credential snapshot for passive (`observed`) catalog gathers.
 *
 * ADC token exchange is async, so passive gathers without an API key return `undefined` and
 * either reuse a fresh model cache or degrade cleanly without sending an unauthenticated GET.
 */
export function resolveObservedVertexDiscoveryToken(provider: OcxProviderConfig): string | undefined {
  if (provider.authMode === "forward" || isVertexApiKeyPoolPaused(provider)) return undefined;
  const credential = selectVertexDiscoveryCredential(provider);
  return credential.kind === "api-key" ? credential.key : undefined;
}

/**
 * Resolve the Vertex model-discovery credential (API key or GCP ADC access token).
 *
 * `signal` bounds the ADC exchange by the discovery time budget; without it a stalled token
 * endpoint would hold discovery through every token retry. Paused key pools, unreadable explicit
 * references and malformed `gcp-sa:` markers return `undefined` and never reach ambient credentials.
 */
export async function resolveVertexDiscoveryToken(
  provider: OcxProviderConfig,
  signal: AbortSignal = vertexDiscoveryDeadline(),
): Promise<string | undefined> {
  if (provider.authMode === "forward" || isVertexApiKeyPoolPaused(provider)) return undefined;
  const credential = selectVertexDiscoveryCredential(provider);
  if (credential.kind === "api-key") return credential.key;
  try {
    const markerAccount = gcpCredentialMarkerAccount(credential.marker);
    const { token } = await getVertexAccessTokenWithAuthority({ signal, ...(markerAccount ? { markerAccount } : {}) });
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
  // (values > 300 return HTTP 400 INVALID_ARGUMENT); later pages follow nextPageToken.
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

export type VertexPublisherModelListing =
  | { ok: true; value: unknown }
  | { ok: false; reason: "incomplete"; diagnostic: string };

/** Wrap a discovery response so the bytes actually read from its body can be counted. */
export function countDiscoveryResponseBytes(response: Response): { response: Response; bytes: () => number } {
  let total = 0;
  if (!response.body) return { response, bytes: () => total };
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }));
  return { response: new Response(counted, { status: response.status, headers: response.headers }), bytes: () => total };
}

/** The single deadline one Vertex discovery shares across ADC, the first request and every page. */
export function vertexDiscoveryDeadline(cancel?: AbortSignal): AbortSignal {
  const budget = AbortSignal.timeout(VERTEX_DISCOVERY_TIMEOUT_MS);
  return cancel ? AbortSignal.any([cancel, budget]) : budget;
}

function nextVertexPageToken(page: Record<string, unknown>): string | undefined | null {
  const token = page.nextPageToken;
  if (token === undefined || token === "") return undefined;
  return typeof token === "string" && token.length <= VERTEX_PAGE_TOKEN_MAX_LENGTH ? token : null;
}

/**
 * Follow `nextPageToken` across Vertex `publisherModels` pages and merge them into one envelope.
 *
 * One listing is bounded three ways: at most `VERTEX_DISCOVERY_MAX_PAGES` requests, at most the
 * discovery row limit across every page, and at most the discovery byte limit across every page
 * (`firstPageBytes` is the byte count the caller read for page one). Every page runs under the
 * caller's `signal`, the same deadline that bounded ADC and the first request. When a bound, a
 * page request, the deadline, a repeated token, or a follow-up page that is not a Vertex page
 * stops the walk before the last page, the listing is reported incomplete: publishing the pages
 * already read as the authoritative roster would drop every model on the pages that were not.
 *
 * A first page without a `publisherModels` array is returned unchanged for the caller's generic
 * envelope handling (an OpenAI-compatible gateway in front of Vertex).
 */
export async function collectVertexPublisherModelPages(
  firstUrl: string,
  firstValue: unknown,
  limits: { maxModels: number; maxResponseBytes: number; firstPageBytes?: number; signal?: AbortSignal },
  fetchPage: (url: string, signal: AbortSignal) => Promise<Response>,
): Promise<VertexPublisherModelListing> {
  const first = firstValue !== null && typeof firstValue === "object" && !Array.isArray(firstValue)
    ? firstValue as Record<string, unknown>
    : undefined;
  if (!first || !Array.isArray(first.publisherModels)) return { ok: true, value: firstValue };
  let token = nextVertexPageToken(first);
  if (token === undefined) return { ok: true, value: firstValue };

  const maxRows = Math.min(limits.maxModels, MODEL_DISCOVERY_MAX_MODELS);
  const maxBytes = Math.min(limits.maxResponseBytes, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
  const rows: unknown[] = [...first.publisherModels];
  let bytes = limits.firstPageBytes ?? new TextEncoder().encode(JSON.stringify(firstValue)).byteLength;
  const seenTokens = new Set<string>();
  const signal = limits.signal ?? vertexDiscoveryDeadline();
  const incomplete = (diagnostic: string): VertexPublisherModelListing =>
    ({ ok: false, reason: "incomplete", diagnostic: `${diagnostic} after ${seenTokens.size + 1} page(s) and ${rows.length} row(s)` });

  while (token !== undefined) {
    if (token === null) return incomplete("returned a malformed nextPageToken");
    if (seenTokens.has(token)) return incomplete("repeated a nextPageToken");
    if (seenTokens.size + 1 >= VERTEX_DISCOVERY_MAX_PAGES) return incomplete(`exceeded the ${VERTEX_DISCOVERY_MAX_PAGES}-request page limit`);
    if (rows.length > maxRows) return incomplete(`exceeded the ${maxRows}-row model limit`);
    if (bytes >= maxBytes) return incomplete(`exceeded the ${maxBytes}-byte listing limit`);
    seenTokens.add(token);
    const pageUrl = new URL(firstUrl);
    pageUrl.searchParams.set("pageToken", token);
    let page: Record<string, unknown> | undefined;
    try {
      const response = await fetchPage(pageUrl.toString(), signal);
      if (!response.ok) {
        try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
        return incomplete(`page request failed with HTTP ${response.status}`);
      }
      const counted = countDiscoveryResponseBytes(response);
      const read = await readBoundedDiscoveryJson(counted.response, maxBytes - bytes);
      bytes += counted.bytes();
      if (!read.ok) {
        return incomplete(read.reason === "response_too_large" ? `exceeded the ${maxBytes}-byte listing limit` : "returned an invalid page");
      }
      const value = read.value;
      page = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    } catch {
      return incomplete(signal.aborted ? "exceeded the discovery time budget" : "page request failed");
    }
    // Google omits an empty repeated field, so an empty Vertex page is `{}` or carries only its
    // token. Anything else without `publisherModels` (a gateway `data[]`, an error body) is not a
    // Vertex page, and treating it as an empty last page would publish page one as the whole roster.
    const vertexPage = page !== undefined && (Array.isArray(page.publisherModels)
      || (page.publisherModels === undefined && Object.keys(page).every(key => key === "nextPageToken")));
    if (!page || !vertexPage) {
      return incomplete("returned a malformed page");
    }
    if (Array.isArray(page.publisherModels)) rows.push(...page.publisherModels);
    token = nextVertexPageToken(page);
  }
  if (rows.length > maxRows) return incomplete(`exceeded the ${maxRows}-row model limit`);
  return { ok: true, value: { publisherModels: rows } };
}

type ReasoningLadders = Readonly<Record<string, readonly string[]>> | undefined;

/**
 * The reasoning ladders the Google adapter will serialize for this row. `routedProviderConfig`
 * fills `modelReasoningEfforts` from the provider's own registry entry when the row matches it,
 * and from the destination entry (`google-vertex` for aiplatform hosts) otherwise; the adapter
 * then writes `thinkingConfig` only for a laddered model. Reading the same entry keeps discovery
 * from advertising a rung the request would silently drop (an unladdered `gemini-3-pro`).
 */
function vertexReasoningLadders(providerName: string, provider: OcxProviderConfig): ReasoningLadders {
  const entry = providerMatchesRegistryTransport(providerName, provider)
    ? getProviderRegistryEntry(providerName)
    : registryEntryForProviderDestination(provider);
  return entry?.modelReasoningEfforts;
}

/**
 * Extracts and normalizes generative Gemini/Gemma model items from a Vertex AI
 * `/v1beta1/publishers/google/models` response payload (`{ publisherModels: [...] }`).
 *
 * Strips the `publishers/google/models/` prefix, filters out non-`generateContent` SKUs
 * (embeddings, TTS, transcription, Live API, Imagen/Veo) and SKUs without function calling, and
 * enriches rows with vendored token/modality metadata and the registry's reasoning ladder.
 */
export function extractGoogleVertexModelItems(
  value: unknown,
  maxModels: number,
  ladders?: ReasoningLadders,
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
    if (!vertexModelSupportsFunctionCalling(id)) continue;
    seen.add(id);

    const meta = getModelMetadata("google", id) ?? getModelMetadataCaseInsensitive("google", id);
    const efforts = ladders && Object.hasOwn(ladders, id) ? ladders[id] : undefined;
    items.push({
      id,
      owned_by: "google",
      ...(meta?.contextWindow !== undefined
        ? { context_length: meta.contextWindow, max_input_tokens: meta.contextWindow }
        : {}),
      ...(meta?.maxTokens !== undefined ? { max_output_tokens: meta.maxTokens } : {}),
      ...(meta?.input?.length ? { input_modalities: [...meta.input] } : {}),
      ...(efforts?.length ? { reasoning_efforts: [...efforts] } : {}),
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
  providerName: string,
  provider: OcxProviderConfig,
  value: unknown,
  maxModels: number,
): ProviderModelItemsResult | undefined {
  const googleMode = effectiveGoogleMode(providerName, provider);
  const result = googleMode === "ai-studio"
    ? extractGoogleAiStudioModelItems(value, maxModels)
    : googleMode === "vertex"
      ? extractGoogleVertexModelItems(value, maxModels, vertexReasoningLadders(providerName, provider))
      : undefined;
  if (!result) return undefined;
  return result.ok || result.reason === "too_many_models" ? result : undefined;
}
