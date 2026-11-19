import { randomBytes } from "node:crypto";
import { RESPONSE_ID_MAX_BYTES } from "../id-limits";
import { normalizedClientThreadId } from "./replay-owner";
import type { ResidentResponseState, StoredResponseState } from "./entry-types";

/**
 * Connection-owned replay scope for an unidentified loopback WebSocket.
 *
 * The /v1/responses upgrade mints one when the caller presented no credential a
 * context principal could resolve from. The minted owner key exists only in
 * process memory: it is never sent to the client, never written to a header,
 * and never persisted. Because the scope handle is reachable only through the
 * socket's own WsData, a second socket, an HTTP request, a reconnect, or a
 * forged thread-id cannot produce the same replay authority — each keeps the
 * explicit previous_response_not_found refusal it has today.
 *
 * A scope is NOT a credential: it never satisfies isContextPrincipalCurrent,
 * never populates clientPrincipalId, and grants no data-plane, context-history
 * or notes authority. It only selects the replay owner namespace that this
 * connection's retained continuation state is stored under.
 */

/** Per-scope cap on retained continuation entries; the oldest drops first. */
export const MAX_CONNECTION_SCOPE_ENTRIES = 64;
/** The deadline for replay authority and retained payloads is measured from the handshake. */
export const CONNECTION_REPLAY_SCOPE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Issuance brand: module-private, so a literal can never satisfy the type, and
 * the record lives in a WeakMap keyed by the handle, so even a cast-through
 * literal holds no record and every check below refuses it. The public handle
 * exposes no ownerKey, thread or mutable state — the opaque value cannot be
 * replayed into authority by shape the way a structurally-typed record could.
 */
const scopeIssuanceBrand: unique symbol = Symbol("ocx.connectionReplayScope.issuance");

export interface ConnectionReplayScope {
  readonly [scopeIssuanceBrand]: true;
}

/** The authority a handle was minted with; unreachable from the handle itself. */
interface ConnectionReplayScopeRecord {
  /** Opaque replay owner key; validReplayOwnerKey-shaped, minted randomly — never derived from a credential. */
  readonly ownerKey: string;
  /** The upgrade request's own thread-id; a frame cannot change its socket's captured headers. */
  readonly ownThread: string;
  readonly expiresAt: number;
  /** Set once when the socket closes; late writes after close are refused. */
  closed: boolean;
  /** Response ids retained under this scope, for exact cleanup on close. */
  readonly entryIds: Set<string>;
}

const scopeRecords = new WeakMap<ConnectionReplayScope, ConnectionReplayScopeRecord>();

function recordOf(scope: ConnectionReplayScope | undefined): ConnectionReplayScopeRecord | undefined {
  return scope === undefined ? undefined : scopeRecords.get(scope);
}

/** Store seam bound by the state owner so this module never maps the entries itself. */
export interface ConnectionScopeStore {
  deleteEntry(id: string): void;
  currentEntry(id: string): StoredResponseState | undefined;
}

let scopeStore: ConnectionScopeStore | null = null;

export function bindConnectionScopeStore(store: ConnectionScopeStore): void {
  scopeStore = store;
}

function requireScopeStore(): ConnectionScopeStore {
  if (!scopeStore) throw new Error("connection replay scope store is not bound");
  return scopeStore;
}

/** Mint a scope for the upgrade's own thread; without one there is nothing safe to bind. */
export function mintConnectionReplayScope(ownThread: string | undefined, at = Date.now()): ConnectionReplayScope | undefined {
  const thread = typeof ownThread === "string" ? ownThread.trim() : "";
  if (!thread) return undefined;
  const handle: ConnectionReplayScope = Object.freeze({ [scopeIssuanceBrand]: true as const });
  scopeRecords.set(handle, {
    ownerKey: randomBytes(32).toString("hex"),
    ownThread: thread,
    expiresAt: at + CONNECTION_REPLAY_SCOPE_TTL_MS,
    closed: false,
    entryIds: new Set(),
  });
  return handle;
}

/**
 * True while the handle was minted here, is not closed and has not expired. A
 * literal cast to the handle type has no WeakMap record, so it is never live.
 */
export function connectionReplayScopeLive(scope: ConnectionReplayScope | undefined, at = Date.now()): scope is ConnectionReplayScope {
  const record = recordOf(scope);
  return !!record && !record.closed && at < record.expiresAt;
}

/**
 * The live scope when the request's own thread is the handshake's — otherwise
 * nothing, so a mismatched frame falls back to the ordinary unscoped refusal.
 */
export function connectionReplayScopeForThread(
  scope: ConnectionReplayScope | undefined,
  ownThread: string | undefined,
  at = Date.now(),
): ConnectionReplayScope | undefined {
  const record = recordOf(scope);
  if (!record || record.closed || at >= record.expiresAt) return undefined;
  return typeof ownThread === "string" && ownThread.trim() === record.ownThread ? scope : undefined;
}

