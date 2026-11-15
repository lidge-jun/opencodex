import {
  PROFILE_SCHEMA_VERSION,
  PROFILE_SECRET_RE,
  validateProfileCreateV1,
  validateProfileDayV1,
} from "../../../src/telemetry/profile/contract";
import { computeProfileRank, parseProfileMetric, type ProfileRow } from "./leaderboard";
import {
  base64Url,
  clientKey,
  consumeProfileRateLimit,
  profileError,
  profileJson,
  readJsonBody,
  readSalt,
  sha256Hex,
} from "./profile-http";
import { formatUtcDay } from "./stats";
import type { CollectorEnv } from "./types";

export const PROFILE_CREATES_PER_HOUR = 5;
export const PROFILE_SUBMITS_PER_HOUR = 48;
export const PROFILE_ME_READS_PER_HOUR = 120;
export const PROFILE_DELETES_PER_HOUR = 10;
export const MAX_PROFILE_CREATE_BYTES = 2 * 1024;
export const MAX_PROFILE_DAY_BYTES = 8 * 1024;

/** Parse `authorization: Bearer <secret>`; null without touching D1 for anything malformed. */
export function readBearerSecret(request: Request): string | null {
  const header = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !PROFILE_SECRET_RE.test(match[1]!)) return null;
  return match[1]!;
}

async function findProfileBySecret(env: CollectorEnv, secret: string): Promise<ProfileRow | null> {
  return env.DB
    .prepare("SELECT id, handle, display_name, avatar, created_day, hidden FROM profiles WHERE secret_hash = ?1")
    .bind(await sha256Hex(secret))
    .first<ProfileRow>();
}

function unauthorized(): Response {
  return profileError(401, "unknown or missing profile secret");
}

/** POST /v1/profiles: create a profile; the secret is returned once and only its hash is stored. */
export async function handleCreateProfile(request: Request, env: CollectorEnv, now: number = Date.now()): Promise<Response> {
  const salt = readSalt(env);
  if (!salt) return profileError(503, "collector rate-limit salt is not configured");
  const body = await readJsonBody(request, MAX_PROFILE_CREATE_BYTES);
  if (!body.ok) return body.response;
  const validated = validateProfileCreateV1(body.value);
  if (!validated.ok) return profileError(400, validated.error);
  const limited = await consumeProfileRateLimit(env, salt, "create", clientKey(request), PROFILE_CREATES_PER_HOUR, now);
  if (limited) return limited;
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = `ocxp_${base64Url(secretBytes)}`;
  const createdDay = formatUtcDay(now);
  const result = await env.DB
    .prepare(
      "INSERT OR IGNORE INTO profiles (id, handle, display_name, avatar, secret_hash, created_day, last_submit_day, hidden) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 0)",
    )
    .bind(crypto.randomUUID(), validated.value.handle, validated.value.displayName, validated.value.avatar, await sha256Hex(secret), createdDay)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) return profileError(409, "handle is already taken");
  return profileJson({
    ok: true,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profile: { handle: validated.value.handle, displayName: validated.value.displayName, avatar: validated.value.avatar },
    createdDay,
    secret,
  }, 201);
}

/**
 * POST /v1/profiles/me/days: one completed UTC day of totals. First write wins per (profile, day),
 * in one atomic batch whose last statement decides; days on or before the creation day are refused.
 */
export async function handleSubmitProfileDay(request: Request, env: CollectorEnv, now: number = Date.now()): Promise<Response> {
  const salt = readSalt(env);
  if (!salt) return profileError(503, "collector rate-limit salt is not configured");
  const secret = readBearerSecret(request);
  if (!secret) return unauthorized();
  const profile = await findProfileBySecret(env, secret);
  if (!profile) return unauthorized();
  const limited = await consumeProfileRateLimit(env, salt, "submit", `profile:${profile.id}`, PROFILE_SUBMITS_PER_HOUR, now);
  if (limited) return limited;
  const body = await readJsonBody(request, MAX_PROFILE_DAY_BYTES);
  if (!body.ok) return body.response;
  const validated = validateProfileDayV1(body.value, now);
  if (!validated.ok) return profileError(400, validated.error);
  const day = validated.value;
  if (day.day <= profile.created_day) return profileError(400, "days on or before the profile's creation day are not accepted");
  const tokens = day.tokens.input + day.tokens.cacheRead + day.tokens.cacheWrite + day.tokens.output + day.tokens.reasoning;
  const notYet = "WHERE NOT EXISTS (SELECT 1 FROM profile_days WHERE profile_id = ?1 AND day = ?2)";
  const statements = day.families.map(row =>
    env.DB
      .prepare(`INSERT INTO profile_day_families (profile_id, day, family, requests, tokens) SELECT ?1, ?2, ?3, ?4, ?5 ${notYet}`)
      .bind(profile.id, day.day, row.family, row.requests, row.tokens),
  );
  statements.push(
    env.DB
      .prepare("UPDATE profiles SET last_submit_day = ?2 WHERE id = ?1 AND (last_submit_day IS NULL OR last_submit_day < ?2)")
      .bind(profile.id, day.day),
    env.DB
      .prepare(
        "INSERT OR IGNORE INTO profile_days (profile_id, day, requests, input, cache_read, cache_write, output, reasoning, tokens) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(profile.id, day.day, day.requests, day.tokens.input, day.tokens.cacheRead, day.tokens.cacheWrite, day.tokens.output, day.tokens.reasoning, tokens),
  );
  const results = await env.DB.batch(statements);
  const inserted = Number(results[results.length - 1]?.meta?.changes ?? 0) > 0;
  return profileJson({ ok: true, deduplicated: !inserted }, 200);
}

/** GET /v1/profiles/me: the caller's own profile and ranks. */
export async function handleGetOwnProfile(request: Request, env: CollectorEnv, now: number = Date.now()): Promise<Response> {
  const salt = readSalt(env);
  if (!salt) return profileError(503, "collector rate-limit salt is not configured");
  const secret = readBearerSecret(request);
  if (!secret) return unauthorized();
  const profile = await findProfileBySecret(env, secret);
  if (!profile) return unauthorized();
  const metric = parseProfileMetric(new URL(request.url).searchParams.get("metric"));
  if (!metric) return profileError(400, "metric must be tokens or requests");
  const limited = await consumeProfileRateLimit(env, salt, "me", `profile:${profile.id}`, PROFILE_ME_READS_PER_HOUR, now);
  if (limited) return limited;
  const rank = await computeProfileRank(env.DB, profile, metric, now);
  return profileJson({ ok: true, ...rank, hidden: Number(profile.hidden) !== 0 }, 200);
}

/** DELETE /v1/profiles/me: remove the profile and every row submitted for it. */
export async function handleDeleteOwnProfile(request: Request, env: CollectorEnv, now: number = Date.now()): Promise<Response> {
  const salt = readSalt(env);
  if (!salt) return profileError(503, "collector rate-limit salt is not configured");
  const limited = await consumeProfileRateLimit(env, salt, "delete", clientKey(request), PROFILE_DELETES_PER_HOUR, now);
  if (limited) return limited;
  const secret = readBearerSecret(request);
  if (!secret) return unauthorized();
  const profile = await findProfileBySecret(env, secret);
  if (!profile) return unauthorized();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM profile_day_families WHERE profile_id = ?1").bind(profile.id),
    env.DB.prepare("DELETE FROM profile_days WHERE profile_id = ?1").bind(profile.id),
    env.DB.prepare("DELETE FROM profiles WHERE id = ?1").bind(profile.id),
  ]);
  return profileJson({ ok: true, deleted: true }, 200);
}

