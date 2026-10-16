/** Saved companion display filters applied to two bounded management reads. */
import { ObservationError, withObserveStream, type ObserveStreamDeps } from "./observe-stream";
import { printData, rejectArgs, runCliAction, takeFlag } from "./runtime-api";

const USAGE = "Usage: ocx companion usage [--json]";
const TOTAL_FIELDS = ["requests", "totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "estimatedCostUsd", "measuredRequests", "pricedRequests", "coverageRatio"] as const;
type Totals = Partial<Record<typeof TOTAL_FIELDS[number], number>>;
type Model = Totals & { model: string; provider: string };
interface Usage {
  summary: Totals;
  models: Model[];
  customWindow?: boolean;
  since?: number | null;
  until?: number;
  usageIncomplete?: boolean;
  historyTruncated?: boolean;
  entriesTruncated?: boolean;
}
interface Filters { models: string[] | null; hiddenProviders: string[] }
interface Settings { filters: Filters; updatedAt: number | null; corrupt: boolean }
type RangeResult = { status: "available"; data: Usage } | { status: "unavailable" };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObservationError("Invalid companion response. Check the runtime and retry the command.");
  return value as Record<string, unknown>;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === "string" && item.length > 0 && !/[\x00-\x1f\x7f-\x9f]/.test(item));
}

function parseSettings(value: unknown): Settings {
  const body = object(value), settings = object(body.settings);
  if ((settings.models !== null && !stringList(settings.models)) || !stringList(settings.hiddenProviders)
    || (body.updatedAt !== null && (typeof body.updatedAt !== "number" || !Number.isFinite(body.updatedAt)))
    || (body.corrupt !== undefined && typeof body.corrupt !== "boolean")) {
    throw new ObservationError("Invalid companion settings. Check the runtime and retry the command.");
  }
  return { filters: { models: settings.models, hiddenProviders: settings.hiddenProviders }, updatedAt: body.updatedAt, corrupt: body.corrupt === true };
}

function parseTotals(value: unknown): Totals {
  const row = object(value), totals: Totals = {};
  for (const key of TOTAL_FIELDS) {
    const metric = row[key];
    if (metric === undefined) continue;
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) throw new ObservationError("Invalid companion usage metrics. Check the runtime and retry the command.");
    totals[key] = metric;
  }
  return totals;
}

function parseUsage(value: unknown): Usage {
  const body = object(value);
  if (body.error || !Array.isArray(body.models)) throw new ObservationError("Invalid companion usage report. Check the runtime and retry the command.");
  const usage: Usage = {
    summary: parseTotals(body.summary),
    models: body.models.map(raw => {
      const row = object(raw);
      if (typeof row.model !== "string" || typeof row.provider !== "string") throw new ObservationError("Invalid companion model row. Check the runtime and retry the command.");
      return { ...parseTotals(row), model: row.model, provider: row.provider };
    }),
  };
  for (const key of ["customWindow", "usageIncomplete", "historyTruncated", "entriesTruncated"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") throw new ObservationError("Invalid companion usage metadata. Check the runtime and retry the command.");
    usage[key] = body[key];
  }
  for (const key of ["since", "until"] as const) {
    const timestamp = body[key];
    if (timestamp === undefined) continue;
    if (key === "since" && timestamp === null) { usage.since = null; continue; }
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) throw new ObservationError("Invalid companion usage window. Check the runtime and retry the command.");
    usage[key] = timestamp;
  }
  return usage;
}

