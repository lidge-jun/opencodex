import { createHmac, randomBytes } from "node:crypto";
import { providerOutboundGet, providerRedirectError } from "../lib/provider-outbound";
import { readBoundedDiscoveryJson } from "./model-discovery";
import type { OcxProviderConfig } from "../types";

const ENDPOINTS_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 128;
const MAX_ACTIVE_FLIGHTS = 8;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ENDPOINTS = 512;
const CACHE_SCOPE_KEY = randomBytes(32);

export interface OpenRouterModelEndpoint {
  tag: string;
  providerName: string;
  name?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  supportsImplicitCaching?: boolean;
  supportedParameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

type CacheEntry = { expiresAt: number; fetchedAt: number; endpoints: OpenRouterModelEndpoint[] };
const cache = new Map<string, CacheEntry>();
const flights = new Map<string, Promise<CacheEntry>>();

export class OpenRouterEndpointsError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "OpenRouterEndpointsError";
  }
}

function modelPath(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1 || modelId.indexOf("/", slash + 1) !== -1) return null;
  return `${encodeURIComponent(modelId.slice(0, slash))}/${encodeURIComponent(modelId.slice(slash + 1))}`;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.trim() === item && item.length > 0);
  return strings.length > 0 ? [...new Set(strings)].slice(0, 128) : undefined;
}

export function parseOpenRouterModelEndpoints(value: unknown, expectedModel: string): OpenRouterModelEndpoint[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenRouterEndpointsError("invalid_response", 502, "OpenRouter returned an invalid endpoint catalog");
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new OpenRouterEndpointsError("invalid_response", 502, "OpenRouter returned an invalid endpoint catalog");
  const record = data as { id?: unknown; endpoints?: unknown };
  if (record.id !== expectedModel || !Array.isArray(record.endpoints) || record.endpoints.length > MAX_ENDPOINTS) {
    throw new OpenRouterEndpointsError("invalid_response", 502, "OpenRouter returned an unexpected endpoint catalog");
  }
  const seen = new Set<string>();
  const parsed: OpenRouterModelEndpoint[] = [];
  for (const raw of record.endpoints) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const endpoint = raw as Record<string, unknown>;
    const tag = typeof endpoint.tag === "string" ? endpoint.tag.trim() : "";
    const providerName = typeof endpoint.provider_name === "string" ? endpoint.provider_name.trim() : "";
    if (!tag || tag.length > 128 || !providerName || providerName.length > 128 || seen.has(tag)) continue;
    seen.add(tag);
    const pricing = endpoint.pricing && typeof endpoint.pricing === "object" && !Array.isArray(endpoint.pricing)
      ? endpoint.pricing as Record<string, unknown>
      : undefined;
    parsed.push({
      tag,
      providerName,
      ...(typeof endpoint.name === "string" && endpoint.name.trim() ? { name: endpoint.name.trim().slice(0, 256) } : {}),
      ...(optionalPositiveInteger(endpoint.context_length) !== undefined ? { contextLength: optionalPositiveInteger(endpoint.context_length) } : {}),
      ...(optionalPositiveInteger(endpoint.max_completion_tokens) !== undefined ? { maxCompletionTokens: optionalPositiveInteger(endpoint.max_completion_tokens) } : {}),
      ...(typeof endpoint.supports_implicit_caching === "boolean" ? { supportsImplicitCaching: endpoint.supports_implicit_caching } : {}),
      ...(optionalStringArray(endpoint.supported_parameters) ? { supportedParameters: optionalStringArray(endpoint.supported_parameters) } : {}),
      ...(pricing ? { pricing: {
        ...(typeof pricing.prompt === "string" ? { prompt: pricing.prompt } : {}),
        ...(typeof pricing.completion === "string" ? { completion: pricing.completion } : {}),
      } } : {}),
    });
  }
  return parsed;
}

function cacheKey(providerName: string, modelId: string, token: string): string {
  const credentialScope = createHmac("sha256", CACHE_SCOPE_KEY).update(token).digest("hex");
  return `${providerName}\n${modelId}\n${credentialScope}`;
}

function insert(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}

export async function listOpenRouterModelEndpoints(
  providerName: string,
  provider: OcxProviderConfig,
  modelId: string,
  token: string,
  refresh = false,
): Promise<{ fetchedAt: number; cached: boolean; endpoints: OpenRouterModelEndpoint[] }> {
  const path = modelPath(modelId);
  if (!path) throw new OpenRouterEndpointsError("invalid_model", 400, "model must be an OpenRouter author/slug id");
  const key = cacheKey(providerName, modelId, token);
  const now = Date.now();
  const cached = cache.get(key);
  if (!refresh && cached && cached.expiresAt > now) return { fetchedAt: cached.fetchedAt, cached: true, endpoints: cached.endpoints };
  let flight = flights.get(key);
  if (!flight) {
    if (flights.size >= MAX_ACTIVE_FLIGHTS) {
      throw new OpenRouterEndpointsError("busy", 429, "OpenRouter endpoint discovery is busy");
    }
    flight = (async () => {
      const requestUrl = `https://openrouter.ai/api/v1/models/${path}/endpoints`;
      const response = await providerOutboundGet(providerName, provider, requestUrl, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const redirect = await providerRedirectError(response, requestUrl);
      if (redirect) throw new OpenRouterEndpointsError("upstream_redirect", 502, redirect);
      if (response.status === 401 || response.status === 403) {
        try { await response.body?.cancel(); } catch { /* best effort */ }
        throw new OpenRouterEndpointsError("authorization_failed", response.status, "OpenRouter rejected the configured API key for endpoint discovery");
      }
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* best effort */ }
        throw new OpenRouterEndpointsError("upstream_error", 502, `OpenRouter endpoint discovery returned ${response.status}`);
      }
      const bounded = await readBoundedDiscoveryJson(response, MAX_RESPONSE_BYTES);
      if (!bounded.ok) throw new OpenRouterEndpointsError("invalid_response", 502, "OpenRouter returned an invalid or oversized endpoint catalog");
      const fetchedAt = Date.now();
      const entry = { fetchedAt, expiresAt: fetchedAt + ENDPOINTS_TTL_MS, endpoints: parseOpenRouterModelEndpoints(bounded.value, modelId) };
      insert(key, entry);
      return entry;
    })().finally(() => flights.delete(key));
    flights.set(key, flight);
  }
  const entry = await flight;
  return { fetchedAt: entry.fetchedAt, cached: false, endpoints: entry.endpoints };
}

export function resetOpenRouterEndpointCacheForTests(): void {
  cache.clear();
  flights.clear();
}
