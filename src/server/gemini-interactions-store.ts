/**
 * Stored Gemini interactions: the history behind `previous_interaction_id` and the resource behind
 * `GET /v1beta/interactions/{id}`.
 *
 * Process memory only: nothing is written to disk or the request log, and a restart forgets every
 * interaction (clients then get 404 and resend history). Every entry belongs to one owner string the
 * caller resolves (the salted principal of the presented data-plane key, or "loopback" for a keyless
 * loopback caller); a lookup by any other owner is indistinguishable from a missing id. Expiry is lazy:
 * an expired entry is dropped on the next write or lookup, and the app-owned memory budget can evict it
 * before that. Bounds: 24 hours from the last
 * write, 1,000 entries and 64 MiB in total, 200 entries and 16 MiB per owner, 8 MiB per entry. A write
 * evicts only its own owner's entries; when the store is full and the writer owns nothing to evict, the
 * interaction is not kept. Only the app-owned memory budget evicts across owners.
 */
import type { RetainedStoreSnapshot } from "../lib/app-owned-memory";

export const INTERACTION_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_STORED_INTERACTIONS = 1_000;
export const MAX_INTERACTION_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_OWNER_INTERACTIONS = 200;
export const MAX_OWNER_INTERACTION_BYTES = 16 * 1024 * 1024;
export const MAX_INTERACTION_BYTES = 8 * 1024 * 1024;

export interface StoredInteraction {
  id: string;
  owner: string;
  /** Chat messages that continue the conversation (no system role). */
  history: Record<string, unknown>[];
  /** The GET body: the interaction resource with input and output steps. */
  resource: Record<string, unknown>;
  bytes: number;
  writtenAt: number;
}

const entries = new Map<string, StoredInteraction>();
const ownerTotals = new Map<string, { count: number; bytes: number }>();
let totalBytes = 0;

function drop(id: string): void {
  const entry = entries.get(id);
  if (!entry) return;
  entries.delete(id);
  totalBytes -= entry.bytes;
  const totals = ownerTotals.get(entry.owner);
  if (totals) {
    totals.count -= 1;
    totals.bytes -= entry.bytes;
    if (totals.count <= 0) ownerTotals.delete(entry.owner);
  }
}

function sweep(now: number): void {
  for (const [id, entry] of entries) {
    // Insertion order is write order, but a clock that steps back must not hide an older entry.
    if (now - entry.writtenAt >= INTERACTION_TTL_MS) drop(id);
  }
}

function oldestOf(owner: string): string | undefined {
  for (const [id, entry] of entries) if (entry.owner === owner) return id;
  return undefined;
}

export function interactionEntryBytes(entry: Pick<StoredInteraction, "history" | "resource">): number {
  return Buffer.byteLength(JSON.stringify(entry.history)) + Buffer.byteLength(JSON.stringify(entry.resource));
}

/** Store an interaction. Returns false when it is too large to keep; the answer is unaffected. */
export function rememberInteraction(
  entry: { id: string; owner: string; history: Record<string, unknown>[]; resource: Record<string, unknown> },
  now = Date.now(),
  maxBytes = MAX_INTERACTION_BYTES,
): boolean {
  const bytes = interactionEntryBytes(entry);
  if (bytes > Math.min(maxBytes, MAX_INTERACTION_BYTES)) return false;
  drop(entry.id);
  sweep(now);
  const owned = () => ownerTotals.get(entry.owner) ?? { count: 0, bytes: 0 };
  while (owned().count + 1 > MAX_OWNER_INTERACTIONS || owned().bytes + bytes > MAX_OWNER_INTERACTION_BYTES) {
    const oldest = oldestOf(entry.owner);
    if (oldest === undefined) break;
    drop(oldest);
  }
  // At the global limits a writer evicts only its own oldest entries; with none left, this one is
  // not kept (the answer is unaffected), so one key's traffic never removes another's history.
  while (entries.size + 1 > MAX_STORED_INTERACTIONS || totalBytes + bytes > MAX_INTERACTION_STORE_BYTES) {
    const oldest = oldestOf(entry.owner);
    if (oldest === undefined) return false;
    drop(oldest);
  }
  entries.set(entry.id, { ...entry, bytes, writtenAt: now });
  totalBytes += bytes;
  const totals = owned();
  ownerTotals.set(entry.owner, { count: totals.count + 1, bytes: totals.bytes + bytes });
  return true;
}

export function recallInteraction(id: string, owner: string | undefined, now = Date.now()): Readonly<StoredInteraction> | undefined {
  const entry = entries.get(id);
  if (!entry || owner === undefined || entry.owner !== owner) return undefined;
  if (now - entry.writtenAt >= INTERACTION_TTL_MS) { drop(id); return undefined; }
  return entry;
}

export function forgetInteraction(id: string, owner: string | undefined, now = Date.now()): boolean {
  if (!recallInteraction(id, owner, now)) return false;
  drop(id);
  return true;
}

/** App-owned memory accounting: every entry is plain memory and may be evicted oldest first. */
export function interactionsRetainedStoreSnapshot(): RetainedStoreSnapshot {
  const oldest = entries.values().next().value;
  return { count: entries.size, bytes: totalBytes, evictableBytes: totalBytes, pinnedBytes: 0, oldestAt: oldest ? oldest.writtenAt : null };
}

export function evictOldestInteractionForBudget(): number {
  const oldest = entries.keys().next().value;
  if (oldest === undefined) return 0;
  const bytes = entries.get(oldest)!.bytes;
  drop(oldest);
  return bytes;
}

export function clearInteractionsForTests(): void {
  entries.clear();
  ownerTotals.clear();
  totalBytes = 0;
}
