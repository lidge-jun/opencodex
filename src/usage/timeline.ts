import { cacheTokensFromUsage, usageAttributions } from "./summary";
import type { PersistedUsageEntry } from "./log";
import { usageDisplayTotalTokens } from "./totals";

export type TimelineMetric = "total" | "input" | "output" | "cached";
export type TimelineAggregation = "sum" | "average" | "max";
export type TimelineGrouping = "model" | "modelAccount";
export const TIMELINE_HOURS = [6, 24, 72, 168] as const;

export interface TimelineQuery {
  hours: typeof TIMELINE_HOURS[number];
  bucketMinutes: number;
  metric: TimelineMetric;
  aggregation: TimelineAggregation;
  grouping: TimelineGrouping;
  models: string[] | null;
  hiddenProviders: string[];
  now: number;
}

export interface TimelineSeries {
  id: string;
  provider: string;
  model: string;
  accountLogLabel?: string;
  total: number;
  points: number[];
}

export interface UsageTimeline {
  appliedFilters: { models: string[] | null; hiddenProviders: string[] };
  start: number;
  end: number;
  bucketSeconds: number;
  buckets: number;
  metric: TimelineMetric;
  aggregation: TimelineAggregation;
  grouping: TimelineGrouping;
  series: TimelineSeries[];
  availableModels: string[];
  missingMeasurements: number;
  truncated: boolean;
}

const METRICS: readonly TimelineMetric[] = ["total", "input", "output", "cached"];
const AGGREGATIONS: readonly TimelineAggregation[] = ["sum", "average", "max"];
const GROUPINGS: readonly TimelineGrouping[] = ["model", "modelAccount"];

function enumValue<T extends string>(value: string | null, values: readonly T[], fallback: T): T | { error: string } {
  if (value === null || value === "") return fallback;
  return values.includes(value as T) ? value as T : { error: `invalid value for parameter: ${value}` };
}

export function isTimelineModelId(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/\S+$/.test(value);
}

function parseModels(raw: string | null): string[] | null | { error: string } {
  if (raw === null || raw.trim() === "") return null;
  const models = raw.split(",").map(model => model.trim());
  if (models.length > 100) return { error: "models must contain at most 100 identifiers" };
  if (models.some(model => !isTimelineModelId(model))) {
    return { error: "models must contain provider/model identifiers" };
  }
  return [...new Set(models)];
}

export function parseTimelineQuery(params: URLSearchParams, now: number): TimelineQuery | { error: string } {
  const rawHours = params.get("hours") ?? "24";
  const hoursNumber = Number(rawHours);
  if (!TIMELINE_HOURS.includes(hoursNumber as typeof TIMELINE_HOURS[number])) {
    return { error: "hours must be one of 6, 24, 72, 168" };
  }
  const bucketMinutes = Number(params.get("bucketMinutes") ?? "60");
  if (!Number.isInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 1440) {
    return { error: "bucketMinutes must be an integer from 1 through 1440" };
  }
  const buckets = Math.ceil(hoursNumber * 60 / bucketMinutes);
  if (buckets > 2000) return { error: "timeline bucket count must not exceed 2000" };
  const metric = enumValue(params.get("metric"), METRICS, "total");
  if (typeof metric !== "string") return metric;
  const aggregation = enumValue(params.get("aggregation"), AGGREGATIONS, "sum");
  if (typeof aggregation !== "string") return aggregation;
  const grouping = enumValue(params.get("grouping"), GROUPINGS, "model");
  if (typeof grouping !== "string") return grouping;
  const models = parseModels(params.get("models"));
  if (typeof models === "object" && models !== null && "error" in models) return models;
  const hiddenProviders = params.getAll("hiddenProvider");
  if (hiddenProviders.length > 100 || hiddenProviders.some(value => !value || /\s/.test(value))) {
    return { error: "hiddenProvider must contain at most 100 nonblank provider names" };
  }
  if (!Number.isFinite(now)) return { error: "now must be finite" };
  return {
    hours: hoursNumber as TimelineQuery["hours"],
    bucketMinutes,
    metric,
    aggregation,
    grouping,
    models: models as string[] | null,
    hiddenProviders: [...new Set(hiddenProviders)].sort(),
    now,
  };
}

interface SeriesState {
  provider: string;
  model: string;
  accountLogLabel?: string;
  points: number[];
  requests: Map<number, Map<string, number>>;
}

function metricValue(metric: TimelineMetric, attribution: ReturnType<typeof usageAttributions>[number]): number | undefined {
  if (metric === "total") return usageDisplayTotalTokens(attribution.usage, attribution.totalTokens);
  if (metric === "input") return attribution.usage?.inputTokens;
  if (metric === "output") return attribution.usage?.outputTokens;
  return cacheTokensFromUsage(attribution.usage).read;
}

