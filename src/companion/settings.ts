import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import {
  TIMELINE_HOURS,
  isTimelineModelId,
  normalizeTimelineModelId,
  type TimelineAggregation,
  type TimelineGrouping,
  type TimelineMetric,
} from "../usage/timeline";

export interface CompanionSettings {
  menuBarMetric: "requests" | "tokens" | "cost" | "quota" | "none";
  menuBarTemplate: string | null;
  showToday: boolean;
  showChart: boolean;
  showModels: boolean;
  showCost: boolean;
  showAccounts: boolean;
  chartHours: typeof TIMELINE_HOURS[number];
  bucketMinutes: number;
  chartStyle: "line" | "stackedBar";
  tokenMetric: TimelineMetric;
  aggregation: TimelineAggregation;
  chartGrouping: TimelineGrouping;
  models: string[] | null;
  hiddenProviders: string[];
}

export const DEFAULT_COMPANION_SETTINGS: CompanionSettings = {
  menuBarMetric: "tokens",
  menuBarTemplate: null,
  showToday: true,
  showChart: true,
  showModels: true,
  showCost: true,
  showAccounts: true,
  chartHours: 24,
  bucketMinutes: 60,
  chartStyle: "line",
  tokenMetric: "total",
  aggregation: "sum",
  chartGrouping: "model",
  models: null,
  hiddenProviders: [],
};

const TEMPLATE_FIELDS = new Set(["requests", "totalTokens", "inputTokens", "outputTokens", "costUsd", "quotaPercent"]);
const MENU_BAR_METRICS = new Set(["requests", "tokens", "cost", "quota", "none"]);
const CHART_STYLES = new Set(["line", "stackedBar"]);
const TIMELINE_METRICS = new Set(["total", "input", "output", "cached"]);
const AGGREGATIONS = new Set(["sum", "average", "max"]);
const GROUPINGS = new Set(["model", "modelAccount"]);
const SETTINGS_KEYS = Object.keys(DEFAULT_COMPANION_SETTINGS) as (keyof CompanionSettings)[];

export function companionSettingsPath(): string {
  return join(getConfigDir(), "companion.json");
}

function invalid(message: string): { error: string } {
  return { error: message };
}

function validModels(value: unknown, key: string): value is string[] | null {
  return value === null
    || (Array.isArray(value)
      && value.length <= 100
      && value.every(isTimelineModelId));
}

function validateValue(key: keyof CompanionSettings, value: unknown): string | null {
  if (key === "menuBarMetric") return typeof value === "string" && MENU_BAR_METRICS.has(value) ? null : "menuBarMetric is invalid";
  if (key === "menuBarTemplate") {
    if (value === null) return null;
    if (typeof value !== "string" || value.length > 200) return "menuBarTemplate must be null or at most 200 characters";
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) {
      if (!TEMPLATE_FIELDS.has(match[1]!)) return `menuBarTemplate contains unknown placeholder: ${match[1]}`;
    }
    return null;
  }
  if (["showToday", "showChart", "showModels", "showCost", "showAccounts"].includes(key)) {
    return typeof value === "boolean" ? null : `${key} must be a boolean`;
  }
  if (key === "chartHours") return TIMELINE_HOURS.includes(value as typeof TIMELINE_HOURS[number]) ? null : "chartHours is invalid";
  if (key === "bucketMinutes") return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1440 ? null : "bucketMinutes must be an integer from 1 through 1440";
  if (key === "chartStyle") return typeof value === "string" && CHART_STYLES.has(value) ? null : "chartStyle is invalid";
  if (key === "tokenMetric") return typeof value === "string" && TIMELINE_METRICS.has(value) ? null : "tokenMetric is invalid";
  if (key === "aggregation") return typeof value === "string" && AGGREGATIONS.has(value) ? null : "aggregation is invalid";
  if (key === "chartGrouping") return typeof value === "string" && GROUPINGS.has(value) ? null : "chartGrouping is invalid";
  if (key === "models") return validModels(value, key) ? null : "models must be null or at most 100 provider/model identifiers";
  if (key === "hiddenProviders") return Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === "string" && item.length > 0 && !/\s/.test(item))
    ? null : "hiddenProviders must contain at most 100 provider names";
  return `${key} is unsupported`;
}

export function applyCompanionSettingsPatch(
  current: CompanionSettings,
  patch: unknown,
): CompanionSettings | { error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return invalid("settings must be an object");
  const values = patch as Record<string, unknown>;
  for (const key of Object.keys(values)) {
    if (!SETTINGS_KEYS.includes(key as keyof CompanionSettings)) return invalid(`unknown settings key: ${key}`);
    const error = validateValue(key as keyof CompanionSettings, values[key]);
    if (error) return invalid(error);
  }
  const next = { ...current, ...values } as CompanionSettings;
  // Every companion re-filters timeline rows against these ids, so a selection saved while the chart
  // still split pool accounts has to name the merged row the timeline now returns.
  if (next.models !== null) next.models = [...new Set(next.models.map(normalizeTimelineModelId))];
  return next;
}

export function loadCompanionSettings(): { settings: CompanionSettings; updatedAt: number | null; corrupt?: true } {
  const path = companionSettingsPath();
  if (!existsSync(path)) return { settings: { ...DEFAULT_COMPANION_SETTINGS }, updatedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const settings = applyCompanionSettingsPatch(DEFAULT_COMPANION_SETTINGS, parsed);
    if ("error" in settings) return { settings: { ...DEFAULT_COMPANION_SETTINGS }, updatedAt: null, corrupt: true };
    return { settings, updatedAt: statSync(path).mtimeMs };
  } catch {
    return { settings: { ...DEFAULT_COMPANION_SETTINGS }, updatedAt: null, corrupt: true };
  }
}

export function saveCompanionSettings(settings: CompanionSettings): void {
  const path = companionSettingsPath();
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
