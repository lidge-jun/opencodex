import type { PersistedUsageEntry } from "./log";
import { isLegacyCodexUsage, matchesUsageSource, snapshotConfiguredKeyIds, USAGE_SOURCE_CLIENTS,
  type UsageDeviceFilter, type UsageSourceClient, type UsageSourceFilter } from "./source-filter";
import type { UsageTimeWindow } from "./time-range";

/** Fold request rows once. Only currently configured IDs get individual counters. */
export function createSourceFacetAccumulator(filter: UsageSourceFilter, ids: readonly string[], window: UsageTimeWindow) {
  const configured = new Set(snapshotConfiguredKeyIds(ids));
  const apps = Object.fromEntries(USAGE_SOURCE_CLIENTS.map(client => [client, 0])) as Record<UsageSourceClient, number>;
  // Preserve every exact ID in `configured` for filtering, but do not advertise an
  // ID the wire contract cannot select (a padded ID cannot be safely trimmed).
  const selectable = [...configured].filter(id => id === id.trim()).sort();
  const unavailableConfiguredKeys = configured.size - selectable.length;
  const keys = new Map(selectable.map(id => [id, 0]));
  let all = 0;
  let noKey = 0;
  let unconfigured = 0;
  let legacyUnclassifiedRequests = 0;
  const selectedDevice = { ...filter.device };
  const matches = (entry: PersistedUsageEntry, client: UsageSourceClient, device: UsageDeviceFilter) =>
    matchesUsageSource(entry, { client, device }, configured);
  return {
    add(entry: PersistedUsageEntry) {
      if (!Number.isFinite(entry.timestamp) || entry.timestamp < window.since || entry.timestamp > window.until) return;
      for (const client of USAGE_SOURCE_CLIENTS) {
        if (matches(entry, client, selectedDevice)) apps[client] += 1;
      }
      // This is the unclassified subset of the Codex option, independently of the
      // currently selected app; the app facets all share the selected device scope.
      if (matches(entry, "codex", selectedDevice) && isLegacyCodexUsage(entry)) legacyUnclassifiedRequests += 1;
      if (!matches(entry, filter.client, { kind: "all" })) return;
      all += 1;
      if (entry.apiKeyId === undefined) noKey += 1;
      else if (keys.has(entry.apiKeyId)) keys.set(entry.apiKeyId, keys.get(entry.apiKeyId)! + 1);
      if (matches(entry, filter.client, { kind: "unconfigured" })) unconfigured += 1;
    },
    snapshot() {
      return {
        apps: { ...apps },
        devices: [
          { device: { kind: "all" as const }, requests: all },
          { device: { kind: "no-key" as const }, requests: noKey },
          ...[...keys].map(([id, requests]) => ({ device: { kind: "key" as const, id }, requests })),
          { device: { kind: "unconfigured" as const }, requests: unconfigured },
        ],
        legacyUnclassifiedRequests,
        unavailableConfiguredKeys,
      };
    },
  };
}
