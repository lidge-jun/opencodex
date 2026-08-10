import type { OcxConfig, OcxEconomicAllowance, OcxEconomicSnapshot } from "../types";
import {
  currentUsageLogRevision,
  readRecentUsageEntries,
  usageLogRevisionKey,
  type PersistedUsageEntry,
} from "../usage/log";
import {
  getEconomicQuotaSnapshot,
  setEconomicQuotaSnapshot,
} from "./economy";

let lastRevisionKey: string | null = null;
let refreshInflight: Promise<void> | null = null;

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function usageAmount(allowance: OcxEconomicAllowance, entry: PersistedUsageEntry): number {
  if (allowance.unit === "requests") return 1;
  if (allowance.unit === "inputTokens") return nonNegative(entry.usage?.inputTokens);
  if (allowance.unit === "outputTokens") return nonNegative(entry.usage?.outputTokens);
  return nonNegative(entry.totalTokens ?? (entry.usage
    ? entry.usage.inputTokens + entry.usage.outputTokens
    : 0));
}

function entryMatchesAllowance(allowance: OcxEconomicAllowance, entry: PersistedUsageEntry): boolean {
  const match = allowance.usageMatch;
  if (!match) return true;
  if (match.providers && match.providers.length > 0 && !match.providers.includes(entry.provider)) return false;
  if (match.models && match.models.length > 0 && !match.models.includes(entry.model)) return false;
  return true;
}

function snapshotFor(
  allowance: OcxEconomicAllowance,
  entries: PersistedUsageEntry[],
  now: number,
): OcxEconomicSnapshot {
  // The remaining value is computed from usage over the just-closed window, but it
  // applies to the CURRENT window starting now — so the snapshot advertises
  // windowStart = now. A boundary of now - durationMs would make the snapshot look
  // immediately rolled-over.
  // Unscoped usage-log is experimental: when usageMatch is absent the allowance
  // sums every provider/model in the log. Prefer scoping with usageMatch.providers/models.
  const filterStart = allowance.window.kind === "rolling" ? now - allowance.window.durationMs : undefined;
  const used = entries
    .filter(entry => filterStart === undefined || entry.timestamp >= filterStart)
    .filter(entry => entryMatchesAllowance(allowance, entry))
    .reduce((total, entry) => total + usageAmount(allowance, entry), 0);
  return {
    remaining: Math.max(0, allowance.capacity - used),
    updatedAt: now,
    source: "usage-log",
    confidence: "estimated",
    ...(allowance.window.kind === "rolling" ? { windowStart: now } : {}),
  };
}

function allowanceConfigKey(config: OcxConfig): string {
  return Object.entries(config.economicAllowances ?? {})
    .filter(([, allowance]) => allowance.source === "usage-log")
    .map(([id, allowance]) => `${id}:${JSON.stringify(allowance)}`)
    .sort()
    .join("\0");
}

function markRefreshFailure(config: OcxConfig, error: unknown): void {
  const message = error instanceof Error ? error.message : "refresh failed";
  for (const [id, allowance] of Object.entries(config.economicAllowances ?? {})) {
    if (allowance.source !== "usage-log") continue;
    const previous = getEconomicQuotaSnapshot(id);
    if (!previous) continue;
    setEconomicQuotaSnapshot(id, {
      ...previous,
      confidence: "estimated",
      error: message.slice(0, 200),
    });
  }
}

async function performRefresh(config: OcxConfig, now: number): Promise<void> {
  let revisionKey: string;
  try {
    revisionKey = `${usageLogRevisionKey(currentUsageLogRevision())}\0${allowanceConfigKey(config)}`;
    if (revisionKey === lastRevisionKey) return;
    const entries = readRecentUsageEntries(2000);
    const prepared = new Map<string, OcxEconomicSnapshot>();
    for (const [id, allowance] of Object.entries(config.economicAllowances ?? {})) {
      if (allowance.source !== "usage-log") continue;
      prepared.set(id, snapshotFor(allowance, entries, now));
    }
    for (const [id, snapshot] of prepared) setEconomicQuotaSnapshot(id, snapshot);
    lastRevisionKey = revisionKey;
  } catch (error) {
    markRefreshFailure(config, error);
    lastRevisionKey = null;
  }
}

export function refreshEconomicSnapshots(config: OcxConfig, now = Date.now()): Promise<void> {
  if (refreshInflight) return refreshInflight;
  const promise = performRefresh(config, now).finally(() => {
    if (refreshInflight === promise) refreshInflight = null;
  });
  refreshInflight = promise;
  return promise;
}

export function resetEconomicSnapshotRefreshForTests(): void {
  lastRevisionKey = null;
  refreshInflight = null;
}

export function stopEconomicSnapshotRefresh(): void {
  refreshInflight = null;
}
