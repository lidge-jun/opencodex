import { TELEMETRY_SCHEMA_VERSION } from "../../../src/telemetry/contract";
import type { CollectorEnv, D1Database, TelemetryStatsRange, TelemetryStatsV1 } from "./types";

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 365;
export const STATS_CACHE_TTL_MS = 300_000;
export const MAX_STATS_VERSIONS = 50;
const MAX_SAFE_SQL_INT = Number.MAX_SAFE_INTEGER;

const SQL_CLAMPED_REQUESTS_SUM =
  "MIN(9007199254740991, SUM(MIN(9007199254740991, MAX(0, requests))))";
const SQL_CLAMPED_TOKENS_SUM =
  "MIN(9007199254740991, SUM(MIN(9007199254740991, " +
  "MIN(9007199254740991, MAX(0, input)) + " +
  "MIN(9007199254740991, MAX(0, cache_read)) + " +
  "MIN(9007199254740991, MAX(0, cache_write)) + " +
  "MIN(9007199254740991, MAX(0, output)) + " +
  "MIN(9007199254740991, MAX(0, reasoning)))))";

const RANGE_TO_DAYS: Readonly<Record<TelemetryStatsRange, number>> = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
});

const STATS_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "public, max-age=300",
});

interface CachedStatsEntry {
  cachedAt: number;
  expiresAt: number;
  body: string;
}

interface EdgeCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

let isolateCacheDb: D1Database | null = null;
const isolateStatsCache = new Map<TelemetryStatsRange, CachedStatsEntry>();

export function clearStatsCache(): void {
  isolateCacheDb = null;
  isolateStatsCache.clear();
}

function getEdgeCache(): EdgeCacheLike | null {
  const cacheStorage = (globalThis as unknown as { caches?: { default?: EdgeCacheLike } }).caches;
  const defaultCache = cacheStorage?.default;
  if (
    defaultCache
    && typeof defaultCache.match === "function"
    && typeof defaultCache.put === "function"
  ) {
    return defaultCache;
  }
  return null;
}

function buildCanonicalStatsCacheRequest(requestUrl: URL, range: TelemetryStatsRange): Request {
  const canonical = new URL("/v1/stats", `${requestUrl.protocol}//${requestUrl.host}`);
  canonical.searchParams.set("range", range);
  return new Request(canonical.toString(), { method: "GET" });
}

function clampSafeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= MAX_SAFE_SQL_INT) return MAX_SAFE_SQL_INT;
  return Math.floor(n);
}

