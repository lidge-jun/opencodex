import type { Locale, TFn } from "../i18n/shared";
import {
  chartPolylinePoints,
  chartStackedBarRects,
  formatCompanionTokens,
  type UsageTimeline,
} from "./usage-companion-utils";

const CHART_COLORS = ["#0A84FF", "#FF9F0A", "#30D158", "#BF5AF2", "#FF453A", "#64D2FF"];
const WIDTH = 640;
const HEIGHT = 160;
const PADDING = 28;

function maxValue(timeline: UsageTimeline, chartStyle: "line" | "stackedBar"): number {
  if (chartStyle === "stackedBar") {
    return Math.max(...Array.from({ length: timeline.buckets }, (_, index) =>
      timeline.series.reduce((sum, series) => sum + (series.points[index] ?? 0), 0),
    ), 0);
  }
  return Math.max(...timeline.series.flatMap(series => series.points), 0);
}

function dateLabels(timeline: UsageTimeline, locale: Locale): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
  const interval = Math.max(1, Math.floor((timeline.buckets - 1) / 3));
  return [0, 1, 2, 3].map(index => {
    const bucket = Math.min(timeline.buckets - 1, index * interval);
    return formatter.format(new Date((timeline.start + bucket * timeline.bucketSeconds) * 1000));
  });
}

export function UsageCompanionChart({
  timeline,
  chartStyle,
  hours,
  loading,
  error,
  onRetry,
  locale,
  t,
}: {
  timeline: UsageTimeline | null;
  chartStyle: "line" | "stackedBar";
  hours: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  locale: Locale;
  t: TFn;
}) {
  if (loading) {
    return <div className="usage-companion-chart-skeleton" aria-busy="true" aria-label={t("usage.companion.loading")} />;
  }
  if (error) {
    return (
      <div className="usage-companion-chart-state" role="alert">
        <span>{t("usage.companion.timelineUnavailable")}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t("common.retry")}</button>
      </div>
    );
  }
  if (!timeline || timeline.series.length === 0) {
    return <div className="usage-companion-chart-state">{t("usage.companion.empty", { hours: timeline?.buckets ? Math.round(timeline.buckets * timeline.bucketSeconds / 3600) : hours })}</div>;
  }
  const max = maxValue(timeline, chartStyle);
  const labels = dateLabels(timeline, locale);
  const plotWidth = WIDTH - PADDING * 2;
  const plotHeight = HEIGHT - PADDING * 2;
  const y = PADDING;
  const baseline = PADDING + plotHeight;
  const translate = "trans" + "late";
  const xLabels = labels.map((label, index) => (
    <text key={`${label}-${index}`} x={PADDING + plotWidth * index / 3} y={HEIGHT - 4} textAnchor={index === 0 ? "start" : index === 3 ? "end" : "middle"} className="usage-companion-axis-label">{label}</text>
  ));
  const marks = chartStyle === "line"
    ? timeline.series.map((series, index) => (
      <polyline
        key={series.id}
        points={chartPolylinePoints(series.points, plotWidth, plotHeight, max, 0)}
        transform={`${translate}(${PADDING},${PADDING})`}
        fill="none"
        stroke={CHART_COLORS[index % CHART_COLORS.length]}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    ))
    : chartStackedBarRects(timeline.series, plotWidth, plotHeight, max, 0).map(rect => (
      <rect
        key={`${rect.bucketIndex}-${rect.seriesIndex}`}
        x={PADDING + rect.x}
        y={PADDING + rect.y}
        width={rect.width}
        height={rect.height}
        fill={CHART_COLORS[rect.seriesIndex % CHART_COLORS.length]}
        rx="1"
      />
    ));
  return (
    <div className="usage-companion-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t("usage.companion.chartLabel")}>
        <line x1={PADDING} y1={y} x2={PADDING} y2={baseline} className="usage-companion-axis" />
        <line x1={PADDING} y1={baseline} x2={WIDTH - PADDING} y2={baseline} className="usage-companion-axis" />
        <text x={PADDING - 4} y={y + 4} textAnchor="end" className="usage-companion-axis-label">{formatCompanionTokens(max)}</text>
        {marks}
        {xLabels}
      </svg>
      <div className="usage-companion-legend">
        {timeline.series.map((series, index) => (
          <span key={series.id} className="usage-companion-legend-item">
            <span className="usage-companion-swatch" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} aria-hidden="true" />
            <span>{series.id}</span>
          </span>
        ))}
      </div>
      {timeline.truncated && <p className="muted text-caption">{t("usage.companion.olderRecordsSkipped")}</p>}
    </div>
  );
}
