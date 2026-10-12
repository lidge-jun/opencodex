export type TimelineMetric = "total" | "input" | "output" | "cached";
export type TimelineAggregation = "sum" | "average" | "max";
export type TimelineGrouping = "model" | "modelAccount";
export type CompanionMenuBarMetric = "requests" | "tokens" | "cost" | "quota" | "none";
export type CompanionChartStyle = "line" | "stackedBar";
export type ChartHours = 6 | 24 | 72 | 168;

export interface CompanionSettings {
  menuBarMetric: CompanionMenuBarMetric;
  menuBarTemplate: string | null;
  showToday: boolean;
  showChart: boolean;
  showModels: boolean;
  showCost: boolean;
  showAccounts: boolean;
  chartHours: ChartHours;
  bucketMinutes: number;
  chartStyle: CompanionChartStyle;
  tokenMetric: TimelineMetric;
  aggregation: TimelineAggregation;
  chartGrouping: TimelineGrouping;
  models: string[] | null;
  hiddenProviders: string[];
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
  appliedFilters?: { models: string[] | null; hiddenProviders: string[] };
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

type TimelineSettings = Pick<CompanionSettings, 'chartHours' | 'bucketMinutes' | 'tokenMetric' | 'aggregation' | 'chartGrouping' | 'models' | 'hiddenProviders'>;
export function companionTimelineQuery(settings: TimelineSettings): URLSearchParams {
  const query = new URLSearchParams({ hours: String(settings.chartHours), bucketMinutes: String(settings.bucketMinutes),
    metric: settings.tokenMetric, aggregation: settings.aggregation, grouping: settings.chartGrouping });
  if (settings.models?.length) query.set('models', settings.models.join(','));
  for (const provider of settings.hiddenProviders) query.append('hiddenProvider', provider);
  return query;
}

function canonicalFilter(value: unknown): string | undefined {
  return Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === 'string')
    ? JSON.stringify([...new Set(value)].sort()) : undefined;
}

/** Older servers cannot attest that hidden traffic was removed before their series fold. */
export function companionTimelineProjection(data: UsageTimeline, settings: Pick<CompanionSettings, 'models' | 'hiddenProviders'>): UsageTimeline {
  const hidden = new Set(settings.hiddenProviders);
  const availableModels = data.availableModels.filter(id => !hidden.has(id.slice(0, id.indexOf('/'))));
  if (settings.models?.length === 0) return { ...data, series: [], availableModels };
  const models = settings.models === null ? null : new Set(settings.models);
  const active = models !== null || hidden.size > 0;
  const echo = data.appliedFilters;
  const matches = !!echo && canonicalFilter(echo.hiddenProviders) === canonicalFilter(settings.hiddenProviders)
    && (settings.models === null ? echo.models === null : canonicalFilter(echo.models) === canonicalFilter(settings.models));
  const series = data.series.filter(row => {
    if (row.id === 'other' && row.provider === '') return !active || matches;
    return !hidden.has(row.provider) && (models === null || models.has(`${row.provider}/${row.model}`) || models.has(row.model));
  });
  return { ...data, series, availableModels, truncated: data.truncated || ((active || echo !== undefined) && !matches) };
}

export interface CompanionSettingsResponse {
  settings: CompanionSettings;
  updatedAt: number | null;
  defaults: CompanionSettings;
  corrupt?: boolean;
  companion?: {
    lastSeenAt: number | null;
    kind?: "menuBar" | "desktop";
  };
}

export const CHART_BUCKET_MINUTES: Record<ChartHours, number> = {
  6: 15,
  24: 60,
  72: 180,
  168: 360,
};

export function bucketMinutesForWindow(hours: ChartHours): number {
  return CHART_BUCKET_MINUTES[hours];
}

export function formatCompanionTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  const units = [
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ] as const;
  for (let index = 0; index < units.length; index += 1) {
    const [threshold, suffix] = units[index]!;
    if (value >= threshold) {
      const rounded = Math.round(value / threshold);
      if (rounded >= 1000 && index > 0) {
        const [largerThreshold, largerSuffix] = units[index - 1]!;
        return `${Math.round(value / largerThreshold)}${largerSuffix}`;
      }
      return `${rounded}${suffix}`;
    }
  }
  return String(Math.round(value));
}

