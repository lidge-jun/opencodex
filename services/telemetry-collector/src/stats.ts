import { TELEMETRY_SCHEMA_VERSION } from "../../../src/telemetry/contract";
import type { CollectorEnv, TelemetryStatsRange, TelemetryStatsV1 } from "./types";

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 365;

const RANGE_TO_DAYS: Readonly<Record<TelemetryStatsRange, number>> = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
});

export function utcMidnightMs(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function formatUtcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function parseStatsRange(raw: string | null): TelemetryStatsRange | null {
  if (raw === null || raw === "") return "30d";
  if (raw === "7d" || raw === "30d" || raw === "90d" || raw === "365d") {
    return raw;
  }
  return null;
}

interface DailyTotalsRow {
  day: string;
  reports: number;
  new_installs: number;
  active_minutes: number;
  completed: number;
  failed: number;
  incomplete: number;
  aborted: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  reasoning: number;
}

interface DailyProviderRow {
  day: string;
  provider_kind: string;
  requests: number;
  tokens: number;
}

interface ProviderRow {
  provider_kind: string;
  requests: number;
  tokens: number;
}

interface ModelRow {
  model_family: string;
  requests: number;
  tokens: number;
}

interface VersionRow {
  version: string;
  installs: number;
  new_installs: number;
}

interface PlatformRow {
  os: string;
  arch: string;
  installs: number;
}

interface ChannelRow {
  install_channel: string;
  installs: number;
  new_installs: number;
}

interface ErrorRow {
  cause: string;
  count: number;
}

export async function buildStatsSnapshot(
  env: CollectorEnv,
  range: TelemetryStatsRange,
  now: number = Date.now(),
): Promise<TelemetryStatsV1> {
  const todayMs = utcMidnightMs(now);
  const rangeDays = RANGE_TO_DAYS[range];
  const rangeStartDay = formatUtcDay(todayMs - (rangeDays - 1) * DAY_MS);
  const rangeEndDay = formatUtcDay(todayMs + DAY_MS);
  const heatmapStartDay = formatUtcDay(todayMs - (HEATMAP_DAYS - 1) * DAY_MS);

  const [
    dailyTotalsRes,
    dailyByProviderRes,
    heatmapRes,
    providersRes,
    modelsRes,
    versionsRes,
    platformsRes,
    channelsRes,
    errorsRes,
  ] = await Promise.all([
    env.DB
      .prepare(
        "SELECT day, reports, new_installs, active_minutes, completed, failed, incomplete, aborted, " +
        "input, cache_read, cache_write, output, reasoning " +
        "FROM daily_totals WHERE day >= ?1 AND day <= ?2 ORDER BY day ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<DailyTotalsRow>(),
    env.DB
      .prepare(
        "SELECT day, provider_kind, SUM(requests) AS requests, " +
        "SUM(input + cache_read + cache_write + output + reasoning) AS tokens " +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY day, provider_kind ORDER BY day ASC, tokens DESC, requests DESC, provider_kind ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<DailyProviderRow>(),
    env.DB
      .prepare(
        "SELECT day, reports FROM daily_totals WHERE day >= ?1 AND day <= ?2 ORDER BY day ASC",
      )
      .bind(heatmapStartDay, rangeEndDay)
      .all<{ day: string; reports: number }>(),
    env.DB
      .prepare(
        "SELECT provider_kind, SUM(requests) AS requests, " +
        "SUM(input + cache_read + cache_write + output + reasoning) AS tokens " +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY provider_kind ORDER BY tokens DESC, requests DESC, provider_kind ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<ProviderRow>(),
    env.DB
      .prepare(
        "SELECT model_family, SUM(requests) AS requests, " +
        "SUM(input + cache_read + cache_write + output + reasoning) AS tokens " +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY model_family ORDER BY tokens DESC, requests DESC, model_family ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<ModelRow>(),
    env.DB
      .prepare(
        "SELECT version, COUNT(*) AS installs, COALESCE(SUM(new_install), 0) AS new_installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY version ORDER BY installs DESC, version DESC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<VersionRow>(),
    env.DB
      .prepare(
        "SELECT os, arch, COUNT(*) AS installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY os, arch ORDER BY installs DESC, os ASC, arch ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<PlatformRow>(),
    env.DB
      .prepare(
        "SELECT install_channel, COUNT(*) AS installs, COALESCE(SUM(new_install), 0) AS new_installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY install_channel ORDER BY installs DESC, install_channel ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<ChannelRow>(),
    env.DB
      .prepare(
        "SELECT cause, SUM(count) AS count " +
        "FROM daily_errors WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY cause ORDER BY count DESC, cause ASC",
      )
      .bind(rangeStartDay, rangeEndDay)
      .all<ErrorRow>(),
  ]);

  let activeInstalls = 0;
  let newInstalls = 0;
  let activeMinutes = 0;
  let completed = 0;
  let failed = 0;
  let incomplete = 0;
  let aborted = 0;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let reasoning = 0;

  const daily: TelemetryStatsV1["daily"] = [];
  for (const row of dailyTotalsRes.results ?? []) {
    const rowReports = Number(row.reports);
    const rowNewInstalls = Number(row.new_installs);
    const rowActiveMinutes = Number(row.active_minutes);
    const rowCompleted = Number(row.completed);
    const rowFailed = Number(row.failed);
    const rowIncomplete = Number(row.incomplete);
    const rowAborted = Number(row.aborted);
    const rowInput = Number(row.input);
    const rowCacheRead = Number(row.cache_read);
    const rowCacheWrite = Number(row.cache_write);
    const rowOutput = Number(row.output);
    const rowReasoning = Number(row.reasoning);
    const rowRequests = rowCompleted + rowFailed + rowIncomplete + rowAborted;
    const rowTokens = rowInput + rowCacheRead + rowCacheWrite + rowOutput + rowReasoning;

    activeInstalls += rowReports;
    newInstalls += rowNewInstalls;
    activeMinutes += rowActiveMinutes;
    completed += rowCompleted;
    failed += rowFailed;
    incomplete += rowIncomplete;
    aborted += rowAborted;
    input += rowInput;
    cacheRead += rowCacheRead;
    cacheWrite += rowCacheWrite;
    output += rowOutput;
    reasoning += rowReasoning;

    daily.push({
      day: row.day,
      activeInstalls: rowReports,
      newInstalls: rowNewInstalls,
      activeMinutes: rowActiveMinutes,
      requests: rowRequests,
      failed: rowFailed,
      tokens: rowTokens,
    });
  }

  const heatmapByDay = new Map<string, number>();
  for (const row of heatmapRes.results ?? []) {
    heatmapByDay.set(row.day, Number(row.reports));
  }
  const heatmap: TelemetryStatsV1["heatmap"] = [];
  for (let offset = HEATMAP_DAYS - 1; offset >= 0; offset--) {
    const day = formatUtcDay(todayMs - offset * DAY_MS);
    heatmap.push({
      day,
      activeInstalls: heatmapByDay.get(day) ?? 0,
    });
  }

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    range,
    totals: {
      activeInstalls,
      newInstalls,
      activeMinutes,
      requests: completed + failed + incomplete + aborted,
      tokens: {
        input,
        cacheRead,
        cacheWrite,
        output,
        reasoning,
      },
    },
    daily,
    dailyByProvider: (dailyByProviderRes.results ?? []).map(row => ({
      day: row.day,
      providerKind: row.provider_kind,
      requests: Number(row.requests),
      tokens: Number(row.tokens),
    })),
    heatmap,
    providers: (providersRes.results ?? []).map(row => ({
      providerKind: row.provider_kind,
      requests: Number(row.requests),
      tokens: Number(row.tokens),
    })),
    models: (modelsRes.results ?? []).map(row => ({
      modelFamily: row.model_family,
      requests: Number(row.requests),
      tokens: Number(row.tokens),
    })),
    versions: (versionsRes.results ?? []).map(row => ({
      version: row.version,
      installs: Number(row.installs),
      newInstalls: Number(row.new_installs),
    })),
    platforms: (platformsRes.results ?? []).map(row => ({
      os: row.os,
      arch: row.arch,
      installs: Number(row.installs),
    })),
    channels: (channelsRes.results ?? []).map(row => ({
      installChannel: row.install_channel,
      installs: Number(row.installs),
      newInstalls: Number(row.new_installs),
    })),
    outcomes: {
      completed,
      failed,
      incomplete,
      aborted,
    },
    errors: (errorsRes.results ?? []).map(row => ({
      cause: row.cause,
      count: Number(row.count),
    })),
  };
}

export async function handleStats(
  request: Request,
  env: CollectorEnv,
  now: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const range = parseStatsRange(url.searchParams.get("range"));
  if (!range) {
    return new Response(
      JSON.stringify({ ok: false, error: "range must be one of 7d, 30d, 90d, 365d" }),
      {
        status: 400,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }
  const stats = await buildStatsSnapshot(env, range, now);
  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