/**
 * The scope's replay owner key for request-path backfill, or undefined when
 * the handle carries no record. The key never appears on the handle itself.
 */
export function connectionReplayScopeOwnerKey(scope: ConnectionReplayScope | undefined): string | undefined {
  return recordOf(scope)?.ownerKey;
}

/**
 * Store-side admission check: the write must carry this scope's own key and
 * thread while the scope is still live. Comparing inside the module keeps the
 * record fields unreachable, so a copied ownerKey cannot widen authority.
 */
export function connectionReplayScopeAcceptsEntry(
  scope: ConnectionReplayScope,
  id: string,
  replayOwnerKey: unknown,
  clientThreadId: unknown,
  at = Date.now(),
): boolean {
  const record = recordOf(scope);
  if (!record || record.closed || at >= record.expiresAt) return false;
  if (id.length === 0 || Buffer.byteLength(id) > RESPONSE_ID_MAX_BYTES) return false;
  const thread = normalizedClientThreadId(clientThreadId);
  return thread !== undefined && thread === record.ownThread && replayOwnerKey === record.ownerKey;
}

function isConnectionScopeEntry(scope: ConnectionReplayScope, entry: StoredResponseState | undefined): boolean {
  return entry?.kind === "resident" && entry.connectionOwned === true && entry.connectionScope === scope;
}

export function connectionScopeEntryExpired(entry: StoredResponseState, at: number): boolean {
  return entry.kind === "resident" && entry.connectionScope !== undefined && !connectionReplayScopeLive(entry.connectionScope, at);
}

export function forgetConnectionScopeEntry(id: string, entry: StoredResponseState): void {
  if (entry.kind === "resident") recordOf(entry.connectionScope)?.entryIds.delete(id);
}

export function isConnectionOwnedResponseState(
  entry: StoredResponseState | undefined,
): entry is ResidentResponseState & { connectionOwned: true } {
  return entry?.kind === "resident" && entry.connectionOwned === true;
}

/** Plan the socket slot first, then shared headroom. A failed plan leaves both indexes untouched. */
export function planConnectionScopeEvictions(
  states: ReadonlyMap<string, StoredResponseState>,
  scope: ConnectionReplayScope,
  id: string,
  countToFree: number,
  bytesToFree: number,
): string[] | undefined {
  const evictions: string[] = [];
  const entries = recordOf(scope)?.entryIds;
  const oldest = entries && !entries.has(id) && entries.size >= MAX_CONNECTION_SCOPE_ENTRIES
    ? entries.values().next().value : undefined;
  if (oldest !== undefined) {
    const entry = states.get(oldest);
    if (!isConnectionOwnedResponseState(entry) || entry.connectionScope !== scope) return undefined;
    evictions.push(oldest);
    countToFree -= 1;
    bytesToFree -= entry.sizeBytes;
  }
  if (countToFree <= 0 && bytesToFree <= 0) return evictions;
  for (const [otherId, entry] of states) {
    if (otherId === id || otherId === oldest || !isConnectionOwnedResponseState(entry)) continue;
    evictions.push(otherId);
    countToFree -= 1;
    bytesToFree -= entry.sizeBytes;
    if (countToFree <= 0 && bytesToFree <= 0) return evictions;
  }
  return undefined;
}

/** Record the response only after its scoped admission succeeds. */
export function noteConnectionScopeEntry(scope: ConnectionReplayScope, id: string): void {
  const record = recordOf(scope);
  if (!record || record.closed) return;
  const store = requireScopeStore();
  if (!isConnectionScopeEntry(scope, store.currentEntry(id))) return;
  record.entryIds.add(id);
}

/**
 * Close the scope and drop every entry it still owns. Late writes race-safe:
 * "closed" is set first, so a write already in the pipeline refuses at the
 * acceptance check, and the id sweep drops only entries still carrying this handle.
 */
export function releaseConnectionReplayScope(scope: ConnectionReplayScope | undefined): void {
  const record = recordOf(scope);
  if (!scope || !record || record.closed) return;
  record.closed = true;
  for (const id of record.entryIds) {
    const store = requireScopeStore();
    if (isConnectionScopeEntry(scope, store.currentEntry(id))) {
      store.deleteEntry(id);
    }
  }
  record.entryIds.clear();
}

/**
 * The insertion-oldest memory-only resident not held by the spill queue, or
 * undefined. Eviction prefers these over demoting durable entries: connection
 * state may never reach disk, so under byte pressure it is deleted outright.
 */
export function oldestConnectionScopeResident(
  states: ReadonlyMap<string, StoredResponseState>,
  isQueueHeld: (id: string, entry: ResidentResponseState) => boolean,
): string | undefined {
  for (const [id, entry] of states) {
    if (entry.kind !== "resident" || entry.connectionOwned !== true) continue;
    if (isQueueHeld(id, entry)) continue;
    return id;
  }
  return undefined;
}
