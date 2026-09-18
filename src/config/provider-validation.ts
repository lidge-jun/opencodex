import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
import { redactSecretString } from "../lib/redact";
import {
  isValidModelDiscoveryModelId,
  MODEL_DISCOVERY_MAX_MODELS,
} from "../providers/model-discovery-limits";
import { isDeclaredReasoningEffort, modelRecordValue } from "../reasoning-effort";
import { encodeRoutedModelId } from "../providers/slug-codec";
import {
  isWirePinnedModel,
  MODEL_ADAPTER_OVERRIDE_ALLOWED,
  REASONING_SUMMARY_DELIVERY_VALUES,
  UPSTREAM_HTTP_VERSION_VALUES,
  type OcxProviderConfig,
  type ModelCapabilities,
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

/** Characters that make a Codex catalog selector ambiguous or unrepresentable. */
export const AUTO_REVIEW_MODEL_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]/;

/** Validate one auto-review target (provider-wide value or map value). */
export function autoReviewModelTargetConfigError(
  value: unknown,
  field = "autoReviewModel",
  allowClear = false,
): string | null {
  if (value === undefined || (allowClear && (value === null || value === ""))) return null;
  if (typeof value !== "string") return `${field} must be a string`;
  const trimmed = value.trim();
  if (!trimmed) return `${field} must be nonblank`;
  if (trimmed.length > 1024 || AUTO_REVIEW_MODEL_CONTROL_CHARS.test(trimmed)) {
    return `${field} must be a catalog selector without whitespace or control characters`;
  }
  return null;
}

/** True when the value is a valid Codex catalog auto-review selector. */
export function isValidAutoReviewModel(value: unknown): value is string {
  return typeof value === "string" && autoReviewModelTargetConfigError(value) === null;
}

/** Canonical model key used for map matching, duplicate detection, and route tombstones. */
export function canonicalAutoReviewModelKey(modelId: string): string {
  return encodeRoutedModelId(modelId.trim());
}

/** Validate a per-model auto-review override map. */
export function autoReviewModelOverridesConfigError(
  value: unknown,
  field = "autoReviewModelOverrides",
  allowTombstones = false,
): string | null {
  if (value === undefined) return null;
  if (value === null && allowTombstones) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return `${field} must be a plain object with own properties`;
  }
  const entries = Object.entries(value);
  if (entries.length > MODEL_DISCOVERY_MAX_MODELS) {
    return `${field} must contain at most ${MODEL_DISCOVERY_MAX_MODELS} entries`;
  }
  const canonicalKeys = new Set<string>();
  for (const [modelId, target] of entries) {
    if (!isValidModelDiscoveryModelId(modelId) || ["__proto__", "prototype", "constructor"].includes(modelId)) {
      return `${field} keys must be valid non-reserved model ids`;
    }
    const safeModelId = JSON.stringify(redactSecretString(modelId));
    const canonicalKey = canonicalAutoReviewModelKey(modelId);
    if (canonicalKeys.has(canonicalKey)) {
      return `${field} keys must be unique after trimming and slash normalization`;
    }
    canonicalKeys.add(canonicalKey);
    if (allowTombstones && (target === null || target === "")) continue;
    const targetError = autoReviewModelTargetConfigError(target, `${field}.${safeModelId}`);
    if (targetError) return targetError;
  }
  return null;
}

