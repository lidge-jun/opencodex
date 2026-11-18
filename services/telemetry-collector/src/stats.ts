import { TELEMETRY_SCHEMA_VERSION } from "../../../src/telemetry/contract";
import type { CollectorEnv, D1Database, TelemetryStatsRange, TelemetryStatsV1 } from "./types";

const DAY_MS = 86_400_000;
const HEATMAP_DAYS = 365;
export const STATS_CACHE_TTL_MS = 300_000;
/** Edge-cache entries carry their build time so an edge hit never restarts the isolate TTL. */
export const STATS_CACHED_AT_HEADER = "x-ocx-stats-cached-at";
export const MAX_STATS_VERSIONS = 50;
/**
 * Small-cohort threshold (D15): a breakdown row is published only for a (day, key) pair reported by
 * at least this many DISTINCT installs on that day. Range breakdowns sum only the day rows that pass.
 */
export const MIN_COHORT_DAILY_INSTALLS = 10;
const MAX_SAFE_SQL_INT = Number.MAX_SAFE_INTEGER;

/**
 * Breakdown over a single-valued per-install-day dimension of daily_installs (version, platform,
 * install channel). Counts are taken per (day, key), where COUNT(*) is a distinct install count;
 * each day's rows below the threshold (and a native "other") fold into that day's "other", and any
 * day bucket still below the threshold is dropped before the range sum.
 */
