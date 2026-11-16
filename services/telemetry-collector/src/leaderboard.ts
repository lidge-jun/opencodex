import {
  PROFILE_METRICS,
  PROFILE_PERIOD_DAYS,
  PROFILE_PERIODS,
  validateProfileHandle,
  type ProfileFamilyRowV1,
  type ProfileMetric,
  type ProfilePeriod,
  type ProfilePeriodRankV1,
  type ProfileRankV1,
} from "../../../src/telemetry/profile/contract";
import { PUBLIC_PROFILE_MAX_AGE_SECONDS, clientKey, consumeProfileRateLimit, profileError, profileJson, readSalt } from "./profile-http";
import { formatUtcDay, utcMidnightMs } from "./stats";
import type { CollectorEnv, D1Database } from "./types";

const DAY_MS = 86_400_000;
export const LEADERBOARD_MAX_LIMIT = 100;
export const LEADERBOARD_DEFAULT_LIMIT = 50;
/** Public reads per client key and hour; generous because a shared NAT may serve many dashboard viewers. */
export const PROFILE_READS_PER_HOUR = 3000;

export interface LeaderboardEntryV1 {
  rank: number;
  handle: string;
  displayName: string;
  avatar: string;
  tokens: number;
  requests: number;
}

export interface LeaderboardV1 {
  schemaVersion: 1;
  period: ProfilePeriod;
  metric: ProfileMetric;
  from: string;
  to: string;
  generatedAt: string;
  total: number;
  entries: LeaderboardEntryV1[];
}

/** The window ending on the latest completed UTC day. */
export function profilePeriodWindow(period: ProfilePeriod, now: number): { from: string; to: string } {
  const anchor = utcMidnightMs(now) - DAY_MS;
  return { from: formatUtcDay(anchor - (PROFILE_PERIOD_DAYS[period] - 1) * DAY_MS), to: formatUtcDay(anchor) };
}

function metricColumn(metric: ProfileMetric): "tokens" | "requests" {
  return metric === "requests" ? "requests" : "tokens";
}

function safeInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

/**
 * Totals per non-hidden profile in [from, to], ranked with RANK() over the metric among profiles
 * whose metric is positive (ties share a rank; display order within a tie is handle ascending).
 */
const RANKED_CTE = (metric: ProfileMetric) =>
  "WITH totals AS (" +
  "SELECT p.id AS id, p.handle AS handle, p.display_name AS display_name, p.avatar AS avatar, " +
  "TOTAL(d.tokens) AS tokens, TOTAL(d.requests) AS requests " +
  "FROM profile_days d JOIN profiles p ON p.id = d.profile_id " +
  "WHERE d.day >= ?1 AND d.day <= ?2 AND p.hidden = 0 GROUP BY p.id" +
  "), ranked AS (" +
  `SELECT id, handle, display_name, avatar, tokens, requests, RANK() OVER (ORDER BY ${metricColumn(metric)} DESC) AS rank ` +
  `FROM totals WHERE ${metricColumn(metric)} > 0` +
  ") ";

export async function readLeaderboard(
  db: D1Database,
  period: ProfilePeriod,
  metric: ProfileMetric,
  limit: number,
  now: number,
): Promise<LeaderboardV1> {
  const { from, to } = profilePeriodWindow(period, now);
  const rows = await db
    .prepare(RANKED_CTE(metric) + "SELECT handle, display_name, avatar, tokens, requests, rank, (SELECT COUNT(*) FROM ranked) AS total FROM ranked ORDER BY rank ASC, handle ASC LIMIT ?3")
    .bind(from, to, limit)
    .all<Record<string, unknown>>();
  const results = rows.results ?? [];
  // LIMIT is at least 1, so an empty page means nobody is ranked.
  const total = results.length > 0 ? safeInt(results[0]!.total) : 0;
  return {
    schemaVersion: 1,
    period,
    metric,
    from,
    to,
    generatedAt: new Date(now).toISOString(),
    total,
    entries: results.map(row => ({
      rank: safeInt(row.rank),
      handle: String(row.handle),
      displayName: String(row.display_name),
      avatar: String(row.avatar),
      tokens: safeInt(row.tokens),
      requests: safeInt(row.requests),
    })),
  };
}

async function readPeriodRank(
  db: D1Database,
  profileId: string,
  period: ProfilePeriod,
  metric: ProfileMetric,
  now: number,
): Promise<ProfilePeriodRankV1> {
  const { from, to } = profilePeriodWindow(period, now);
  const row = await db
    .prepare(
      RANKED_CTE(metric) +
      "SELECT (SELECT COUNT(*) FROM ranked) AS total, (SELECT rank FROM ranked WHERE id = ?3) AS rank, " +
      "(SELECT TOTAL(tokens) FROM profile_days WHERE profile_id = ?3 AND day >= ?1 AND day <= ?2) AS own_tokens, " +
      "(SELECT TOTAL(requests) FROM profile_days WHERE profile_id = ?3 AND day >= ?1 AND day <= ?2) AS own_requests",
    )
    .bind(from, to, profileId)
    .first<Record<string, unknown>>();
  const rank = row?.rank === null || row?.rank === undefined ? null : safeInt(row.rank) || null;
  return {
    rank,
    of: safeInt(row?.total),
    tokens: safeInt(row?.own_tokens),
    requests: safeInt(row?.own_requests),
  };
}

