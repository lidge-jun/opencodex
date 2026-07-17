import type { EChartsOption } from "echarts";
import {
  efficiencyRatio,
  FRONTIER_COST_PART_KEYS,
  type FrontierCostPartKey,
  type FrontierCostParts,
  type FrontierFamily,
  type FrontierRow,
} from "./frontier-types";

export type FrontierChartKind = "scatter" | "costStack" | "score" | "efficiency" | "reasoning";

export interface FrontierThemeColors {
  text: string;
  muted: string;
  border: string;
  surface: string;
  bg: string;
  accent: string;
  green: string;
  amber: string;
  families: Record<FrontierFamily, string>;
}

const FAMILY_FALLBACK: Record<FrontierFamily, string> = {
  openai: "#10a37f",
  anthropic: "#d97757",
  xai: "#7c8cff",
  google: "#4285f4",
  moonshot: "#8b5cf6",
  zhipu: "#0ea5e9",
  cursor: "#f59e0b",
  deepseek: "#4f46e5",
  other: "#94a3b8",
};

/** Stack segment colors for Intelligence Index cost breakdown (AA-style). */
const COST_PART_COLORS: Record<FrontierCostPartKey, string> = {
  answer: "#3b82f6",
  reasoning: "#a855f7",
  cacheWrite: "#f59e0b",
  cacheHit: "#10b981",
  input: "#64748b",
};

const COST_PART_LABELS: Record<FrontierCostPartKey, string> = {
  answer: "Answer",
  reasoning: "Reasoning",
  cacheWrite: "Cache write",
  cacheHit: "Cache hit",
  input: "Input",
};

/** Read OpenCodex design tokens from the document for ECharts theming. */
export function readFrontierThemeColors(root: HTMLElement = document.documentElement): FrontierThemeColors {
  const cs = getComputedStyle(root);
  const pick = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    text: pick("--text", "#0d0d0d"),
    muted: pick("--muted", "#6e6e6e"),
    border: pick("--border", "#e6e6e6"),
    surface: pick("--surface", "#ffffff"),
    bg: pick("--bg", "#ffffff"),
    accent: pick("--accent", "#0d0d0d"),
    green: pick("--green", "#0a7d5c"),
    amber: pick("--amber", "#b45309"),
    families: { ...FAMILY_FALLBACK },
  };
}

export function familyColor(family: FrontierFamily, theme: FrontierThemeColors): string {
  return theme.families[family] ?? theme.families.other;
}

function rowLabel(row: FrontierRow): string {
  return row.effort ? `${row.model} · ${row.effort}` : row.model;
}

function formatScore(row: FrontierRow, yUnit?: string): string {
  if (yUnit === "%") return `${row.score}%${row.scoreCi != null ? ` ±${row.scoreCi}` : ""}`;
  return `${row.score}${yUnit ? ` ${yUnit}` : ""}`;
}

function tooltipHtml(args: {
  row: FrontierRow;
  xLabel: string;
  yLabel: string;
  yUnit?: string;
  locale: string;
}): string {
  const { row, xLabel, yLabel, yUnit, locale } = args;
  const eff = row.avgCostUsd > 0 ? (row.score / row.avgCostUsd).toFixed(1) : "—";
  const effort = row.effort ? ` · ${row.effort}` : "";
  const parts = row.costParts
    ? FRONTIER_COST_PART_KEYS.map(key =>
      `<div>${COST_PART_LABELS[key]}: <b>$${row.costParts![key].toLocaleString(locale, { maximumFractionDigits: 3 })}</b></div>`,
    ).join("")
    : "";
  return [
    `<div style="font-weight:600;margin-bottom:4px">${row.model}${effort}</div>`,
    `<div>${yLabel}: <b>${formatScore(row, yUnit)}</b></div>`,
    `<div>${xLabel}: <b>$${row.avgCostUsd.toLocaleString(locale, { maximumFractionDigits: 2 })}</b></div>`,
    `<div>Score / $: <b>${eff}</b></div>`,
    parts,
    row.tags.length ? `<div style="margin-top:4px;opacity:.75">${row.tags.join(" · ")}</div>` : "",
  ].join("");
}