/** Normalize a persisted auto-review override map (trim, drop blanks, keep insertion order). */
export function normalizeAutoReviewModelOverrides(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out = Object.create(null) as Record<string, string>;
  for (const [modelId, target] of Object.entries(value)) {
    const key = modelId.trim();
    if (!key) continue;
    if (target === null || typeof target !== "string") continue;
    const trimmed = target.trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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


function capabilityRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Strict writes; only PATCH may carry deletion tombstones. Model IDs are exact. */
export function modelCapabilitiesConfigError(value: unknown, allowTombstones = false): string | null {
  if (value === undefined || (allowTombstones && value === null)) return null;
  if (!capabilityRecord(value)) return "modelCapabilities must be a plain object";
  if (Object.keys(value).length > MODEL_DISCOVERY_MAX_MODELS) return "modelCapabilities has too many models";
  for (const [id, row] of Object.entries(value)) {
    if (!isValidModelDiscoveryModelId(id) || ["__proto__", "prototype", "constructor"].includes(id)) {
      return "modelCapabilities keys must be exact non-reserved model ids without surrounding whitespace";
    }
    if (allowTombstones && row === null) continue;
    if (!capabilityRecord(row)) return "modelCapabilities rows must be plain objects";
    for (const [axis, declaration] of Object.entries(row)) {
      if (!["inputModalities", "contextTier", "video"].includes(axis)) return "modelCapabilities contains an unknown axis";
      if (allowTombstones && declaration === null) continue;
      if (axis === "inputModalities") {
        if (!Array.isArray(declaration) || declaration.length === 0
          || declaration.some(item => typeof item !== "string" || !["text", "image", "audio", "video"].includes(item))) {
          return "modelCapabilities inputModalities must be a nonempty array of text, image, audio or video";
        }
      } else if (axis === "contextTier") {
        if (declaration !== "default" && declaration !== "long_context") return "modelCapabilities contextTier must be default or long_context";
      } else {
        if (!capabilityRecord(declaration) || Object.keys(declaration).some(key => key !== "processing")) {
          return "modelCapabilities video must be a plain object containing only processing";
        }
        if (Object.hasOwn(declaration, "processing") && declaration.processing !== "static" && declaration.processing !== "agentic"
          && !(allowTombstones && declaration.processing === null)) return "modelCapabilities video processing must be static or agentic";
      }
    }
  }
  return null;
}

/** Merge a validated patch without sharing nested objects with the live provider. */
export function mergeModelCapabilities(
  current: Record<string, ModelCapabilities> | undefined,
  patch: unknown,
): Record<string, ModelCapabilities> | undefined {
  if (patch === null) return undefined;
  const next = Object.fromEntries(Object.entries(current ?? {}).map(([id, row]) => [id, structuredClone(row)]));
  if (patch !== undefined) for (const [id, raw] of Object.entries(patch as Record<string, Record<string, unknown> | null>)) {
    if (raw === null) { delete next[id]; continue; }
    const row: ModelCapabilities = Object.hasOwn(next, id) ? next[id]! : {};
    for (const [axis, value] of Object.entries(raw)) {
      if (axis === "inputModalities") {
        if (value === null) delete row.inputModalities;
        else row.inputModalities = [...(value as NonNullable<ModelCapabilities["inputModalities"]>)];
      } else if (axis === "contextTier") {
        if (value === null) delete row.contextTier;
        else row.contextTier = value as ModelCapabilities["contextTier"];
      } else if (axis === "video") {
        if (value === null) delete row.video;
        else {
          const video = { ...(row.video ?? {}) };
          const change = value as { processing?: "static" | "agentic" | null };
          if (Object.hasOwn(change, "processing")) {
            if (change.processing === null) delete video.processing;
            else video.processing = change.processing;
          }
          if (Object.keys(video).length) row.video = video;
          else delete row.video;
        }
      }
    }
    if (Object.keys(row).length) next[id] = row;
    else delete next[id];
  }
  return Object.keys(next).length ? next : undefined;
}

/** Load-only repair preserves independent valid axes; malformed explicit modalities restrict to text. */
export function sanitizeModelCapabilitiesForLoad(value: unknown): Record<string, ModelCapabilities> | undefined {
  if (!capabilityRecord(value)) return undefined;
  const rows: Record<string, ModelCapabilities> = Object.create(null);
  for (const [id, raw] of Object.entries(value).slice(0, MODEL_DISCOVERY_MAX_MODELS)) {
    if (!capabilityRecord(raw) || !isValidModelDiscoveryModelId(id) || ["__proto__", "prototype", "constructor"].includes(id)) continue;
    const row: Record<string, unknown> = {};
    for (const axis of ["inputModalities", "contextTier", "video"] as const) {
      if (!Object.hasOwn(raw, axis)) continue;
      const declaration = raw[axis];
      if (modelCapabilitiesConfigError({ [id]: { [axis]: declaration } }) === null) row[axis] = declaration;
      else if (axis === "inputModalities") row.inputModalities = ["text"];
    }
    const normalized = mergeModelCapabilities(undefined, { [id]: row });
    if (normalized?.[id]) rows[id] = normalized[id];
  }
  return Object.keys(rows).length ? rows : undefined;
}
