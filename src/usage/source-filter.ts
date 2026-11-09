import type { PersistedUsageEntry } from "./log";

export const USAGE_SOURCE_CLIENTS = [
  "all", "codex", "claude_code", "claude_desktop", "grok", "opencode", "aside", "other", "unknown",
] as const;
export type UsageSourceClient = (typeof USAGE_SOURCE_CLIENTS)[number];
/**
 * The client labels a `codex` source filter includes, beyond legacy Codex-surface rows.
 *
 * The SQL candidate index derives its `IN (...)` list from this roster, so adding a Codex
 * client here cannot silently narrow a filtered usage query.
 */
export const USAGE_CODEX_CLIENT_LABELS = ["codex_cli", "codex_desktop", "codex_ide"] as const;
export type UsageDeviceFilter = { kind: "all" | "no-key" | "unconfigured" } | { kind: "key"; id: string };
export interface UsageSourceFilter { client: UsageSourceClient; device: UsageDeviceFilter }

/** Reject excessive snapshots instead of truncating identity or retaining unbounded keys. */
export const MAX_USAGE_CONFIGURED_KEYS = 1024;
export function snapshotConfiguredKeyIds(ids: readonly string[]): string[] {
  if (ids.length > MAX_USAGE_CONFIGURED_KEYS) throw new Error("configured key snapshot exceeds limit");
  let size = 0;
  for (const id of ids) {
    if (typeof id !== "string" || !id || id.length > 256 || (size += id.length) > 65536) {
      throw new Error("configured key snapshot exceeds limit");
    }
  }
  return [...new Set(ids)].sort();
}

/** Old rows in the historic Codex surface are disclosed as unclassified, never as a subtype. */
export function isLegacyCodexUsage(entry: PersistedUsageEntry): boolean {
  return entry.client === undefined && entry.surface === undefined;
}

export function matchesUsageSource(entry: PersistedUsageEntry, filter: UsageSourceFilter, configuredIds?: ReadonlySet<string>): boolean {
  const device = filter.device;
  if (device.kind === "no-key" && entry.apiKeyId !== undefined) return false;
  if (device.kind === "key" && entry.apiKeyId !== device.id) return false;
  if (device.kind === "unconfigured" && (!configuredIds || entry.admissionKind !== "configured"
    || !entry.apiKeyId || configuredIds.has(entry.apiKeyId))) return false;
  if (filter.client === "all") return true;
  if (filter.client === "codex") {
    return isLegacyCodexUsage(entry)
      || (entry.client !== undefined
        && (USAGE_CODEX_CLIENT_LABELS as readonly string[]).includes(entry.client));
  }
  if (filter.client === "unknown") return entry.client === "unknown" || (entry.client === undefined && !isLegacyCodexUsage(entry));
  return entry.client === filter.client;
}

export type ParsedUsageSource =
  | { kind: "legacy" }
  | { kind: "invalid" }
  | { kind: "filtered"; filter: UsageSourceFilter };

/** Parse a management query without letting absent or malformed fields broaden its scope. */
export function parseUsageSource(params: URLSearchParams): ParsedUsageSource {
  if (!params.has("client") && !params.has("device")) return { kind: "legacy" };
  if (params.getAll("client").length !== 1 || params.getAll("device").length !== 1
    || params.getAll("surface").length > 1 || params.getAll("apiKeyId").length > 1
    || (params.has("surface") && params.get("surface") !== "all")
    || params.has("jev") || params.has("failures")) return { kind: "invalid" };
  const client = params.get("client");
  const device = params.get("device");
  if (!client || !(USAGE_SOURCE_CLIENTS as readonly string[]).includes(client)) return { kind: "invalid" };
  if (device === "key") {
    const id = params.get("apiKeyId");
    if (!id || id !== id.trim()) return { kind: "invalid" };
    return { kind: "filtered", filter: { client: client as UsageSourceClient, device: { kind: "key", id } } };
  }
  if ((device !== "all" && device !== "no-key" && device !== "unconfigured") || params.has("apiKeyId")) return { kind: "invalid" };
  return { kind: "filtered", filter: { client: client as UsageSourceClient, device: { kind: device } } };
}