function baseChrome(theme: FrontierThemeColors): Pick<EChartsOption, "backgroundColor" | "textStyle" | "legend" | "tooltip"> {
  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.text, fontFamily: "inherit" },
    legend: {
      top: 8,
      left: "center",
      icon: "circle",
      itemWidth: 10,
      itemHeight: 10,
      textStyle: { color: theme.muted, fontSize: 12 },
      inactiveColor: theme.border,
    },
    tooltip: {
      trigger: "item",
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: 1,
      textStyle: { color: theme.text, fontSize: 12 },
    },
  };
}

function buildScatterLike(args: {
  rows: FrontierRow[];
  xLabel: string;
  yLabel: string;
  yUnit?: string;
  theme: FrontierThemeColors;
  locale: string;
}): EChartsOption {
  const { rows, xLabel, yLabel, yUnit, theme, locale } = args;
  const byFamily = new Map<FrontierFamily, FrontierRow[]>();
  for (const row of rows) {
    const list = byFamily.get(row.family) ?? [];
    list.push(row);
    byFamily.set(row.family, list);
  }

  const series = [...byFamily.entries()].map(([family, familyRows]) => ({
    name: family,
    type: "scatter" as const,
    symbolSize: 14,
    itemStyle: {
      color: familyColor(family, theme),
      opacity: 0.88,
      borderColor: theme.surface,
      borderWidth: 1.5,
      shadowBlur: 8,
      shadowColor: "rgba(0,0,0,0.12)",
    },
    emphasis: {
      scale: 1.12,
      itemStyle: { opacity: 1, borderWidth: 2 },
    },
    data: familyRows.map(row => ({
      value: [row.avgCostUsd, row.score],
      row,
    })),
  }));

  const costs = rows.map(r => r.avgCostUsd);
  const scores = rows.map(r => r.score);
  const maxCost = costs.length ? Math.max(...costs) : 10;
  const minScore = scores.length ? Math.min(...scores) : 0;
  const maxScore = scores.length ? Math.max(...scores) : 100;
  const scorePad = Math.max(2, (maxScore - minScore) * 0.08);

  return {
    ...baseChrome(theme),
    grid: { left: 56, right: 24, top: 48, bottom: 56, containLabel: false },
    tooltip: {
      ...baseChrome(theme).tooltip,
      formatter: (params: unknown) => {
        const p = params as { data?: { row?: FrontierRow } };
        const row = p.data?.row;
        if (!row) return "";
        return tooltipHtml({ row, xLabel, yLabel, yUnit, locale });
      },
    },
    xAxis: {
      type: "value",
      name: xLabel,
      nameLocation: "middle",
      nameGap: 32,
      nameTextStyle: { color: theme.muted, fontSize: 12 },
      min: 0,
      max: Math.ceil(maxCost * 1.12 * 10) / 10,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.muted, formatter: (v: number) => `$${v}` },
      splitLine: { lineStyle: { color: theme.border, type: "dashed", opacity: 0.65 } },
    },
    yAxis: {
      type: "value",
      name: yLabel,
      nameLocation: "middle",
      nameGap: 40,
      nameTextStyle: { color: theme.muted, fontSize: 12 },
      min: Math.max(0, Math.floor(minScore - scorePad)),
      max: Math.ceil(maxScore + scorePad),
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: {
        color: theme.muted,
        formatter: (v: number) => (yUnit === "%" ? `${v}%` : String(v)),
      },
      splitLine: { lineStyle: { color: theme.border, type: "dashed", opacity: 0.65 } },
    },
    series,
  };
}

