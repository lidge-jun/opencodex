/** Read the existing usage timeline without changing companion settings. */
import { isTimelineModelId, normalizeTimelineModelId, parseTimelineQuery, type TimelineQuery, type TimelineSeries, type UsageTimeline } from "../usage/timeline";
import { runCatalogAction } from "./catalog-command-result";
import { CliUsageError, printData, runtimeRequest, takeFlag, takeOptionWithSyntax, type RuntimeApiDeps } from "./runtime-api";

const USAGE = `Usage: ocx companion timeline [--hours <6|24|72|168>] [--bucket-minutes <1..1440>]
  [--metric <total|input|output|cached>] [--aggregation <sum|average|max>]
  [--grouping <model|modelAccount>] [--model <provider/model>]... [--hide-provider <name>]... [--json]
Providers are excluded with --hide-provider; --provider is not supported.`;

function repeatedOption(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length;) {
    const token = args[index]!;
    if (token === flag) {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new CliUsageError(`${flag} requires a value`, USAGE);
      values.push(next); args.splice(index, 2);
    } else if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      if (!value) throw new CliUsageError(`${flag} requires a value`, USAGE);
      values.push(value); args.splice(index, 1);
    } else index++;
  }
  return values;
}

function timelineInput(argv: string[]): { query: TimelineQuery; params: URLSearchParams; wantsJson: boolean } {
  const args = [...argv], wantsJson = takeFlag(args, "--json"), params = new URLSearchParams();
  for (const [flag, name] of [
    ["--hours", "hours"], ["--bucket-minutes", "bucketMinutes"], ["--metric", "metric"],
    ["--aggregation", "aggregation"], ["--grouping", "grouping"],
  ] as const) {
    const option = takeOptionWithSyntax(args, flag);
    if (option) params.set(name, option.value);
  }
  const models = repeatedOption(args, "--model");
  // Each occurrence is one identifier, not an implicit CSV escape hatch.
  if (models.some(model => !isTimelineModelId(model) || model.includes(","))) {
    throw new CliUsageError("Each --model must be one provider/model identifier", USAGE);
  }
  if (models.length) params.set("models", models.join(","));
  for (const provider of repeatedOption(args, "--hide-provider")) params.append("hiddenProvider", provider);
  if (args.length) throw new CliUsageError("Unsupported timeline arguments; use --hide-provider to exclude providers", USAGE);
  const query = parseTimelineQuery(params, Date.now());
  if ("error" in query) throw new CliUsageError("Invalid timeline options; check window, bucket count, enums and the 100-item filter limits", USAGE);
  return { query, params, wantsJson };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid timeline object");
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid timeline measurement");
  return value;
}
function integer(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Invalid timeline integer");
  return result;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid timeline text");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid timeline list");
  return value.map(text);
}
function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function timelineDto(raw: unknown, query: TimelineQuery): UsageTimeline {
  const value = record(raw), filters = record(value.appliedFilters);
  const models = filters.models === null ? null : strings(filters.models);
  const hiddenProviders = strings(filters.hiddenProviders), expectedModels = query.models === null ? null : [...query.models].sort();
  if ((models === null) !== (expectedModels === null)
    || (models !== null && expectedModels !== null && !sameStrings(models, expectedModels))
    || !sameStrings(hiddenProviders, query.hiddenProviders)) throw new Error("Timeline filters were not acknowledged");
  const start = integer(value.start), end = integer(value.end), buckets = integer(value.buckets), bucketSeconds = integer(value.bucketSeconds);
  const expectedBucketSeconds = query.bucketMinutes * 60;
  const requestedEnd = (Math.floor(query.now / 1000 / expectedBucketSeconds) + 1) * expectedBucketSeconds;
  const observedNow = Math.floor(Date.now() / 1000);
  const currentWindow = end === requestedEnd
    || (observedNow >= requestedEnd && end === requestedEnd + expectedBucketSeconds);
  if (bucketSeconds !== query.bucketMinutes * 60 || buckets !== Math.ceil(query.hours * 60 / query.bucketMinutes)
    || end <= start || end - start !== buckets * bucketSeconds || start % bucketSeconds !== 0 || end % bucketSeconds !== 0
    // Match the requested current bucket, or its immediate successor after an observed rollover.
    || !currentWindow || end > observedNow + bucketSeconds
    || value.metric !== query.metric || value.aggregation !== query.aggregation || value.grouping !== query.grouping
    || typeof value.truncated !== "boolean" || !Array.isArray(value.series) || value.series.length > 24) {
    throw new Error("Invalid timeline bounds or metadata");
  }
  const availableModels = strings(value.availableModels);
  if (availableModels.some(model => !isTimelineModelId(model)) || new Set(availableModels).size !== availableModels.length) {
    throw new Error("Invalid available timeline models");
  }
  const selectedModels = models === null ? null : new Set(models.map(normalizeTimelineModelId));
  const available = new Set(availableModels);
  const series: TimelineSeries[] = value.series.map(rawSeries => {
    const row = record(rawSeries), id = text(row.id), provider = text(row.provider), model = text(row.model);
    const accountLogLabel = row.accountLogLabel === undefined ? undefined : text(row.accountLogLabel);
    const total = number(row.total);
    if (!Array.isArray(row.points) || row.points.length !== buckets) throw new Error("Invalid timeline points");
    const points = row.points.map(number), pointTotal = points.reduce((sum, point) => sum + point, 0);
    if (!Number.isFinite(pointTotal) || Math.abs(total - pointTotal) > 1e-9 * Math.max(1, total, pointTotal)) throw new Error("Invalid timeline total");
    const other = id === "other" && provider === "" && model === "other" && accountLogLabel === undefined;
    if (!other && (!isTimelineModelId(`${provider}/${model}`) || hiddenProviders.includes(provider)
      || !available.has(`${provider}/${model}`) || (selectedModels !== null && !selectedModels.has(`${provider}/${model}`))
      || id !== (query.grouping === "model" ? `${provider}/${model}` : `${provider}/${model} · ${accountLogLabel}`)
      || (query.grouping === "modelAccount" ? accountLogLabel === undefined : accountLogLabel !== undefined))) {
      throw new Error("Invalid timeline series identity");
    }
    return { id, provider, model, ...(accountLogLabel !== undefined ? { accountLogLabel } : {}), total, points };
  });
  if (new Set(series.map(row => row.id)).size !== series.length) throw new Error("Duplicate timeline series");
  return { appliedFilters: { models, hiddenProviders }, start, end, bucketSeconds, buckets,
    metric: query.metric, aggregation: query.aggregation, grouping: query.grouping, series, availableModels,
    missingMeasurements: integer(value.missingMeasurements), truncated: value.truncated };
}

