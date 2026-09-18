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
  replaceMapEntry(id: string, next: StoredResponseState, expected?: StoredResponseState): boolean;
  stubSize(id: string, entry: Omit<SpilledResponseState, "sizeBytes">): number;
  tombstone(id: string, createdAt: number): SpillFailedResponseState;
  measureResidentEntry(id: string, entry: ResidentInput): ResidentResponseState | null;
  admitOversizedCandidate(id: string, candidate: ResidentResponseState, expected?: StoredResponseState): void;
  byteCap(): number;
}

interface LegacySnapshotState {
  createdAt?: unknown;
  clientThreadId?: unknown;
  items?: unknown;
  providers?: OcxProviderContinuationState;
  conversationId?: unknown;
  cursorCheckpointUsable?: unknown;
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

export function loadSnapshotEntry(id: string, value: unknown, store: SnapshotLoadStore): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as LegacySnapshotState & { kind?: unknown; spill?: unknown };
  if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) return;
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
  if (rec.kind === "spill") {
    if (!isSpillRef(rec.spill)) return;
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: rec.createdAt,
      ...(clientThreadId ? { clientThreadId } : {}),
      // Item count is unknown until materialization, so accept any non-negative integer
      // here; the spill payload validator re-checks it against the real array.
      ...(anchorFor(Number.MAX_SAFE_INTEGER) !== undefined ? { providerOutputStart: anchorFor(Number.MAX_SAFE_INTEGER) } : {}),
      ...(rec.providers ? { providers: rec.providers } : {}),
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
    items: rec.items,
    ...(anchorFor(rec.items.length) !== undefined ? { providerOutputStart: anchorFor(rec.items.length) } : {}),
    ...(providers ? { providers } : {}),
  });
  if (!resident) {
    store.replaceMapEntry(id, store.tombstone(id, rec.createdAt));
    return;
  }
  // Same admission boundary as live writes: an oversized snapshot row goes
  // straight to spill (or tombstone above the payload ceiling) instead of
  // entering the resident map and demoting unrelated rows on the first prune.
  if (resident.sizeBytes > store.byteCap()) {
    store.admitOversizedCandidate(id, resident, undefined);
    return;
  }
  store.replaceMapEntry(id, resident);
}
