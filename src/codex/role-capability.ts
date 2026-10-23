/**
 * Measured capability per task domain, so role auto-assign can tier candidates by what they score
 * instead of what they cost. Read live from the LMArena leaderboard dataset,
 * https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset, published under CC BY 4.0;
 * every response that uses it carries CAPABILITY_SOURCE as the attribution.
 *
 * Each domain maps to one published leaderboard table. Arena names a model by display name and
 * lists one row per reasoning setting ("Claude Opus 5.5 (High)"); capabilityModelKey drops the
 * setting and folds the rest to a slug, which matches a catalog id once its provider prefix is
 * gone ("cpa/claude-opus-5-5"). The best setting's score stands for the model, since a role can
 * be given that setting. A candidate with no row is unmeasured, never guessed.
 */
import { parquetReadObjects } from "hyparquet";
import type { SizingDomain } from "./role-sizing";

export const CAPABILITY_SOURCE = {
  name: "LMArena leaderboard dataset",
  url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
  license: "CC BY 4.0",
} as const;

interface DomainTable {
  readonly config: string;
  readonly category: string;
  readonly metric: "rating" | "score";
}

const DOMAIN_TABLES: Record<SizingDomain, DomainTable> = {
  coding: { config: "text", category: "coding", metric: "rating" },
  agentic: { config: "agent", category: "overall", metric: "score" },
  reasoning: { config: "text", category: "math", metric: "rating" },
  writing: { config: "text", category: "creative_writing", metric: "rating" },
  knowledge: { config: "text", category: "expert", metric: "rating" },
  general: { config: "text", category: "overall", metric: "rating" },
};

const FETCH_TIMEOUT_MS = 30_000;
/** Each published table is under 1 MB today; 16 MB leaves room to grow and still bounds memory. */
export const MAX_TABLE_BYTES = 16 * 1024 * 1024;

export interface CapabilityTable {
  readonly publishedAt: string | null;
  /** Per domain: model key to its best published score. */
  readonly domains: Partial<Record<SizingDomain, ReadonlyMap<string, number>>>;
}

export type LoadCapability = () => Promise<CapabilityTable>;

export function capabilityModelKey(name: string): string {
  return name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function candidateModelKey(slug: string): string {
  return capabilityModelKey(slug.slice(slug.lastIndexOf("/") + 1));
}

type LeaderboardRow = Record<string, unknown>;

export function capabilityTableFromRows(rowsByConfig: ReadonlyMap<string, readonly LeaderboardRow[]>): CapabilityTable {
  const domains: Partial<Record<SizingDomain, Map<string, number>>> = {};
  let publishedAt: string | null = null;
  for (const [domain, table] of Object.entries(DOMAIN_TABLES) as [SizingDomain, DomainTable][]) {
    const scores = new Map<string, number>();
    for (const row of rowsByConfig.get(table.config) ?? []) {
      const value = row[table.metric];
      if (row.category !== table.category || typeof row.model_name !== "string" || typeof value !== "number" || !Number.isFinite(value)) continue;
      const key = capabilityModelKey(row.model_name);
      scores.set(key, Math.max(value, scores.get(key) ?? -Infinity));
      const date = String(row.leaderboard_publish_date ?? "");
      if (date > (publishedAt ?? "")) publishedAt = date;
    }
    if (scores.size > 0) domains[domain] = scores;
  }
  return { publishedAt, domains };
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

async function readLatest(config: string, fetchImpl: typeof fetch): Promise<LeaderboardRow[]> {
  const url = `${CAPABILITY_SOURCE.url}/resolve/main/${config}/latest-00000-of-00001.parquet`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await parquetReadObjects({ file: await readBoundedBytes(response, MAX_TABLE_BYTES) }) as LeaderboardRow[];
}

export async function fetchCapabilityTable(fetchImpl: typeof fetch = fetch): Promise<CapabilityTable> {
  const configs = [...new Set(Object.values(DOMAIN_TABLES).map(table => table.config))];
  const rows = await Promise.all(configs.map(config => readLatest(config, fetchImpl)));
  return capabilityTableFromRows(new Map(configs.map((config, index) => [config, rows[index]!])));
}

let cached: { hour: string; table: Promise<CapabilityTable> } | null = null;

/** One fetch per clock hour; a failed fetch is forgotten so the next request retries. */
export const loadCapabilityTable: LoadCapability = () => {
  const hour = new Date().toISOString().slice(0, 13);
  if (cached?.hour !== hour) {
    const table = fetchCapabilityTable();
    cached = { hour, table };
    table.catch(() => { if (cached?.table === table) cached = null; });
  }
  return cached.table;
};
