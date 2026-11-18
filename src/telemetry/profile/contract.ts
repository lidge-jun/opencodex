/**
 * Wire contract for the opt-in public profile (leaderboard). Shared by the proxy and the collector
 * (services/telemetry-collector imports it), like ../contract.ts, so any change here needs a
 * collector-first rollout. Import-free apart from the anonymous contract's closed rosters.
 *
 * Nothing here relates to the anonymous install identity: a profile day carries no install id,
 * install-day hash, batch id, version, platform, channel, provider kind or error field.
 */
import { MODEL_FAMILIES, parseCalendarUtcDayMs, type TelemetryModelFamily } from "../contract";

export const PROFILE_SCHEMA_VERSION = 1 as const;
export const PROFILE_HANDLE_MIN = 3;
export const PROFILE_HANDLE_MAX = 24;
export const PROFILE_HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;
export const PROFILE_DISPLAY_NAME_MAX = 32;
export const PROFILE_MAX_DAY_REQUESTS = 1_000_000;
export const PROFILE_MAX_DAY_TOKENS = 10_000_000_000;
export const PROFILE_SUBMIT_MAX_AGE_DAYS = 7;
/** `ocxp_` + base64url of 32 random bytes. */
export const PROFILE_SECRET_RE = /^ocxp_[A-Za-z0-9_-]{43}$/;

export const PROFILE_RESERVED_HANDLES: readonly string[] = Object.freeze([
  "about", "admin", "administrator", "anthropic", "api", "app", "dashboard", "deepseek", "delete", "docs",
  "everyone", "github", "google", "help", "leaderboard", "lidge", "login", "logout", "me", "mod",
  "moderator", "new", "null", "ocx", "official", "openai", "opencodex", "owner", "privacy", "profile",
  "profiles", "rank", "root", "security", "settings", "staff", "stats", "support", "system", "team",
  "telemetry", "test", "undefined", "xai",
]);

export const PROFILE_AVATARS = Object.freeze([
  "slate", "red", "orange", "amber", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink",
] as const);
export type ProfileAvatar = typeof PROFILE_AVATARS[number];

export const PROFILE_PERIODS = Object.freeze(["day", "week", "month"] as const);
export type ProfilePeriod = typeof PROFILE_PERIODS[number];
export const PROFILE_PERIOD_DAYS: Readonly<Record<ProfilePeriod, number>> = Object.freeze({ day: 1, week: 7, month: 30 });
export const PROFILE_METRICS = Object.freeze(["tokens", "requests"] as const);
export type ProfileMetric = typeof PROFILE_METRICS[number];

export interface ProfileTokensV1 {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export interface ProfileFamilyRowV1 {
  family: TelemetryModelFamily;
  requests: number;
  tokens: number;
}

/** One completed UTC day of a connected profile: totals only. */
export interface ProfileDayV1 {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  day: string;
  requests: number;
  tokens: ProfileTokensV1;
  families: ProfileFamilyRowV1[];
}

export interface ProfileCreateV1 {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  handle: string;
  displayName: string;
  avatar: ProfileAvatar;
}

/** Public fields of a profile. Never an id, secret, creation day or moderation flag. */
export interface PublicProfileV1 {
  handle: string;
  displayName: string;
  avatar: ProfileAvatar;
}

export interface ProfilePeriodRankV1 {
  /** RANK() among non-hidden profiles with a positive metric in the window; null when outside that set. */
  rank: number | null;
  /** Size of the ranked set (0 when nobody is ranked). */
  of: number;
  tokens: number;
  requests: number;
}

export interface ProfileRankV1 {
  profile: PublicProfileV1;
  metric: ProfileMetric;
  periods: Record<ProfilePeriod, ProfilePeriodRankV1>;
  /** Model-family totals over the month window, largest token total first. */
  families: ProfileFamilyRowV1[];
}

const DAY_MS = 86_400_000;
const TOKEN_KEYS = ["input", "cacheRead", "cacheWrite", "output", "reasoning"] as const;
const DAY_KEYS = ["schemaVersion", "day", "requests", "tokens", "families"] as const;
const FAMILY_KEYS = ["family", "requests", "tokens"] as const;
const CREATE_KEYS = ["schemaVersion", "handle", "displayName", "avatar"] as const;
const FAMILY_SET: ReadonlySet<string> = new Set(MODEL_FAMILIES);
const AVATAR_SET: ReadonlySet<string> = new Set(PROFILE_AVATARS);
const RESERVED_SET: ReadonlySet<string> = new Set(PROFILE_RESERVED_HANDLES);
/** Letters, combining marks, digits, space and a few punctuation marks; nothing that can form markup or a URL scheme. */
const DISPLAY_NAME_CHARS_RE = /^[\p{L}\p{M}\p{N} ._'-]+$/u;
/** Rejects anything shaped like a domain (`example.com`, `x.io`), so a display name cannot be a link. */
const DOMAIN_LIKE_RE = /\.[a-z]{2,}/i;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(record, key));
}

function isBoundedInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

export function normalizeProfileHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateProfileHandle(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "handle must be a string" };
  const handle = normalizeProfileHandle(raw);
  if (handle.length < PROFILE_HANDLE_MIN || handle.length > PROFILE_HANDLE_MAX || !PROFILE_HANDLE_RE.test(handle)) {
    return { ok: false, error: "handle must be 3-24 lowercase letters, digits or hyphens, starting and ending with a letter or digit" };
  }
  if (handle.includes("--")) return { ok: false, error: "handle must not contain consecutive hyphens" };
  if (/^[0-9-]+$/.test(handle)) return { ok: false, error: "handle must contain a letter" };
  if (RESERVED_SET.has(handle)) return { ok: false, error: "handle is reserved" };
  return { ok: true, value: handle };
}

export function validateProfileDisplayName(raw: unknown): Result<string> {
  if (typeof raw !== "string") return { ok: false, error: "displayName must be a string" };
  const name = raw.normalize("NFC").trim();
  const length = [...name].length;
  if (length < 1 || length > PROFILE_DISPLAY_NAME_MAX) {
    return { ok: false, error: `displayName must be 1-${PROFILE_DISPLAY_NAME_MAX} characters` };
  }
  if (!DISPLAY_NAME_CHARS_RE.test(name)) {
    return { ok: false, error: "displayName may contain only letters, digits, spaces and . _ ' -" };
  }
  if (name.includes("  ")) return { ok: false, error: "displayName must not contain consecutive spaces" };
  if (DOMAIN_LIKE_RE.test(name)) return { ok: false, error: "displayName must not look like a web address" };
  return { ok: true, value: name };
}

export function isProfileAvatar(value: unknown): value is ProfileAvatar {
  return typeof value === "string" && AVATAR_SET.has(value);
}

export function validateProfileCreateV1(input: unknown): Result<ProfileCreateV1> {
  if (!isPlainRecord(input) || !hasExactKeys(input, CREATE_KEYS)) {
    return { ok: false, error: "profile must have exactly schemaVersion, handle, displayName and avatar" };
  }
  if (input.schemaVersion !== PROFILE_SCHEMA_VERSION) return { ok: false, error: "unsupported schemaVersion" };
  const handle = validateProfileHandle(input.handle);
  if (!handle.ok) return handle;
  const displayName = validateProfileDisplayName(input.displayName);
  if (!displayName.ok) return displayName;
  if (!isProfileAvatar(input.avatar)) return { ok: false, error: "avatar must be one of the palette colours" };
  return {
    ok: true,
    value: { schemaVersion: PROFILE_SCHEMA_VERSION, handle: handle.value, displayName: displayName.value, avatar: input.avatar },
  };
}

export function sumProfileTokens(tokens: ProfileTokensV1): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning;
}

function parsePeriodRank(value: unknown): ProfilePeriodRankV1 | null {
  if (!isPlainRecord(value)) return null;
  const rank = value.rank === null ? null : isBoundedInt(value.rank, Number.MAX_SAFE_INTEGER) && value.rank > 0 ? value.rank : undefined;
  if (rank === undefined) return null;
  if (!isBoundedInt(value.of, Number.MAX_SAFE_INTEGER) || !isBoundedInt(value.tokens, Number.MAX_SAFE_INTEGER)
    || !isBoundedInt(value.requests, Number.MAX_SAFE_INTEGER)) return null;
  return { rank, of: value.of, tokens: value.tokens, requests: value.requests };
}

/**
 * Parse a rank response from the collector, keeping only the documented fields. Anything that
 * does not match is rejected rather than rendered.
 */
export function parseProfileRankV1(value: unknown): ProfileRankV1 | null {
  if (!isPlainRecord(value) || !isPlainRecord(value.profile) || !isPlainRecord(value.periods)) return null;
  const handle = validateProfileHandle(value.profile.handle);
  const displayName = validateProfileDisplayName(value.profile.displayName);
  if (!handle.ok || !displayName.ok || !isProfileAvatar(value.profile.avatar)) return null;
  if (value.metric !== "tokens" && value.metric !== "requests") return null;
  const periods = {} as Record<ProfilePeriod, ProfilePeriodRankV1>;
  for (const period of PROFILE_PERIODS) {
    const parsed = parsePeriodRank(value.periods[period]);
    if (!parsed) return null;
    periods[period] = parsed;
  }
  if (!Array.isArray(value.families)) return null;
  const families: ProfileFamilyRowV1[] = [];
  for (const row of value.families) {
    if (!isPlainRecord(row) || typeof row.family !== "string" || !FAMILY_SET.has(row.family)) return null;
    if (!isBoundedInt(row.requests, Number.MAX_SAFE_INTEGER) || !isBoundedInt(row.tokens, Number.MAX_SAFE_INTEGER)) return null;
    families.push({ family: row.family as TelemetryModelFamily, requests: row.requests, tokens: row.tokens });
  }
  return {
    profile: { handle: handle.value, displayName: displayName.value, avatar: value.profile.avatar },
    metric: value.metric,
    periods,
    families,
  };
}

