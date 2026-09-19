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

export interface CompanionSettingsResponse {
  settings: CompanionSettings;
  updatedAt: number | null;
  defaults: CompanionSettings;
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
