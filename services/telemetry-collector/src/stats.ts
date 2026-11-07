import { TELEMETRY_SCHEMA_VERSION } from "../../../src/telemetry/contract";
import type { CollectorEnv, D1Database, TelemetryStatsRange, TelemetryStatsV1 } from "./types";

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 365;
export const STATS_CACHE_TTL_MS = 300_000;
export const MAX_STATS_VERSIONS = 50;
export const MIN_COHORT_INSTALL_DAYS = 10;
const MAX_SAFE_SQL_INT = Number.MAX_SAFE_INTEGER;

const SQL_CLAMPED_INSTALLS_SUM =
  "MIN(9007199254740991, SUM(MIN(9007199254740991, MAX(0, installs))))";
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

export function computeAvgDailyActiveInstalls(activeInstalls: number, rangeDays: number): number {
  if (
    !Number.isFinite(activeInstalls)
    || activeInstalls <= 0
    || !Number.isFinite(rangeDays)
    || rangeDays <= 0
  ) {
    return 0;
  }
  return Math.round((activeInstalls / rangeDays) * 10) / 10;
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
  installs: number;
  requests: number;
  tokens: number;
}

interface ModelRow {
  model_family: string;
  installs: number;
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
  installs: number;
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
        `SELECT day, provider_kind, ${SQL_CLAMPED_INSTALLS_SUM} AS installs, ` +
        `${SQL_CLAMPED_REQUESTS_SUM} AS requests, ` +
        `${SQL_CLAMPED_TOKENS_SUM} AS tokens ` +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY day, provider_kind ORDER BY day ASC, tokens DESC, requests DESC, provider_kind ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        `SELECT model_family, ${SQL_CLAMPED_INSTALLS_SUM} AS installs, ` +
        `${SQL_CLAMPED_REQUESTS_SUM} AS requests, ` +
        `${SQL_CLAMPED_TOKENS_SUM} AS tokens ` +
        "FROM daily_models WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY model_family ORDER BY tokens DESC, requests DESC, model_family ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        "SELECT " +
        `CASE WHEN version = 'other' OR installs < ${MIN_COHORT_INSTALL_DAYS} THEN 'other' ELSE version END AS version, ` +
        "SUM(installs) AS installs, " +
        "SUM(new_installs) AS new_installs " +
        "FROM (" +
        "SELECT version, COUNT(*) AS installs, COALESCE(SUM(new_install), 0) AS new_installs " +
        "FROM daily_installs WHERE day >= ?1 AND day <= ?2 " +
        "GROUP BY version" +
        ") " +
        `GROUP BY CASE WHEN version = 'other' OR installs < ${MIN_COHORT_INSTALL_DAYS} THEN 'other' ELSE version END ` +
        `HAVING SUM(installs) >= ${MIN_COHORT_INSTALL_DAYS} ` +
        `ORDER BY installs DESC, version DESC LIMIT ${MAX_STATS_VERSIONS}`,
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
        `SELECT cause, ${SQL_CLAMPED_INSTALLS_SUM} AS installs, ` +
        "MIN(9007199254740991, SUM(MIN(9007199254740991, MAX(0, count)))) AS count " +
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
  const providerTotals = new Map<string, { installs: number; requests: number; tokens: number }>();
  const dailyProviderByDay = new Map<
    string,
    Array<{ providerKind: string; installs: number; requests: number; tokens: number }>
  >();
  for (const row of (dailyByProviderRes?.results ?? []) as unknown as DailyProviderRow[]) {
    const installs = clampSafeInt(row.installs);
    const requests = clampSafeInt(row.requests);
    const tokens = clampSafeInt(row.tokens);
    let dayRows = dailyProviderByDay.get(row.day);
    if (!dayRows) {
      dayRows = [];
      dailyProviderByDay.set(row.day, dayRows);
    }
    dayRows.push({
      providerKind: row.provider_kind,
      installs,
      requests,
      tokens,
    });
    const existing = providerTotals.get(row.provider_kind);
    if (existing) {
      existing.installs = addSafeInt(existing.installs, installs);
      existing.requests = addSafeInt(existing.requests, requests);
      existing.tokens = addSafeInt(existing.tokens, tokens);
    } else {
      providerTotals.set(row.provider_kind, { installs, requests, tokens });
    }
  }

