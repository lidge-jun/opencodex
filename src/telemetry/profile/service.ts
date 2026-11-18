import { getConfigDir } from "../../config/paths";
import { isTelemetryEnvOptOut } from "../consent";
import { formatUtcDay } from "../state";
import { aggregateTelemetryForDay } from "../aggregate";
import { createProfile, deleteProfile, fetchOwnProfileRank, type ProfileClientOptions } from "./client";
import {
  PROFILE_SCHEMA_VERSION,
  validateProfileCreateV1,
  type ProfileDayV1,
  type ProfileRankV1,
} from "./contract";
import {
  deleteTelemetryProfileFile,
  readTelemetryProfileFile,
  toPublicProfileState,
  writeTelemetryProfileState,
  type TelemetryProfilePublicState,
} from "./state";
import { buildProfileDay, readProfileTelemetryGate, resolveNextProfileDay } from "./sync";

export type ProfileErrorCode =
  | "telemetry_off"
  | "already_connected"
  | "deletion_pending"
  | "invalid"
  | "handle_taken"
  | "rate_limited"
  | "collector_unavailable"
  | "not_connected"
  | "profile_unreadable";

export class ProfileActionError extends Error {
  constructor(readonly code: ProfileErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = "ProfileActionError";
  }
}

export interface ProfileStatusSnapshot {
  connected: boolean;
  /** The file exists but cannot be read: nothing is sent; disconnect is still offered. */
  unreadable: boolean;
  profile: TelemetryProfilePublicState | null;
  /** Anonymous telemetry is effectively on (required for connecting and for sending). */
  telemetryEffective: boolean;
  nextDay: string | null;
  nextDayReason: string;
  /** Exactly what the next send would contain, or null. */
  preview: ProfileDayV1 | null;
}

export interface ProfileServiceOptions extends ProfileClientOptions {
  configDir?: string;
  now?: number;
  env?: Record<string, string | undefined>;
}

const PREVIEW_CACHE_MS = 10 * 60 * 1000;
let previewCache: { configDir: string; connectedAt: string; day: string; at: number; preview: ProfileDayV1 | null } | null = null;
const RANK_CACHE_MS = 5 * 60 * 1000;
let rankCache: { configDir: string; handle: string; at: number; rank: ProfileRankV1 } | null = null;

export function resetProfileServiceCachesForTests(): void {
  previewCache = null;
  rankCache = null;
}

export async function buildProfileStatusSnapshot(
  options: ProfileServiceOptions & { cachePreview?: boolean } = {},
): Promise<ProfileStatusSnapshot> {
  const configDir = options.configDir ?? getConfigDir();
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const gate = readProfileTelemetryGate({ configDir, env });
  const telemetryEffective = gate.status.effective && isTelemetryEnvOptOut(env) === null;
  const file = readTelemetryProfileFile(configDir);
  const base = { connected: file.state !== null, unreadable: file.unreadable, telemetryEffective };
  if (!file.state) {
    return { ...base, profile: null, nextDay: null, nextDayReason: file.unreadable ? "state-unreadable" : "not-connected", preview: null };
  }
  const profile = file.state;
  const next = profile.pendingDelete
    ? { day: null, reason: "deletion-pending" }
    : profile.revoked
      ? { day: null, reason: "revoked" }
      : resolveNextProfileDay(profile, gate, now);
  let preview: ProfileDayV1 | null = null;
  if (next.day) {
    const hit = previewCache;
    if (options.cachePreview && hit && hit.configDir === configDir && hit.connectedAt === profile.connectedAt && hit.day === next.day && now - hit.at >= 0 && now - hit.at < PREVIEW_CACHE_MS) {
      preview = hit.preview;
    } else {
      preview = buildProfileDay(await aggregateTelemetryForDay(next.day));
      if (options.cachePreview) previewCache = { configDir, connectedAt: profile.connectedAt, day: next.day, at: now, preview };
    }
  }
  return { ...base, profile: toPublicProfileState(profile), nextDay: next.day, nextDayReason: next.reason, preview };
}

export interface ConnectProfileInput {
  handle: unknown;
  displayName: unknown;
  avatar: unknown;
}

/**
 * Create the public profile and store its secret. Callers have already established that a person
 * asked for this (a human dashboard session or an interactive, non-agent terminal).
 */
