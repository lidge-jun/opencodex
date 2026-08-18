import { createHash } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema } from "./gen/agent_pb";
import {
  createCursorBlobCheckpointLease,
  pinCursorBlobIdsForCheckpoint,
  releaseCursorBlobRequestScope,
  type CursorBlobRequestScopeToken,
} from "./native-exec";

export const CURSOR_CHECKPOINT_TTL_MS = 15 * 60_000;
export const CURSOR_CHECKPOINT_MAX_ENTRIES = 64;
export const CURSOR_CHECKPOINT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export type CursorCheckpointInvalidationReason =
  | "missing_ref"
  | "expired"
  | "decode_failed"
  | "conversation_changed"
  | "identity_changed"
  | "model_changed"
  | "compaction"
  | "trailing_tool_result"
  | "force_fresh"
  | "upstream_invalid_argument";

export interface CursorCheckpointSnapshot {
  ref: string;
  conversationId: string;
  identityScope: string;
  modelId: string;
  checkpointBytes: Uint8Array;
  createdAt: number;
  lastAccessAt: number;
  blobLease?: CursorBlobRequestScopeToken;
  coveredMessageCount?: number;
}

interface CursorCheckpointStore {
  snapshots: Map<string, CursorCheckpointSnapshot>;
  totalBytes: number;
}

const store: CursorCheckpointStore = {
  snapshots: new Map(),
  totalBytes: 0,
};

function now(): number {
  return Date.now();
}

function prune(at = now()): void {
  for (const [ref, snapshot] of store.snapshots) {
    if (at - snapshot.lastAccessAt > CURSOR_CHECKPOINT_TTL_MS) deleteSnapshot(ref);
  }
  while (store.snapshots.size > CURSOR_CHECKPOINT_MAX_ENTRIES || store.totalBytes > CURSOR_CHECKPOINT_MAX_TOTAL_BYTES) {
    const oldest = store.snapshots.keys().next().value;
    if (oldest === undefined) break;
    deleteSnapshot(oldest);
  }
}

function deleteSnapshot(ref: string): void {
  const existing = store.snapshots.get(ref);
  if (!existing) return;
  if (existing.blobLease) releaseCursorBlobRequestScope(existing.blobLease);
  store.snapshots.delete(ref);
  store.totalBytes = Math.max(0, store.totalBytes - existing.checkpointBytes.byteLength);
}

function collectCheckpointBlobIds(checkpointBytes: Uint8Array): Uint8Array[] | undefined {
  try {
    const state = fromBinary(ConversationStateStructureSchema, checkpointBytes);
    const ids: Uint8Array[] = [
      ...state.rootPromptMessagesJson,
      ...state.turns,
      ...state.turnsOld,
      ...state.todos,
      ...state.summaryArchives,
    ];
    if (state.summary) ids.push(state.summary);
    if (state.summaryArchive) ids.push(state.summaryArchive);
    if (state.plan) ids.push(state.plan);
    for (const value of Object.values(state.fileStates)) ids.push(value);
    for (const value of Object.values(state.fileStatesV2)) {
      if (value.content) ids.push(value.content);
      if (value.initialContent) ids.push(value.initialContent);
    }
    return ids.filter(id => id.byteLength > 0);
  } catch {
    return undefined;
  }
}

export function cursorCheckpointRefHash(ref: string): string {
  return createHash("sha256").update("ocx:cursor:ckpt-ref:").update(ref).digest("hex").slice(0, 16);
}

export function commitCursorCheckpoint(input: {
  conversationId: string;
  identityScope?: string;
  modelId: string;
  checkpointBytes: Uint8Array;
  coveredMessageCount?: number;
}): string | undefined {
  if (!input.conversationId || !input.modelId || input.checkpointBytes.byteLength === 0) return undefined;
  if (input.checkpointBytes.byteLength > CURSOR_CHECKPOINT_MAX_TOTAL_BYTES) return undefined;
  prune();
  const createdAt = now();
  const ref = createHash("sha256")
    .update("ocx:cursor:ckpt:")
    .update(input.conversationId)
    .update("|")
    .update(input.identityScope?.trim() || "local")
    .update("|")
    .update(input.modelId)
    .update("|")
    .update(String(createdAt))
    .update("|")
    .update(input.checkpointBytes)
    .digest("hex")
    .slice(0, 32);
  const snapshot: CursorCheckpointSnapshot = {
    ref,
    conversationId: input.conversationId,
    identityScope: input.identityScope?.trim() || "local",
    modelId: input.modelId,
    checkpointBytes: input.checkpointBytes.slice(),
    createdAt,
    lastAccessAt: createdAt,
    ...(input.coveredMessageCount !== undefined ? { coveredMessageCount: input.coveredMessageCount } : {}),
  };
  const blobIds = collectCheckpointBlobIds(input.checkpointBytes);
  if (blobIds === undefined) return undefined;
  if (blobIds.length > 0) {
    const lease = createCursorBlobCheckpointLease(ref);
    if (!pinCursorBlobIdsForCheckpoint(blobIds, lease)) {
      releaseCursorBlobRequestScope(lease);
      return undefined;
    }
    snapshot.blobLease = lease;
  }
  deleteSnapshot(ref);
  store.snapshots.set(ref, snapshot);
  store.totalBytes += snapshot.checkpointBytes.byteLength;
  prune(createdAt);
  return store.snapshots.has(ref) ? ref : undefined;
}

export function getLatestCursorCheckpoint(
  match: (snapshot: CursorCheckpointSnapshot) => boolean,
): CursorCheckpointSnapshot | undefined {
  prune();
  let found: CursorCheckpointSnapshot | undefined;
  for (const snapshot of store.snapshots.values()) {
    if (match(snapshot)) found = snapshot;
  }
  return found ? getCursorCheckpoint(found.ref) : undefined;
}

export function getCursorCheckpoint(ref: string | undefined): CursorCheckpointSnapshot | undefined {
  if (!ref) return undefined;
  prune();
  const snapshot = store.snapshots.get(ref);
  if (!snapshot) return undefined;
  const at = now();
  if (at - snapshot.lastAccessAt > CURSOR_CHECKPOINT_TTL_MS) {
    deleteSnapshot(ref);
    return undefined;
  }
  snapshot.lastAccessAt = at;
  store.snapshots.delete(ref);
  store.snapshots.set(ref, snapshot);
  return snapshot;
}

export function invalidateCursorCheckpoint(ref: string | undefined): void {
  if (!ref) return;
  deleteSnapshot(ref);
}

export function clearCursorCheckpointsForTests(): void {
  for (const ref of [...store.snapshots.keys()]) deleteSnapshot(ref);
  store.snapshots.clear();
  store.totalBytes = 0;
}

export function cursorCheckpointStoreMetricsForTests(): { count: number; totalBytes: number } {
  return { count: store.snapshots.size, totalBytes: store.totalBytes };
}
