import type { IntegrationReason, IntegrationState, IntegrationStatus } from "./integration-api";

export interface AsideProfileStatus extends IntegrationStatus {
  clientId: "aside"; profileId: number; name?: string; current: boolean; enabled: boolean; error?: string;
}
export interface AsideProfileOutcome {
  profileId: number; ok: boolean; state?: IntegrationState; reason?: string; refusalReason?: string;
  message?: string; snapshotPath?: string; residual?: boolean;
}
const STATES = new Set<IntegrationState>(["absent", "current", "stale", "conflict", "unsafe"]);
const REASONS = new Set<IntegrationReason>(["unparseable", "not-regular-file", "foreign-edit", "unowned-key", "blocked-container", "unresolvable-path"]);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function id(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Shared by list and detail reads, including every field that controls actions or recovery. */
export function parseAsideProfileStatus(value: unknown): AsideProfileStatus | null {
  if (!record(value) || value.clientId !== "aside" || !id(value.profileId)
    || typeof value.current !== "boolean" || typeof value.enabled !== "boolean"
    || !STATES.has(value.state as IntegrationState) || typeof value.installed !== "boolean"
    || typeof value.configPath !== "string" || !Number.isSafeInteger(value.snapshotCount)
    || (value.snapshotCount as number) < -1 || typeof value.retentionDegraded !== "boolean"
    || (value.reason !== undefined && !REASONS.has(value.reason as IntegrationReason))) return null;
  for (const key of ["name", "error", "appliedAt", "lastOpId"]) if (value[key] !== undefined && typeof value[key] !== "string") return null;
  return {
    clientId: "aside", profileId: value.profileId, current: value.current, enabled: value.enabled,
    state: value.state as IntegrationState, installed: value.installed, configPath: value.configPath,
    snapshotCount: value.snapshotCount as number, retentionDegraded: value.retentionDegraded,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.appliedAt === "string" ? { appliedAt: value.appliedAt } : {}),
    ...(typeof value.lastOpId === "string" ? { lastOpId: value.lastOpId } : {}),
    ...(value.reason !== undefined ? { reason: value.reason as IntegrationReason } : {}),
  };
}

/** Keep refusal data even when only one profile failed; it cannot be recovered by a later GET. */
export function parseAsideProfileOutcomes(value: unknown): AsideProfileOutcome[] | null {
  if (!Array.isArray(value)) return null;
  const results: AsideProfileOutcome[] = [];
  for (const row of value) {
    if (!record(row) || !id(row.profileId) || typeof row.ok !== "boolean"
      || (row.state !== undefined && !STATES.has(row.state as IntegrationState))
      || (row.residual !== undefined && typeof row.residual !== "boolean")) return null;
    for (const key of ["reason", "refusalReason", "message", "snapshotPath"]) if (row[key] !== undefined && typeof row[key] !== "string") return null;
    results.push({ profileId: row.profileId, ok: row.ok,
      ...(row.state !== undefined ? { state: row.state as IntegrationState } : {}),
      ...(typeof row.reason === "string" ? { reason: row.reason } : {}),
      ...(typeof row.refusalReason === "string" ? { refusalReason: row.refusalReason } : {}),
      ...(typeof row.message === "string" ? { message: row.message } : {}),
      ...(typeof row.snapshotPath === "string" ? { snapshotPath: row.snapshotPath } : {}),
      ...(typeof row.residual === "boolean" ? { residual: row.residual } : {}),
    });
  }
  return results;
}