export async function connectTelemetryProfile(
  input: ConnectProfileInput,
  options: ProfileServiceOptions = {},
): Promise<TelemetryProfilePublicState> {
  const configDir = options.configDir ?? getConfigDir();
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const existing = readTelemetryProfileFile(configDir);
  if (existing.unreadable) {
    throw new ProfileActionError(
      "profile_unreadable",
      "The local profile file cannot be read. Remove it first with 'ocx telemetry profile disconnect' (or Disconnect on the dashboard Home).",
      409,
    );
  }
  if (existing.state?.pendingDelete) throw new ProfileActionError("deletion_pending", "The previous profile is still being deleted; try again once deletion is confirmed.", 409);
  if (existing.state) throw new ProfileActionError("already_connected", "A public profile is already connected; disconnect it first.", 409);
  const gate = readProfileTelemetryGate({ configDir, env });
  if (!gate.status.effective || isTelemetryEnvOptOut(env) !== null) {
    throw new ProfileActionError("telemetry_off", "A public profile needs anonymous telemetry to be on: its totals come from the same daily aggregate.", 409);
  }
  const validated = validateProfileCreateV1({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    handle: input.handle,
    displayName: input.displayName,
    avatar: input.avatar,
  });
  if (!validated.ok) throw new ProfileActionError("invalid", validated.error, 400);
  const created = await createProfile(validated.value, options);
  if (!created.ok) {
    if (created.status === 409) throw new ProfileActionError("handle_taken", "That handle is already taken.", 409);
    if (created.status === 400) throw new ProfileActionError("invalid", created.error, 400);
    if (created.status === 429) throw new ProfileActionError("rate_limited", "Too many profiles were created from this network recently; try again later.", 429);
    throw new ProfileActionError("collector_unavailable", "The telemetry service could not be reached; nothing was saved.", 502);
  }
  // Another connect may have finished while this one waited on the collector.
  const raced = readTelemetryProfileFile(configDir);
  if (raced.state || raced.unreadable) {
    await deleteProfile(created.body.secret, options);
    throw new ProfileActionError("already_connected", "A public profile is already connected; disconnect it first.", 409);
  }
  const state = {
    version: 1 as const,
    handle: validated.value.handle,
    displayName: validated.value.displayName,
    avatar: validated.value.avatar,
    secret: created.body.secret,
    connectedAt: new Date(now).toISOString(),
    // The collector refuses days on or before its own creation day; never start below it.
    connectedDay: created.body.createdDay && created.body.createdDay > formatUtcDay(now) ? created.body.createdDay : formatUtcDay(now),
    sentDays: {},
    lastSentDay: null,
    lastSentAt: null,
    retryAfterUntil: null,
    pendingDelete: false,
    revoked: false,
  };
  writeTelemetryProfileState(state, configDir, now);
  rankCache = null;
  previewCache = null;
  return toPublicProfileState(state);
}

export type DisconnectOutcome =
  | { status: "deleted" }
  | { status: "not_connected" }
  | { status: "local_removed" }
  | { status: "deletion_pending"; error: string };

/**
 * Disconnect: mark the deletion as pending, ask the collector to delete the profile and every row,
 * and remove the local file once it confirms. Never gated: leaving is always allowed, with
 * anonymous telemetry on or off. A deletion that cannot reach the collector stays pending and the
 * proxy's profile loop retries it.
 */
export async function disconnectTelemetryProfile(options: ProfileServiceOptions = {}): Promise<DisconnectOutcome> {
  const configDir = options.configDir ?? getConfigDir();
  const now = options.now ?? Date.now();
  const file = readTelemetryProfileFile(configDir);
  if (file.unreadable) {
    // Its secret cannot be read, so the server profile cannot be deleted from here; removing the
    // local file is still the person's way out. A profile that stops submitting is pruned by the
    // collector after 400 days and drops out of every ranked period at once.
    if (!deleteTelemetryProfileFile(configDir)) {
      throw new ProfileActionError("profile_unreadable", "The local profile file cannot be read or removed (it may be a symlink or a directory).", 409);
    }
    rankCache = null;
    return { status: "local_removed" };
  }
  const state = file.state;
  if (!state) return { status: "not_connected" };
  if (!state.pendingDelete) writeTelemetryProfileState({ ...state, pendingDelete: true, retryAfterUntil: null }, configDir, now);
  rankCache = null;
  previewCache = null;
  const result = await deleteProfile(state.secret, options);
  if (result.deleted) {
    if (deleteTelemetryProfileFile(configDir)) return { status: "deleted" };
    // The server profile is gone, but the local file (with its now useless secret) is still
    // there: say so instead of reporting a clean disconnect. The loop keeps retrying the removal.
    return { status: "deletion_pending", error: "the local profile file could not be removed" };
  }
  return { status: "deletion_pending", error: result.error ?? "collector unavailable" };
}

/** The connected profile's ranks, from the collector, cached for a few minutes. */
export async function fetchConnectedProfileRank(
  options: ProfileServiceOptions = {},
): Promise<{ ok: true; rank: ProfileRankV1 } | { ok: false; code: ProfileErrorCode | "revoked"; error: string }> {
  const configDir = options.configDir ?? getConfigDir();
  const now = options.now ?? Date.now();
  const file = readTelemetryProfileFile(configDir);
  if (!file.state || file.state.pendingDelete) return { ok: false, code: "not_connected", error: "No public profile is connected." };
  const hit = rankCache;
  if (hit && hit.configDir === configDir && hit.handle === file.state.handle && now - hit.at >= 0 && now - hit.at < RANK_CACHE_MS) {
    return { ok: true, rank: hit.rank };
  }
  const result = await fetchOwnProfileRank(file.state.secret, options);
  if (!result.ok) {
    if (result.status === 401) return { ok: false, code: "revoked", error: "The telemetry service no longer knows this profile." };
    return { ok: false, code: "collector_unavailable", error: "Rank is unavailable right now." };
  }
  rankCache = { configDir, handle: file.state.handle, at: now, rank: result.body };
  return { ok: true, rank: result.body };
}

