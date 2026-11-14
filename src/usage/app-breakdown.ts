import { normalizeRecordedClient, normalizeUsageClientName } from "./client";

/** Closed report categories; an absent historical client is kept distinct. */
export const USAGE_APPS = ["codex", "claude_code", "claude_desktop", "grok", "opencode", "aside", "other", "unknown", "unclassified"] as const;
export type UsageApp = typeof USAGE_APPS[number];

/** The wire a row predating client attribution arrived on; the only identity such a row has. */
export const USAGE_LEGACY_WIRES = ["responses", "chat", "messages", "claude", "claude-desktop", "grok"] as const;
export type UsageLegacyWire = typeof USAGE_LEGACY_WIRES[number];

export function usageApp(client: unknown): UsageApp {
  const normalized = normalizeRecordedClient(client);
  if (normalized === undefined) return "unclassified";
  if (normalized === "codex_cli" || normalized === "codex_desktop" || normalized === "codex_ide") return "codex";
  return normalized;
}

/** One apps row: the closed category plus the detail that names it more precisely, when known. */
export type UsageAppIdentity = { client: UsageApp; name?: string; legacyWire?: UsageLegacyWire };

export function usageAppIdentity(entry: { client?: unknown; clientName?: unknown; surface?: unknown; inboundProtocol?: unknown }): UsageAppIdentity {
  const client = usageApp(entry.client);
  if (client === "unknown") {
    const name = normalizeUsageClientName(entry.clientName);
    return name ? { client, name } : { client };
  }
  if (client !== "unclassified") return { client };
  const wire = typeof entry.surface === "string" ? entry.surface : entry.inboundProtocol;
  return (USAGE_LEGACY_WIRES as readonly unknown[]).includes(wire) ? { client, legacyWire: wire as UsageLegacyWire } : { client };
}

/** Distinct names one report keeps before folding the rest into the plain unknown row. */
export const MAX_USAGE_APP_NAMES = 24;

export function usageAppKey(identity: UsageAppIdentity): string {
  return identity.name ? `${identity.client}\0n:${identity.name}`
    : identity.legacyWire ? `${identity.client}\0w:${identity.legacyWire}` : identity.client;
}

export function usageAppFromKey(key: string): UsageAppIdentity {
  const [client, detail] = key.split("\0") as [UsageApp, string | undefined];
  if (detail?.startsWith("n:")) return { client, name: detail.slice(2) };
  if (detail?.startsWith("w:")) return { client, legacyWire: detail.slice(2) as UsageLegacyWire };
  return { client };
}

export interface UsageAppSummary extends UsageAppIdentity {
  requests: number;
  measuredRequests: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  pricedRequests: number;
  unpricedRequests: number;
  shareRatio: number;
}

/** Per-partition key budget: every closed category and legacy wire, plus the named clients. */
export const MAX_PARTITION_APP_KEYS = USAGE_APPS.length + USAGE_LEGACY_WIRES.length + MAX_USAGE_APP_NAMES;

type AppTotals = { requests: number; measuredRequests: number; totalTokens: number; estimatedCostUsd: number; pricedRequests: number; unpricedRequests: number; unmeteredRequests: number };

/** Report rows, biggest first; named clients past `MAX_USAGE_APP_NAMES` fold into plain unknown. */
export function foldUsageAppRows(apps: ReadonlyMap<string, AppTotals>, totalTokens: number): UsageAppSummary[] {
  const merged = new Map<string, AppTotals>();
  let names = 0;
  for (const [key, app] of [...apps].sort(([, a], [, b]) => b.totalTokens - a.totalTokens)) {
    const identity = usageAppFromKey(key);
    const target = identity.name && ++names > MAX_USAGE_APP_NAMES ? identity.client : key;
    const into = merged.get(target);
    merged.set(target, into ? {
      requests: into.requests + app.requests, measuredRequests: into.measuredRequests + app.measuredRequests,
      totalTokens: into.totalTokens + app.totalTokens, estimatedCostUsd: into.estimatedCostUsd + app.estimatedCostUsd,
      pricedRequests: into.pricedRequests + app.pricedRequests, unpricedRequests: into.unpricedRequests + app.unpricedRequests,
      unmeteredRequests: into.unmeteredRequests + app.unmeteredRequests,
    } : app);
  }
  return [...merged].map(([key, app]) => ({
    ...usageAppFromKey(key), requests: app.requests, measuredRequests: app.measuredRequests, totalTokens: app.totalTokens,
    ...(app.pricedRequests ? { estimatedCostUsd: app.estimatedCostUsd } : {}), pricedRequests: app.pricedRequests,
    unpricedRequests: app.unpricedRequests + app.unmeteredRequests,
    shareRatio: totalTokens === 0 ? 0 : Math.min(1, app.totalTokens / totalTokens),
  }));
}