function addSafeInt(a: number, b: number): number {
  return clampSafeInt(a + b);
}

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
  const rangeEndDay = formatUtcDay(todayMs);
  const heatmapStartDay = formatUtcDay(todayMs - (HEATMAP_DAYS - 1) * DAY_MS);

  const [
    dailyTotalsRes,
    dailyByProviderRes,
    modelsRes,
    versionsRes,
    platformsRes,
    channelsRes,
    errorsRes,
  ] = await env.DB.batch<Record<string, unknown>>([
    env.DB
      .prepare(
        "SELECT day, reports, new_installs, active_minutes, completed, failed, incomplete, aborted, " +
        "input, cache_read, cache_write, output, reasoning " +
        "FROM daily_totals WHERE day >= ?1 AND day <= ?2 ORDER BY day ASC",
      )
      .bind(heatmapStartDay, rangeEndDay),
    env.DB
      .prepare(
        `SELECT day, provider_kind, ${SQL_CLAMPED_REQUESTS_SUM} AS requests, ` +
        `${SQL_CLAMPED_TOKENS_SUM} AS tokens ` +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY day, provider_kind ORDER BY day ASC, tokens DESC, requests DESC, provider_kind ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        `SELECT model_family, ${SQL_CLAMPED_REQUESTS_SUM} AS requests, ` +
        `${SQL_CLAMPED_TOKENS_SUM} AS tokens ` +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY model_family ORDER BY tokens DESC, requests DESC, model_family ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        "SELECT version, COUNT(*) AS installs, COALESCE(SUM(new_install), 0) AS new_installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        `GROUP BY version ORDER BY installs DESC, version DESC LIMIT ${MAX_STATS_VERSIONS}`,
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        "SELECT os, arch, COUNT(*) AS installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY os, arch ORDER BY installs DESC, os ASC, arch ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        "SELECT install_channel, COUNT(*) AS installs, COALESCE(SUM(new_install), 0) AS new_installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY install_channel ORDER BY installs DESC, install_channel ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        "SELECT cause, MIN(9007199254740991, SUM(MIN(9007199254740991, MAX(0, count)))) AS count " +
        "FROM daily_errors WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY cause ORDER BY count DESC, cause ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
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

  const heatmapByDay = new Map<string, number>();
  const daily: TelemetryStatsV1["daily"] = [];
  for (const rawRow of (dailyTotalsRes?.results ?? []) as unknown as DailyTotalsRow[]) {
    const rowReports = clampSafeInt(rawRow.reports);
    heatmapByDay.set(rawRow.day, rowReports);
    if (rawRow.day < rangeStartDay || rawRow.day > rangeEndDay) {
      continue;
    }
    const rowNewInstalls = clampSafeInt(rawRow.new_installs);
    const rowActiveMinutes = clampSafeInt(rawRow.active_minutes);
    const rowCompleted = clampSafeInt(rawRow.completed);
    const rowFailed = clampSafeInt(rawRow.failed);
    const rowIncomplete = clampSafeInt(rawRow.incomplete);
    const rowAborted = clampSafeInt(rawRow.aborted);
    const rowInput = clampSafeInt(rawRow.input);
    const rowCacheRead = clampSafeInt(rawRow.cache_read);
    const rowCacheWrite = clampSafeInt(rawRow.cache_write);
    const rowOutput = clampSafeInt(rawRow.output);
    const rowReasoning = clampSafeInt(rawRow.reasoning);
    const rowRequests = addSafeInt(
      addSafeInt(rowCompleted, rowFailed),
      addSafeInt(rowIncomplete, rowAborted),
    );
    const rowTokens = addSafeInt(
      addSafeInt(addSafeInt(rowInput, rowCacheRead), addSafeInt(rowCacheWrite, rowOutput)),
      rowReasoning,
    );

    activeInstalls = addSafeInt(activeInstalls, rowReports);
    newInstalls = addSafeInt(newInstalls, rowNewInstalls);
    activeMinutes = addSafeInt(activeMinutes, rowActiveMinutes);
    completed = addSafeInt(completed, rowCompleted);
    failed = addSafeInt(failed, rowFailed);
    incomplete = addSafeInt(incomplete, rowIncomplete);
    aborted = addSafeInt(aborted, rowAborted);
    input = addSafeInt(input, rowInput);
    cacheRead = addSafeInt(cacheRead, rowCacheRead);
    cacheWrite = addSafeInt(cacheWrite, rowCacheWrite);
    output = addSafeInt(output, rowOutput);
    reasoning = addSafeInt(reasoning, rowReasoning);

    daily.push({
      day: rawRow.day,
      activeInstalls: rowReports,
      newInstalls: rowNewInstalls,
      activeMinutes: rowActiveMinutes,
      requests: rowRequests,
      failed: rowFailed,
      tokens: rowTokens,
    });
  }

  const heatmap: TelemetryStatsV1["heatmap"] = [];
  for (let offset = HEATMAP_DAYS - 1; offset >= 0; offset--) {
    const day = formatUtcDay(todayMs - offset * DAY_MS);
    heatmap.push({
      day,
      activeInstalls: heatmapByDay.get(day) ?? 0,
    });
  }

  const dailyByProvider: TelemetryStatsV1["dailyByProvider"] = [];
  const providerTotals = new Map<string, { requests: number; tokens: number }>();
  for (const row of (dailyByProviderRes?.results ?? []) as unknown as DailyProviderRow[]) {
    const requests = clampSafeInt(row.requests);
    const tokens = clampSafeInt(row.tokens);
    dailyByProvider.push({
      day: row.day,
      providerKind: row.provider_kind,
      requests,
      tokens,
    });
    const existing = providerTotals.get(row.provider_kind);
    if (existing) {
      existing.requests = addSafeInt(existing.requests, requests);
      existing.tokens = addSafeInt(existing.tokens, tokens);
    } else {
      providerTotals.set(row.provider_kind, { requests, tokens });
    }
  }

  const providers: TelemetryStatsV1["providers"] = Array.from(
    providerTotals.entries(),
    ([providerKind, agg]) => ({
      providerKind,
      requests: agg.requests,
      tokens: agg.tokens,
    }),
  ).sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.providerKind < b.providerKind ? -1 : a.providerKind > b.providerKind ? 1 : 0;
  });

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    range,
    totals: {
      activeInstalls,
      newInstalls,
      activeMinutes,
      requests: addSafeInt(addSafeInt(completed, failed), addSafeInt(incomplete, aborted)),
      tokens: {
        input,
        cacheRead,
        cacheWrite,
        output,
        reasoning,
      },
    },
    daily,
    dailyByProvider,
    heatmap,
    providers,
    models: ((modelsRes?.results ?? []) as unknown as ModelRow[]).map(row => ({
      modelFamily: row.model_family,
      requests: clampSafeInt(row.requests),
      tokens: clampSafeInt(row.tokens),
    })),
    versions: ((versionsRes?.results ?? []) as unknown as VersionRow[]).map(row => ({
      version: row.version,
      installs: clampSafeInt(row.installs),
      newInstalls: clampSafeInt(row.new_installs),
    })),
    platforms: ((platformsRes?.results ?? []) as unknown as PlatformRow[]).map(row => ({
      os: row.os,
      arch: row.arch,
      installs: clampSafeInt(row.installs),
    })),
    channels: ((channelsRes?.results ?? []) as unknown as ChannelRow[]).map(row => ({
      installChannel: row.install_channel,
      installs: clampSafeInt(row.installs),
      newInstalls: clampSafeInt(row.new_installs),
    })),
    outcomes: {
      completed,
      failed,
      incomplete,
      aborted,
    },
    errors: ((errorsRes?.results ?? []) as unknown as ErrorRow[]).map(row => ({
      cause: row.cause,
      count: clampSafeInt(row.count),
    })),
  };
}

