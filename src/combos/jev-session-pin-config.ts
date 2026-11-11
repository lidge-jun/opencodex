/**
 * Opt-in JEV session pin settings (#7525). Dependency-free so combo validation, the management
 * API and the CLI share one grammar and one range.
 */

/** Shortest idle window a pin may be configured with. */
export const JEV_SESSION_PIN_TTL_MIN_MS = 60_000;
/** Longest idle window a pin may be configured with (one day). */
export const JEV_SESSION_PIN_TTL_MAX_MS = 86_400_000;

export interface JevSessionPinConfig {
  /** Idle window after the last successful pinned turn; a quieter session is decided afresh. */
  ttlMs: number;
  /**
   * `per-turn` keeps the pinned target but asks the decision backend for its effort on every
   * pinned turn, offering only the pinned target's efforts. Absent (the default) reuses the
   * pinned effort too. `pinned` is accepted as input and normalized away.
   */
  effort?: "per-turn";
}

/**
 * Closed persisted vocabulary: `session` marks a turn that reused its pin; every other value names
 * why an existing pin was released before a fresh decision. `session_effort` marks a pinned turn
 * whose effort was decided afresh (`effort: "per-turn"`), so it also sent a decision request.
 */
export const JEV_SESSION_PIN_REASONS = [
  "session",
  "expired",
  "config_changed",
  "target_unavailable",
  "effort_unavailable",
  "quota_nearly_exhausted",
  "session_effort",
] as const;
export type JevSessionPinReason = (typeof JEV_SESSION_PIN_REASONS)[number];
export type JevSessionPinRelease = Exclude<JevSessionPinReason, "session" | "session_effort">;
/** Reasons persisted with `pinned: true`: the turn kept its session target. */
export const JEV_SESSION_PINNED_REASONS: readonly JevSessionPinReason[] = ["session", "session_effort"];

/**
 * The canonical pin setting, or undefined for anything other than `{ ttlMs }` in range with an
 * optional `effort` of `pinned` or `per-turn`.
 */
export function normalizeJevSessionPin(value: unknown): JevSessionPinConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (!keys.includes("ttlMs") || keys.some(key => key !== "ttlMs" && key !== "effort")) return undefined;
  const { ttlMs, effort } = value as { ttlMs?: unknown; effort?: unknown };
  if (effort !== undefined && effort !== "pinned" && effort !== "per-turn") return undefined;
  if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs)
    || ttlMs < JEV_SESSION_PIN_TTL_MIN_MS || ttlMs > JEV_SESSION_PIN_TTL_MAX_MS) return undefined;
  return effort === "per-turn" ? { ttlMs, effort } : { ttlMs };
}

const DURATION_UNITS_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

/** Parse `90s`, `20m`, `1h` or bare milliseconds into an in-range TTL, else undefined. */
export function parseJevSessionPinDuration(raw: string): number | undefined {
  const match = /^(\d{1,9})(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) return undefined;
  const ttlMs = Number(match[1]) * DURATION_UNITS_MS[match[2] ?? "ms"]!;
  return ttlMs >= JEV_SESSION_PIN_TTL_MIN_MS && ttlMs <= JEV_SESSION_PIN_TTL_MAX_MS ? ttlMs : undefined;
}
