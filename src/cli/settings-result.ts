import { printData } from "./runtime-api";
import type { CodexDesktopSwitchApply, CodexDesktopSwitchApplyReason } from "../codex/desktop-switches";

const APPLY_REASONS = {
  not_requested: true, proxy_not_running: true, integration_disabled: true,
  external_provider: true, ownership_undetermined: true, write_lock_busy: true, injection_refused: true,
} satisfies Record<CodexDesktopSwitchApplyReason, true>;

/** The shared native apply DTO, excluding exception/path detail. */
export function projectSettingsApply(value: unknown): CodexDesktopSwitchApply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.applied === true) return { applied: true };
  if (row.applied !== false || typeof row.reason !== "string" || !Object.hasOwn(APPLY_REASONS, row.reason)
    || typeof row.retryable !== "boolean") return null;
  return { applied: false, reason: row.reason as CodexDesktopSwitchApplyReason, retryable: row.retryable };
}

/** Caller rebuilds the relevant task DTO; settings pending is not a CatalogDisposition. */
export function printSettingsResult(
  data: Record<string, unknown>, pending: unknown, wantsJson: boolean, lines: readonly string[],
): number {
  const verified = typeof pending === "boolean";
  const note = !verified ? "Settings were accepted; catalog status is unverified. Read back before retrying."
    : pending ? "Settings saved; catalog refresh is pending."
      : "Settings saved; this response reports no pending catalog refresh.";
  printData({ ...data, catalogRefreshPending: verified ? pending : null,
    ...(!verified ? { verification: "unverified" } : {}) }, wantsJson, [...lines, note]);
  return verified && pending === false ? 0 : 1;
}
