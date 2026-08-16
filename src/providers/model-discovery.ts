import type { OcxProviderConfig } from "../types";
import {
  isValidModelDiscoveryModelId,
  MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH,
  MODEL_DISCOVERY_MAX_MODELS,
  MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
} from "./model-discovery-limits";
export {
  isValidModelDiscoveryModelId,
  MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH,
  MODEL_DISCOVERY_MAX_MODELS,
  MODEL_DISCOVERY_MAX_RESPONSE_BYTES,
} from "./model-discovery-limits";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  registryEntryForProviderDestination,
  type ProviderModelDiscoveryFilter,
  type ProviderModelDiscoveryPredicate,
  type ProviderModelDiscoveryScalar,
  type ProviderModelDiscoverySpec,
} from "./registry";

const MODEL_DISCOVERY_MAX_FILTER_VALUES = 256;
const MODEL_DISCOVERY_MAX_FILTER_STRING_LENGTH = 1_024;

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
    if (path.includes("\\")) return "discovery path must use forward slashes";
    const segments = path.split("/");
    if (segments.some((segment, index) => {
      const decoded = segment.replace(/%2e/gi, ".");
      if (decoded !== "..") return false;
      return index !== 0 || segments.filter(s => s.replace(/%2e/gi, ".") === "..").length !== 1;
    })) {
      return "discovery path must not contain parent-directory segments";
    }
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
  // The dashboard permits a canonical preset to be saved under a different name. Recover its
  // registry-owned discovery policy by transport in that case. The destination helper is limited
  // to exact fixed-key baseUrl + adapter matches, so custom endpoints, OAuth rows, templates, and
  // overridable destinations cannot acquire another provider's discovery URL or filter.
  const namedEntry = getProviderRegistryEntry(providerName);
  const entry = namedEntry
    ? (providerMatchesRegistryTransport(providerName, provider) ? namedEntry : undefined)
    : registryEntryForProviderDestination(provider);
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
/**
 * Metadata a sibling `models[]` array may contribute to an ALREADY-ADMITTED
 * `data[]` row (#1797).
 *
 * llama.cpp serves a dual-envelope body: an Ollama-style `models[]` array
 * carrying `capabilities` alongside the OpenAI-style `data[]` array carrying
 * `meta`, so the two halves of one model's metadata never meet and a server
 * that truthfully advertises "multimodal" produced an image-blind row.
 *
 * Two boundaries make this safe, and both were added after review found the
 * first attempt unsound:
 *
 * 1. It runs AFTER admission filtering. Enriching first let a sibling supply
 *    the exact field a provider filter requires — reproduced against the real
 *    Chutes policy, where a row lacking `supported_features: ["tools"]` was
 *    admitted once a same-id sibling provided it. Enrichment may change what is
 *    KNOWN about a model, never WHICH models are published.
 * 2. Only the capability keys #1797 needs are copied. A blanket "fill every
 *    absent key" made the untrusted `models[]` array a way into any field the
 *    pipeline consumes.
 *
 *    The list deliberately EXCLUDES `supported_features` and `features`, even
 *    though both are capability-shaped: they are the two keys real provider
 *    filters test (`registry.ts:1591` requires `supported_features` to contain
 *    "tools"; `registry.ts:1883` tests `features.tool_use`). Ordering already
 *    prevents a sibling from flipping an admission verdict, but a key that is
 *    both enrichable and filter-relevant is one refactor away from becoming a
 *    bypass again. #1797 does not need them.
 */
const SIBLING_ENRICHABLE_KEYS = new Set(["capabilities", "modalities", "input_modalities"]);

type SiblingIndex = Map<string, Record<string, unknown> | null>;

function buildSiblingIndex(value: unknown, limit: number): SiblingIndex | null {
  const record = plainObject(value);
  const sibling = record?.models;
  if (!Array.isArray(sibling) || sibling.length === 0 || sibling.length > limit) return null;

  const byId: SiblingIndex = new Map();
  for (const raw of sibling) {
    const entry = plainObject(raw);
    if (!entry) continue;
    for (const key of ["id", "model", "name"]) {
      const id = entry[key];
      if (typeof id !== "string" || id.length === 0) continue;
      // `null` marks an ambiguous id: two sibling entries claim it, so neither
      // can be attributed with confidence and both are ignored.
      byId.set(id, byId.has(id) && byId.get(id) !== entry ? null : entry);
    }
  }
  return byId.size > 0 ? byId : null;
}

function enrichAdmittedModel(item: ProviderModelsApiItem, siblings: SiblingIndex): ProviderModelsApiItem {
  const extra = siblings.get(item.id);
  if (!extra) return item;
  let merged: Record<string, unknown> | null = null;
  for (const key of SIBLING_ENRICHABLE_KEYS) {
    if (!(key in extra) || key in item) continue;
    merged ??= { ...(item as Record<string, unknown>) };
    merged[key] = extra[key];
  }
  return (merged ?? item) as ProviderModelsApiItem;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
export function extractProviderModelItems(
  value: unknown,
  discovery: ResolvedProviderModelDiscovery,
): ProviderModelItemsResult {
  const limit = positiveIntegerAtMost(discovery.maxModels, MODEL_DISCOVERY_MAX_MODELS);
  let data: unknown[];
  let siblings: SiblingIndex | null = null;
  if (Array.isArray(value)) {
    // Together-style top-level /models arrays. Catalog discovery must not treat a stray
    // `models` key on openai-chat responses as valid — only `data` envelopes or top-level arrays.
    if (value.length > limit) return { ok: false, reason: "too_many_models" };
    data = value;
  } else {
    const envelope = extractModelEnvelopeRows(value, discovery.maxModels, ["data"]);
    if (!envelope.ok) return envelope;
    data = envelope.rows;
    siblings = buildSiblingIndex(value, limit);
  }

  const items: ProviderModelsApiItem[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "invalid_shape" };
    }
    const id = (raw as { id?: unknown }).id;
    if (!isValidModelDiscoveryModelId(id)) return { ok: false, reason: "invalid_shape" };
    const prefix = discovery.spec?.stripIdPrefix;
    let finalId = id;
    if (prefix && finalId.startsWith(prefix)) {
      finalId = finalId.slice(prefix.length);
      if (!isValidModelDiscoveryModelId(finalId)) continue;
    }
    const item = finalId === id ? raw as ProviderModelsApiItem : { ...(raw as ProviderModelsApiItem), id: finalId };
    // Admission is decided on the ORIGINAL `data[]` row, before any sibling
    // enrichment. Merging first let a `models[]` entry supply the very field a
    // provider filter requires — reproduced against the real Chutes policy,
    // where a row lacking `supported_features: ["tools"]` was admitted once a
    // same-id sibling provided it. Enrichment must never change WHICH models
    // are published, only what is known about an already-admitted one.
    if (!providerModelMatchesDiscoveryFilter(item, discovery.spec?.filter) || seen.has(finalId)) continue;
    seen.add(finalId);
    items.push(siblings ? enrichAdmittedModel(item, siblings) : item);
  }
  return { ok: true, items, rawCount: data.length };
}
