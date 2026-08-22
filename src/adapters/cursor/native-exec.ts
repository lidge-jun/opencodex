import { createHash } from "node:crypto";
import { enforceAppOwnedMemoryBudget } from "../../lib/app-owned-memory";
import { create } from "@bufbuild/protobuf";
import {
  DiagnosticsErrorSchema,
  DiagnosticsResultSchema,
  ErrorSchema,
  GetBlobResultSchema,
  KvClientMessageSchema,
  McpErrorSchema,
  McpResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  type ExecServerMessage,
  type KvServerMessage,
} from "./gen/agent_pb";
import {
  deleteExec,
  grepExec,
  lsExec,
  readExec,
  rejectDeleteExecForApplyPatch,
  rejectDeleteExecForPolicy,
  rejectGrepExecForPolicy,
  rejectLsExecForPolicy,
  rejectReadExecForPolicy,
  rejectWriteExecForApplyPatch,
  rejectWriteExecForPolicy,
  writeExec,
} from "./native-exec-fs";
import { debugProviderDiagnostic } from "../../lib/debug";
import { fetchExec, rejectFetchExecForPolicy, type CursorNativeNetworkDeps } from "./native-exec-network";
import {
  backgroundShellSpawnExec,
  rejectBackgroundShellSpawnExecForPolicy,
  rejectShellExecForPolicy,
  rejectShellStreamExecForPolicy,
  rejectWriteShellStdinExecForPolicy,
  shellExec,
  shellStreamExec,
  writeShellStdinExec,
} from "./native-exec-shell";
import {
  computerUseExec,
  listMcpResourcesExec,
  mcpExec,
  readMcpResourceExec,
  recordScreenExec,
  type CursorNativeToolDeps,
} from "./native-exec-tools";
import { clientBytes, execBytes } from "./native-exec-common";
import type { McpToolDefinition } from "./gen/agent_pb";
import { OCX_RESPONSES_TOOL_PROVIDER } from "./tool-definitions";

export type CursorNativeExecDeps = CursorNativeNetworkDeps & CursorNativeToolDeps;

/**
 * Execution context for a Cursor stream: the per-call executors plus the MCP tool definitions
 * advertised to the server via `requestContextResult`. Without `mcpToolDefs`, the server is
 * never told any MCP tools exist, so it never sends `mcpArgs`.
 */
export interface CursorNativeExecContext extends CursorNativeExecDeps {
  /** Stable owner for background shells created by this transport session. */
  sessionId?: string;
  mcpToolDefs?: McpToolDefinition[];
  clientToolDefs?: McpToolDefinition[];
  /** Unsafe opt-in escape hatch for Cursor server-driven local fs/shell/fetch execution. */
  unsafeAllowNativeLocalExec?: boolean;
  /** apply_patch is visible for this request; Cursor-native write/delete must not bypass Codex. */
  rejectNativeFileMutations?: boolean;
  /** The synthetic exact-match edit tools (edit_file / multi_edit) are advertised this request. */
  structuredEditAvailable?: boolean;
}

export function cursorUnsafeNativeLocalExecEnabled(input: Pick<CursorNativeExecContext, "unsafeAllowNativeLocalExec"> = {}): boolean {
  return input.unsafeAllowNativeLocalExec === true;
}

/**
 * Content-addressed blob store shared across streams. Bounded: without eviction a long-running
 * proxy accumulates every conversation's prompt blobs forever (unbounded memory) and any stale
 * blob stays servable indefinitely — a cross-conversation contamination enabler if Cursor's
 * server-side state ever references old ids (devlog 260702 P0). Continuation requests re-store
 * their blobs on every turn (`rootPromptMessages` → `storeCursorBlob`), so TTL + cap eviction is
 * safe for live sessions: only genuinely abandoned entries age out.
 */
const BLOB_TTL_MS = 15 * 60_000;
const BLOB_MAX_ENTRIES = 4_096;
const BLOB_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
export const CURSOR_BLOB_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

