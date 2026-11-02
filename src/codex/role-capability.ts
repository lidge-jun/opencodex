/**
 * Measured capability per task domain, so role auto-assign can tier candidates by what they score
 * instead of what they cost. Artificial Analysis is read live when configured:
 *
 * - Artificial Analysis (https://artificialanalysis.ai/api-reference), when the user configures
 *   their own API key. Its terms allow that user's internal use with attribution and forbid
 *   redistributing the raw data, so its scores never leave this process.
 *
 * Each domain maps to one published index. The source names a model by display name
 * with one row per reasoning setting ("Claude Opus 5.5 (High)"); capabilityModelKey drops the
 * setting and folds the rest to a slug, which matches a catalog id once its provider prefix is
 * gone ("cpa/claude-opus-5-5"). The best setting's score stands for the model, since a role can
 * be given that setting. A candidate with no row is unmeasured, never guessed.
 */
import { resolveProviderApiKey } from "../providers/api-key-resolve";
import type { OcxConfig } from "../types";
import type { SizingDomain } from "./role-sizing";

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

const ARTIFICIAL_ANALYSIS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";

/** Per domain, the indexes to read in order; the first one the response carries is used. */
const INTELLIGENCE_INDEX = "artificial_analysis_intelligence_index";
const ARTIFICIAL_ANALYSIS_INDEXES: Record<SizingDomain, readonly string[]> = {
  coding: ["artificial_analysis_coding_index", INTELLIGENCE_INDEX],
  agentic: ["artificial_analysis_agentic_index", INTELLIGENCE_INDEX],
  reasoning: ["artificial_analysis_math_index", INTELLIGENCE_INDEX],
  writing: [INTELLIGENCE_INDEX],
  knowledge: [INTELLIGENCE_INDEX],
  general: [INTELLIGENCE_INDEX],
};

const FETCH_TIMEOUT_MS = 30_000;
/** Each published table is under 1 MB today; 16 MB leaves room to grow and still bounds memory. */
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
  const domains: Partial<Record<SizingDomain, Map<string, number>>> = {};
  for (const [domain, indexes] of Object.entries(ARTIFICIAL_ANALYSIS_INDEXES) as [SizingDomain, readonly string[]][]) {
    for (const index of indexes) {
      const scores = new Map<string, number>();
      for (const row of rows as Record<string, unknown>[]) {
        const value = (row?.evaluations as Record<string, unknown> | undefined)?.[index];
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        if (typeof row.name === "string") keepBest(scores, capabilityModelKey(row.name), value);
        if (typeof row.slug === "string") keepBest(scores, capabilityModelKey(row.slug), value);
      }
      if (scores.size > 0) {
        domains[domain] = scores;
        break;
      }
    }
  }
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

export async function fetchArtificialAnalysisTable(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<CapabilityTable> {
  const response = await fetchImpl(ARTIFICIAL_ANALYSIS_URL, {
    redirect: "error",
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readBoundedBytes(response, MAX_TABLE_BYTES);
  return capabilityTableFromArtificialAnalysis(JSON.parse(new TextDecoder().decode(bytes)));
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
