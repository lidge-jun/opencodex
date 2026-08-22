import { createHash } from "node:crypto";
import { fromBinary } from "@bufbuild/protobuf";
import { ConversationStateStructureSchema, type ConversationStateStructure } from "./gen/agent_pb";
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
  | "upstream_invalid_argument"
  | "lineage_mismatch";

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
  prefixDigest?: string;
  systemDigest?: string;
}

interface CursorCheckpointStore {
  snapshots: Map<string, CursorCheckpointSnapshot>;
  prefixIndex: Map<string, Set<string>>;
  totalBytes: number;
}

const store: CursorCheckpointStore = {
  snapshots: new Map(),
  prefixIndex: new Map(),
  totalBytes: 0,
};

let nowFn = (): number => Date.now();
let scheduleFn = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};
let clearScheduleFn = (timer: ReturnType<typeof setTimeout>): void => {
  clearTimeout(timer);
};
let pruneTimer: ReturnType<typeof setTimeout> | undefined;

function now(): number {
  return nowFn();
}

export function installCursorCheckpointClockForTests(input: {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: (timer: ReturnType<typeof setTimeout>) => void;
}): void {
  if (input.now) nowFn = input.now;
  if (input.schedule) scheduleFn = input.schedule;
  if (input.clear) clearScheduleFn = input.clear;
}

export function resetCursorCheckpointClockForTests(): void {
  nowFn = () => Date.now();
  scheduleFn = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  };
  clearScheduleFn = timer => {
    clearTimeout(timer);
  };
  stopPruneTimer();
}

function stopPruneTimer(): void {
  if (pruneTimer !== undefined) clearScheduleFn(pruneTimer);
  pruneTimer = undefined;
}

function schedulePrune(at = now()): void {
  stopPruneTimer();
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const snapshot of store.snapshots.values()) {
    nextExpiry = Math.min(nextExpiry, snapshot.lastAccessAt + CURSOR_CHECKPOINT_TTL_MS);
  }
  if (!Number.isFinite(nextExpiry)) return;
  pruneTimer = scheduleFn(() => {
    pruneTimer = undefined;
    prune();
    schedulePrune();
  }, Math.max(0, nextExpiry - at));
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
  schedulePrune(at);
}

function indexPrefix(digest: string | undefined, ref: string): void {
  if (!digest) return;
  const refs = store.prefixIndex.get(digest) ?? new Set<string>();
  refs.add(ref);
  store.prefixIndex.set(digest, refs);
}

function unindexPrefix(digest: string | undefined, ref: string): void {
  if (!digest) return;
  const refs = store.prefixIndex.get(digest);
  if (!refs) return;
  refs.delete(ref);
  if (refs.size === 0) store.prefixIndex.delete(digest);
}

function deleteSnapshot(ref: string): void {
  const existing = store.snapshots.get(ref);
  if (!existing) return;
  if (existing.blobLease) releaseCursorBlobRequestScope(existing.blobLease);
  unindexPrefix(existing.prefixDigest, ref);
  store.snapshots.delete(ref);
  store.totalBytes = Math.max(0, store.totalBytes - existing.checkpointBytes.byteLength);
}

function collectStateBlobIds(state: ConversationStateStructure, ids: Uint8Array[]): void {
  ids.push(
    ...state.rootPromptMessagesJson,
    ...state.turns,
    ...state.turnsOld,
    ...state.todos,
    ...state.summaryArchives,
  );
  if (state.summary) ids.push(state.summary);
  if (state.summaryArchive) ids.push(state.summaryArchive);
  if (state.plan) ids.push(state.plan);
  for (const value of Object.values(state.fileStates)) ids.push(value);
  for (const value of Object.values(state.fileStatesV2)) {
    if (value.content) ids.push(value.content);
    if (value.initialContent) ids.push(value.initialContent);
  }
  for (const nested of Object.values(state.subagentStates)) {
    if (nested.conversationState) collectStateBlobIds(nested.conversationState, ids);
  }
}

function collectCheckpointBlobIds(checkpointBytes: Uint8Array): Uint8Array[] | undefined {
  try {
    const ids: Uint8Array[] = [];
    collectStateBlobIds(fromBinary(ConversationStateStructureSchema, checkpointBytes), ids);
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
  prefixDigest?: string;
  systemDigest?: string;
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
    ...(input.prefixDigest ? { prefixDigest: input.prefixDigest } : {}),
    ...(input.systemDigest ? { systemDigest: input.systemDigest } : {}),
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
  indexPrefix(snapshot.prefixDigest, ref);
  prune(createdAt);
  return store.snapshots.has(ref) ? ref : undefined;
}

export function getCursorCheckpointForPrefix(input: {
  prefixDigest: string;
  systemDigest: string;
  coveredMessageCount: number;
  identityScope?: string;
  modelId: string;
}): CursorCheckpointSnapshot | undefined {
  prune();
  const refs = store.prefixIndex.get(input.prefixDigest);
  if (!refs || refs.size !== 1) return undefined;
  const [ref] = refs;
  if (!ref) return undefined;
  const snapshot = getCursorCheckpoint(ref);
  if (!snapshot) return undefined;
  const identityScope = input.identityScope?.trim() || "local";
  if (snapshot.systemDigest !== input.systemDigest) return undefined;
  if (snapshot.coveredMessageCount !== input.coveredMessageCount) return undefined;
  if (snapshot.identityScope !== identityScope) return undefined;
  if (snapshot.modelId !== input.modelId) return undefined;
  return snapshot;
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
  stopPruneTimer();
  for (const ref of [...store.snapshots.keys()]) deleteSnapshot(ref);
  store.snapshots.clear();
  store.prefixIndex.clear();
  store.totalBytes = 0;
  resetCursorCheckpointClockForTests();
}

export function cursorCheckpointStoreMetricsForTests(): { count: number; totalBytes: number } {
  return { count: store.snapshots.size, totalBytes: store.totalBytes };
}
