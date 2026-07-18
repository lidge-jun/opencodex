/** Shared shape for static frontier benchmark snapshots (GUI Frontier page). */

export type FrontierFamily =
  | "openai"
  | "anthropic"
  | "xai"
  | "google"
  | "moonshot"
  | "zhipu"
  | "cursor"
  | "deepseek"
  | "other";

export type FrontierTag =
  | "workhorse"
  | "planner"
  | "frontier"
  | "cheap-subagent"
  | "fast";

/**
 * How `avgCostUsd` was obtained. Estimates / API blends must not share a
 * score-per-dollar ranking axis with leaderboard-measured $/task figures.
 */
export type FrontierCostKind =
  | "measured" // published cost-per-task from the benchmark source
  | "apiBlend" // derived from list prices × tokens (not a measured task bill)
  | "estimated" // illustrative / relative / unofficial
  | "unavailable";

export interface FrontierProvenance {
  /** Canonical public URL for the board (leaderboard or methodology page). */
  url: string;
  /** ISO date (YYYY-MM-DD) when this snapshot was captured from the source. */
  capturedAt: string;
  /** Benchmark / index version string when the source publishes one. */
  version?: string;
  /** Short reuse / citation terms (e.g. Cybench citation request). */
  license?: string;
  /** Optional preferred citation string. */
  citation?: string;
}

export interface FrontierCostParts {
  /** USD attributed to answer / completion tokens per task. */
  answer: number;
  /** USD attributed to reasoning / thinking tokens per task. */
  reasoning: number;
  /** USD attributed to cache-write tokens per task. */
  cacheWrite: number;
  /** USD attributed to cache-hit tokens per task. */
  cacheHit: number;
  /** USD attributed to non-cache input tokens per task. */
  input: number;
}

export type FrontierCostPartKey = keyof FrontierCostParts;

export const FRONTIER_COST_PART_KEYS: FrontierCostPartKey[] = [
  "answer",
  "reasoning",
  "cacheWrite",
  "cacheHit",
  "input",
];

export interface FrontierRow {
  id: string;
  model: string;
  family: FrontierFamily;
  /** Reasoning effort, or harness id when the board reports harness instead of effort. */
  effort?: string;
  /** Board-specific score (pass@1 %, index points, …). */
  score: number;
  scoreCi?: number;
  /**
   * Display cost figure (USD). Interpretation is `costKind` — only `measured`
   * may participate in score/$ rankings.
   */
  avgCostUsd: number;
  costKind: FrontierCostKind;
  /** Optional AA-style cost-per-task breakdown (sums ≈ avgCostUsd). */
  costParts?: FrontierCostParts;
  outTokens?: number;
  steps?: number;
  tags: FrontierTag[];
}

export interface FrontierAxes {
  xKey: "avgCostUsd";
  yKey: "score";
  xLabel: string;
  yLabel: string;
  xUnit?: string;
  yUnit?: string;
}

/** Whether `row.effort` stores reasoning effort or agent harness id. */
export type FrontierModeKind = "effort" | "harness";

export interface FrontierBenchmark {
  id: string;
  title: string;
  /** Short human blurb; prefer `provenance` for URL / date / license. */
  sourceNote: string;
  /** @deprecated Prefer provenance.capturedAt — kept for older UI copy. */
  updated: string;
  provenance: FrontierProvenance;
  /**
   * How to label `row.effort` in filters / ranking.
   * Defaults to `effort` when omitted.
   */
  modeKind?: FrontierModeKind;
  taskCount?: number;
  axes: FrontierAxes;
  rows: FrontierRow[];
}

export function benchmarkModeKind(benchmark: FrontierBenchmark): FrontierModeKind {
  return benchmark.modeKind === "harness" ? "harness" : "effort";
}

export interface FrontierCatalog {
  version: number;
  benchmarks: FrontierBenchmark[];
}

export type PriceBand = "lt3" | "mid" | "gt8";

export function priceBandFor(cost: number): PriceBand {
  if (cost < 3) return "lt3";
  if (cost <= 8) return "mid";
  return "gt8";
}

export function rowCostIsMeasured(row: FrontierRow): boolean {
  return row.costKind === "measured";
}

/** True when every row has a source-measured $/task (safe for score/$ charts). */
export function benchmarkHasUniformMeasuredCost(benchmark: FrontierBenchmark): boolean {
  return benchmark.rows.length > 0 && benchmark.rows.every(rowCostIsMeasured);
}

export function efficiencyRatio(score: number, cost: number): number {
  if (cost <= 0) return 0;
  return score / cost;
}

export function sumCostParts(parts: FrontierCostParts): number {
  return parts.answer + parts.reasoning + parts.cacheWrite + parts.cacheHit + parts.input;
}

export function rowHasCostParts(row: FrontierRow): boolean {
  return row.costParts != null;
}

export function benchmarkHasCostParts(benchmark: FrontierBenchmark): boolean {
  return benchmark.rows.some(rowHasCostParts);
}

/** True when at least one model has multiple effort rows (FrontierCode-style boards). */
export function benchmarkHasMultiEffort(benchmark: FrontierBenchmark): boolean {
  const counts = new Map<string, number>();
  for (const row of benchmark.rows) {
    counts.set(row.model, (counts.get(row.model) ?? 0) + 1);
  }
  return [...counts.values()].some(n => n > 1);
}

export type FrontierEffortView = "best" | "all";

/** Keep the highest-scoring row per model (Cognition “Best reasoning mode”). */
export function selectBestEffortRows(rows: FrontierRow[]): FrontierRow[] {
  const best = new Map<string, FrontierRow>();
  for (const row of rows) {
    const prev = best.get(row.model);
    if (!prev || row.score > prev.score || (row.score === prev.score && row.avgCostUsd < prev.avgCostUsd)) {
      best.set(row.model, row);
    }
  }
  return [...best.values()];
}

/**
 * Rank by score/$ only for measured costs; otherwise rank by score alone
 * (never award “best value” across estimate/measurement mixes).
 */
export function rankFrontierRows(
  rows: FrontierRow[],
  opts: { preferValue: boolean },
): FrontierRow[] {
  const useValue = opts.preferValue && rows.length > 0 && rows.every(rowCostIsMeasured);
  return [...rows].toSorted((a, b) => {
    if (useValue) {
      const eff = efficiencyRatio(b.score, b.avgCostUsd) - efficiencyRatio(a.score, a.avgCostUsd);
      if (Math.abs(eff) > 1e-9) return eff;
    }
    return b.score - a.score;
  });
}

const EFFORT_SORT_RANK: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

export function sortEffortLabels(efforts: string[]): string[] {
  return [...efforts].toSorted((a, b) => {
    const ra = EFFORT_SORT_RANK[a] ?? 50;
    const rb = EFFORT_SORT_RANK[b] ?? 50;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}
