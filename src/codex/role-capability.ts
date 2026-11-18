/**
 * Measured capability per task domain, so role auto-assign can tier candidates by what they score
 * instead of what they cost. Artificial Analysis is read live when configured:
 *
 * - Artificial Analysis (https://artificialanalysis.ai/data-api/docs), when the user configures
 *   their own API key. Its terms allow that user's internal use with attribution and forbid
 *   redistributing the raw data, so its scores never leave this process.
 *
 * Every domain reads the Intelligence Index: Artificial Analysis no longer publishes a Coding or
 * an Agentic Index (both are always null) and its free model list carries no math index. The
 * source names a model by display name with one row per reasoning setting ("Claude Opus 5.5
 * (High)"); capabilityModelKey drops the setting and folds the rest to a slug, which matches a
 * catalog id once its provider prefix is gone ("cpa/claude-opus-5-5"). The best setting's score
 * stands for the model, since a role can be given that setting. A candidate with no row is
 * unmeasured, never guessed.
 */
import { resolveProviderApiKey } from "../providers/api-key-resolve";
import type { OcxConfig } from "../types";
import { SIZING_DOMAINS, type SizingDomain } from "./role-sizing";

export interface CapabilitySource {
  readonly name: string;
  readonly url: string;
  readonly license: string;
  /** Whether the terms let a response carry the raw scores. */
  readonly redistributable: boolean;
}

export const ARTIFICIAL_ANALYSIS_SOURCE: CapabilitySource = {
  name: "Artificial Analysis",
  url: "https://artificialanalysis.ai",
  license: "Artificial Analysis API terms: internal use, attribution required, no redistribution",
  redistributable: false,
};

/**
 * The free-tier language model list, which any key may read. It replaced
 * /api/v2/data/llms/models, retired at 2026-11-04 23:59 UTC with 410 Gone afterwards
 * (https://artificialanalysis.ai/data-api/migrate-v2-data).
 */
export const ARTIFICIAL_ANALYSIS_URL = "https://artificialanalysis.ai/api/v2/language/models/free";

const INTELLIGENCE_INDEX = "artificial_analysis_intelligence_index";

/**
 * Pages read per refresh. The list is paginated (200 rows a page in the published example, two
 * pages); ten pages bound one daily refresh to a tenth of the free tier's 100 requests a day.
 */
export const MAX_TABLE_PAGES = 10;

const FETCH_TIMEOUT_MS = 30_000;
/** The bytes all pages of one refresh may total; the list is under 1 MB today, 16 MB still bounds memory. */
export const MAX_TABLE_BYTES = 16 * 1024 * 1024;

export interface CapabilityTable {
  readonly source: CapabilitySource | null;
  readonly publishedAt: string | null;
  /** Per domain: model key to its best published score. */
  readonly domains: Partial<Record<SizingDomain, ReadonlyMap<string, number>>>;
  /** Why a configured source was passed over for this one. */
  readonly fallbackReason?: string;
}

export type LoadCapability = (config: OcxConfig) => Promise<CapabilityTable>;

export function capabilityModelKey(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function candidateModelKey(slug: string): string {
  return capabilityModelKey(slug.slice(slug.lastIndexOf("/") + 1));
}

function keepBest(scores: Map<string, number>, key: string, value: number) {
  if (key) scores.set(key, Math.max(value, scores.get(key) ?? -Infinity));
}

export function capabilityTableFromArtificialAnalysis(body: unknown): CapabilityTable {
  const rows = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) throw new Error("Artificial Analysis returned no model list");
  const scores = new Map<string, number>();
  for (const row of rows as Record<string, unknown>[]) {
    const value = (row?.evaluations as Record<string, unknown> | undefined)?.[INTELLIGENCE_INDEX];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (typeof row.name === "string") keepBest(scores, capabilityModelKey(row.name), value);
    if (typeof row.slug === "string") keepBest(scores, capabilityModelKey(row.slug), value);
  }
  const domains: Partial<Record<SizingDomain, ReadonlyMap<string, number>>> = {};
  if (scores.size > 0) for (const domain of SIZING_DOMAINS) domains[domain] = scores;
  return { source: ARTIFICIAL_ANALYSIS_SOURCE, publishedAt: null, domains };
}

/** The body's bytes, refused once they pass maxBytes, whatever the transport declared. */
export async function readBoundedBytes(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.byteLength > maxBytes) {
      await reader.cancel();
      throw new Error("response exceeded byte bound");
    }
    chunks.push(value);
    length += value.byteLength;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

/** A list past either bound fails whole, so price ranking takes over rather than tiering on part of it. */
export async function fetchArtificialAnalysisTable(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<CapabilityTable> {
  const rows: unknown[] = [];
  let budget = MAX_TABLE_BYTES;
  for (let page = 1; page <= MAX_TABLE_PAGES; page++) {
    const url = new URL(ARTIFICIAL_ANALYSIS_URL);
    url.searchParams.set("page", String(page));
    const response = await fetchImpl(url.href, {
      redirect: "error",
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await readBoundedBytes(response, budget);
    budget -= bytes.byteLength;
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { data?: unknown; pagination?: { has_more?: unknown } } | null;
    if (!Array.isArray(body?.data)) throw new Error("Artificial Analysis returned no model list");
    const hasMore = body.pagination?.has_more;
    if (typeof hasMore !== "boolean") throw new Error("Artificial Analysis returned no pagination.has_more");
    rows.push(...body.data);
    if (!hasMore) return capabilityTableFromArtificialAnalysis({ data: rows });
  }
  throw new Error(`Artificial Analysis listed more than ${MAX_TABLE_PAGES} pages`);
}

/** One fetch per period key; a failed fetch is forgotten so the next request retries. */
function periodCache() {
  let slot: { key: string; table: Promise<CapabilityTable> } | null = null;
  return (key: string, fetchTable: () => Promise<CapabilityTable>): Promise<CapabilityTable> => {
    if (slot?.key === key) return slot.table;
    const table = fetchTable();
    slot = { key, table };
    table.catch(() => { if (slot?.table === table) slot = null; });
    return table;
  };
}

const artificialAnalysisCache = periodCache();

/**
 * Artificial Analysis when the user's key resolves, read once per UTC day to stay inside the
 * free tier's daily request quota. Absent or unavailable scores leave price ranking in charge.
 */
export const loadCapabilityTable: LoadCapability = async config => {
  const now = new Date().toISOString();
  const unavailable = (fallbackReason: string): CapabilityTable => ({ source: null, publishedAt: null, domains: {}, fallbackReason });
  const apiKey = resolveProviderApiKey(config.codexRoleCapability?.artificialAnalysis?.apiKey)?.trim();
  if (!apiKey) return unavailable("benchmark data was unavailable: no Artificial Analysis key is configured");
  try {
    return await artificialAnalysisCache(`${now.slice(0, 10)} ${apiKey}`, () => fetchArtificialAnalysisTable(apiKey));
  } catch {
    return unavailable("Artificial Analysis could not be read");
  }
};
