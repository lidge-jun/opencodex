/** Model-row display search; server attribution and report totals stay unchanged. */
import { CliUsageError } from "./runtime-api";

export interface UsageModelView {
  query: string;
  matchedModelCount: number;
  returnedModelCount: number;
  limit: 100;
  truncated: boolean;
}

interface SearchableModel {
  model: string;
  provider: string;
  resolvedModel?: string;
  requests: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  [key: string]: unknown;
}

/** Unlike exact attribution flags, an explicit empty search is a valid view. */
export function takeUsageSearchOption(args: string[]): string | undefined {
  const indices = args.flatMap((arg, index) => arg === "--search" || arg.startsWith("--search=") ? [index] : []);
  if (indices.length > 1) throw new CliUsageError("--search was given more than once");
  const index = indices[0];
  if (index === undefined) return undefined;
  const arg = args[index]!;
  if (arg.startsWith("--search=")) {
    args.splice(index, 1);
    return arg.slice("--search=".length);
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new CliUsageError("--search requires a value; use --search= for an empty search");
  args.splice(index, 2);
  return value;
}

export function selectUsageModelView<T extends { models?: unknown }>(report: T, rawQuery: string): Omit<T, "models"> & { models: SearchableModel[]; modelView: UsageModelView } {
  if (!report || !Array.isArray(report.models)) throw new Error("Invalid usage model rows; retry after checking the runtime.");
  const models = report.models.map((raw: unknown): SearchableModel => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid usage model row.");
    const row = raw as Record<string, unknown>;
    if (typeof row.model !== "string" || typeof row.provider !== "string"
      || (row.resolvedModel !== undefined && typeof row.resolvedModel !== "string")
      || ![row.requests, row.totalTokens].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
      || (row.estimatedCostUsd !== undefined && (typeof row.estimatedCostUsd !== "number" || !Number.isFinite(row.estimatedCostUsd)))) {
      throw new Error("Invalid usage model row.");
    }
    return row as SearchableModel;
  });
  const query = rawQuery.trim().toLowerCase();
  const matching = models.toSorted((a, b) => b.totalTokens - a.totalTokens).filter(row => !query
    || row.model.toLowerCase().includes(query) || row.provider.toLowerCase().includes(query)
    || (row.resolvedModel ?? "").toLowerCase().includes(query));
  const selected = matching.slice(0, 100);
  return { ...report, models: selected, modelView: { query, matchedModelCount: matching.length, returnedModelCount: selected.length, limit: 100, truncated: matching.length > selected.length } };
}