  for (const [day, dayRows] of dailyProviderByDay.entries()) {
    const keptDayRows: TelemetryStatsV1["dailyByProvider"] = [];
    let otherInstalls = 0;
    let otherRequests = 0;
    let otherTokens = 0;
    for (const row of dayRows) {
      if (row.providerKind === "other" || row.installs < MIN_COHORT_INSTALL_DAYS) {
        otherInstalls = addSafeInt(otherInstalls, row.installs);
        otherRequests = addSafeInt(otherRequests, row.requests);
        otherTokens = addSafeInt(otherTokens, row.tokens);
      } else {
        keptDayRows.push({
          day,
          providerKind: row.providerKind,
          requests: row.requests,
          tokens: row.tokens,
        });
      }
    }
    if (otherInstalls >= MIN_COHORT_INSTALL_DAYS) {
      keptDayRows.push({
        day,
        providerKind: "other",
        requests: otherRequests,
        tokens: otherTokens,
      });
    }
    keptDayRows.sort((a, b) => {
      if (b.tokens !== a.tokens) return b.tokens - a.tokens;
      if (b.requests !== a.requests) return b.requests - a.requests;
      return a.providerKind < b.providerKind ? -1 : a.providerKind > b.providerKind ? 1 : 0;
    });
    for (const kept of keptDayRows) {
      dailyByProvider.push(kept);
    }
  }