export async function handleStats(
  request: Request,
  env: CollectorEnv,
  now: number = Date.now(),
  options?: { bypassCache?: boolean },
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

  const bypassCache = Boolean(options?.bypassCache);
  if (isolateCacheDb !== env.DB) {
    isolateStatsCache.clear();
    isolateCacheDb = env.DB;
  }

  if (!bypassCache) {
    const memCached = isolateStatsCache.get(range);
    if (memCached) {
      if (now >= memCached.cachedAt && now < memCached.expiresAt) {
        return new Response(memCached.body, {
          status: 200,
          headers: STATS_RESPONSE_HEADERS,
        });
      }
      isolateStatsCache.delete(range);
    }

    const edgeCache = getEdgeCache();
    if (edgeCache) {
      const cacheReq = buildCanonicalStatsCacheRequest(url, range);
      const edgeHit = await edgeCache.match(cacheReq);
      if (edgeHit) {
        const body = await edgeHit.text();
        isolateStatsCache.set(range, {
          cachedAt: now,
          expiresAt: now + STATS_CACHE_TTL_MS,
          body,
        });
        return new Response(body, {
          status: 200,
          headers: STATS_RESPONSE_HEADERS,
        });
      }
    }
  }

  const stats = await buildStatsSnapshot(env, range, now);
  const body = JSON.stringify(stats);

  if (!bypassCache) {
    isolateStatsCache.set(range, {
      cachedAt: now,
      expiresAt: now + STATS_CACHE_TTL_MS,
      body,
    });
    const edgeCache = getEdgeCache();
    if (edgeCache) {
      const cacheReq = buildCanonicalStatsCacheRequest(url, range);
      await edgeCache.put(
        cacheReq,
        new Response(body, {
          status: 200,
          headers: STATS_RESPONSE_HEADERS,
        }),
      );
    }
  }

  return new Response(body, {
    status: 200,
    headers: STATS_RESPONSE_HEADERS,
  });
}
