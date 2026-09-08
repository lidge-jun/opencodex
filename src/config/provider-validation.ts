import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { redactSecretString } from "../lib/redact";
import {
  isValidModelDiscoveryModelId,
  MODEL_DISCOVERY_MAX_MODELS,
} from "../providers/model-discovery-limits";
import { isDeclaredReasoningEffort, modelRecordValue } from "../reasoning-effort";
import {
  isWirePinnedModel,
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  REASONING_SUMMARY_DELIVERY_VALUES,
  UPSTREAM_HTTP_VERSION_VALUES,
  type OcxProviderConfig,
} from "../types";

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENSITIVE_PROVIDER_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "x-amz-security-token",
]);
const REASONING_SUMMARY_DELIVERY_SET = new Set<string>(REASONING_SUMMARY_DELIVERY_VALUES);
const DISPLAY_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_MODEL_DISPLAY_NAME_LENGTH = 128;

/** Operator pins share one strict boundary across config and management writes. */
export function pinnedReasoningEffortConfigError(value: unknown, allowClear = false): string | null {
  if (value === undefined || (allowClear && (value === null || value === ""))) return null;
  return typeof value === "string" && isDeclaredReasoningEffort(value)
    ? null : "pinnedReasoningEffort must be a declared reasoning effort";
}

export function modelPinnedEffortsConfigError(
  value: unknown,
  field = "modelPinnedEfforts",
  allowTombstones = false,
): string | null {
  if (value === undefined || (allowTombstones && value === null)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `${field} must be a plain object`;
  }
  const keys = new Set<string>();
  for (const [key, effort] of Object.entries(value)) {
    const normalized = key.trim();
    if (!normalized || ["__proto__", "prototype", "constructor"].includes(normalized)) {
      return `${field} keys must be nonblank model ids and must not be reserved object keys`;
    }
    if (keys.has(normalized)) return `${field} keys must be unique after trimming`;
    keys.add(normalized);
    if (allowTombstones && (effort === null || effort === "")) continue;
    if (typeof effort !== "string" || !isDeclaredReasoningEffort(effort)) {
      return `${field} values must be declared reasoning efforts`;
    }
  }
  return null;
}

/** Apply a validated map patch; null clears the field, entry tombstones remove one key. */
export function mergeModelPinnedEfforts(
  current: Record<string, string> | undefined,
  patch: unknown,
): Record<string, string> | undefined {
  if (patch === undefined) return current === undefined ? undefined : { ...current };
  if (patch === null) return undefined;
  const next = Object.fromEntries(Object.entries(current ?? {}).map(([key, value]) => [key.trim(), value]));
  for (const [key, effort] of Object.entries(patch as Record<string, string | null>)) {
    if (effort === null || effort === "") delete next[key.trim()];
    else next[key.trim()] = effort;
  }
  return Object.keys(next).length ? next : undefined;
}

export function providerReasoningPinsConfigError(provider: Record<string, unknown>): string | null {
  return pinnedReasoningEffortConfigError(provider.pinnedReasoningEffort)
    ?? modelPinnedEffortsConfigError(provider.modelPinnedReasoningEfforts, "modelPinnedReasoningEfforts");
}

/** Validate only pin fields, including callers that bypass the whole-config schema. */
export function configReasoningPinsConfigError(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const globalError = modelPinnedEffortsConfigError(raw.modelPinnedEfforts);
  if (globalError) return globalError;
  if (raw.providers && typeof raw.providers === "object") {
    for (const provider of Object.values(raw.providers)) {
      if (!provider || typeof provider !== "object") continue;
      const error = providerReasoningPinsConfigError(provider as Record<string, unknown>);
      if (error) return error;
    }
  }
  return null;
}

/** Validate a provider destination without coupling DTO callers to config persistence. */
export function providerBaseUrlConfigError(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "baseUrl must be an http(s) URL";
    if (parsed.username || parsed.password) return "baseUrl must not include embedded credentials";
    if (parsed.search || parsed.hash) return "baseUrl must not include query strings or fragments";
  } catch {
    return "baseUrl must be a valid URL";
  }
  return null;
}

/** Validate user-configured provider headers while keeping auth headers on owned fields. */
export function providerHeadersConfigError(headers: unknown): string | null {
  if (headers === undefined) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return "headers must be an object";
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || !HEADER_NAME_PATTERN.test(name)) return "headers must use valid HTTP header names";
    if (SENSITIVE_PROVIDER_HEADERS.has(normalized)) return `headers must not include sensitive header "${name}"; use apiKey/authMode instead`;
    if (typeof value !== "string") return `header "${name}" value must be a string`;
    if (/[\r\n]/.test(value)) return `header "${name}" value must not include line breaks`;
  }
  return null;
}

/** Keep the configured API-key header style scoped to Anthropic-compatible key auth. */
export function apiKeyTransportConfigError(
  provider: Pick<OcxProviderConfig, "adapter" | "authMode" | "apiKeyTransport">,
): string | null {
  if (provider.apiKeyTransport === undefined) return null;
  if (provider.apiKeyTransport !== "x-api-key" && provider.apiKeyTransport !== "bearer") {
    return 'apiKeyTransport must be "x-api-key" or "bearer"';
  }
  if (provider.adapter !== "anthropic") {
    return "apiKeyTransport is supported only by the anthropic adapter";
  }
  if (provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") {
    return "apiKeyTransport requires Anthropic API-key authentication";
  }
  return null;
}