function buildHorizontalBars(args: {
  rows: FrontierRow[];
  xLabel: string;
  yLabel: string;
  yUnit?: string;
  theme: FrontierThemeColors;
  locale: string;
  mode: "score" | "efficiency";
}): EChartsOption {
  const { rows, xLabel, yLabel, yUnit, theme, locale, mode } = args;
  const sorted = [...rows].toSorted((a, b) => {
    if (mode === "efficiency") {
      return efficiencyRatio(a.score, a.avgCostUsd) - efficiencyRatio(b.score, b.avgCostUsd);
    }
    return a.score - b.score;
  });

  const labels = sorted.map(rowLabel);
  const values = sorted.map(row =>
    mode === "efficiency" ? efficiencyRatio(row.score, row.avgCostUsd) : row.score,
  );
  const colors = sorted.map(row => familyColor(row.family, theme));

  return {
    ...baseChrome(theme),
    legend: { show: false },
    grid: { left: 8, right: 28, top: 16, bottom: 40, containLabel: true },
    tooltip: {
      ...baseChrome(theme).tooltip,
      formatter: (params: unknown) => {
        const p = params as { dataIndex?: number };
        const row = sorted[p.dataIndex ?? -1];
        if (!row) return "";
        return tooltipHtml({ row, xLabel, yLabel, yUnit, locale });
      },
    },
    xAxis: {
      type: "value",
      name: mode === "efficiency" ? "Score / $" : yLabel,
      nameLocation: "middle",
      nameGap: 28,
      nameTextStyle: { color: theme.muted, fontSize: 12 },
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: {
        color: theme.muted,
        formatter: (v: number) => {
          if (mode === "efficiency") return v.toFixed(v >= 10 ? 0 : 1);
          return yUnit === "%" ? `${v}%` : String(v);
        },
      },
      splitLine: { lineStyle: { color: theme.border, type: "dashed", opacity: 0.65 } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 11, width: 160, overflow: "truncate" },
    },
    series: [
      {
        type: "bar",
        data: values.map((v, i) => ({
          value: v,
          itemStyle: {
            color: colors[i],
            borderRadius: [0, 4, 4, 0],
            opacity: 0.9,
          },
          row: sorted[i],
        })),
        barMaxWidth: 18,
        emphasis: { itemStyle: { opacity: 1 } },
      },
    ],
    animationDuration: 400,
  };
}

/** Stacked cost-per-Intelligence-Index-task bars (Answer / Reasoning / Cache write / Cache hit / Input). */
function buildCostStack(args: {
  rows: FrontierRow[];
  theme: FrontierThemeColors;
  locale: string;
  xLabel: string;
  yLabel: string;
  yUnit?: string;
}): EChartsOption {
  const { rows, theme, locale, xLabel, yLabel, yUnit } = args;
  const withParts = rows.filter((r): r is FrontierRow & { costParts: FrontierCostParts } => r.costParts != null);
  const sorted = [...withParts].toSorted((a, b) => a.avgCostUsd - b.avgCostUsd);
  const labels = sorted.map(rowLabel);

  const series = FRONTIER_COST_PART_KEYS.map((key, idx) => ({
    name: COST_PART_LABELS[key],
    type: "bar" as const,
    stack: "cost",
    barMaxWidth: 18,
    emphasis: { focus: "series" as const },
    itemStyle: {
      color: COST_PART_COLORS[key],
      borderRadius: idx === FRONTIER_COST_PART_KEYS.length - 1 ? [0, 4, 4, 0] : 0,
    },
    data: sorted.map(row => ({
      value: row.costParts[key],
      row,
      part: key,
    })),
  }));

  return {
    ...baseChrome(theme),
    legend: {
      ...baseChrome(theme).legend,
      data: FRONTIER_COST_PART_KEYS.map(k => COST_PART_LABELS[k]),
    },
    grid: { left: 8, right: 28, top: 48, bottom: 40, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "shadow" },
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: 1,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = params as Array<{ dataIndex?: number; seriesName?: string; value?: number; color?: string }>;
        const idx = list[0]?.dataIndex ?? -1;
        const row = sorted[idx];
        if (!row) return "";
        const lines = list
          .filter(p => typeof p.value === "number" && p.value > 0)
          .map(p =>
            `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}: <b>$${Number(p.value).toLocaleString(locale, { maximumFractionDigits: 3 })}</b></div>`,
          );
        return [
          `<div style="font-weight:600;margin-bottom:4px">${rowLabel(row)}</div>`,
          ...lines,
          `<div style="margin-top:4px">Total: <b>$${row.avgCostUsd.toLocaleString(locale, { maximumFractionDigits: 3 })}</b></div>`,
          `<div>${yLabel}: <b>${formatScore(row, yUnit)}</b></div>`,
        ].join("");
      },
    },
    xAxis: {
      type: "value",
      name: xLabel || "Cost per Intelligence Index task (USD)",
      nameLocation: "middle",
      nameGap: 28,
      nameTextStyle: { color: theme.muted, fontSize: 12 },
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.muted, formatter: (v: number) => `$${v}` },
      splitLine: { lineStyle: { color: theme.border, type: "dashed", opacity: 0.65 } },
    },
    yAxis: {
      type: "category",
      data: labels,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { show: false },
      axisLabel: { color: theme.muted, fontSize: 11, width: 160, overflow: "truncate" },
    },
    series,
    animationDuration: 400,
  };
}

