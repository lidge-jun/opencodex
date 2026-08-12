/** Shared route-decision validation for Logs session-cache / API rows. */

export interface LogRouteDecision {
  routeKind?: string;
  profile?: { id?: string; revision?: string };
  selected?: { provider?: string; model?: string; reason?: string };
  candidates?: Array<{ provider?: string; model?: string; eligible?: boolean; exclusions?: Array<{ code?: string }> }>;
}

export interface LogEntryBase {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs: number;
  routeDecision?: LogRouteDecision;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Session-cache / API entries are arbitrary JSON — reject shapes that would crash the detail panel. */
export function validCachedRouteDecision(routeDecision: LogRouteDecision | undefined): boolean {
  if (routeDecision === undefined) return true;
  if (!routeDecision || typeof routeDecision !== "object") return false;
  if (!isOptionalString(routeDecision.routeKind)) return false;
  if (routeDecision.profile !== undefined) {
    if (!routeDecision.profile || typeof routeDecision.profile !== "object") return false;
    if (!isOptionalString(routeDecision.profile.id)) return false;
    if (!isOptionalString(routeDecision.profile.revision)) return false;
  }
  if (routeDecision.selected !== undefined) {
    if (!routeDecision.selected || typeof routeDecision.selected !== "object") return false;
    if (!isOptionalString(routeDecision.selected.provider)) return false;
    if (!isOptionalString(routeDecision.selected.model)) return false;
    if (!isOptionalString(routeDecision.selected.reason)) return false;
  }
  if (routeDecision.candidates === undefined) return true;
  if (!Array.isArray(routeDecision.candidates)) return false;
  for (const candidate of routeDecision.candidates) {
    if (!candidate || typeof candidate !== "object") return false;
    if (!isOptionalString(candidate.provider)) return false;
    if (!isOptionalString(candidate.model)) return false;
    if (candidate.eligible !== undefined && typeof candidate.eligible !== "boolean") return false;
    if (candidate.exclusions !== undefined) {
      if (!Array.isArray(candidate.exclusions)) return false;
      for (const exclusion of candidate.exclusions) {
        if (!exclusion || typeof exclusion !== "object") return false;
        if (!isOptionalString(exclusion.code)) return false;
      }
    }
  }
  return true;
}

export function sanitizeLogEntryRouteDecision<T extends LogEntryBase>(entry: T): T {
  if (entry.routeDecision === undefined) return entry;
  if (validCachedRouteDecision(entry.routeDecision)) return entry;
  const rest = { ...entry };
  delete rest.routeDecision;
  return rest;
}
