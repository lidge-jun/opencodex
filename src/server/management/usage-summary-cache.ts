import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../../lib/app-owned-memory";
import type { UsageSummary } from "../../usage/summary";

export type CachedUsageSummary = UsageSummary & {
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
};

export interface UsageSummaryCacheEntry {
  revisionKey: string;
  /** path/dev/ino/birthtime only; appends keep this stable. */
  identityKey: string;
  maxReadBytes: number;
  /** userCostOverlayVersion() when the summary was computed; overlay edits invalidate the entry. */
  overlayVersion: number;
  expiresAt: number;
  /** Generation freshness: ignore size/mtime until this instant. */
  freshUntil: number;
  lastSeenSize: number;
  summary: CachedUsageSummary;
  revisionReadAt: number;
  sizeBytes: number;
}

const usageSummaryCache = new Map<string, UsageSummaryCacheEntry>();
let usageSummaryCacheBytes = 0;
let oldestUsageSummaryKey: string | undefined;
let oldestUsageSummaryAt: number | null = null;

function recomputeOldestUsageSummary(): void {
  oldestUsageSummaryKey = undefined;
  oldestUsageSummaryAt = null;
  for (const [key, entry] of usageSummaryCache) {
    const readAt = entry.revisionReadAt;
    if (oldestUsageSummaryAt !== null && readAt >= oldestUsageSummaryAt) continue;
    oldestUsageSummaryKey = key;
    oldestUsageSummaryAt = readAt;
  }
}

function deleteUsageSummaryCacheEntry(key: string): number {
  const entry = usageSummaryCache.get(key);
  if (!entry) return 0;
  usageSummaryCache.delete(key);
  usageSummaryCacheBytes = Math.max(0, usageSummaryCacheBytes - entry.sizeBytes);
  if (oldestUsageSummaryKey === key) recomputeOldestUsageSummary();
  return entry.sizeBytes;
}

export function getUsageSummaryCacheEntry(key: string): UsageSummaryCacheEntry | undefined {
  return usageSummaryCache.get(key);
}

export function discardUsageSummaryCacheEntry(key: string): number {
  return deleteUsageSummaryCacheEntry(key);
}

export function setUsageSummaryCacheEntry(
  key: string,
  entry: Omit<UsageSummaryCacheEntry, "sizeBytes">,
): void {
  deleteUsageSummaryCacheEntry(key);
  const sizeBytes = Buffer.byteLength(JSON.stringify({ key, ...entry }), "utf8");
  usageSummaryCache.set(key, { ...entry, sizeBytes });
  usageSummaryCacheBytes += sizeBytes;
  if (oldestUsageSummaryAt === null || entry.revisionReadAt < oldestUsageSummaryAt) {
    oldestUsageSummaryKey = key;
    oldestUsageSummaryAt = entry.revisionReadAt;
  }
  enforceAppOwnedMemoryBudget();
}

export function usageSummaryRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: usageSummaryCache.size,
    bytes: usageSummaryCacheBytes,
    evictableBytes: usageSummaryCacheBytes,
    pinnedBytes: 0,
    oldestAt: oldestUsageSummaryAt,
  };
}

export function evictOldestUsageSummaryForBudget(): number {
  return oldestUsageSummaryKey === undefined ? 0 : deleteUsageSummaryCacheEntry(oldestUsageSummaryKey);
}

export function resetUsageSummaryCacheForTests(): void {
  usageSummaryCache.clear();
  usageSummaryCacheBytes = 0;
  oldestUsageSummaryKey = undefined;
  oldestUsageSummaryAt = null;
}