  const providers: TelemetryStatsV1["providers"] = [];
  let otherProviderInstalls = 0;
  let otherProviderRequests = 0;
  let otherProviderTokens = 0;
  for (const [providerKind, agg] of providerTotals.entries()) {
    if (providerKind === "other" || agg.installs < MIN_COHORT_INSTALL_DAYS) {
      otherProviderInstalls = addSafeInt(otherProviderInstalls, agg.installs);
      otherProviderRequests = addSafeInt(otherProviderRequests, agg.requests);
      otherProviderTokens = addSafeInt(otherProviderTokens, agg.tokens);
    } else {
      providers.push({
        providerKind,
        requests: agg.requests,
        tokens: agg.tokens,
      });
    }
  }
  if (otherProviderInstalls >= MIN_COHORT_INSTALL_DAYS) {
    providers.push({
      providerKind: "other",
      requests: otherProviderRequests,
      tokens: otherProviderTokens,
    });
  }
  providers.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.providerKind < b.providerKind ? -1 : a.providerKind > b.providerKind ? 1 : 0;
  });

  const models: TelemetryStatsV1["models"] = [];
  let otherModelInstalls = 0;
  let otherModelRequests = 0;
  let otherModelTokens = 0;
  for (const row of (modelsRes?.results ?? []) as unknown as ModelRow[]) {
    const installs = clampSafeInt(row.installs);
    const requests = clampSafeInt(row.requests);
    const tokens = clampSafeInt(row.tokens);
    if (row.model_family === "other" || installs < MIN_COHORT_INSTALL_DAYS) {
      otherModelInstalls = addSafeInt(otherModelInstalls, installs);
      otherModelRequests = addSafeInt(otherModelRequests, requests);
      otherModelTokens = addSafeInt(otherModelTokens, tokens);
    } else {
      models.push({
        modelFamily: row.model_family,
        requests,
        tokens,
      });
    }
  }
  if (otherModelInstalls >= MIN_COHORT_INSTALL_DAYS) {
    models.push({
      modelFamily: "other",
      requests: otherModelRequests,
      tokens: otherModelTokens,
    });
  }
  models.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.modelFamily < b.modelFamily ? -1 : a.modelFamily > b.modelFamily ? 1 : 0;
  });

  const versions: TelemetryStatsV1["versions"] = [];
  let otherVersionInstalls = 0;
  let otherVersionNewInstalls = 0;
  for (const row of (versionsRes?.results ?? []) as unknown as VersionRow[]) {
    const installs = clampSafeInt(row.installs);
    const newInstalls = clampSafeInt(row.new_installs);
    if (row.version === "other" || installs < MIN_COHORT_INSTALL_DAYS) {
      otherVersionInstalls = addSafeInt(otherVersionInstalls, installs);
      otherVersionNewInstalls = addSafeInt(otherVersionNewInstalls, newInstalls);
    } else {
      versions.push({
        version: row.version,
        installs,
        newInstalls,
      });
    }
  }
  if (otherVersionInstalls >= MIN_COHORT_INSTALL_DAYS) {
    versions.push({
      version: "other",
      installs: otherVersionInstalls,
      newInstalls: otherVersionNewInstalls,
    });
  }
  versions.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return b.version < a.version ? -1 : b.version > a.version ? 1 : 0;
  });
  if (versions.length > MAX_STATS_VERSIONS) {
    versions.length = MAX_STATS_VERSIONS;
  }

  const platforms: TelemetryStatsV1["platforms"] = [];
  let otherPlatformInstalls = 0;
  for (const row of (platformsRes?.results ?? []) as unknown as PlatformRow[]) {
    const installs = clampSafeInt(row.installs);
    if ((row.os === "other" && row.arch === "other") || installs < MIN_COHORT_INSTALL_DAYS) {
      otherPlatformInstalls = addSafeInt(otherPlatformInstalls, installs);
    } else {
      platforms.push({
        os: row.os,
        arch: row.arch,
        installs,
      });
    }
  }
  if (otherPlatformInstalls >= MIN_COHORT_INSTALL_DAYS) {
    platforms.push({
      os: "other",
      arch: "other",
      installs: otherPlatformInstalls,
    });
  }
  platforms.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    if (a.os !== b.os) return a.os < b.os ? -1 : 1;
    return a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0;
  });

  const channels: TelemetryStatsV1["channels"] = [];
  let otherChannelInstalls = 0;
  let otherChannelNewInstalls = 0;
  for (const row of (channelsRes?.results ?? []) as unknown as ChannelRow[]) {
    const installs = clampSafeInt(row.installs);
    const newInstalls = clampSafeInt(row.new_installs);
    if (row.install_channel === "other" || installs < MIN_COHORT_INSTALL_DAYS) {
      otherChannelInstalls = addSafeInt(otherChannelInstalls, installs);
      otherChannelNewInstalls = addSafeInt(otherChannelNewInstalls, newInstalls);
    } else {
      channels.push({
        installChannel: row.install_channel,
        installs,
        newInstalls,
      });
    }
  }
  if (otherChannelInstalls >= MIN_COHORT_INSTALL_DAYS) {
    channels.push({
      installChannel: "other",
      installs: otherChannelInstalls,
      newInstalls: otherChannelNewInstalls,
    });
  }
  channels.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return a.installChannel < b.installChannel ? -1 : a.installChannel > b.installChannel ? 1 : 0;
  });

  const errors: TelemetryStatsV1["errors"] = [];
  let otherErrorInstalls = 0;
  let otherErrorCount = 0;
  for (const row of (errorsRes?.results ?? []) as unknown as ErrorRow[]) {
    const installs = clampSafeInt(row.installs);
    const count = clampSafeInt(row.count);
    if (row.cause === "other" || installs < MIN_COHORT_INSTALL_DAYS) {
      otherErrorInstalls = addSafeInt(otherErrorInstalls, installs);
      otherErrorCount = addSafeInt(otherErrorCount, count);
    } else {
      errors.push({
        cause: row.cause,
        count,
      });
    }
  }
  if (otherErrorInstalls >= MIN_COHORT_INSTALL_DAYS) {
    errors.push({
      cause: "other",
      count: otherErrorCount,
    });
  }
  errors.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0;
  });

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    generatedAt: new Date(now).toISOString(),
    range,
    totals: {
      activeInstalls,
      avgDailyActiveInstalls: computeAvgDailyActiveInstalls(activeInstalls, rangeDays),
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
    models,
    versions,
    platforms,
    channels,
    outcomes: {
      completed,
      failed,
      incomplete,
      aborted,
    },
    errors,
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