type CursorBlobProvenance = "local-regenerated" | "remote-setBlobArgs";
export type CursorBlobRequestScopeToken = symbol;

interface CursorBlobEntry {
  data: Uint8Array;
  storedAt: number;
  sizeBytes: number;
  provenance: CursorBlobProvenance;
  requestPins: Set<CursorBlobRequestScopeToken>;
}

type CursorBlobRejectionReason = "entry_too_large" | "pinned_saturation" | "request_pinned_conflict";
type CursorBlobAdmission =
  | { admitted: true; replaced: boolean }
  | { admitted: false; reason: CursorBlobRejectionReason };

interface CursorBlobLimits {
  ttlMs: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

interface CursorBlobRequestScopeState {
  keys: Set<string>;
  sealed: boolean;
  kind: "request" | "checkpoint";
}

const DEFAULT_BLOB_LIMITS: CursorBlobLimits = {
  ttlMs: BLOB_TTL_MS,
  maxEntries: BLOB_MAX_ENTRIES,
  maxEntryBytes: BLOB_MAX_ENTRY_BYTES,
  maxTotalBytes: CURSOR_BLOB_MAX_TOTAL_BYTES,
};

const blobs = new Map<string, CursorBlobEntry>();
const blobRequestScopes = new Map<CursorBlobRequestScopeToken, CursorBlobRequestScopeState>();
let blobLimits = { ...DEFAULT_BLOB_LIMITS };
let blobBytes = 0;
/** Retained key-string bytes (separate from the payload cap — see key()). */
let blobKeyBytes = 0;
let blobLocalBytes = 0;
let blobPinnedBytes = 0;
let blobEvictableBytes = 0;
let blobOldestEvictableAt: number | null = null;
let rejectedEntryTooLarge = 0;
let rejectedPinnedSaturation = 0;
let blobExpiryAccountingTimer: ReturnType<typeof setTimeout> | undefined;

function isExpired(entry: CursorBlobEntry, now: number): boolean {
  return now - entry.storedAt >= blobLimits.ttlMs;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function recomputeBlobClassAccounting(): void {
  const now = Date.now();
  let localBytes = 0;
  let pinnedBytes = 0;
  let evictableBytes = 0;
  let oldestAt: number | null = null;
  for (const [k, entry] of blobs) {
    const requestPinned = entry.requestPins.size > 0;
    const provenancePinned = entry.provenance === "remote-setBlobArgs" && !isExpired(entry, now);
    if (entry.provenance === "local-regenerated") localBytes += entry.sizeBytes;
    // Key strings classify WITH their entry: a zero-payload blob must stay
    // evictable/pinned exactly as its payload would be, or the budget cannot
    // select it even though the total snapshot counts its key.
    if (requestPinned || provenancePinned) pinnedBytes += entry.sizeBytes + k.length;
    if (!requestPinned && (entry.provenance === "local-regenerated" || isExpired(entry, now))) {
      evictableBytes += entry.sizeBytes + k.length;
      oldestAt = oldestAt === null ? entry.storedAt : Math.min(oldestAt, entry.storedAt);
    }
  }
  blobLocalBytes = localBytes;
  blobPinnedBytes = pinnedBytes;
  blobEvictableBytes = evictableBytes;
  blobOldestEvictableAt = oldestAt;
  scheduleBlobExpiryAccounting(now);
}

function reconcileBlobClassAccountingAndEnforce(): void {
  recomputeBlobClassAccounting();
  enforceAppOwnedMemoryBudget();
}

function scheduleBlobExpiryAccounting(now: number): void {
  if (blobExpiryAccountingTimer) clearTimeout(blobExpiryAccountingTimer);
  blobExpiryAccountingTimer = undefined;
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const entry of blobs.values()) {
    if (entry.provenance !== "remote-setBlobArgs" || entry.requestPins.size > 0) continue;
    const expiresAt = entry.storedAt + blobLimits.ttlMs;
    if (expiresAt > now) nextExpiry = Math.min(nextExpiry, expiresAt);
  }
  if (!Number.isFinite(nextExpiry)) return;
  blobExpiryAccountingTimer = setTimeout(() => {
    blobExpiryAccountingTimer = undefined;
    reconcileBlobClassAccountingAndEnforce();
  }, Math.max(0, nextExpiry - now));
  blobExpiryAccountingTimer.unref?.();
}

function deleteBlob(k: string, recompute = true): number {
  const entry = blobs.get(k);
  if (!entry) return 0;
  blobs.delete(k);
  blobBytes -= entry.sizeBytes;
  blobKeyBytes -= k.length;
  for (const scope of entry.requestPins) blobRequestScopes.get(scope)?.keys.delete(k);
  if (recompute) recomputeBlobClassAccounting();
  // Full logical release (payload + key): the retained-store snapshot counts
  // both, so budget enforcement must see both leave.
  return entry.sizeBytes + k.length;
}

function releaseHydratedBlob(k: string, requestScope?: CursorBlobRequestScopeToken): void {
  const entry = blobs.get(k);
  if (!entry) return;
  const scopes = requestScope ? [requestScope] : [...entry.requestPins];
  let changed = false;
  for (const scope of scopes) {
    if (!entry.requestPins.delete(scope)) continue;
    changed = true;
    const state = blobRequestScopes.get(scope);
    state?.keys.delete(k);
    if (state?.sealed && state.keys.size === 0) blobRequestScopes.delete(scope);
  }
  if (changed) reconcileBlobClassAccountingAndEnforce();
}

function setBlob(
  k: string,
  data: Uint8Array,
  provenance: CursorBlobProvenance,
  requestScope?: CursorBlobRequestScopeToken,
): CursorBlobAdmission {
  if (data.byteLength > blobLimits.maxEntryBytes) {
    rejectedEntryTooLarge++;
    return { admitted: false, reason: "entry_too_large" };
  }

  const now = Date.now();
  const existing = blobs.get(k);
  const sameData = existing ? bytesEqual(existing.data, data) : false;
  if (existing && !sameData && existing.requestPins.size > 0) {
    return { admitted: false, reason: "request_pinned_conflict" };
  }

  const removals = new Set<string>();
  for (const [candidateKey, entry] of blobs) {
    if (candidateKey === k && sameData) continue;
    if (entry.requestPins.size === 0 && isExpired(entry, now)) removals.add(candidateKey);
  }

  const existingRemovedByTtl = existing !== undefined && removals.has(k);
  const reuseExisting = existing !== undefined && sameData && !existingRemovedByTtl;
  const mergedProvenance: CursorBlobProvenance = reuseExisting && existing.provenance === "remote-setBlobArgs"
    ? "remote-setBlobArgs"
    : provenance;
  const storedAt = reuseExisting && existing.provenance === "remote-setBlobArgs" && provenance === "local-regenerated"
    ? existing.storedAt
    : now;

  let projectedBytes = blobBytes;
  let projectedCount = blobs.size;
  for (const candidateKey of removals) {
    const entry = blobs.get(candidateKey);
    if (!entry) continue;
    projectedBytes -= entry.sizeBytes;
    projectedCount--;
  }
  if (existing && !existingRemovedByTtl) {
    projectedBytes -= existing.sizeBytes;
    projectedCount--;
  }
  projectedBytes += data.byteLength;
  projectedCount++;

  if (projectedBytes > blobLimits.maxTotalBytes || projectedCount > blobLimits.maxEntries) {
    const localVictims = [...blobs.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    for (const [candidateKey, entry] of localVictims) {
      if (
        candidateKey === k
        || removals.has(candidateKey)
        || entry.requestPins.size > 0
        || entry.provenance !== "local-regenerated"
      ) continue;
      removals.add(candidateKey);
      projectedBytes -= entry.sizeBytes;
      projectedCount--;
      if (projectedBytes <= blobLimits.maxTotalBytes && projectedCount <= blobLimits.maxEntries) break;
    }
  }

  if (projectedBytes > blobLimits.maxTotalBytes || projectedCount > blobLimits.maxEntries) {
    rejectedPinnedSaturation++;
    return { admitted: false, reason: "pinned_saturation" };
  }

  // Carry forward only pins whose scope still has live state; a dead scope's
  // token can never be released again (review C1-1).
  const requestPins = new Set<CursorBlobRequestScopeToken>();
  if (reuseExisting) {
    for (const scope of existing.requestPins) {
      if (blobRequestScopes.has(scope)) requestPins.add(scope);
    }
  }
  // A pin is only attached when the scope still has live UNSEALED state:
  // sealing fixes the advertised key set (locked contract), so a remote
  // setBlobArgs arriving after seal must not extend the pin set — and a
  // sealed scope whose advertised keys have all hydrated is already deleted,
  // so attaching its stale token would create a permanent untracked pin the
  // terminal release could never clear (reviews C1-1/C2-1).
  const scopeState = requestScope ? blobRequestScopes.get(requestScope) : undefined;
  if (requestScope && scopeState && !scopeState.sealed) requestPins.add(requestScope);
  const entry: CursorBlobEntry = {
    data: reuseExisting ? existing.data : data.slice(),
    storedAt,
    sizeBytes: data.byteLength,
    provenance: mergedProvenance,
    requestPins,
  };

  for (const candidateKey of removals) deleteBlob(candidateKey, false);
  if (blobs.has(k)) deleteBlob(k, false);
  blobs.set(k, entry);
  blobBytes += entry.sizeBytes;
  blobKeyBytes += k.length;
  for (const scope of entry.requestPins) blobRequestScopes.get(scope)?.keys.add(k);
  reconcileBlobClassAccountingAndEnforce();
  return { admitted: true, replaced: existing !== undefined };
}

function getBlob(k: string): Uint8Array | undefined {
  const entry = blobs.get(k);
  if (!entry) return undefined;
  if (entry.requestPins.size === 0 && isExpired(entry, Date.now())) {
    deleteBlob(k);
    return undefined;
  }
  return entry.data;
}

/**
 * Raw blob IDs up to this size keep their hex passthrough (every ID the live
 * protocol carries is a 32-byte digest). Anything larger maps to a fixed-size
 * SHA-256 hex of the raw bytes — the derivation is symmetric across
 * setBlobArgs/getBlobArgs, so the round-trip still works, but a hostile or
 * malformed multi-MiB ID can never become an unbounded hex Map key.
 * The `h:`/`d:` prefix domain-separates the two namespaces: a digested ID's
 * key can never collide with a raw 32-byte ID that happens to BE that digest.
 */
const MAX_BLOB_ID_PASSTHROUGH_BYTES = 64;

function key(bytes: Uint8Array): string {
  if (bytes.byteLength <= MAX_BLOB_ID_PASSTHROUGH_BYTES) return `h:${Buffer.from(bytes).toString("hex")}`;
  return `d:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Store a blob (SHA-256 keyed) in the shared map that `handleCursorNativeKv` serves, and return its
 * blob id. Cursor's `rootPromptMessagesJson`/turn entries are blob IDS, not inline content — the
 * server fetches the bytes back via `getBlobArgs`. Mirrors jawcode `createBlobId`/`storeCursorBlob`.
 */
export class CursorBlobAdmissionError extends Error {
  readonly code = "cursor_blob_capacity";

  constructor(readonly reason: CursorBlobRejectionReason) {
    super("Cursor blob capacity is exhausted; retry with a smaller request.");
    this.name = "CursorBlobAdmissionError";
  }
}

let blobScopeSequence = 0;

export function createCursorBlobRequestScope(): CursorBlobRequestScopeToken {
  // Unique description per token so debug snapshots expose exact pin
  // IDENTITY, not just pin counts (review C2-2: identical descriptions made
  // scope-swap bugs invisible to deep comparison).
  const scope = Symbol(`cursor-blob-request-${++blobScopeSequence}`);
  blobRequestScopes.set(scope, { keys: new Set(), sealed: false, kind: "request" });
  return scope;
}

export function sealCursorBlobRequestScope(scope: CursorBlobRequestScopeToken): void {
  const state = blobRequestScopes.get(scope);
  if (!state) return;
  state.sealed = true;
  if (state.keys.size === 0) blobRequestScopes.delete(scope);
}

export function releaseCursorBlobRequestScope(scope: CursorBlobRequestScopeToken): void {
  const state = blobRequestScopes.get(scope);
  if (!state) return;
  for (const k of state.keys) blobs.get(k)?.requestPins.delete(scope);
  blobRequestScopes.delete(scope);
  reconcileBlobClassAccountingAndEnforce();
}

export function storeCursorBlob(data: Uint8Array, requestScope?: CursorBlobRequestScopeToken): Uint8Array {
  const blobId = new Uint8Array(createHash("sha256").update(data).digest());
  const admission = setBlob(key(blobId), data, "local-regenerated", requestScope);
  if (!admission.admitted) throw new CursorBlobAdmissionError(admission.reason);
  return blobId;
}

/**
 * Long-lived pin for blobs referenced by an active Cursor conversation checkpoint.
 * Unlike a request scope, this lease is not sealed and is not released by getBlob hydration.
 */
export function createCursorBlobCheckpointLease(label: string): CursorBlobRequestScopeToken {
  const scope = Symbol("cursor-blob-checkpoint-" + (++blobScopeSequence) + "-" + label.slice(0, 16));
  blobRequestScopes.set(scope, { keys: new Set(), sealed: false, kind: "checkpoint" });
  return scope;
}

export function pinCursorBlobIdsForCheckpoint(
  blobIds: readonly Uint8Array[],
  lease: CursorBlobRequestScopeToken,
): boolean {
  const state = blobRequestScopes.get(lease);
  if (!state || state.sealed) return false;
  const added: Array<{ entry: { requestPins: Set<CursorBlobRequestScopeToken> }; key: string }> = [];
  for (const blobId of blobIds) {
    if (blobId.byteLength === 0) continue;
    const k = key(blobId);
    const entry = blobs.get(k);
    if (!entry || (isExpired(entry, Date.now()) && entry.requestPins.size === 0 && entry.provenance !== "remote-setBlobArgs")) {
      for (const pinned of added) {
        pinned.entry.requestPins.delete(lease);
        state.keys.delete(pinned.key);
      }
      return false;
    }
    if (!entry.requestPins.has(lease)) {
      entry.requestPins.add(lease);
      state.keys.add(k);
      added.push({ entry, key: k });
    }
  }
  reconcileBlobClassAccountingAndEnforce();
  return true;
}

export function hasCursorBlob(blobId: Uint8Array): boolean {
  return getBlob(key(blobId)) !== undefined;
}

export interface CursorBlobMetrics {
  count: number;
  totalBytes: number;
  keyBytes: number;
  localBytes: number;
  pinnedBytes: number;
  rejectedEntryTooLarge: number;
  rejectedPinnedSaturation: number;
  oldestAt: number | null;
}

export function cursorBlobMetrics(): CursorBlobMetrics {
  return {
    count: blobs.size,
    totalBytes: blobBytes,
    keyBytes: blobKeyBytes,
    localBytes: blobLocalBytes,
    pinnedBytes: blobPinnedBytes,
    rejectedEntryTooLarge,
    rejectedPinnedSaturation,
    oldestAt: blobOldestEvictableAt,
  };
}

export function cursorBlobRetainedStoreSnapshot(): {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
} {
  return {
    count: blobs.size,
    // Payload + retained key strings: the framework must see everything the
    // store retains. The 64 MiB admission cap stays payload-only by design.
    bytes: blobBytes + blobKeyBytes,
    evictableBytes: blobEvictableBytes,
    pinnedBytes: blobPinnedBytes,
    oldestAt: blobOldestEvictableAt,
  };
}

export function evictOldestCursorBlobForBudget(): number {
  const now = Date.now();
  let oldest: [string, CursorBlobEntry] | undefined;
  for (const candidate of blobs) {
    const entry = candidate[1];
    if (entry.requestPins.size > 0) continue;
    if (entry.provenance !== "local-regenerated" && !isExpired(entry, now)) continue;
    if (!oldest || entry.storedAt < oldest[1].storedAt) oldest = candidate;
  }
  return oldest ? deleteBlob(oldest[0]) : 0;
}

export function setCursorBlobLimitsForTests(limits?: Partial<CursorBlobLimits>): void {
  resetCursorBlobStateForTests();
  blobLimits = limits ? { ...DEFAULT_BLOB_LIMITS, ...limits } : { ...DEFAULT_BLOB_LIMITS };
}

/**
 * The live per-blob admission ceiling. Callers that build a blob must budget against THIS value
 * rather than a copy of the constant: the limit is test-overridable, and a hardcoded 16 MiB would
 * silently drift from admission the moment either side changes.
 */
export function cursorBlobMaxEntryBytes(): number {
  return blobLimits.maxEntryBytes;
}

export function resetCursorBlobStateForTests(): void {
  if (blobExpiryAccountingTimer) clearTimeout(blobExpiryAccountingTimer);
  blobExpiryAccountingTimer = undefined;
  blobs.clear();
  blobRequestScopes.clear();
  blobBytes = 0;
  blobKeyBytes = 0;
  rejectedEntryTooLarge = 0;
  rejectedPinnedSaturation = 0;
  recomputeBlobClassAccounting();
}

export function cursorBlobStoreDebugSnapshotForTests(): Array<{
  key: string;
  sizeBytes: number;
  storedAt: number;
  provenance: CursorBlobProvenance;
  requestPins: number;
  dataDigest: string;
  pinTokens: string[];
}> {
  return [...blobs].map(([blobKey, entry]) => ({
    key: blobKey,
    sizeBytes: entry.sizeBytes,
    storedAt: entry.storedAt,
    provenance: entry.provenance,
    requestPins: entry.requestPins.size,
    // Byte-for-byte content identity + exact pin-set membership so rollback
    // tests can deep-compare complete state (review C1-2).
    dataDigest: createHash("sha256").update(entry.data).digest("hex"),
    pinTokens: [...entry.requestPins].map(scope => String(scope.description ?? "scope")).sort(),
  }));
}

export async function handleCursorNativeExec(execMsg: ExecServerMessage, deps: CursorNativeExecContext = {}): Promise<Uint8Array[]> {
  const execCase = execMsg.message.case;
  if (execCase === "requestContextArgs") {
    const tools = [...(deps.mcpToolDefs ?? []), ...(deps.clientToolDefs ?? [])];
    return [execBytes(execMsg, "requestContextResult", create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, { tools }) }) },
    }))];
  }
  if (!cursorUnsafeNativeLocalExecEnabled(deps)) {
    if (execCase === "readArgs") return [rejectReadExecForPolicy(execMsg)];
    if (execCase === "writeArgs") return [rejectWriteExecForPolicy(execMsg)];
    if (execCase === "deleteArgs") return [rejectDeleteExecForPolicy(execMsg)];
    if (execCase === "lsArgs") return [rejectLsExecForPolicy(execMsg)];
    if (execCase === "grepArgs") return [rejectGrepExecForPolicy(execMsg)];
    if (execCase === "shellArgs") return [rejectShellExecForPolicy(execMsg)];
    if (execCase === "shellStreamArgs") return rejectShellStreamExecForPolicy(execMsg);
    if (execCase === "backgroundShellSpawnArgs") return [rejectBackgroundShellSpawnExecForPolicy(execMsg)];
    if (execCase === "writeShellStdinArgs") return [rejectWriteShellStdinExecForPolicy(execMsg)];
    if (execCase === "fetchArgs") return [rejectFetchExecForPolicy(execMsg)];
  }
  if (execCase === "readArgs") return [readExec(execMsg)];
  if (execCase === "writeArgs") return [deps.rejectNativeFileMutations ? rejectWriteExecForApplyPatch(execMsg, deps.structuredEditAvailable === true) : writeExec(execMsg)];
  if (execCase === "deleteArgs") return [deps.rejectNativeFileMutations ? rejectDeleteExecForApplyPatch(execMsg, deps.structuredEditAvailable === true) : deleteExec(execMsg)];
  if (execCase === "lsArgs") return [lsExec(execMsg)];
  if (execCase === "grepArgs") return [grepExec(execMsg)];
  if (execCase === "shellArgs") return [shellExec(execMsg)];
  if (execCase === "shellStreamArgs") return shellStreamExec(execMsg);
  if (execCase === "backgroundShellSpawnArgs") return [backgroundShellSpawnExec(execMsg, deps.sessionId ?? "")];
  if (execCase === "writeShellStdinArgs") return [writeShellStdinExec(execMsg, deps.sessionId ?? "")];
  if (execCase === "fetchArgs") return [await fetchExec(execMsg, deps)];
  if (execCase === "mcpArgs" && execMsg.message.value.providerIdentifier === OCX_RESPONSES_TOOL_PROVIDER) {
    return [execBytes(execMsg, "mcpResult", create(McpResultSchema, {
      result: {
        case: "error",
        value: create(McpErrorSchema, { error: "Cursor requested a client Responses tool through the native exec channel; bridge suspension is not implemented." }),
      },
    }))];
  }
  if (execCase === "mcpArgs") return [await mcpExec(execMsg, deps)];
  if (execCase === "listMcpResourcesExecArgs") return [await listMcpResourcesExec(execMsg, deps)];
  if (execCase === "readMcpResourceExecArgs") return [await readMcpResourceExec(execMsg, deps)];
  if (execCase === "computerUseArgs") return [await computerUseExec(execMsg, deps)];
  if (execCase === "recordScreenArgs") return [await recordScreenExec(execMsg, deps)];
  if (execCase === "diagnosticsArgs") {
    const path = execMsg.message.value.path;
    return [execBytes(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {
      result: {
        case: "error",
        value: create(DiagnosticsErrorSchema, {
          path,
          error: "Diagnostics are not supported by the opencodex Cursor transport.",
        }),
      },
    }))];
  }
  // Unknown exec case — Cursor added a new native exec type that our protobuf definition does not
  // include yet. Return an empty reply so the stream stays alive instead of throwing (which kills
  // the entire gRPC connection via failAndClear). Same class of bug as #116.
  debugProviderDiagnostic("cursor", "unknown-exec-case", { execCase: execCase ?? "unknown", execId: execMsg.execId });
  return [];
}


export function handleCursorNativeKv(
  kvMsg: KvServerMessage,
  requestScope?: CursorBlobRequestScopeToken,
): Uint8Array {
  if (kvMsg.message.case === "getBlobArgs") {
    const blobKey = key(kvMsg.message.value.blobId);
    const blobData = getBlob(blobKey);
    if (blobData && requestScope && blobRequestScopes.get(requestScope)?.kind === "request") {
      releaseHydratedBlob(blobKey, requestScope);
    }
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
        }),
      },
    });
  }
  if (kvMsg.message.case === "setBlobArgs") {
    const admission = setBlob(
      key(kvMsg.message.value.blobId),
      kvMsg.message.value.blobData,
      "remote-setBlobArgs",
      requestScope,
    );
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: {
            case: "setBlobResult",
            value: create(SetBlobResultSchema, admission.admitted ? {} : {
              error: create(ErrorSchema, {
                message: "Cursor blob capacity is exhausted; the blob was not stored.",
              }),
            }),
          },
        }),
      },
    });
  }
  return clientBytes({ message: { case: "kvClientMessage", value: create(KvClientMessageSchema, { id: kvMsg.id }) } });
}