function foldedInstallBreakdownSql(keys: readonly string[], includeNewInstalls: boolean): string {
  const keyList = keys.join(", ");
  const fold = `(${keys.map(key => `${key} = 'other'`).join(" AND ")}) OR installs < ${MIN_COHORT_DAILY_INSTALLS}`;
  const perDayNew = includeNewInstalls ? ", COALESCE(SUM(new_install), 0) AS new_installs" : "";
  const carryNew = includeNewInstalls ? ", new_installs" : "";
  const sumNew = includeNewInstalls ? ", SUM(new_installs) AS new_installs" : "";
  return (
    "WITH per_day AS (" +
    `SELECT day, ${keyList}, COUNT(*) AS installs${perDayNew} ` +
    `FROM daily_installs WHERE day >= ?1 AND day <= ?2 GROUP BY day, ${keyList}` +
    "), labeled AS (" +
    `SELECT day, ${keys.map(key => `CASE WHEN ${fold} THEN 'other' ELSE ${key} END AS ${key}`).join(", ")}, ` +
    `installs${carryNew} FROM per_day` +
    "), kept AS (" +
    `SELECT day, ${keyList}, SUM(installs) AS installs${sumNew} FROM labeled ` +
    `GROUP BY day, ${keyList} HAVING SUM(installs) >= ${MIN_COHORT_DAILY_INSTALLS}` +
    ") " +
    `SELECT ${keyList}, SUM(installs) AS installs${sumNew} FROM kept GROUP BY ${keyList}`
  );
}

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
        // Per (day, provider_kind): requests/tokens summed over that day's family rows, published only
        // when daily_provider_installs (a DISTINCT install count) meets the threshold on that day.
        "SELECT m.day AS day, m.provider_kind AS provider_kind, " +
        `${SQL_CLAMPED_REQUESTS_SUM} AS requests, ` +
        `${SQL_CLAMPED_TOKENS_SUM} AS tokens ` +
        "FROM daily_models m JOIN daily_provider_installs p " +
        "ON p.day = m.day AND p.provider_kind = m.provider_kind " +
        `WHERE m.day >= ?1 AND m.day <= ?2 AND p.installs >= ${MIN_COHORT_DAILY_INSTALLS} ` +
        "GROUP BY m.day, m.provider_kind ORDER BY m.day ASC, tokens DESC, requests DESC, m.provider_kind ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        // Range sum of the (day, model_family) rows whose DISTINCT install count passes on that day.
        "SELECT m.model_family AS model_family, " +
        `${SQL_CLAMPED_REQUESTS_SUM} AS requests, ` +
        `${SQL_CLAMPED_TOKENS_SUM} AS tokens ` +
        "FROM daily_models m JOIN daily_family_installs f " +
        "ON f.day = m.day AND f.model_family = m.model_family " +
        `WHERE m.day >= ?1 AND m.day <= ?2 AND f.installs >= ${MIN_COHORT_DAILY_INSTALLS} ` +
        "GROUP BY m.model_family ORDER BY tokens DESC, requests DESC, m.model_family ASC",
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        `${foldedInstallBreakdownSql(["version"], true)} ORDER BY installs DESC, version DESC`,
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(`${foldedInstallBreakdownSql(["os", "arch"], false)} ORDER BY installs DESC, os ASC, arch ASC`)
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        `${foldedInstallBreakdownSql(["install_channel"], true)} ORDER BY installs DESC, install_channel ASC`,
      )
      .bind(rangeStartDay, rangeEndDay),
    env.DB
      .prepare(
        // daily_errors.installs counts each report at most once per (day, cause), so it is distinct.
        "SELECT cause, MIN(9007199254740991, SUM(MIN(9007199254740991, MAX(0, count)))) AS count " +
        `FROM daily_errors WHERE day >= ?1 AND day <= ?2 AND installs >= ${MIN_COHORT_DAILY_INSTALLS} ` +
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

  // Small-cohort protection (D15). Every row below already passed the threshold per (day, key) on a
  // DISTINCT install count before any range sum, so one install cannot pass it alone by reporting on
  // many days or through many provider/family rows. Rows that fail are dropped, never folded, for the
  // multi-valued dimensions (providers, model families, error causes): a bucket built from several
  // of them could be one install counted several times.
  const dailyByProvider: TelemetryStatsV1["dailyByProvider"] = [];
  const providerTotals = new Map<string, { requests: number; tokens: number }>();
  for (const row of (dailyByProviderRes?.results ?? []) as unknown as DailyProviderRow[]) {
    const requests = clampSafeInt(row.requests);
    const tokens = clampSafeInt(row.tokens);
    dailyByProvider.push({ day: row.day, providerKind: row.provider_kind, requests, tokens });
    const existing = providerTotals.get(row.provider_kind);
    if (existing) {
      existing.requests = addSafeInt(existing.requests, requests);
      existing.tokens = addSafeInt(existing.tokens, tokens);
    } else {
      providerTotals.set(row.provider_kind, { requests, tokens });
    }
  }

  const providers: TelemetryStatsV1["providers"] = [];
  for (const [providerKind, agg] of providerTotals.entries()) {
    providers.push({ providerKind, requests: agg.requests, tokens: agg.tokens });
  }
  providers.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.providerKind < b.providerKind ? -1 : a.providerKind > b.providerKind ? 1 : 0;
  });

  const models: TelemetryStatsV1["models"] = [];
  for (const row of (modelsRes?.results ?? []) as unknown as ModelRow[]) {
    models.push({
      modelFamily: row.model_family,
      requests: clampSafeInt(row.requests),
      tokens: clampSafeInt(row.tokens),
    });
  }
  models.sort((a, b) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    if (b.requests !== a.requests) return b.requests - a.requests;
    return a.modelFamily < b.modelFamily ? -1 : a.modelFamily > b.modelFamily ? 1 : 0;
  });

  // Single-valued dimensions: the SQL already folded each day's sub-threshold rows into that day's
  // "other" bucket (distinct, since an install-day has one version/platform/channel) and dropped
  // any day's bucket still below the threshold.
  // At most MAX_STATS_VERSIONS rows: the tail beyond the limit folds into "other" (every tail row
  // already passed the per-day threshold), so the limit never drops the folded bucket.
  const versionsByInstalls = (a: { version: string; installs: number }, b: { version: string; installs: number }): number => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return b.version < a.version ? -1 : b.version > a.version ? 1 : 0;
  };
  const namedVersions: TelemetryStatsV1["versions"] = [];
  let otherVersion: TelemetryStatsV1["versions"][number] | null = null;
  for (const row of (versionsRes?.results ?? []) as unknown as VersionRow[]) {
    const entry = {
      version: row.version,
      installs: clampSafeInt(row.installs),
      newInstalls: clampSafeInt(row.new_installs),
    };
    if (entry.version === "other") otherVersion = entry;
    else namedVersions.push(entry);
  }
  namedVersions.sort(versionsByInstalls);
  if (namedVersions.length + (otherVersion ? 1 : 0) > MAX_STATS_VERSIONS) {
    const folded = otherVersion ?? { version: "other", installs: 0, newInstalls: 0 };
    for (const tail of namedVersions.splice(MAX_STATS_VERSIONS - 1)) {
      folded.installs = addSafeInt(folded.installs, tail.installs);
      folded.newInstalls = addSafeInt(folded.newInstalls, tail.newInstalls);
    }
    otherVersion = folded;
  }
  const versions: TelemetryStatsV1["versions"] = otherVersion ? [...namedVersions, otherVersion] : namedVersions;
  versions.sort(versionsByInstalls);

  const platforms: TelemetryStatsV1["platforms"] = [];
  for (const row of (platformsRes?.results ?? []) as unknown as PlatformRow[]) {
    platforms.push({ os: row.os, arch: row.arch, installs: clampSafeInt(row.installs) });
  }
  platforms.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    if (a.os !== b.os) return a.os < b.os ? -1 : 1;
    return a.arch < b.arch ? -1 : a.arch > b.arch ? 1 : 0;
  });

  const channels: TelemetryStatsV1["channels"] = [];
  for (const row of (channelsRes?.results ?? []) as unknown as ChannelRow[]) {
    channels.push({
      installChannel: row.install_channel,
      installs: clampSafeInt(row.installs),
      newInstalls: clampSafeInt(row.new_installs),
    });
  }
  channels.sort((a, b) => {
    if (b.installs !== a.installs) return b.installs - a.installs;
    return a.installChannel < b.installChannel ? -1 : a.installChannel > b.installChannel ? 1 : 0;
  });

  const errors: TelemetryStatsV1["errors"] = [];
  for (const row of (errorsRes?.results ?? []) as unknown as ErrorRow[]) {
    errors.push({ cause: row.cause, count: clampSafeInt(row.count) });
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
        const edgeCachedAt = Number(edgeHit.headers.get(STATS_CACHED_AT_HEADER));
        // Serve an edge entry only within its original TTL, and keep its original build time in
        // the isolate cache; an entry without a valid build time is treated as a miss.
        if (
          Number.isFinite(edgeCachedAt)
          && now >= edgeCachedAt
          && now < edgeCachedAt + STATS_CACHE_TTL_MS
        ) {
          const body = await edgeHit.text();
          isolateStatsCache.set(range, {
            cachedAt: edgeCachedAt,
            expiresAt: edgeCachedAt + STATS_CACHE_TTL_MS,
            body,
          });
          return new Response(body, {
            status: 200,
            headers: STATS_RESPONSE_HEADERS,
          });
        }
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
          headers: { ...STATS_RESPONSE_HEADERS, [STATS_CACHED_AT_HEADER]: String(now) },
        }),
      );
    }
  }

  return new Response(body, {
    status: 200,
    headers: STATS_RESPONSE_HEADERS,
  });
}