export function createTimelineAccumulator(query: TimelineQuery): { add(entry: PersistedUsageEntry): void; finish(): UsageTimeline } {
  const bucketSeconds = query.bucketMinutes * 60;
  const buckets = Math.ceil(query.hours * 60 / query.bucketMinutes);
  const end = (Math.floor(query.now / 1000 / bucketSeconds) + 1) * bucketSeconds;
  const start = end - buckets * bucketSeconds;
  const startMs = start * 1000;
  const endMs = end * 1000;
  const series = new Map<string, SeriesState>();
  const availableModels = new Set<string>();
  const hiddenProviders = new Set(query.hiddenProviders);
  let missingMeasurements = 0;

  function add(entry: PersistedUsageEntry): void {
    if (entry.timestamp < startMs || entry.timestamp >= endMs) return;
    const bucket = Math.floor((entry.timestamp - startMs) / (bucketSeconds * 1000));
    if (bucket < 0 || bucket >= buckets) return;
    for (const attribution of usageAttributions(entry)) {
      if (hiddenProviders.has(attribution.provider)) continue;
      const modelId = `${attribution.provider}/${attribution.model}`;
      availableModels.add(modelId);
      if (query.models && !query.models.includes(modelId)) continue;
      const id = query.grouping === "model"
        ? modelId
        : `${modelId} · ${attribution.accountLogLabel ?? "unknown"}`;
      let state = series.get(id);
      if (!state) {
        state = {
          provider: attribution.provider,
          model: attribution.model,
          ...(query.grouping === "modelAccount" ? { accountLogLabel: attribution.accountLogLabel ?? "unknown" } : {}),
          points: Array<number>(buckets).fill(0),
          requests: new Map(),
        };
        series.set(id, state);
      }
      const value = metricValue(query.metric, attribution);
      if (value === undefined) {
        missingMeasurements += 1;
        continue;
      }
      if (query.aggregation === "sum") {
        state.points[bucket] = (state.points[bucket] ?? 0) + value;
      } else {
        let requests = state.requests.get(bucket);
        if (!requests) {
          requests = new Map();
          state.requests.set(bucket, requests);
        }
        requests.set(attribution.requestId, (requests.get(attribution.requestId) ?? 0) + value);
      }
    }
  }

  function finish(): UsageTimeline {
    const rows = [...series].map(([id, state]): { row: TimelineSeries; state: SeriesState } => {
      if (query.aggregation !== "sum") {
        for (const [bucket, requests] of state.requests) {
          const values = [...requests.values()];
          state.points[bucket] = query.aggregation === "max"
            ? Math.max(...values)
            : values.reduce((sum, value) => sum + value, 0) / values.length;
        }
      }
      const total = state.points.reduce((sum, value) => sum + value, 0);
      return {
        row: {
          id,
          provider: state.provider,
          model: state.model,
          ...(state.accountLogLabel !== undefined ? { accountLogLabel: state.accountLogLabel } : {}),
          total,
          points: state.points,
        },
        state,
      };
    }).sort((left, right) => right.row.total - left.row.total || left.row.id.localeCompare(right.row.id));
    const kept = (rows.length > 24 ? rows.slice(0, 23) : rows).map(({ row }) => row);
    if (rows.length > 24) {
      const otherPoints = Array<number>(buckets).fill(0);
      const folded = rows.slice(23);
      if (query.aggregation === "sum") {
        for (const { row } of folded) {
          for (let index = 0; index < buckets; index += 1) otherPoints[index] = (otherPoints[index] ?? 0) + (row.points[index] ?? 0);
        }
      } else {
        for (let index = 0; index < buckets; index += 1) {
          const values = folded.flatMap(({ state }) => [...(state.requests.get(index)?.values() ?? [])]);
          if (values.length > 0) {
            otherPoints[index] = query.aggregation === "max"
              ? Math.max(...values)
              : values.reduce((sum, value) => sum + value, 0) / values.length;
          }
        }
      }
      kept.push({ id: "other", provider: "", model: "other", total: otherPoints.reduce((sum, value) => sum + value, 0), points: otherPoints });
    }
    return {
      appliedFilters: {
        models: query.models === null ? null : [...new Set(query.models)].sort(),
        hiddenProviders: [...hiddenProviders].sort(),
      },
      start,
      end,
      bucketSeconds,
      buckets,
      metric: query.metric,
      aggregation: query.aggregation,
      grouping: query.grouping,
      series: kept,
      availableModels: [...availableModels].sort(),
      missingMeasurements,
      truncated: false,
    };
  }

  return { add, finish };
}
