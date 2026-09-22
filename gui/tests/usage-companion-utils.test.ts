import { describe, expect, test } from "bun:test";
import {
  bucketMinutesForWindow,
  companionTimelineQuery,
  companionTimelineProjection,
  buildCompanionSettingsPatch,
  chartPolylinePoints,
  chartStackedBarRects,
  formatCompanionTokens,
  groupCompanionModels,
  toggleCompanionModels,
  type UsageTimeline,
} from "../src/pages/usage-companion-utils";

describe("usage companion utilities", () => {
  test("timeline queries encode nested models and repeated hidden providers", () => {
    const models = ["provider/vendor/model+name"];
    const hiddenProviders = ["work+private", "hidden"];
    const query = companionTimelineQuery({ chartHours: 24, bucketMinutes: 60, tokenMetric: "total",
      aggregation: "sum", chartGrouping: "model", models, hiddenProviders });
    expect(new URLSearchParams(query.toString()).get("models")).toBe(models[0]);
    expect(new URLSearchParams(query.toString()).getAll("hiddenProvider")).toEqual(hiddenProviders);
  });

  test("filter echoes preserve valid folded rows and old-server uncertainty stays visible", () => {
    const timeline: UsageTimeline = { start: 0, end: 60, bucketSeconds: 60, buckets: 1, metric: "total",
      aggregation: "sum", grouping: "model", availableModels: ["visible/m", "hidden/m"], missingMeasurements: 0, truncated: false,
      series: [
        { id: "visible/m", provider: "visible", model: "m", points: [2], total: 2 },
        { id: "hidden/m", provider: "hidden", model: "m", points: [1], total: 1 },
        { id: "other", provider: "", model: "other", points: [3], total: 3 },
      ] };
    const settings = { models: null, hiddenProviders: ["hidden"] };
    const matched = companionTimelineProjection({ ...timeline, appliedFilters: settings }, settings);
    expect(matched.series.map(row => row.id)).toEqual(["visible/m", "other"]);
    expect(matched.availableModels).toEqual(["visible/m"]);
    expect(matched.truncated).toBe(false);
    for (const appliedFilters of [undefined, { models: null, hiddenProviders: ["different"] }]) {
      const old = companionTimelineProjection({ ...timeline, appliedFilters }, settings);
      expect(old.series.map(row => row.id)).toEqual(["visible/m"]);
      expect(old.truncated).toBe(true);
    }
    const selected = { models: ["visible/m"], hiddenProviders: [] };
    expect(companionTimelineProjection({ ...timeline, appliedFilters: selected }, selected).series.map(row => row.id)).toEqual(["visible/m", "other"]);
    const empty = companionTimelineProjection(timeline, { models: [], hiddenProviders: [] });
    expect(empty.series).toEqual([]);
    expect(empty.availableModels).toEqual(timeline.availableModels);
    expect(empty.truncated).toBe(false);
    expect(companionTimelineProjection(timeline, { models: null, hiddenProviders: [] })).toEqual(timeline);
  });

  test("maps chart windows to bounded buckets", () => {
    expect([6, 24, 72, 168].map(bucketMinutesForWindow)).toEqual([15, 60, 180, 360]);
  });

  test("normalizes empty templates and all-selected models", () => {
    expect(buildCompanionSettingsPatch({
      menuBarTemplate: " ",
      models: ["openai/gpt-5", "anthropic/claude"],
    }, ["openai/gpt-5", "anthropic/claude"])).toEqual({
      menuBarTemplate: null,
      models: null,
    });
    expect(buildCompanionSettingsPatch({ models: ["openai/gpt-5"] }, ["openai/gpt-5", "anthropic/claude"])).toEqual({
      models: ["openai/gpt-5"],
    });
  });

  test("creates line and stacked bar geometry", () => {
    expect(chartPolylinePoints([0, 5, 10], 100, 50, 10)).toBe("8,42 50,25 92,8");
    expect(chartStackedBarRects([
      { points: [5] },
      { points: [5] },
    ], 100, 50, 10)).toEqual([
      { x: 9.5, y: 25, width: 81, height: 17, seriesIndex: 0, bucketIndex: 0 },
      { x: 9.5, y: 8, width: 81, height: 17, seriesIndex: 1, bucketIndex: 0 },
    ]);
  });

  test("formats companion token values as integer SI units", () => {
    expect([999, 1_000, 999_600, 1_634_303, 333_400_000, 12_300_000_000].map(formatCompanionTokens)).toEqual([
      "999", "1K", "1M", "2M", "333M", "12B",
    ]);
  });

  test("groups companion models by descending totals with alphabetical ties", () => {
    expect(groupCompanionModels(
      ["openai/gpt-4", "anthropic/claude", "openai/gpt-5", "local"],
      new Map([
        ["openai/gpt-4", 5],
        ["anthropic/claude", 10],
        ["openai/gpt-5", 5],
      ]),
    )).toEqual([
      { provider: "anthropic", models: [{ id: "anthropic/claude", total: 10 }], total: 10 },
      { provider: "openai", models: [{ id: "openai/gpt-4", total: 5 }, { id: "openai/gpt-5", total: 5 }], total: 10 },
      { provider: "local", models: [{ id: "local", total: 0 }], total: 0 },
    ]);
  });

  test("keeps known totals for models absent from the current timeline", () => {
    expect(groupCompanionModels(
      ["openai/gpt-4", "anthropic/claude"],
      new Map([["openai/gpt-4", 10]]),
    )).toEqual([
      { provider: "openai", models: [{ id: "openai/gpt-4", total: 10 }], total: 10 },
      { provider: "anthropic", models: [{ id: "anthropic/claude", total: 0 }], total: 0 },
    ]);
  });

  test("toggles mixed groups and collapses all-selected state to null", () => {
    const available = ["openai/gpt-4", "openai/gpt-5", "anthropic/claude"];
    expect(toggleCompanionModels(["openai/gpt-4"], available, ["openai/gpt-5"], true)).toEqual(["openai/gpt-4", "openai/gpt-5"]);
    expect(toggleCompanionModels(["openai/gpt-4", "openai/gpt-5"], available, ["anthropic/claude"], true)).toBeNull();
  });
});
