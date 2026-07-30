import type { OcxProviderConfig } from "../types";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  type ProviderModelDiscoveryFilter,
  type ProviderModelDiscoveryPredicate,
  type ProviderModelDiscoveryScalar,
  type ProviderModelDiscoverySpec,
} from "./registry";

/** Hard process-wide limits. Registry entries may lower, but never raise, these ceilings. */
export const MODEL_DISCOVERY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MODEL_DISCOVERY_MAX_MODELS = 2_000;
export const MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH = 1_024;
const MODEL_DISCOVERY_MAX_FILTER_VALUES = 256;
const MODEL_DISCOVERY_MAX_FILTER_STRING_LENGTH = 1_024;
const MODEL_DISCOVERY_MODEL_ID_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export interface ResolvedProviderModelDiscovery {
  spec?: ProviderModelDiscoverySpec;
  maxResponseBytes: number;
  maxModels: number;
}

export type ProviderModelsApiItem = Record<string, unknown> & { id: string };

export type ModelDiscoveryResponseFailure =
  | "response_too_large"
  | "invalid_json"
  | "invalid_shape"
  | "too_many_models";

export type BoundedDiscoveryJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "response_too_large" | "invalid_json" };

export type ProviderModelItemsResult =
  | { ok: true; items: ProviderModelsApiItem[]; rawCount: number }
  | { ok: false; reason: "invalid_shape" | "too_many_models" };

export type ModelEnvelopeRowsResult =
  | { ok: true; rows: unknown[] }
  | { ok: false; reason: "invalid_shape" | "too_many_models" };

function positiveIntegerAtMost(value: number | undefined, hardLimit: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return hardLimit;
  return Math.min(Math.floor(value), hardLimit);
}

function discoveryPredicateError(predicate: ProviderModelDiscoveryPredicate): string | null {
  if (!Array.isArray(predicate.path) || predicate.path.length === 0 || predicate.path.length > 8) {
    return "predicate path must contain 1-8 segments";
  }
  if (predicate.path.some(segment => typeof segment !== "string" || !segment.trim() || segment.length > 64)) {
    return "predicate path segments must be nonblank strings up to 64 characters";
  }
  const values = "equalsAny" in predicate
    ? predicate.equalsAny
    : "containsAny" in predicate
      ? predicate.containsAny
      : predicate.containsAll;
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    return "predicate values must contain 1-32 scalars";
  }
  if (values.some(value => (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    || (typeof value === "string" && (!value.trim() || value.length > 128))
    || (typeof value === "number" && !Number.isFinite(value))
  ))) {
    return "predicate values must be finite booleans/numbers or nonblank strings up to 128 characters";
  }
  return null;
}

/** Static registry validation used by parity tests; discovery metadata never comes from config. */
export function providerModelDiscoverySpecError(spec: ProviderModelDiscoverySpec): string | null {
  if (spec.url && spec.path) return "url and path are mutually exclusive";
  if (spec.url !== undefined) {
    try {
      const parsed = new URL(spec.url);
      if (parsed.protocol !== "https:") return "absolute discovery url must use https";
      if (parsed.username || parsed.password || parsed.hash) return "absolute discovery url must not contain credentials or a fragment";
    } catch {
      return "absolute discovery url must be valid";
    }
  }
  if (spec.path !== undefined) {
    const path = spec.path.trim();
    if (!path || path.length > 512) return "discovery path must be 1-512 characters";
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//") || path.includes("?") || path.includes("#")) {
      return "discovery path must be a query-free relative/origin path";
    }
    if (path.split("/").includes("..")) return "discovery path must not contain parent-directory segments";
  }
  const queryEntries = Object.entries(spec.query ?? {});
  if (queryEntries.length > 32) return "discovery query may contain at most 32 entries";
  if (queryEntries.some(([key, value]) => !key.trim() || key.length > 128 || typeof value !== "string" || value.length > 512)) {
    return "discovery query keys/values exceed their bounds";
  }
  for (const [field, value, hardLimit] of [
    ["maxResponseBytes", spec.maxResponseBytes, MODEL_DISCOVERY_MAX_RESPONSE_BYTES],
    ["maxModels", spec.maxModels, MODEL_DISCOVERY_MAX_MODELS],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > hardLimit)) {
      return `${field} must be a positive integer no greater than ${hardLimit}`;
    }
  }
  for (const [group, predicates] of Object.entries(spec.filter ?? {})) {
    if (!Array.isArray(predicates) || predicates.length === 0 || predicates.length > 32) {
      return `${group} must contain 1-32 predicates`;
    }
    for (const predicate of predicates) {
      const error = discoveryPredicateError(predicate);
      if (error) return `${group}: ${error}`;
    }
  }
  return null;
}