export interface ProfileRow {
  id: string;
  handle: string;
  display_name: string;
  avatar: string;
  created_day: string;
  hidden: number;
}

/** Ranks for every period plus month model-family totals. A hidden profile is outside every ranked set. */
export async function computeProfileRank(
  db: D1Database,
  profile: ProfileRow,
  metric: ProfileMetric,
  now: number,
): Promise<ProfileRankV1> {
  const periods = {} as Record<ProfilePeriod, ProfilePeriodRankV1>;
  for (const period of PROFILE_PERIODS) {
    periods[period] = await readPeriodRank(db, profile.id, period, metric, now);
  }
  const month = profilePeriodWindow("month", now);
  const familyRows = await db
    .prepare(
      "SELECT family, TOTAL(requests) AS requests, TOTAL(tokens) AS tokens FROM profile_day_families " +
      "WHERE profile_id = ?1 AND day >= ?2 AND day <= ?3 GROUP BY family ORDER BY tokens DESC, family ASC",
    )
    .bind(profile.id, month.from, month.to)
    .all<Record<string, unknown>>();
  const families = (familyRows.results ?? []).map(row => ({
    family: String(row.family),
    requests: safeInt(row.requests),
    tokens: safeInt(row.tokens),
  })) as ProfileFamilyRowV1[];
  return {
    profile: { handle: profile.handle, displayName: profile.display_name, avatar: profile.avatar as ProfileRankV1["profile"]["avatar"] },
    metric,
    periods,
    families,
  };
}

export function parseProfileMetric(raw: string | null): ProfileMetric | null {
  const value = raw ?? "tokens";
  return (PROFILE_METRICS as readonly string[]).includes(value) ? value as ProfileMetric : null;
}

function parsePeriod(raw: string | null): ProfilePeriod | null {
  const value = raw ?? "week";
  return (PROFILE_PERIODS as readonly string[]).includes(value) ? value as ProfilePeriod : null;
}

/** GET /v1/leaderboard?period=day|week|month&metric=tokens|requests&limit=1..100 */
export async function handleLeaderboard(request: Request, env: CollectorEnv, now: number = Date.now()): Promise<Response> {
  const salt = readSalt(env);
  if (!salt) return profileError(503, "collector rate-limit salt is not configured");
  const url = new URL(request.url);
  const period = parsePeriod(url.searchParams.get("period"));
  const metric = parseProfileMetric(url.searchParams.get("metric"));
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? LEADERBOARD_DEFAULT_LIMIT : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
  if (!period || !metric || !Number.isInteger(limit) || limit < 1 || limit > LEADERBOARD_MAX_LIMIT) {
    return profileError(400, "period must be day, week or month; metric tokens or requests; limit 1-100");
  }
  const limited = await consumeProfileRateLimit(env, salt, "read", clientKey(request), PROFILE_READS_PER_HOUR, now);
  if (limited) return limited;
  // No in-process cache: a maintainer's hide must show on the next read. Shared caches may keep a
  // board for PUBLIC_PROFILE_MAX_AGE_SECONDS at most.
  const board = await readLeaderboard(env.DB, period, metric, limit, now);
  return new Response(JSON.stringify(board), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-robots-tag": "noindex",
      "cache-control": `public, max-age=${PUBLIC_PROFILE_MAX_AGE_SECONDS}`,
    },
  });
}

/** GET /v1/profiles/by-handle/<handle>?metric=tokens|requests: a public profile's ranks; 404 for unknown or hidden. */
export async function handleProfileByHandle(
  request: Request,
  env: CollectorEnv,
  rawHandle: string,
  now: number = Date.now(),
): Promise<Response> {
  const salt = readSalt(env);
  if (!salt) return profileError(503, "collector rate-limit salt is not configured");
  const url = new URL(request.url);
  const metric = parseProfileMetric(url.searchParams.get("metric"));
  let decoded = rawHandle;
  try { decoded = decodeURIComponent(rawHandle); } catch { decoded = ""; }
  const handle = validateProfileHandle(decoded);
  if (!metric || !handle.ok) return profileError(404, "profile not found");
  const limited = await consumeProfileRateLimit(env, salt, "read", clientKey(request), PROFILE_READS_PER_HOUR, now);
  if (limited) return limited;
  const profile = await env.DB
    .prepare("SELECT id, handle, display_name, avatar, created_day, hidden FROM profiles WHERE handle = ?1 AND hidden = 0")
    .bind(handle.value)
    .first<ProfileRow>();
  if (!profile) return profileError(404, "profile not found");
  const rank = await computeProfileRank(env.DB, profile, metric, now);
  return profileJson({ ok: true, ...rank }, 200, "public");
}
