import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { redactSecretString } from "../lib/redact";
import {
  isValidModelDiscoveryModelId,
  MODEL_DISCOVERY_MAX_MODELS,
} from "../providers/model-discovery-limits";
import { modelRecordValue } from "../reasoning-effort";
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

/**
 * Validate the Codex auto-review model override shape at the management write
 * boundary. Returns an error string, or null when the fields may be persisted.
 */
export function autoReviewModelConfigError(name: string, model: unknown, overrides: unknown): string | null {
  if (name === "openai" && (model !== undefined || overrides !== undefined)) {
    return "provider openai must not include autoReviewModel or autoReviewModelOverrides";
  }
  if (model !== undefined) {
    const trimmed = typeof model === "string" ? model.trim() : "";
    if (trimmed === "" || /\s/.test(trimmed)) {
      return "autoReviewModel must be a nonblank model id without whitespace";
    }
  }
  if (overrides === undefined) return null;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return "autoReviewModelOverrides must be an object mapping model ids to approval model ids";
  }
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    if (trimmedKey === "" || /\s/.test(trimmedKey)) {
      return "autoReviewModelOverrides keys must be nonblank model ids without whitespace";
    }
    const trimmedValue = typeof value === "string" ? value.trim() : "";
    if (trimmedValue === "" || /\s/.test(trimmedValue)) {
      return "autoReviewModelOverrides values must be nonblank model ids without whitespace";
    }
  }
  return null;
}

/** Normalize one autoReviewModel field with PATCH-style null-to-clear semantics. */
export function normalizeAutoReviewModelField(value: unknown):
  | { value: string }
  | { clear: true }
  | { error: string } {
  if (value === null) return { clear: true };
  if (typeof value !== "string" || value.trim() === "" || /\s/.test(value.trim())) {
    return { error: "autoReviewModel must be a nonblank model id without whitespace, or null to clear" };
  }
  return { value: value.trim() };
}

/** Normalize one autoReviewModelOverrides field with PATCH-style null-to-clear semantics. */
export function normalizeAutoReviewModelOverridesField(value: unknown):
  | { value: Record<string, string> }
  | { clear: true }
  | { error: string } {
  if (value === null) return { clear: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "autoReviewModelOverrides must be an object mapping model ids to approval model ids, or null to clear" };
  }
  const cleaned: Record<string, string> = {};
  const canonicalSeen = new Set<string>();
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    const trimmedEntry = typeof entry === "string" ? entry.trim() : "";
    if (trimmedKey === "" || /\s/.test(trimmedKey) || trimmedEntry === "" || /\s/.test(trimmedEntry)) {
      return { error: "autoReviewModelOverrides entries must be nonblank model ids without whitespace" };
    }
    const canonicalKey = trimmedKey.toLowerCase();
    if (canonicalSeen.has(canonicalKey)) {
      return { error: "autoReviewModelOverrides keys must be unique after trimming and case folding" };
    }
    canonicalSeen.add(canonicalKey);
    cleaned[trimmedKey] = trimmedEntry;
  }
  return { value: cleaned };
}

/**
 * Trim auto-review fields in place on a provider object that already passed
 * boundary validation (POST path). Returns an error string only when the
 * caller skipped validation; provider-routes always validates first.
 */
export function normalizeAutoReviewModelFields(name: string, provider: {
  autoReviewModel?: unknown;
  autoReviewModelOverrides?: unknown;
}): string | null {
  const error = autoReviewModelConfigError(name, provider.autoReviewModel, provider.autoReviewModelOverrides);
  if (error) return error;
  if (typeof provider.autoReviewModel === "string") {
    provider.autoReviewModel = provider.autoReviewModel.trim();
  }
  if (provider.autoReviewModelOverrides !== undefined) {
    const normalized = normalizeAutoReviewModelOverridesField(provider.autoReviewModelOverrides);
    if ("error" in normalized) return normalized.error;
    if ("value" in normalized) provider.autoReviewModelOverrides = normalized.value;
  }
  return null;
}

/**
 * Load-time sanitizer for hand-edited configs: malformed auto-review fields are
 * trimmed and dropped instead of retiring the whole config. The strict
 * management write boundary still rejects bad input before it reaches disk.
 */
export function sanitizeAutoReviewOverridesForLoad(parsed: unknown): void {
  if (!parsed || typeof parsed !== "object") return;
  const root = parsed as Record<string, unknown>;
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return;
  for (const [name, provider] of Object.entries(providers as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const row = provider as Record<string, unknown>;
    if (name === "openai") {
      delete row.autoReviewModel;
      delete row.autoReviewModelOverrides;
      continue;
    }
    if (row.autoReviewModel !== undefined) {
      const value = typeof row.autoReviewModel === "string" ? row.autoReviewModel.trim() : "";
      row.autoReviewModel = value !== "" && !/\s/.test(value) ? value : undefined;
    }
    if (row.autoReviewModelOverrides !== undefined) {
      const overrides = row.autoReviewModelOverrides;
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
        row.autoReviewModelOverrides = undefined;
        continue;
      }
      const cleaned: Record<string, string> = {};
      const canonicalSeen = new Set<string>();
      let collision = false;
      for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
        const trimmedKey = key.trim();
        if (trimmedKey === "" || /\s/.test(trimmedKey)) continue;
        const trimmedValue = typeof value === "string" ? value.trim() : "";
        if (trimmedValue === "" || /\s/.test(trimmedValue)) continue;
        const canonicalKey = trimmedKey.toLowerCase();
        if (canonicalSeen.has(canonicalKey)) {
          collision = true;
          break;
        }
        canonicalSeen.add(canonicalKey);
        cleaned[trimmedKey] = trimmedValue;
      }
      row.autoReviewModelOverrides = collision || Object.keys(cleaned).length === 0 ? undefined : cleaned;
    }
  }
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