export function resolveProviderModelDiscovery(
  providerName: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
): ResolvedProviderModelDiscovery {
  const entry = providerMatchesRegistryTransport(providerName, provider)
    ? getProviderRegistryEntry(providerName)
    : undefined;
  const spec = entry?.modelDiscovery;
  return {
    ...(spec ? { spec } : {}),
    maxResponseBytes: positiveIntegerAtMost(spec?.maxResponseBytes, MODEL_DISCOVERY_MAX_RESPONSE_BYTES),
    maxModels: positiveIntegerAtMost(spec?.maxModels, MODEL_DISCOVERY_MAX_MODELS),
  };
}

function appendDiscoveryQuery(url: URL, query: Readonly<Record<string, string>> | undefined): URL {
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url;
}

/** Apply a registry-owned URL/path/query policy to the adapter's normal discovery endpoint. */
export function resolveProviderModelDiscoveryUrl(
  providerName: string,
  configuredProvider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  effectiveBaseUrl: string,
  defaultUrl: string,
): string {
  const { spec } = resolveProviderModelDiscovery(providerName, configuredProvider);
  if (!spec) return defaultUrl;

  let resolved: URL;
  if (spec.url) {
    resolved = new URL(spec.url);
  } else if (spec.path) {
    const base = new URL(effectiveBaseUrl.endsWith("/") ? effectiveBaseUrl : `${effectiveBaseUrl}/`);
    resolved = spec.path.startsWith("/")
      ? new URL(spec.path, base.origin)
      : new URL(spec.path, base);
  } else {
    resolved = new URL(defaultUrl);
  }
  return appendDiscoveryQuery(resolved, spec.query).toString();
}

function cancelWithoutWaiting(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // A non-conforming stream may throw synchronously from cancel().
  }
}

