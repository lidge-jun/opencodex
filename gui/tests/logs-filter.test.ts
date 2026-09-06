import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LOG_FILTER_STATE,
  extractLogFilterOptions,
  filterLogs,
  hasActiveLogFilters,
} from "../src/pages/logs-filter";

const NOW = 2_000_000_000_000;
const logs = [
  {
    id: "claude",
    timestamp: NOW - 5 * 60 * 1000,
    model: "combo/reliable",
    resolvedModel: "claude-sonnet-4.6",
    provider: "primary",
    surface: "claude" as const,
    status: 200,
    conversationId: "conv-123",
    displayMetrics: { tokPerSecond: { kind: "value" as const, value: 15 } },
    attempts: [{ provider: "anthropic", model: "claude-sonnet-4.6" }],
  },
  {
    id: "codex",
    timestamp: NOW - 30 * 60 * 1000,
    model: "gpt-5.6-terra",
    provider: "openai",
    status: 500,
    conversationId: "conv-456",
    displayMetrics: { tokPerSecond: { kind: "value" as const, value: 50 } },
  },
  {
    id: "helper",
    timestamp: NOW - 2 * 60 * 60 * 1000,
    model: "gemini-3.8-flash",
    provider: "google",
    status: 204,
    shadowCallRewrittenFrom: "small-helper",
    displayMetrics: { tokPerSecond: { kind: "value" as const, value: 90 } },
  },
];

describe("rich Logs filtering", () => {
  test("the default state is inert", () => {
    expect(hasActiveLogFilters(DEFAULT_LOG_FILTER_STATE)).toBe(false);
    expect(filterLogs(logs, DEFAULT_LOG_FILTER_STATE, NOW)).toEqual(logs);
  });

  test("matches complete requested, resolved, and attempted model identities", () => {
    const attemptOnly = [{
      id: "attempt-only",
      model: "requested-model",
      attempts: [{ model: "fallback-only" }],
    }];
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, model: "claude-sonnet-4.6" }, NOW).map(row => row.id)).toEqual(["claude"]);
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, model: "GPT-5.6-TERRA" }, NOW).map(row => row.id)).toEqual(["codex"]);
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, model: "reliable" }, NOW).map(row => row.id)).toEqual([]);
    expect(filterLogs(attemptOnly, { ...DEFAULT_LOG_FILTER_STATE, model: "fallback-only" }, NOW).map(row => row.id)).toEqual(["attempt-only"]);
  });

  test("does not treat a stale or partial model selection as a substring query", () => {
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, model: "terra" }, NOW)).toEqual([]);
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, model: "gpt-5.6-terra-old" }, NOW)).toEqual([]);
  });

  test("matches the selected provider on the row or any attempt", () => {
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, provider: "OPENAI" }, NOW).map(row => row.id)).toEqual(["codex"]);
    expect(filterLogs(logs, { ...DEFAULT_LOG_FILTER_STATE, provider: "anthropic" }, NOW).map(row => row.id)).toEqual(["claude"]);
  });

  test("composes surface, status, interception, and conversation filters", () => {
    expect(filterLogs(logs, {
      ...DEFAULT_LOG_FILTER_STATE,
      surface: "claude",
      status: "success",
      conversationId: "conv-123",
    }, NOW).map(row => row.id)).toEqual(["claude"]);
    expect(filterLogs(logs, {
      ...DEFAULT_LOG_FILTER_STATE,
      status: "success",
      interceptedOnly: true,
    }, NOW).map(row => row.id)).toEqual(["helper"]);
  });

  test("accepts only finite integer HTTP statuses in status buckets", () => {
    const rows = [
      { id: "success", status: 200 },
      { id: "error", status: 599 },
      { id: "redirect", status: 302 },
      { id: "nan", status: Number.NaN },
      { id: "fractional", status: 200.5 },
      { id: "out-of-range", status: 600 },
    ];
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, status: "success" }, NOW).map(row => row.id)).toEqual(["success"]);
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, status: "errors" }, NOW).map(row => row.id)).toEqual(["error"]);
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, status: "all" }, NOW).map(row => row.id)).toContain("redirect");
  });

  test("uses deterministic time windows and rejects rows without a usable timestamp", () => {
    const rows = [...logs, { id: "missing-time", status: 200 }];
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, timeWindow: "15m" }, NOW).map(row => row.id)).toEqual(["claude"]);
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, timeWindow: "1h" }, NOW).map(row => row.id)).toEqual(["claude", "codex"]);
  });

  test("uses non-overlapping speed boundaries and excludes unavailable metrics", () => {
    const unavailable = { id: "unknown", displayMetrics: { tokPerSecond: { kind: "unavailable" as const } } };
    expect(filterLogs([...logs, unavailable], { ...DEFAULT_LOG_FILTER_STATE, maxTokPerSec: 15 }, NOW).map(row => row.id)).toEqual([]);
    expect(filterLogs([...logs, unavailable], { ...DEFAULT_LOG_FILTER_STATE, minTokPerSec: 15, maxTokPerSec: 50 }, NOW).map(row => row.id)).toEqual(["claude"]);
    expect(filterLogs([...logs, unavailable], { ...DEFAULT_LOG_FILTER_STATE, minTokPerSec: 50 }, NOW).map(row => row.id)).toEqual(["codex", "helper"]);
  });

  test("extracts sorted unique options and ignores malformed attempts", () => {
    const options = extractLogFilterOptions([
      ...logs,
      { model: 42, provider: null, attempts: [null, "bad", { model: "alpha", provider: "zeta" }] },
    ]);
    expect(options.models).toEqual(["alpha", "claude-sonnet-4.6", "combo/reliable", "gemini-3.8-flash", "gpt-5.6-terra"]);
    expect(options.providers).toEqual(["anthropic", "google", "openai", "primary", "zeta"]);
  });

  test("sorts options by stable code-point order instead of the host locale", () => {
    expect(extractLogFilterOptions([
      { model: "zeta", provider: "Zulu" },
      { model: "Alpha", provider: "alpha" },
    ])).toEqual({ models: ["Alpha", "zeta"], providers: ["Zulu", "alpha"] });
  });

  test("normalizes option whitespace and casing without making selections unusable", () => {
    const rows = [
      { id: "lower", model: "  gpt-5  ", provider: "  openai  " },
      { id: "upper", model: "GPT-5", provider: "OpenAI" },
    ];
    const options = extractLogFilterOptions(rows);
    expect(options).toEqual({ models: ["GPT-5"], providers: ["OpenAI"] });
    expect(extractLogFilterOptions([...rows].reverse())).toEqual(options);
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, model: options.models[0] }, NOW).map(row => row.id)).toEqual(["lower", "upper"]);
    expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, provider: options.providers[0] }, NOW).map(row => row.id)).toEqual(["lower", "upper"]);
  });

  test("reports every non-default field as active", () => {
    expect(hasActiveLogFilters({ ...DEFAULT_LOG_FILTER_STATE, provider: "openai" })).toBe(true);
    expect(hasActiveLogFilters({ ...DEFAULT_LOG_FILTER_STATE, status: "errors" })).toBe(true);
    expect(hasActiveLogFilters({ ...DEFAULT_LOG_FILTER_STATE, minTokPerSec: 1 })).toBe(true);
    expect(hasActiveLogFilters({ ...DEFAULT_LOG_FILTER_STATE, conversationId: "  conv  " })).toBe(true);
  });
});