function utcMidnight(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * True for a completed UTC day no older than {@link PROFILE_SUBMIT_MAX_AGE_DAYS}. Today and the
 * future are never submittable: only whole, finished days are ranked.
 */
export function isSubmittableProfileDay(day: string, now: number): boolean {
  const dayMs = parseCalendarUtcDayMs(day);
  if (dayMs === null) return false;
  const todayMs = utcMidnight(now);
  return dayMs < todayMs && dayMs >= todayMs - PROFILE_SUBMIT_MAX_AGE_DAYS * DAY_MS;
}

export function validateProfileDayV1(input: unknown, now: number = Date.now()): Result<ProfileDayV1> {
  if (!isPlainRecord(input) || !hasExactKeys(input, DAY_KEYS)) {
    return { ok: false, error: "day must have exactly schemaVersion, day, requests, tokens and families" };
  }
  if (input.schemaVersion !== PROFILE_SCHEMA_VERSION) return { ok: false, error: "unsupported schemaVersion" };
  if (typeof input.day !== "string" || !isSubmittableProfileDay(input.day, now)) {
    return { ok: false, error: `day must be a completed UTC day within the last ${PROFILE_SUBMIT_MAX_AGE_DAYS} days` };
  }
  if (!isBoundedInt(input.requests, PROFILE_MAX_DAY_REQUESTS) || input.requests === 0) {
    return { ok: false, error: `requests must be an integer in 1..${PROFILE_MAX_DAY_REQUESTS}` };
  }
  const rawTokens = input.tokens;
  if (!isPlainRecord(rawTokens) || !hasExactKeys(rawTokens, TOKEN_KEYS)) {
    return { ok: false, error: "tokens must have exactly input, cacheRead, cacheWrite, output and reasoning" };
  }
  for (const key of TOKEN_KEYS) {
    if (!isBoundedInt(rawTokens[key], PROFILE_MAX_DAY_TOKENS)) return { ok: false, error: `tokens.${key} is out of range` };
  }
  const tokens: ProfileTokensV1 = {
    input: rawTokens.input as number,
    cacheRead: rawTokens.cacheRead as number,
    cacheWrite: rawTokens.cacheWrite as number,
    output: rawTokens.output as number,
    reasoning: rawTokens.reasoning as number,
  };
  const tokenSum = sumProfileTokens(tokens);
  if (tokenSum > PROFILE_MAX_DAY_TOKENS) return { ok: false, error: "token total exceeds the daily limit" };
  if (!Array.isArray(input.families) || input.families.length === 0 || input.families.length > MODEL_FAMILIES.length) {
    return { ok: false, error: "families must list 1 or more model families" };
  }
  const seen = new Set<string>();
  const families: ProfileFamilyRowV1[] = [];
  let familyRequests = 0;
  let familyTokens = 0;
  for (const row of input.families) {
    if (!isPlainRecord(row) || !hasExactKeys(row, FAMILY_KEYS)) {
      return { ok: false, error: "family rows must have exactly family, requests and tokens" };
    }
    if (typeof row.family !== "string" || !FAMILY_SET.has(row.family)) return { ok: false, error: "unknown model family" };
    if (seen.has(row.family)) return { ok: false, error: "duplicate model family" };
    seen.add(row.family);
    if (!isBoundedInt(row.requests, PROFILE_MAX_DAY_REQUESTS) || row.requests === 0) {
      return { ok: false, error: "family requests must be positive" };
    }
    if (!isBoundedInt(row.tokens, PROFILE_MAX_DAY_TOKENS)) return { ok: false, error: "family tokens are out of range" };
    familyRequests += row.requests;
    familyTokens += row.tokens;
    families.push({ family: row.family as TelemetryModelFamily, requests: row.requests, tokens: row.tokens });
  }
  if (familyRequests !== input.requests) return { ok: false, error: "family requests must sum to requests" };
  if (familyTokens !== tokenSum) return { ok: false, error: "family tokens must sum to the token total" };
  return { ok: true, value: { schemaVersion: PROFILE_SCHEMA_VERSION, day: input.day, requests: input.requests, tokens, families } };
}

