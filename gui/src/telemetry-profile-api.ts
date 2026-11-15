import { createBoundedFetch } from "./bounded-fetch";

/** Wire shapes of /api/telemetry/profile (the opt-in public leaderboard profile). */
export const PROFILE_AVATARS = [
  "slate", "red", "orange", "amber", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink",
] as const;
export type ProfileAvatar = (typeof PROFILE_AVATARS)[number];
export const PROFILE_HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;
export const PROFILE_LEADERBOARD_URL = "https://opencodex.me/dashboard/";
export const PROFILE_GUIDE_URL = "https://opencodex.me/guides/telemetry/#public-profile-and-rank-opt-in";
export const PROFILE_TIMEOUT_MS = 15_000;

/** Mirrors the server's handle rule so the form can disable Connect before asking. */
export function isValidProfileHandle(handle: string): boolean {
  return PROFILE_HANDLE_RE.test(handle) && !handle.includes("--") && !/^[0-9-]+$/.test(handle);
}

export interface ProfilePublicState {
  handle: string;
  displayName: string;
  avatar: ProfileAvatar;
  connectedAt: string;
  lastSentDay: string | null;
  pendingDelete: boolean;
  revoked: boolean;
}

export interface ProfileStatus {
  connected: boolean;
  unreadable: boolean;
  profile: ProfilePublicState | null;
  telemetryEffective: boolean;
  nextDay: string | null;
}

export interface ProfilePeriodRank { rank: number | null; of: number; tokens: number; requests: number }
export interface ProfileRank {
  periods: Record<"day" | "week" | "month", ProfilePeriodRank>;
  families: Array<{ family: string; requests: number; tokens: number }>;
}

export class ProfileRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code ? `HTTP ${String(status)} ${code}` : `HTTP ${String(status)}`);
    this.name = "ProfileRequestError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAvatar(value: unknown): value is ProfileAvatar {
  return typeof value === "string" && (PROFILE_AVATARS as readonly string[]).includes(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function parseProfileStatus(value: unknown): ProfileStatus | null {
  if (!isRecord(value) || typeof value.connected !== "boolean") return null;
  const raw = isRecord(value.profile) ? value.profile : null;
  const profile: ProfilePublicState | null = raw && typeof raw.handle === "string" && typeof raw.displayName === "string" && isAvatar(raw.avatar)
    ? {
        handle: raw.handle,
        displayName: raw.displayName,
        avatar: raw.avatar,
        connectedAt: typeof raw.connectedAt === "string" ? raw.connectedAt : "",
        lastSentDay: typeof raw.lastSentDay === "string" ? raw.lastSentDay : null,
        pendingDelete: raw.pendingDelete === true,
        revoked: raw.revoked === true,
      }
    : null;
  return {
    connected: value.connected && profile !== null,
    unreadable: value.unreadable === true,
    profile,
    telemetryEffective: value.telemetryEffective === true,
    nextDay: typeof value.nextDay === "string" ? value.nextDay : null,
  };
}

export function parseProfileRank(value: unknown): ProfileRank | null {
  if (!isRecord(value) || !isRecord(value.periods)) return null;
  const periods = {} as ProfileRank["periods"];
  for (const period of ["day", "week", "month"] as const) {
    const entry = value.periods[period];
    if (!isRecord(entry)) return null;
    periods[period] = {
      rank: typeof entry.rank === "number" && entry.rank > 0 ? Math.floor(entry.rank) : null,
      of: count(entry.of),
      tokens: count(entry.tokens),
      requests: count(entry.requests),
    };
  }
  const families = Array.isArray(value.families)
    ? value.families.filter(isRecord).filter(row => typeof row.family === "string").map(row => ({
        family: String(row.family),
        requests: count(row.requests),
        tokens: count(row.tokens),
      }))
    : [];
  return { periods, families };
}

async function request(apiBase: string, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
  const bounded = createBoundedFetch(PROFILE_TIMEOUT_MS);
  const onAbort = () => bounded.controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(apiBase + path, { ...init, signal: bounded.signal });
    if (!res.ok) {
      const failure: unknown = await res.json().catch(() => null);
      const code = isRecord(failure) && typeof failure.code === "string" ? failure.code : null;
      throw new ProfileRequestError(res.status, code);
    }
    return await res.json().catch(() => null);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    bounded.clear();
  }
}

export async function fetchProfileStatus(apiBase: string, signal?: AbortSignal): Promise<ProfileStatus> {
  const parsed = parseProfileStatus(await request(apiBase, "/api/telemetry/profile", {}, signal));
  if (!parsed) throw new Error("invalid profile status payload");
  return parsed;
}

export async function fetchProfileRank(apiBase: string, signal?: AbortSignal): Promise<ProfileRank> {
  const body = await request(apiBase, "/api/telemetry/profile/rank", {}, signal);
  const parsed = parseProfileRank(isRecord(body) ? body.rank : null);
  if (!parsed) throw new Error("invalid profile rank payload");
  return parsed;
}

export async function connectProfile(
  apiBase: string,
  input: { handle: string; displayName: string; avatar: ProfileAvatar },
): Promise<void> {
  await request(apiBase, "/api/telemetry/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, acknowledgePublic: true }),
  });
}

export async function disconnectProfile(apiBase: string): Promise<"deleted" | "deletion_pending" | "not_connected" | "local_removed"> {
  const body = await request(apiBase, "/api/telemetry/profile", { method: "DELETE" });
  const status = isRecord(body) ? body.status : null;
  return status === "deleted" || status === "deletion_pending" || status === "not_connected" || status === "local_removed" ? status : "deleted";
}

/** The public leaderboard, opened on this handle's personal-rank view. */
export function profileLeaderboardUrl(handle: string): string | null {
  if (!PROFILE_HANDLE_RE.test(handle)) return null;
  const url = new URL(PROFILE_LEADERBOARD_URL);
  url.search = new URLSearchParams({ profile: handle }).toString();
  url.hash = "leaderboard";
  return url.toString();
}