const MODEL_LINE_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#0ea5e9", "#3b82f6", "#8b5cf6", "#d946ef", "#f43f5e",
  "#84cc16", "#06b6d4", "#6366f1", "#a855f7", "#fb7185",
  "#64748b",
];

/** Stable line/legend colors keyed by model name (sorted palette order). */
export function frontierModelColorMap(models: string[]): Record<string, string> {
  const sorted = [...new Set(models)].toSorted((a, b) => a.localeCompare(b));
  return Object.fromEntries(
    sorted.map((model, i) => [model, MODEL_LINE_COLORS[i % MODEL_LINE_COLORS.length]!]),
  );
}

/** Cost vs score lines per model; points are reasoning efforts (label at peak score). */
function buildReasoningGraph(args: {
  rows: FrontierRow[];
  xLabel: string;
  yLabel: string;
  yUnit?: string;
  theme: FrontierThemeColors;
  locale: string;
  modelColors?: Record<string, string>;
}): EChartsOption {
  const { rows, xLabel, yLabel, yUnit, theme, locale, modelColors } = args;
  const byModel = new Map<string, FrontierRow[]>();
  for (const row of rows) {
    const list = byModel.get(row.model) ?? [];
    list.push(row);
    byModel.set(row.model, list);
  }
  const fallbackColors = frontierModelColorMap([...byModel.keys()]);
  const colors = modelColors ?? fallbackColors;
  const models = [...byModel.keys()].toSorted((a, b) => {
    const maxA = Math.max(...byModel.get(a)!.map(r => r.score));
    const maxB = Math.max(...byModel.get(b)!.map(r => r.score));
    return maxB - maxA;
  });

  const costs = rows.map(r => r.avgCostUsd);
  const scores = rows.map(r => r.score);
  const maxCost = costs.length ? Math.max(...costs) : 10;
  const minScore = scores.length ? Math.min(...scores) : 0;
  const maxScore = scores.length ? Math.max(...scores) : 100;
  const scorePad = Math.max(2, (maxScore - minScore) * 0.1);

  const series = models.map(model => {
    const entryRows = [...byModel.get(model)!].toSorted((a, b) => a.avgCostUsd - b.avgCostUsd);
    const peakRow = entryRows.reduce((best, row) => {
      if (row.score > best.score) return row;
      if (row.score === best.score && row.avgCostUsd < best.avgCostUsd) return row;
      return best;
    });
    const color = colors[model] ?? fallbackColors[model] ?? MODEL_LINE_COLORS[0]!;
    return {
      name: model,
      type: "line" as const,
      smooth: 0.12,
      symbol: "circle",
      symbolSize: 9,
      showSymbol: true,
      connectNulls: false,
      lineStyle: { width: 2, color, opacity: 0.88 },
      itemStyle: {
        color,
        borderColor: theme.surface,
        borderWidth: 1.5,
      },
      emphasis: {
        focus: "series" as const,
        lineStyle: { width: 3, opacity: 1 },
        itemStyle: { borderWidth: 2 },
      },
      labelLayout: { hideOverlap: true, moveOverlap: "shiftY" as const },
      data: entryRows.map(row => ({
        value: [row.avgCostUsd, row.score],
        row,
        label: {
          show: row.id === peakRow.id,
          position: "top" as const,
          color: theme.text,
          fontSize: 11,
          fontWeight: 600 as const,
          distance: 6,
          formatter: model,
        },
      })),
    };
  });

  return {
    ...baseChrome(theme),
    legend: { show: false },
    grid: { left: 56, right: 72, top: 28, bottom: 56, containLabel: false },
    tooltip: {
      trigger: "item",
      backgroundColor: theme.surface,
      borderColor: theme.border,
      borderWidth: 1,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (params: unknown) => {
        const p = params as {
          seriesName?: string;
          color?: string;
          data?: { row?: FrontierRow };
        };
        const row = p.data?.row;
        if (!row) return "";
        const effort = row.effort ?? "default";
        const scoreText = yUnit === "%" ? `${row.score}%` : String(row.score);
        return [
          `<div style="font-weight:600;margin-bottom:4px">${p.seriesName ?? row.model}</div>`,
          `<div>Reasoning: <b>${effort}</b></div>`,
          `<div>${yLabel}: <b>${scoreText}</b></div>`,
          `<div>${xLabel || "Avg cost"}: <b>$${row.avgCostUsd.toLocaleString(locale, { maximumFractionDigits: 2 })}</b></div>`,
        ].join("");
      },
    },
    xAxis: {
      type: "value",
      name: xLabel || "Avg cost per rollout (USD)",
      nameLocation: "middle",
      nameGap: 32,
      nameTextStyle: { color: theme.muted, fontSize: 12 },
      min: 0,
      max: Math.ceil(maxCost * 1.12 * 10) / 10,
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: { color: theme.muted, formatter: (v: number) => `$${v}` },
      splitLine: { lineStyle: { color: theme.border, type: "dashed", opacity: 0.65 } },
    },
    yAxis: {
      type: "value",
      name: yLabel,
      nameLocation: "middle",
      nameGap: 40,
      nameTextStyle: { color: theme.muted, fontSize: 12 },
      min: Math.max(0, Math.floor(minScore - scorePad)),
      max: Math.ceil(maxScore + scorePad),
      axisLine: { lineStyle: { color: theme.border } },
      axisTick: { lineStyle: { color: theme.border } },
      axisLabel: {
        color: theme.muted,
        formatter: (v: number) => (yUnit === "%" ? `${v}%` : String(v)),
      },
      splitLine: { lineStyle: { color: theme.border, type: "dashed", opacity: 0.65 } },
    },
    series,
    animationDuration: 400,
  };
}

