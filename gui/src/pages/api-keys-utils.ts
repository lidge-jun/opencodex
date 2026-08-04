import type { GatewayInboundProtocol } from "../api-access-models";

/**
 * Per-key usage as the server rolls it up. A discriminated union: when two config
 * entries share an id there is no per-key total, and an optional flag beside
 * `requests7d: 7` would invite rendering the 7 anyway.
 */
export type ApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

export interface ApiKeyEntry {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  /** Always present from the server; zeroes are a real answer. Whether anything
   *  is attributable at all is the response-level `attributionSince`. */
  usage: ApiKeyUsage;
}

/**
 * A usage object the GUI can actually render. Coercing a malformed one to zeroes
 * would state "used zero times" about data we could not read — the exact false
 * confidence `attributionSince` exists to avoid.
 */
export function isApiKeyUsage(value: unknown): value is ApiKeyUsage {
  if (!value || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  if (usage.ambiguous === true) return true;
  if (typeof usage.requests7d !== "number" || !Number.isFinite(usage.requests7d)) return false;
  if (typeof usage.totalRequests !== "number" || !Number.isFinite(usage.totalRequests)) return false;
  if (usage.lastUsedAt !== undefined) {
    if (typeof usage.lastUsedAt !== "string" || Number.isNaN(new Date(usage.lastUsedAt).getTime())) return false;
  }
  return true;
}

export type ApiAuthDisposition = "required" | "accepted" | "rejected";

export interface ApiAuthMatrixRow {
  endpoint: string;
  bearer: ApiAuthDisposition;
  dedicated: ApiAuthDisposition;
  xApiKey: ApiAuthDisposition;
}

const DISPOSITIONS = new Set<ApiAuthDisposition>(["required", "accepted", "rejected"]);

/** The GUI must not invent auth rules; an unusable payload is a load failure. */
export function isApiAuthMatrix(value: unknown): value is ApiAuthMatrixRow[] {
  return Array.isArray(value) && value.length > 0 && value.every(row => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.endpoint === "string"
      && DISPOSITIONS.has(r.bearer as ApiAuthDisposition)
      && DISPOSITIONS.has(r.dedicated as ApiAuthDisposition)
      && DISPOSITIONS.has(r.xApiKey as ApiAuthDisposition);
  });
}

/** Shared by both key-name inputs; the server rejects anything longer. */
export const API_KEY_NAME_MAX_LENGTH = 64;

export interface ApiEndpointInfo {
  baseUrl: string;
  responses: string;
  chatCompletions: string;
  messages: string;
  models: string;
}

export type ModelTestState = "idle" | "testing" | "ok" | "error";
export interface ModelTestResult { state: ModelTestState; detail?: string }
/** Per model, per protocol: a result belongs to the chip that produced it. */
export type ModelTests = Record<string, Partial<Record<GatewayInboundProtocol, ModelTestResult>>>;

export const DEFAULT_ENDPOINTS: ApiEndpointInfo = {
  baseUrl: "http://127.0.0.1:10100/v1",
  responses: "http://127.0.0.1:10100/v1/responses",
  chatCompletions: "http://127.0.0.1:10100/v1/chat/completions",
  messages: "http://127.0.0.1:10100/v1/messages",
  models: "http://127.0.0.1:10100/v1/models",
};

export function deriveApiEndpoints(endpoint: string): ApiEndpointInfo {
  const responses = endpoint || DEFAULT_ENDPOINTS.responses;
  const match = responses.match(/^(.*)\/v1\/responses\/?$/);
  const baseUrl = match ? `${match[1]}/v1` : responses.replace(/\/responses\/?$/, "");
  return {
    baseUrl,
    responses,
    chatCompletions: `${baseUrl}/chat/completions`,
    messages: `${baseUrl}/messages`,
    models: `${baseUrl}/models`,
  };
}

export function formatCreatedDate(iso: string, localeTag?: string): string {
  // A hand-edited config can carry a non-string createdAt, which the server
  // salvages to "" rather than discarding a working key. Rendering that as
  // "Invalid Date" states something false about the key; an em dash says the
  // one true thing, which is that we do not know when it was created.
  const parsed = new Date(iso);
  if (!iso || Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(localeTag);
}