export interface CompanionModelGroup {
  provider: string;
  models: { id: string; total: number }[];
  total: number;
}

export function groupCompanionModels(
  available: string[],
  totals: Map<string, number>,
): CompanionModelGroup[] {
  const groups = new Map<string, CompanionModelGroup>();
  for (const id of available) {
    const provider = id.includes("/") ? id.slice(0, id.indexOf("/")) : id;
    const group = groups.get(provider) ?? { provider, models: [], total: 0 };
    const total = totals.get(id) ?? 0;
    group.models.push({ id, total });
    group.total += total;
    groups.set(provider, group);
  }
  return Array.from(groups.values())
    .map(group => ({
      ...group,
      models: group.models.toSorted((a, b) => b.total - a.total || a.id.localeCompare(b.id)),
    }))
    .toSorted((a, b) => b.total - a.total || a.provider.localeCompare(b.provider));
}

export function toggleCompanionModels(
  selected: string[] | null,
  available: string[],
  ids: string[],
  on: boolean,
): string[] | null {
  const availableSet = new Set(available);
  const next = new Set((selected ?? available).filter(id => availableSet.has(id)));
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  if (available.length > 0 && available.every(id => next.has(id))) return null;
  return available.filter(id => next.has(id));
}

export function buildCompanionSettingsPatch(
  patch: Partial<CompanionSettings>,
  availableModels: readonly string[] = [],
): Partial<CompanionSettings> {
  const next = { ...patch };
  if (typeof next.menuBarTemplate === "string" && next.menuBarTemplate.trim() === "") {
    next.menuBarTemplate = null;
  }
  if (next.models !== undefined && availableModels.length > 0) {
    const selected = next.models ?? [];
    const selectedSet = new Set(selected);
    const allSelected = selected.length === availableModels.length
      && availableModels.every(model => selectedSet.has(model));
    if (allSelected) next.models = null;
  }
  return next;
}

export function chartPolylinePoints(
  points: readonly number[],
  width: number,
  height: number,
  maxValue: number,
  padding = 8,
): string {
  const plotWidth = Math.max(0, width - padding * 2);
  const plotHeight = Math.max(0, height - padding * 2);
  const denominator = Math.max(maxValue, 1);
  const divisor = Math.max(points.length - 1, 1);
  return points.map((value, index) => {
    const x = padding + plotWidth * index / divisor;
    const y = padding + plotHeight * (1 - Math.max(0, value) / denominator);
    return `${x},${y}`;
  }).join(" ");
}

export interface StackedBarRect {
  x: number;
  y: number;
  width: number;
  height: number;
  seriesIndex: number;
  bucketIndex: number;
}

export function chartStackedBarRects(
  series: readonly Pick<TimelineSeries, "points">[],
  width: number,
  height: number,
  maxValue: number,
  padding = 8,
): StackedBarRect[] {
  const buckets = series[0]?.points.length ?? 0;
  if (buckets === 0) return [];
  const plotWidth = Math.max(0, width - padding * 2);
  const plotHeight = Math.max(0, height - padding * 2);
  const denominator = Math.max(maxValue, 1);
  const gap = Math.min(3, plotWidth / Math.max(buckets * 8, 1));
  const barWidth = Math.max(0, plotWidth / buckets - gap);
  const rects: StackedBarRect[] = [];
  for (let bucketIndex = 0; bucketIndex < buckets; bucketIndex += 1) {
    let offset = 0;
    for (let seriesIndex = 0; seriesIndex < series.length; seriesIndex += 1) {
      const value = Math.max(0, series[seriesIndex]?.points[bucketIndex] ?? 0);
      const barHeight = plotHeight * value / denominator;
      if (barHeight > 0) {
        rects.push({
          x: padding + bucketIndex * (plotWidth / buckets) + gap / 2,
          y: padding + plotHeight - offset - barHeight,
          width: barWidth,
          height: barHeight,
          seriesIndex,
          bucketIndex,
        });
      }
      offset += barHeight;
    }
  }
  return rects;
}