export function buildFrontierChartOption(args: {
  kind: FrontierChartKind;
  rows: FrontierRow[];
  xLabel: string;
  yLabel: string;
  yUnit?: string;
  theme: FrontierThemeColors;
  locale: string;
  modelColors?: Record<string, string>;
}): EChartsOption {
  const { kind, modelColors, ...rest } = args;
  switch (kind) {
    case "scatter":
      return buildScatterLike(rest);
    case "costStack":
      return buildCostStack(rest);
    case "score":
      return buildHorizontalBars({ ...rest, mode: "score" });
    case "efficiency":
      return buildHorizontalBars({ ...rest, mode: "efficiency" });
    case "reasoning":
      return buildReasoningGraph({ ...rest, modelColors });
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return buildScatterLike(rest);
    }
  }
}

/** Preferred canvas height for bar charts (grows with row count). */
export function frontierChartHeight(kind: FrontierChartKind, rowCount: number, _modelCount = rowCount): number {
  if (kind === "reasoning") {
    return 460;
  }
  if (kind === "score" || kind === "efficiency" || kind === "costStack") {
    return Math.max(400, 36 + rowCount * 22);
  }
  return 440;
}

/** @deprecated Prefer buildFrontierChartOption({ kind: "scatter", ... }) */
export function buildFrontierScatterOption(args: {
  rows: FrontierRow[];
  xLabel: string;
  yLabel: string;
  yUnit?: string;
  theme: FrontierThemeColors;
  locale: string;
}): EChartsOption {
  return buildFrontierChartOption({ kind: "scatter", ...args });
}