/** Shared strict boundary for the per-provider upstream HTTP-version pin. */
export function upstreamHttpVersionConfigError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !(UPSTREAM_HTTP_VERSION_VALUES as readonly string[]).includes(value)) {
    return 'upstreamHttpVersion must be one of "auto", "http1.1", "h1", "http2", "h2", or null to clear';
  }
  return null;
}

export function positiveIntegerRecordConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "number" || !Number.isFinite(entry) || !Number.isInteger(entry) || entry <= 0) {
      return `${field}.${key} must be a positive finite integer`;
    }
  }
  return null;
}

export function positiveIntegerConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return `${field} must be a positive finite integer`;
  }
  return null;
}

export function nonBlankStringArrayConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${field} must be an array`;
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) {
      return `${field}.${index} must be a nonblank model id`;
    }
  }
  return null;
}

/** Normalize only after validation so whitespace-only entries cannot silently disappear. */
export function normalizeNonBlankStringArray(value: readonly string[]): string[] {
  return [...new Set(value.map(entry => entry.trim()))];
}

export function booleanRecordConfigError(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "boolean") return `${field}.${key} must be a boolean`;
  }
  return null;
}

/** Validate display-only labels without changing the provider's model identity. */
export function modelDisplayNamesConfigError(
  value: unknown,
  field = "modelDisplayNames",
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return `${field} must be a plain object with own properties`;
  }
  const entries = Object.entries(value);
  // One discovered model can own one label, so both maps share the same safe cap.
  if (entries.length > MODEL_DISCOVERY_MAX_MODELS) {
    return `${field} must contain at most ${MODEL_DISCOVERY_MAX_MODELS} entries`;
  }
  for (const [modelId, displayName] of entries) {
    if (!isValidModelDiscoveryModelId(modelId)) return `${field} keys must be valid model ids`;
    const safeModelId = JSON.stringify(redactSecretString(modelId));
    if (typeof displayName !== "string") return `${field}.${safeModelId} must be a string`;
    const trimmed = displayName.trim();
    if (!trimmed) return `${field}.${safeModelId} must be nonblank`;
    if (displayName !== trimmed) return `${field}.${safeModelId} must be trimmed`;
    if (displayName.length > MAX_MODEL_DISPLAY_NAME_LENGTH) {
      return `${field}.${safeModelId} must be at most ${MAX_MODEL_DISPLAY_NAME_LENGTH} characters`;
    }
    if (displayName.includes("/")) return `${field}.${safeModelId} must not contain /`;
    if (DISPLAY_NAME_CONTROL_CHARS.test(displayName)) {
      return `${field}.${safeModelId} must not contain control characters`;
    }
  }
  return null;
}

/** Validate the management DTO boundary for the opt-in empty-tool-output annotation. */
export function providerEmptyToolOutputConfigError(name: string, provider: unknown): string | null {
  const raw = provider as Record<string, unknown> | null | undefined;
  const value = raw === null || raw === undefined ? undefined : raw.annotateEmptyToolOutputs;
  if (value !== undefined && typeof value !== "boolean") {
    return `provider ${JSON.stringify(redactSecretString(name))} annotateEmptyToolOutputs must be a boolean`;
  }
  return null;
}

export function reasoningSummaryDeliveryRecordConfigError(
  value: unknown,
  supportsReasoningSummaries: unknown,
  field = "modelReasoningSummaryDelivery",
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;

  const supports = booleanRecordConfigError(supportsReasoningSummaries, "modelSupportsReasoningSummaries") === null
    && supportsReasoningSummaries && typeof supportsReasoningSummaries === "object"
    ? supportsReasoningSummaries as Record<string, boolean>
    : undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "string" || !REASONING_SUMMARY_DELIVERY_SET.has(entry)) {
      return `${field}.${key} must be one of: ${REASONING_SUMMARY_DELIVERY_VALUES.join(", ")}`;
    }
    if (modelRecordValue(supports, key) === false) {
      return `${field}.${key} conflicts with modelSupportsReasoningSummaries=false`;
    }
  }
  return null;
}

/** Validate a provider's per-model wire override map against runtime routing rules. */
export function modelAdapterRecordConfigError(
  value: unknown,
  field: string,
  providerName: string,
  provider: { adapter?: unknown; authMode?: unknown; baseUrl?: unknown },
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  if (entries.length > 0 && isCanonicalOpenAiForwardProvider(provider as OcxProviderConfig)) {
    return `${field} is not supported on the canonical ChatGPT forward provider`;
  }
  for (const [key, entry] of entries) {
    if (!key.trim()) return `${field} keys must be nonblank model ids`;
    if (typeof entry !== "string" || !MODEL_ADAPTER_OVERRIDE_ALLOWED.has(entry)) {
      return `${field}.${key} must be one of: ${[...MODEL_ADAPTER_OVERRIDE_ALLOWED].join(", ")}`;
    }
    if (isWirePinnedModel(providerName, key.trim())) {
      return `${field}.${key} cannot be overridden: the upstream only speaks one wire for this model`;
    }
  }
  return null;
}
