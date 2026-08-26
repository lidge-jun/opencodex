import { MAX_DISPLAY_LABEL_LENGTH, isValidDisplayLabel } from "../codex/catalog/display-labels";
import { isCanonicalOpenAiForwardProvider } from "../providers/openai-tiers";
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

/**
 * Bound on how many labels one provider may carry. A display map is a convenience,
 * not a catalogue, so an unbounded hand-edited map is a mistake rather than a use
 * case — and every entry is walked on each convergence.
 */
export const MAX_MODEL_DISPLAY_NAMES = 512;

/**
 * Strict diagnostic for `providers[<name>].modelDisplayNames`, mirroring
 * `booleanRecordConfigError`.
 *
 * This is the *write* rule, used by the provider editor so a bad label is a 400
 * rather than something that lands on disk. The load path is deliberately more
 * forgiving — see the schema entry, which drops a bad entry instead of failing —
 * because the two paths answer different questions: "is this a valid edit?" and
 * "can this file still be served?".
 *
 * `null` is accepted as an explicit clear, matching `upstreamHttpVersion`: the
 * management API says null means "remove this", so rejecting it here would refuse
 * the documented way to take a label back off.
 */
export function displayLabelRecordConfigError(value: unknown, field = "modelDisplayNames"): string | null {
  // `null` clears the whole map, the same way a per-key `null` clears one label and the same
  // way the load schema treats it. Rejecting it here made the documented way to remove every
  // label a 400 on POST while the loader accepted it — the two boundaries disagreed about
  // what the operator had asked for.
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${field} must be a plain object`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return `${field} must be a plain object with own properties`;
  const entries = Object.entries(value);
  if (entries.length > MAX_MODEL_DISPLAY_NAMES) {
    return `${field} must hold at most ${MAX_MODEL_DISPLAY_NAMES} entries`;
  }
  // Keys are stored trimmed, so two submitted keys can collapse into one stored entry.
  // Counting before that happens means the cap is enforced against a number the store
  // never sees, and the later of the two labels silently wins over the earlier — the
  // operator gets a 200 for an instruction that was self-contradictory.
  const seen = new Set<string>();
  for (const [key, label] of entries) {
    const id = key.trim();
    if (!id) return `${field} keys must be nonblank model ids`;
    if (seen.has(id)) return `${field} must not set the same model id twice (${id})`;
    seen.add(id);
    if (label === null) continue;
    if (typeof label !== "string") return `${field}.${key} must be a string`;
    if (!isValidDisplayLabel(label)) {
      return `${field}.${key} must be a nonblank single-line label of at most `
        + `${MAX_DISPLAY_LABEL_LENGTH} characters, and must not contain '/'`;
    }
  }
  return null;
}

/**
 * Normalize a submitted label map to the shape that is actually persisted: keys and labels
 * trimmed, non-string values carried through as tombstones for the caller to apply.
 *
 * PATCH already stored `model.trim()` while POST stored the key verbatim, so the same id
 * submitted through the two routes produced two different stored keys for one model. This
 * is the single definition of "what does this entry become", so the cap and the label rules
 * can be checked against the map that will exist rather than the one that was sent.
 */
export function normalizeDisplayLabelRecord(value: object): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, label] of Object.entries(value)) {
    const id = key.trim();
    if (!id) continue;
    out[id] = typeof label === "string" ? label.trim() : null;
  }
  return out;
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