test.each([
  ["15m", 15 * 60_000], ["1h", 60 * 60_000], ["24h", 24 * 60 * 60_000],
] as const)("relative window %s includes its lower boundary and expires it as time advances", (timeWindow, duration) => {
  const rows = [
    { id: "before", timestamp: NOW - duration - 1 },
    { id: "boundary", timestamp: NOW - duration },
    { id: "inside", timestamp: NOW - duration + 1 },
    { id: "invalid", timestamp: Number.NaN },
  ];
  const filters = { ...DEFAULT_LOG_FILTER_STATE, timeWindow };
  expect(filterLogs(rows, filters, NOW).map(row => row.id)).toEqual(["boundary", "inside"]);
  expect(filterLogs(rows, filters, NOW + 1).map(row => row.id)).toEqual(["inside"]);
});

test("speed buckets separate values immediately below and at both boundaries", () => {
  const rows = [14.99, 15, 49.99, 50].map(value => ({
    id: String(value), displayMetrics: { tokPerSecond: { kind: "value" as const, value } },
  }));
  expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, maxTokPerSec: 15 }).map(row => row.id)).toEqual(["14.99"]);
  expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, minTokPerSec: 15, maxTokPerSec: 50 }).map(row => row.id))
    .toEqual(["15", "49.99"]);
  expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, minTokPerSec: 50 }).map(row => row.id)).toEqual(["50"]);
});

test("exact model choices distinguish prefix siblings and compose with a provider on another attempt", () => {
  const rows = [
    { id: "exact", model: "model-a", provider: "openai" },
    { id: "sibling", model: "model-a-plus", provider: "openai" },
    { id: "resolved", model: "requested", resolvedModel: " MODEL-A ", provider: "openai" },
    { id: "attempt", attempts: [{ model: "model-a", provider: "first" }, { model: "other", provider: "openai" }] },
  ];
  expect(filterLogs(rows, { ...DEFAULT_LOG_FILTER_STATE, model: "model-a", provider: "openai" }).map(row => row.id))
    .toEqual(["exact", "resolved", "attempt"]);
});