/** Keep in conformance with tray-data's display rules without a GUI runtime import. */
function filterUsage(usage: Usage, filters: Filters): Usage {
  const hidden = new Set(filters.hiddenProviders), selected = filters.models === null ? null : new Set(filters.models);
  const models = usage.models.filter(row => !hidden.has(row.provider)
    && (selected === null || selected.has(`${row.provider}/${row.model}`) || selected.has(row.model)));
  if (filters.models === null && filters.hiddenProviders.length === 0) return { ...usage, models };
  if (filters.models?.length !== 0 && usage.models.some(row => !row.provider || !row.model || (row.provider === "other" && row.model === "other"))) {
    return { ...usage, models: models.filter(row => row.provider !== "other" || row.model !== "other"), summary: {}, usageIncomplete: true };
  }
  const summary: Totals = {};
  for (const key of TOTAL_FIELDS) {
    if (key === "coverageRatio") continue;
    if (models.length && models.every(row => row[key] !== undefined)) summary[key] = models.reduce((sum, row) => sum + row[key]!, 0);
  }
  return { ...usage, models, summary };
}

function measuredTotals<T extends Totals>(data: T): T {
  const next = { ...data };
  if ((data.requests ?? 0) > 0 && (data.measuredRequests === 0 || data.coverageRatio === 0)) {
    for (const key of ["totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "cacheReadInputTokens"] as const) delete next[key];
  }
  if ((data.requests ?? 0) > 0 && data.pricedRequests === 0) delete next.estimatedCostUsd;
  return next;
}

function formatRange(label: string, result: RangeResult): string[] {
  if (result.status === "unavailable") return [`${label}: unavailable`];
  const count = (value: number | undefined) => value === undefined ? "unknown" : value.toLocaleString("en-US");
  const cost = (value: number | undefined) => value === undefined ? "unknown" : `~$${value.toFixed(4)}`;
  const data = result.data;
  return [`${label}: ${count(data.summary.requests)} requests; ${count(data.summary.totalTokens)} tokens; cost ${cost(data.summary.estimatedCostUsd)}`,
    ...(data.usageIncomplete || data.historyTruncated || data.entriesTruncated ? ["  Incomplete observation; totals include only attributable measured data."] : []),
    ...data.models.map(row => `  ${row.provider}/${row.model}: ${count(row.requests)} requests; ${count(row.totalTokens)} tokens; cost ${cost(row.estimatedCostUsd)}`)];
}

export async function handleCompanionUsageCommand(argv: string[], deps: ObserveStreamDeps = {}): Promise<number> {
  let outcome = 0;
  const parseExit = await runCliAction(async () => {
    const args = [...argv], wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE, { redactValues: true });
    outcome = await withObserveStream(deps, async stream => {
      const settings = parseSettings(await stream.get("/api/companion/settings", new URLSearchParams()));
      const ranges: Record<"today" | "30d", RangeResult> = { today: { status: "unavailable" }, "30d": { status: "unavailable" } };
      for (const range of ["today", "30d"] as const) {
        try {
          const data = filterUsage(parseUsage(await stream.get("/api/usage", new URLSearchParams({ range }))), settings.filters);
          ranges[range] = { status: "available", data: { ...data, summary: measuredTotals(data.summary), models: data.models.map(measuredTotals) } };
        } catch {
          stream.signal.throwIfAborted();
        }
      }
      stream.signal.throwIfAborted();
      const partial = ranges.today.status === "unavailable" || ranges["30d"].status === "unavailable";
      const result = { schemaVersion: 1, filters: settings.filters, settingsUpdatedAt: settings.updatedAt, settingsCorrupt: settings.corrupt,
        settingsFallback: settings.corrupt || settings.updatedAt === null, ranges, partial };
      const lines = ["Companion usage — saved display filters (sequential observations)",
        `Models: ${settings.filters.models === null ? "all" : settings.filters.models.length === 0 ? "none" : settings.filters.models.join(", ")}`,
        `Hidden providers: ${settings.filters.hiddenProviders.join(", ") || "none"}`,
        ...(settings.corrupt ? ["WARNING: Saved settings are corrupt; the runtime supplied fallback settings."] : []),
        ...formatRange("Today", ranges.today), ...formatRange("30 days", ranges["30d"])];
      printData(result, wantsJson, wantsJson ? undefined : lines);
      if (partial) console.error("Error: Some companion usage ranges are unavailable. Check the runtime and retry the command.");
      return partial ? 1 : 0;
    }, { kind: "snapshot" });
  });
  return parseExit || outcome;
}