/** argv starts after `companion timeline`; numeric errors propagate through the public companion dispatcher. */
export async function handleCompanionTimelineCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCatalogAction(async () => {
    const { params, query, wantsJson } = timelineInput(argv);
    const result = timelineDto(await runtimeRequest(`/api/usage/timeline${params.size ? `?${params}` : ""}`,
      { method: "GET", redirect: "error" }, deps), query);
    printData(result, wantsJson, [
      `Usage timeline: ${result.metric}, ${result.aggregation}, grouped by ${result.grouping}`,
      `Window: ${new Date(result.start * 1000).toISOString()} to ${new Date(result.end * 1000).toISOString()} (end exclusive)`,
      `Buckets: ${result.buckets} × ${result.bucketSeconds} seconds`,
      `Models: ${result.appliedFilters.models?.join(", ") ?? "all"}; excluded providers: ${result.appliedFilters.hiddenProviders.join(", ") || "none"}`,
      `Missing measurements: ${result.missingMeasurements}; truncated: ${result.truncated}`,
      ...(result.missingMeasurements || result.truncated ? ["Incomplete evidence: plotted zeros do not establish zero usage."] : []),
      ...(result.series.length ? result.series.map(row => `${row.id}: ${row.total} (${row.points.join(", ")})`)
        : ["No matching series in the available timeline. Try a wider --hours window or fewer filters."]),
      `Available models: ${result.availableModels.join(", ") || "none"}`,
    ]);
  });
}