/** Read a discovery response under a strict byte ceiling before JSON.parse can allocate freely. */
export async function readBoundedDiscoveryJson(
  response: Response,
  maxResponseBytes: number,
): Promise<BoundedDiscoveryJsonResult> {
  const limit = positiveIntegerAtMost(maxResponseBytes, MODEL_DISCOVERY_MAX_RESPONSE_BYTES);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    try {
      void response.body?.cancel(new DOMException("Model discovery response is too large", "QuotaExceededError"))
        .catch(() => undefined);
    } catch {
      // Best-effort cancellation only.
    }
    return { ok: false, reason: "response_too_large" };
  }

  if (!response.body) return { ok: false, reason: "invalid_json" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > limit - total) {
        cancelWithoutWaiting(
          reader,
          new DOMException("Model discovery response is too large", "QuotaExceededError"),
        );
        return { ok: false, reason: "response_too_large" };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may keep the lock briefly.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

function valueAtPath(item: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = item;
  for (const segment of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function comparableScalar(value: unknown, caseInsensitive: boolean): ProviderModelDiscoveryScalar | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  if (typeof value === "string" && value.length > MODEL_DISCOVERY_MAX_FILTER_STRING_LENGTH) return undefined;
  return caseInsensitive && typeof value === "string" ? value.toLowerCase() : value;
}

function comparableNeedles(
  values: readonly ProviderModelDiscoveryScalar[],
  caseInsensitive: boolean,
): ProviderModelDiscoveryScalar[] {
  return values.map(value => caseInsensitive && typeof value === "string" ? value.toLowerCase() : value);
}

function predicateMatches(item: ProviderModelsApiItem, predicate: ProviderModelDiscoveryPredicate): boolean {
  const caseInsensitive = predicate.caseInsensitive === true;
  const raw = valueAtPath(item, predicate.path);
  if ("equalsAny" in predicate) {
    const value = comparableScalar(raw, caseInsensitive);
    return value !== undefined && comparableNeedles(predicate.equalsAny, caseInsensitive).includes(value);
  }

  const collection = Array.isArray(raw);
  const values: ProviderModelDiscoveryScalar[] = [];
  if (collection) {
    for (let i = 0; i < raw.length && i < MODEL_DISCOVERY_MAX_FILTER_VALUES; i += 1) {
      const value = comparableScalar(raw[i], caseInsensitive);
      if (value !== undefined) values.push(value);
    }
  } else if (typeof raw === "string") {
    values.push(caseInsensitive ? raw.toLowerCase() : raw);
  }
  const needles = comparableNeedles(
    "containsAny" in predicate ? predicate.containsAny : predicate.containsAll,
    caseInsensitive,
  );
  if ("containsAny" in predicate) {
    return needles.some(needle => values.some(value => (
      !collection && typeof value === "string" && typeof needle === "string" ? value.includes(needle) : value === needle
    )));
  }
  return needles.every(needle => values.some(value => (
    !collection && typeof value === "string" && typeof needle === "string" ? value.includes(needle) : value === needle
  )));
}

export function providerModelMatchesDiscoveryFilter(
  item: ProviderModelsApiItem,
  filter: ProviderModelDiscoveryFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.allOf && !filter.allOf.every(predicate => predicateMatches(item, predicate))) return false;
  if (filter.anyOf && filter.anyOf.length > 0 && !filter.anyOf.some(predicate => predicateMatches(item, predicate))) return false;
  if (filter.noneOf?.some(predicate => predicateMatches(item, predicate))) return false;
  return true;
}

/** Extract one allowlisted array envelope while enforcing the raw-row ceiling. */
export function extractModelEnvelopeRows(
  value: unknown,
  maxModels: number,
  envelopeKeys: readonly string[],
): ModelEnvelopeRowsResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_shape" };
  }
  const record = value as Record<string, unknown>;
  const rows = envelopeKeys.map(key => record[key]).find(Array.isArray);
  if (!rows) return { ok: false, reason: "invalid_shape" };
  const limit = positiveIntegerAtMost(maxModels, MODEL_DISCOVERY_MAX_MODELS);
  if (rows.length > limit) return { ok: false, reason: "too_many_models" };
  return { ok: true, rows };
}

/** Validate, bound, deduplicate, and declaratively filter OpenAI `{data:[...]}` or top-level arrays (Together `#617`). */
export function extractProviderModelItems(
  value: unknown,
  discovery: ResolvedProviderModelDiscovery,
): ProviderModelItemsResult {
  const limit = positiveIntegerAtMost(discovery.maxModels, MODEL_DISCOVERY_MAX_MODELS);
  let data: unknown[];
  if (Array.isArray(value)) {
    // Together-style top-level /models arrays. Catalog discovery must not treat a stray
    // `models` key on openai-chat responses as valid — only `data` envelopes or top-level arrays.
    if (value.length > limit) return { ok: false, reason: "too_many_models" };
    data = value;
  } else {
    const envelope = extractModelEnvelopeRows(value, discovery.maxModels, ["data"]);
    if (!envelope.ok) return envelope;
    data = envelope.rows;
  }

  const items: ProviderModelsApiItem[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "invalid_shape" };
    }
    const id = (raw as { id?: unknown }).id;
    if (typeof id !== "string") return { ok: false, reason: "invalid_shape" };
    const normalizedId = id.trim();
    if (
      !normalizedId
      || normalizedId !== id
      || normalizedId.length > MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH
      || MODEL_DISCOVERY_MODEL_ID_CONTROL_CHARS.test(normalizedId)
    ) {
      return { ok: false, reason: "invalid_shape" };
    }
    const item = raw as ProviderModelsApiItem;
    if (!providerModelMatchesDiscoveryFilter(item, discovery.spec?.filter) || seen.has(normalizedId)) continue;
    seen.add(normalizedId);
    items.push(item);
  }
  return { ok: true, items, rawCount: data.length };
}
