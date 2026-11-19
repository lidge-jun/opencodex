import { readFileSync, statSync, type Stats } from "node:fs";
import { validReplayOwnerKey } from "./replay-owner";
import type {
  ResidentInput,
  ResidentResponseState,
  SpillFailedResponseState,
  SpilledResponseState,
  StoredResponseState,
} from "../state";
import type { ResponseSpillRef } from "../spill-store";
import type { OcxProviderContinuationState } from "../../types";

export interface SnapshotLoadStore {
  replaceMapEntry(id: string, next: StoredResponseState): void;
  stubSize(id: string, entry: Omit<SpilledResponseState, "sizeBytes">): number;
  tombstone(id: string, createdAt: number): SpillFailedResponseState;
  measureResidentEntry(id: string, entry: ResidentInput): ResidentResponseState | null;
  admitResident(id: string, candidate: ResidentResponseState): void;
}

interface SnapshotLoadResult {
  oversized: boolean;
  failed: boolean;
  fingerprint?: string;
}

function fileFingerprint(stat: Stats | undefined): string | undefined {
  return stat === undefined ? "absent" : stat.isFile()
    ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : undefined;
}

function missingFile(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A content-free stamp; an unreadable or non-regular file cannot validate cached admission. */
export function snapshotFileFingerprint(path: string): string | undefined {
  try { return fileFingerprint(statSync(path, { throwIfNoEntry: false })); }
  catch (error) { return missingFile(error) ? "absent" : undefined; }
}

/** Read failures are distinct from confirmed absence: neither callers nor cleanup may finalize them. */
export function loadSnapshotEntries(path: string, maxBytes: number, store: SnapshotLoadStore, cutoff = -Infinity): SnapshotLoadResult {
  try {
    // stat and read both follow symlinks. A FIFO or device could block or supply unbounded input.
    const stat = statSync(path, { throwIfNoEntry: false });
    const fingerprint = fileFingerprint(stat);
    // Confirmed absent/non-regular targets retain the existing empty-snapshot behavior.
    // A failed stat/read is different: the catch below leaves a later load possible.
    if (!stat?.isFile()) return { oversized: false, failed: false, fingerprint };
    if (stat.size > maxBytes) return { oversized: true, failed: false, fingerprint };
    const text = readFileSync(path, "utf-8");
    let raw: { version?: unknown; states?: unknown };
    try { raw = JSON.parse(text); }
    catch { return { oversized: false, failed: false, fingerprint }; }
    if (raw && (raw.version === 1 || raw.version === 2) && Array.isArray(raw.states)) {
      for (const entry of raw.states) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
        loadSnapshotEntry(entry[0], entry[1], store, cutoff);
      }
    }
    return { oversized: false, failed: false, fingerprint };
  } catch (error) {
    return missingFile(error) ? { oversized: false, failed: false, fingerprint: "absent" }
      : { oversized: false, failed: true };
  }
}

/** Decode and account live cold rows without running admission or disk maintenance. */
export function stageSnapshotEntries(path: string, maxBytes: number, store: SnapshotLoadStore, cutoff: number) {
  const entries = new Map<string, StoredResponseState>();
  let bytes = 0;
  const stage = (id: string, entry: StoredResponseState): void => {
    bytes += entry.sizeBytes - (entries.get(id)?.sizeBytes ?? 0);
    entries.delete(id);
    entries.set(id, entry);
  };
  const result = loadSnapshotEntries(path, maxBytes, { ...store, replaceMapEntry: stage, admitResident: stage }, cutoff);
  let oldestCreatedAt = Infinity;
  for (const entry of entries.values()) oldestCreatedAt = Math.min(oldestCreatedAt, entry.createdAt);
  return { path, entries, bytes, oldestCreatedAt, ...result };
}

interface LegacySnapshotState {
  createdAt?: unknown;
  clientThreadId?: unknown;
  replayOwnerKey?: unknown;
  items?: unknown;
  providers?: OcxProviderContinuationState;
  conversationId?: unknown;
  cursorCheckpointUsable?: unknown;
  unforcedStoreFalse?: unknown;
}

