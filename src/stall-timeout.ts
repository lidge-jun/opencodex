/**
 * Bridge upstream stall budget: seconds of silence (no adapter events) before the
 * Responses bridge emits `response.incomplete` / `upstream_stall_timeout`.
 *
 * Raised from 90s → 300s → 600s so long Cursor/xhigh reasoning that stays
 * heartbeat-only is not cut mid-turn. Hung streams still die; they just get a
 * more realistic window.
 */
export const DEFAULT_STALL_TIMEOUT_SEC = 600;

/**
 * Resolve the effective bridge stall deadline for a turn.
 * - unset / non-finite config → {@link DEFAULT_STALL_TIMEOUT_SEC}
 * - finite config → ceil, minimum 1
 */
export function resolveStallTimeoutSec(configuredSec: number | undefined): number {
  if (typeof configuredSec === "number" && Number.isFinite(configuredSec)) {
    return Math.max(1, Math.ceil(configuredSec));
  }
  return DEFAULT_STALL_TIMEOUT_SEC;
}
