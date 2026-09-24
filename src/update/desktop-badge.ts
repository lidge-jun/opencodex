import type { UpdateBadge } from "./badge";
import { defaultUpdateTag } from "./index";

export type DesktopPhase =
  | "idle" | "checking" | "available" | "current"
  | "error" | "installing" | "install-failed";

export interface DesktopSnapshot {
  sessionId: string;
  currentVersion: string;
  latestVersion: string | null;
  available: boolean;
  checkedAtMs: number | null;
  phase: DesktopPhase;
}

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PHASES = new Set<DesktopPhase>([
  "idle", "checking", "available", "current", "error", "installing", "install-failed",
]);
export const DESKTOP_SNAPSHOT_TTL_MS = 180_000;
export const DESKTOP_SNAPSHOT_MAX_SESSIONS = 32;
const MIN_DESKTOP_CHECKED_AT_MS = 946_684_800_000; // 2000-01-01 UTC
const MAX_DESKTOP_CLOCK_SKEW_MS = 60_000;

export function validDesktopSession(value: unknown): value is string {
  return typeof value === "string" && SESSION.test(value);
}

export function parseDesktopSnapshot(value: unknown, nowMs: number): DesktopSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "available,checkedAtMs,currentVersion,latestVersion,phase,sessionId") return null;
  if (!validDesktopSession(body.sessionId)
    || typeof body.currentVersion !== "string" || !VERSION.test(body.currentVersion)
    || (body.latestVersion !== null && (typeof body.latestVersion !== "string" || !VERSION.test(body.latestVersion)))
    || typeof body.available !== "boolean"
    || typeof body.phase !== "string" || !PHASES.has(body.phase as DesktopPhase)) return null;
  const checked = body.checkedAtMs;
  if (checked !== null && (typeof checked !== "number" || !Number.isSafeInteger(checked) || checked < 0
    || checked < MIN_DESKTOP_CHECKED_AT_MS
    || checked > nowMs + MAX_DESKTOP_CLOCK_SKEW_MS)) return null;
  if (body.available !== (body.latestVersion !== null)) return null;
  if (body.available && checked === null) return null;
  if (body.phase === "available" && !body.available) return null;
  if (body.phase === "current" && (body.available || checked === null)) return null;
  if (body.phase === "idle" && (body.available || checked !== null)) return null;
  if ((body.phase === "installing" || body.phase === "install-failed") && !body.available) return null;
  return body as unknown as DesktopSnapshot;
}

export class DesktopBadgeStore {
  private readonly entries = new Map<string, { snapshot: DesktopSnapshot; receivedAtMs: number }>();
  constructor(
    private readonly wallNowMs: () => number = Date.now,
    private readonly elapsedNowMs: () => number = () => performance.now(),
  ) {}

  put(value: unknown): boolean {
    const snapshot = parseDesktopSnapshot(value, this.wallNowMs());
    if (!snapshot) return false;
    const now = this.elapsedNowMs();
    this.prune(now);
    this.entries.delete(snapshot.sessionId);
    while (this.entries.size >= DESKTOP_SNAPSHOT_MAX_SESSIONS) {
      this.entries.delete(this.entries.keys().next().value!);
    }
    this.entries.set(snapshot.sessionId, { snapshot, receivedAtMs: now });
    return true;
  }

  read(sessionId: string | null): UpdateBadge {
    const now = this.elapsedNowMs();
    this.prune(now);
    const snapshot = sessionId && validDesktopSession(sessionId)
      ? this.entries.get(sessionId)?.snapshot : undefined;
    if (!snapshot) return {
      updateAvailable: false, currentVersion: "?", latestVersion: null,
      channel: "latest", installer: "desktop", canUpdate: true, unknown: true,
    };
    return {
      updateAvailable: snapshot.available,
      currentVersion: snapshot.currentVersion,
      latestVersion: snapshot.latestVersion,
      channel: defaultUpdateTag(snapshot.currentVersion),
      installer: "desktop",
      canUpdate: true,
      unknown: snapshot.phase === "idle"
        || ((snapshot.phase === "checking" || snapshot.phase === "error") && !snapshot.available),
    };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.receivedAtMs >= DESKTOP_SNAPSHOT_TTL_MS) this.entries.delete(key);
    }
  }
}

export const desktopBadgeStore = new DesktopBadgeStore();
