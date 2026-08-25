export interface RecentRouteEntry {
  requestId?: string;
  timestamp: number;
  model: string;
  requestedModel?: string;
  resolvedModel?: string;
  provider: string;
  status: number;
  attempts?: Array<{ ordinal: number }>;
  routeDecision?: {
    routeKind?: string;
    profile?: { id?: string; revision?: string };
    selected?: { provider?: string; model?: string };
  };
}

export interface RecentRoutePage {
  entries: RecentRouteEntry[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown, max = 300): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function parseRecentRouteEntry(value: unknown): RecentRouteEntry | null {
  const row = record(value);
  if (!row || typeof row.timestamp !== "number" || !Number.isFinite(row.timestamp)
    || typeof row.model !== "string" || !row.model || row.model.length > 300
    || typeof row.provider !== "string" || !row.provider || row.provider.length > 300
    || typeof row.status !== "number" || !Number.isInteger(row.status)) return null;
  const route = record(row.routeDecision);
  const profile = record(route?.profile);
  const selected = record(route?.selected);
  let attempts: Array<{ ordinal: number }> | undefined;
  if (row.attempts !== undefined) {
    if (!Array.isArray(row.attempts) || row.attempts.length > 100) return null;
    const parsed = row.attempts.map(record);
    if (parsed.some(attempt => !attempt || !Number.isInteger(attempt.ordinal) || Number(attempt.ordinal) < 1)) return null;
    attempts = parsed.map(attempt => ({ ordinal: Number(attempt!.ordinal) }));
  }
  return {
    requestId: optionalString(row.requestId, 200),
    timestamp: Number(row.timestamp),
    model: row.model,
    requestedModel: optionalString(row.requestedModel),
    resolvedModel: optionalString(row.resolvedModel),
    provider: row.provider,
    status: Number(row.status),
    attempts,
    routeDecision: route ? {
      routeKind: optionalString(route.routeKind, 80),
      profile: profile ? { id: optionalString(profile.id, 160), revision: optionalString(profile.revision, 160) } : undefined,
      selected: selected ? { provider: optionalString(selected.provider), model: optionalString(selected.model) } : undefined,
    } : undefined,
  };
}

async function validatedRecentRoutePage(response: Response): Promise<RecentRoutePage> {
  const payload: unknown = await response.json();
  const object = record(payload);
  const rows = Array.isArray(payload) ? payload : Array.isArray(object?.entries) ? object.entries : Array.isArray(object?.logs) ? object.logs : null;
  if (!rows || rows.length > 5) throw new Error("invalid_recent_route_page");
  const entries = rows.map(parseRecentRouteEntry);
  if (entries.some(entry => entry === null)) throw new Error("invalid_recent_route_entry");
  return { entries: entries as RecentRouteEntry[] };
}

export async function fetchRecentRoutes(apiBase: string, signal: AbortSignal): Promise<RecentRoutePage> {
  let response = await fetch(`${apiBase}/api/request-history?limit=5`, { signal });
  if (response.status === 404) response = await fetch(`${apiBase}/api/logs?limit=5`, { signal });
  if (!response.ok) throw new Error(String(response.status));
  return validatedRecentRoutePage(response);
}
