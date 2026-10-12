import { JEV_DECISION_GATES } from "../usage/jev-stats";
import { runCatalogAction } from "./catalog-command-result";
import { CliUsageError, printData, runtimeBaseUrl, runtimeRequest, takeFlag, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

const USAGE = "Usage: ocx combo stats <stored-id> [--range <7d|30d|all>] [--json]";
const SUMMARY_COUNTS = [
  "decisions", "appliedDecisions", "failOpenDecisions", "successfulRequests", "requestsWithModelFallback",
  "modelAttempts", "measuredModelAttempts", "modelInputTokens", "modelOutputTokens", "modelReasoningTokens",
  "modelCacheReadTokens", "modelCacheWriteTokens", "modelTotalTokens", "decisionUsageReported",
  "decisionInputTokens", "decisionOutputTokens", "decisionTotalTokens",
] as const;
const MODEL_COUNTS = [
  "picks", "appliedPicks", "failOpenPicks", "attempts", "measuredAttempts", "inputTokens", "outputTokens",
  "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens",
] as const;
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];

function invalid(): never { throw new Error("Invalid combo statistics response"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return invalid();
  return value;
}
function nullable(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return null;
  const result = number(value);
  return result <= max ? result : invalid();
}
function boolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid();
}
function identity(value: unknown, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
function counts<K extends string>(value: Record<string, unknown>, keys: readonly K[]): Record<K, number> {
  // Every requested key is assigned only after numeric validation. fromEntries
  // loses the literal-key set in its library type, so retain that set here.
  return Object.fromEntries(keys.map(key => [key, number(value[key])])) as Record<K, number>;
}
function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(record) : invalid();
}

/** Rebuild only the real JEV wire contract; never expose unknown server fields. */
function projectStats(value: unknown, id: string, range: string) {
  const dto = record(value);
  if (dto.comboId !== id || dto.range !== range) return invalid();
  const rawSummary = record(dto.summary);
  const summary = {
    ...counts(rawSummary, SUMMARY_COUNTS),
    averageLatencyMs: nullable(rawSummary.averageLatencyMs),
    averageConfidence: nullable(rawSummary.averageConfidence, 1),
    averageChosenProbability: nullable(rawSummary.averageChosenProbability, 1),
  };
  const gates = rows(dto.gates).map(row => {
    if (!(JEV_DECISION_GATES as readonly unknown[]).includes(row.gate)) return invalid();
    return { gate: row.gate as string, decisions: number(row.decisions) };
  });
  const backends = rows(dto.backends).map(row => {
    if (!["typesafe", "systemone", "model", "unknown"].includes(String(row.backend))) return invalid();
    return { backend: row.backend as string, decisions: number(row.decisions), applied: number(row.applied), averageLatencyMs: nullable(row.averageLatencyMs) };
  });
  const models = rows(dto.models).map(row => {
    const overflow = boolean(row.overflow);
    const efforts = rows(row.efforts).map(item => {
      if (item.effort !== null && (typeof item.effort !== "string" || !EFFORTS.includes(item.effort))) return invalid();
      return { effort: item.effort as string | null, picks: number(item.picks) };
    });
    return { provider: identity(row.provider, overflow), model: identity(row.model, overflow), overflow, ...counts(row, MODEL_COUNTS), efforts };
  });
  const incomplete: { usageIncomplete?: boolean; usageIncompleteReason?: "oversized_rows" } = {};
  if (Object.hasOwn(dto, "usageIncomplete")) incomplete.usageIncomplete = boolean(dto.usageIncomplete);
  if (Object.hasOwn(dto, "usageIncompleteReason")) {
    if (dto.usageIncompleteReason !== "oversized_rows" || dto.usageIncomplete !== true) return invalid();
    incomplete.usageIncompleteReason = "oversized_rows";
  }
  if (dto.usageIncomplete === true && incomplete.usageIncompleteReason === undefined) return invalid();
  return {
    range, comboId: id, since: nullable(dto.since),
    ...(Object.hasOwn(dto, "until") ? { until: number(dto.until) } : {}),
    generatedAt: number(dto.generatedAt), summary, gates, backends, models,
    snapshotWindowStart: nullable(dto.snapshotWindowStart), snapshotWindowEnd: nullable(dto.snapshotWindowEnd),
    ...incomplete, historyTruncated: boolean(dto.historyTruncated), truncatedPrefixBytes: number(dto.truncatedPrefixBytes),
    entriesTruncated: boolean(dto.entriesTruncated), entriesDropped: number(dto.entriesDropped),
  };
}

export async function handleComboStatsCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const args = [...argv];
    const id = args.shift();
    const wantsJson = takeFlag(args, "--json");
    const range = takeOptionWithSyntax(args, "--range")?.value ?? "30d";
    // Do not normalize, truncate or resolve a public alias to another stored ID.
    if (!id || id.length > 128 || id.trim() !== id || id.startsWith("--") || /[\u0000-\u001f\u007f]/u.test(id)) {
      throw new CliUsageError("A nonblank exact stored combo ID of at most 128 characters is required", USAGE);
    }
    if (!["7d", "30d", "all"].includes(range)) throw new CliUsageError("--range must be 7d, 30d or all", USAGE);
    if (args.length) throw new CliUsageError("Unexpected combo stats argument(s)", USAGE);
    const pinned = { ...deps, baseUrl: await runtimeBaseUrl(deps) };
    const query = new URLSearchParams({ jev: "1", comboId: id, range });
    const data = projectStats(await runtimeRequest(`/api/usage?${query}`, { redirect: "error" }, pinned), id, range);
    const summary = data.summary;
    const incomplete = data.usageIncomplete || data.historyTruncated || data.entriesTruncated;
    printData(data, wantsJson, [
      `Combo ${id} — JEV observations (${range})`,
      ...(summary.decisions === 0 ? ["No recorded JEV decisions in this window."] : []),
      `Decisions: ${summary.decisions}; applied: ${summary.appliedDecisions}; fail-open: ${summary.failOpenDecisions}`,
      `Successful requests: ${summary.successfulRequests}; requests with model fallback: ${summary.requestsWithModelFallback}`,
      `Model tokens: ${summary.modelTotalTokens}; measured attempts: ${summary.measuredModelAttempts}/${summary.modelAttempts}`,
      `Decision tokens: ${summary.decisionTotalTokens}; decisions reporting usage: ${summary.decisionUsageReported}/${summary.decisions}`,
      `Average decision latency: ${summary.averageLatencyMs === null ? "unavailable" : `${summary.averageLatencyMs} ms`}`,
      `Average confidence: ${summary.averageConfidence ?? "unavailable"}; chosen probability: ${summary.averageChosenProbability ?? "unavailable"}`,
      ...(incomplete ? ["History is incomplete; totals cover only observed records."] : []),
    ]);
    return 0;
  });
}