function isSpillRef(value: unknown): value is ResponseSpillRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as ResponseSpillRef;
  return ref.version === 1
    && typeof ref.fileName === "string"
    && /^[0-9a-f]{64}$/.test(ref.digest)
    && Number.isSafeInteger(ref.payloadBytes)
    && ref.payloadBytes >= 0;
}

function loadSnapshotEntry(id: string, value: unknown, store: SnapshotLoadStore, cutoff: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as LegacySnapshotState & { kind?: unknown; spill?: unknown };
  if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt) || rec.createdAt < cutoff) return;
  if (rec.replayOwnerKey !== undefined && !validReplayOwnerKey(rec.replayOwnerKey)) {
    store.replaceMapEntry(id, store.tombstone(id, rec.createdAt));
    return;
  }
  const replayOwnerKey = rec.replayOwnerKey;
  const clientThreadId = typeof rec.clientThreadId === "string" && rec.clientThreadId.trim().length > 0
    ? rec.clientThreadId.trim()
    : undefined;
  // A malformed boundary degrades to "never skip" rather than to a bad index: an untrusted
  // snapshot must not be able to authorize dropping conversation history.
  const anchorFor = (itemCount: number): number | undefined => {
    const raw = (rec as { providerOutputStart?: unknown }).providerOutputStart;
    return Number.isSafeInteger(raw) && (raw as number) >= 0 && (raw as number) <= itemCount
      ? raw as number
      : undefined;
  };
  // Restricted retention requires proven provider output; legacy unrestricted rows stay readable.
  if (rec.unforcedStoreFalse === true
    && anchorFor(rec.kind === "spill" ? Number.MAX_SAFE_INTEGER : Array.isArray(rec.items) ? rec.items.length : 0) === undefined) return;
  if (rec.kind === "spill") {
    if (!isSpillRef(rec.spill)) return;
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: rec.createdAt,
      ...(clientThreadId ? { clientThreadId } : {}),
      ...(replayOwnerKey ? { replayOwnerKey } : {}),
      // Item count is unknown until materialization, so accept any non-negative integer
      // here; the spill payload validator re-checks it against the real array.
      ...(anchorFor(Number.MAX_SAFE_INTEGER) !== undefined ? { providerOutputStart: anchorFor(Number.MAX_SAFE_INTEGER) } : {}),
      ...(rec.providers ? { providers: rec.providers } : {}),
      ...(rec.unforcedStoreFalse === true ? { unforcedStoreFalse: true } : {}),
      spill: rec.spill,
    };
    store.replaceMapEntry(id, { ...base, sizeBytes: store.stubSize(id, base) });
    return;
  }
  if (rec.kind === "spill-failed") {
    store.replaceMapEntry(id, store.tombstone(id, rec.createdAt));
    return;
  }
  if (rec.kind !== undefined && rec.kind !== "resident") return;
  if (!Array.isArray(rec.items)) return;
  const providers = rec.providers ?? (typeof rec.conversationId === "string"
    ? {
        cursor: {
          conversationId: rec.conversationId,
          ...(typeof rec.cursorCheckpointUsable === "boolean"
            ? { checkpointUsable: rec.cursorCheckpointUsable }
            : {}),
        },
      }
    : undefined);
  const resident = store.measureResidentEntry(id, {
    createdAt: rec.createdAt,
    ...(clientThreadId ? { clientThreadId } : {}),
    ...(replayOwnerKey ? { replayOwnerKey } : {}),
    items: rec.items,
    ...(anchorFor(rec.items.length) !== undefined ? { providerOutputStart: anchorFor(rec.items.length) } : {}),
    ...(providers ? { providers } : {}),
    ...(rec.unforcedStoreFalse === true ? { unforcedStoreFalse: true } : {}),
  });
  if (!resident) {
    store.replaceMapEntry(id, store.tombstone(id, rec.createdAt));
    return;
  }
  store.admitResident(id, resident);
}
