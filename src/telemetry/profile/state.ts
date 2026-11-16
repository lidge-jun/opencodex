import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFileNoFollow } from "../../config/atomic-write";
import { getConfigDir } from "../../config/paths";
import { recordOwnedConfigPath } from "../../lib/config-ownership";
import { parseCalendarUtcDayMs } from "../contract";
import {
  PROFILE_SECRET_RE,
  isProfileAvatar,
  validateProfileDisplayName,
  validateProfileHandle,
  type ProfileAvatar,
  type PublicProfileV1,
} from "./contract";
import { telemetryProfilePath } from "./paths";

/**
 * `telemetry-profile.json`: the connected public profile, its bearer secret and its own send
 * bookkeeping. Independent of the anonymous telemetry state and identity files: connecting or
 * disconnecting never touches them, and turning anonymous telemetry off never touches this one.
 */
export interface TelemetryProfileState {
  version: 1;
  handle: string;
  displayName: string;
  avatar: ProfileAvatar;
  /** Bearer secret issued by the collector. Never leaves this module except towards the collector. */
  secret: string;
  connectedAt: string;
  /** UTC day of the connect; only later days are ever sent. */
  connectedDay: string;
  sentDays: Record<string, string>;
  lastSentDay: string | null;
  lastSentAt: string | null;
  retryAfterUntil: string | null;
  /** Set by a disconnect whose deletion has not been confirmed by the collector yet. */
  pendingDelete: boolean;
  /** Set when the collector no longer knows the secret (401): nothing is sent until a reconnect. */
  revoked: boolean;
}

/** What may be shown anywhere: the state without its secret. */
export interface TelemetryProfilePublicState extends PublicProfileV1 {
  connectedAt: string;
  connectedDay: string;
  lastSentDay: string | null;
  lastSentAt: string | null;
  pendingDelete: boolean;
  revoked: boolean;
}

const MAX_PROFILE_FILE_BYTES = 64 * 1024;
const SENT_DAYS_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validIso(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

/**
 * Read the profile file. A file that exists but cannot be trusted (a symlink, oversized or
 * malformed) is reported as unreadable rather than as "not connected", so a disconnect is still
 * offered and nothing is sent over it.
 */
export function readTelemetryProfileFile(
  configDir = getConfigDir(),
): { state: TelemetryProfileState | null; unreadable: boolean } {
  const path = telemetryProfilePath(configDir);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { state: null, unreadable: false };
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROFILE_FILE_BYTES) return { state: null, unreadable: true };
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const handle = validateProfileHandle(raw?.handle);
    const displayName = validateProfileDisplayName(raw?.displayName);
    const connectedAt = validIso(raw?.connectedAt);
    if (
      raw?.version !== 1
      || !handle.ok
      || !displayName.ok
      || !isProfileAvatar(raw.avatar)
      || typeof raw.secret !== "string"
      || !PROFILE_SECRET_RE.test(raw.secret)
      || connectedAt === null
      || typeof raw.connectedDay !== "string"
      || parseCalendarUtcDayMs(raw.connectedDay) === null
    ) {
      return { state: null, unreadable: true };
    }
    const sentDays: Record<string, string> = {};
    if (raw.sentDays && typeof raw.sentDays === "object" && !Array.isArray(raw.sentDays)) {
      for (const [day, at] of Object.entries(raw.sentDays as Record<string, unknown>)) {
        if (DAY_RE.test(day) && typeof at === "string") sentDays[day] = at;
      }
    }
    return {
      unreadable: false,
      state: {
        version: 1,
        handle: handle.value,
        displayName: displayName.value,
        avatar: raw.avatar,
        secret: raw.secret,
        connectedAt,
        connectedDay: raw.connectedDay,
        sentDays,
        lastSentDay: typeof raw.lastSentDay === "string" && DAY_RE.test(raw.lastSentDay) ? raw.lastSentDay : null,
        lastSentAt: validIso(raw.lastSentAt),
        retryAfterUntil: validIso(raw.retryAfterUntil),
        pendingDelete: raw.pendingDelete === true,
        revoked: raw.revoked === true,
      },
    };
  } catch {
    return { state: null, unreadable: true };
  }
}

export function writeTelemetryProfileState(
  state: TelemetryProfileState,
  configDir = getConfigDir(),
  now = Date.now(),
): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const path = telemetryProfilePath(configDir);
  try { recordOwnedConfigPath(configDir, path); } catch { /* best-effort */ }
  const minKeepDay = new Date(now - SENT_DAYS_RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const sentDays: Record<string, string> = {};
  for (const [day, at] of Object.entries(state.sentDays)) {
    if (day >= minKeepDay) sentDays[day] = at;
  }
  const payload: TelemetryProfileState = { ...state, version: 1, sentDays };
  atomicWriteFileNoFollow(path, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Bookkeeping after a network call. The file is re-read and the update applied to what is on disk
 * now, and only while it still belongs to the same profile (same secret): a disconnect that landed
 * meanwhile (pendingDelete set, or the file removed) or a reconnect is never overwritten. The
 * update cannot clear pendingDelete. Returns false when nothing was written.
 */
export function updateTelemetryProfileState(
  secret: string,
  update: (state: TelemetryProfileState) => TelemetryProfileState,
  options: { configDir?: string; now?: number; whilePendingDelete?: boolean } = {},
): boolean {
  const configDir = options.configDir ?? getConfigDir();
  const current = readTelemetryProfileFile(configDir).state;
  if (!current || current.secret !== secret) return false;
  if (current.pendingDelete && !options.whilePendingDelete) return false;
  const next = update(current);
  writeTelemetryProfileState({ ...next, secret: current.secret, pendingDelete: current.pendingDelete || next.pendingDelete }, configDir, options.now);
  return true;
}

/**
 * Delete the profile file. Refuses to follow a symlink. A file that cannot be read (corrupt) can
 * still be removed; returns true when no file remains.
 */
export function deleteTelemetryProfileFile(configDir = getConfigDir()): boolean {
  const path = telemetryProfilePath(configDir);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
  }
}

export function toPublicProfileState(state: TelemetryProfileState): TelemetryProfilePublicState {
  return {
    handle: state.handle,
    displayName: state.displayName,
    avatar: state.avatar,
    connectedAt: state.connectedAt,
    connectedDay: state.connectedDay,
    lastSentDay: state.lastSentDay,
    lastSentAt: state.lastSentAt,
    pendingDelete: state.pendingDelete,
    revoked: state.revoked,
  };
}

