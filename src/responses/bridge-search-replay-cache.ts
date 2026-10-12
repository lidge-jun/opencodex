/**
 * Process-local memo pairing a bridged hosted `web_search` cell with the destination's own
 * call and the result the proxy executed for it (issue #4587).
 *
 * The web-search passthrough bridge (`src/web-search/passthrough-bridge.ts`) intercepts the
 * destination's `function_call` named `web_search`, runs the search itself, and shows the
 * caller a hosted `web_search_call` cell under a proxy-minted `ws_<uuid>` id. The caller
 * stores that cell and replays it on every later turn. The destination, which never produced a
 * `web_search_call` in its life, then sees an unknown item type carrying a query and sources
 * but no result — so it usually just searches again.
 *
 * This memo is what lets the pre-dispatch rewrite in the Responses adapter put the destination's
 * own `function_call` and `function_call_output` back in that item's place. It records exactly
 * what `appendBridgeSearchTurn` would have written onto a continuation leg, so a replayed turn
 * and a continued turn show the destination the same conversation.
 *
 * Scope. Entries are keyed by the exact conversation and serving identity in addition to the cell
 * id. The cell id is a v4 UUID minted here, but possession of a client-visible id is not authority
 * to recover result text under another provider, model, destination, or credential.
 *
 * Bounds and privacy. Result text is web content the caller already received, but it is still
 * request-derived data: it lives in memory only, is never logged, serialized, or exported, and is
 * bounded by entry count, total bytes, and TTL so a long-lived proxy cannot grow without limit.
 *
 * A miss is deliberately indistinguishable from "no entry": the caller leaves the replayed item
 * alone. Neither re-running the search nor inventing a result is an acceptable recovery.
 */

import type { OcxReasoningReplayScopeRef } from "../types";

const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 512 * 1024;
const TTL_MS = 60 * 60 * 1000;

export interface BridgeSearchReplayEntry {
  /** The destination's own call id, as it appeared on the intercepted item. */
  callId: string;
  /** The destination's own item id, replayed when the upstream supplied one. */
  sourceItemId?: string;
  /** The tool name the destination called, recorded rather than assumed. */
  name: string;
  /** The intercepted call's complete arguments text. */
  argumentsText: string;
  /** The tool result the bridge produced for that call. */
  output: string;
}

interface StoredEntry {
  entry: BridgeSearchReplayEntry;
  bytes: number;
  at: number;
}

const entries = new Map<string, StoredEntry>();
let totalBytes = 0;
let clockForTests: (() => number) | null = null;

const now = (): number => clockForTests?.() ?? Date.now();

/**
 * Identify the exact conversation and upstream binding a bridged search belongs to.
 *
 * The serving route binds this holder only after provider, model, and physical credential
 * selection. A missing conversation or binding fails closed: a cell id is client-visible and is
 * not itself authority to recover another request's retained result.
 */
export function bridgeSearchReplayScope(scope: OcxReasoningReplayScopeRef | undefined): string | undefined {
  const identity = scope?.current;
  if (!scope?.clientPrincipalId || !scope.clientThreadId || !identity) return undefined;
  return JSON.stringify([
    scope.clientPrincipalId,
    scope.clientThreadId,
    identity.providerName,
    identity.providerDestinationIdentity,
    identity.adapterName,
    identity.modelId,
    identity.credentialIdentity,
  ]);
}

function keyFor(scope: string, cellItemId: string): string {
  return scope + "\u0000" + cellItemId;
}

function drop(key: string, stored: StoredEntry): void {
  entries.delete(key);
  totalBytes -= stored.bytes;
}

function sweep(at: number): void {
  for (const [key, stored] of entries) {
    if (at - stored.at >= TTL_MS) drop(key, stored);
  }
  // Map iteration is insertion-ordered, so the oldest surviving entry is always the first one.
  while (entries.size > MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES) {
    const oldest = entries.entries().next();
    if (oldest.done) {
      totalBytes = 0;
      return;
    }
    drop(oldest.value[0], oldest.value[1]);
  }
}

/**
 * Record one executed bridged search.
 *
 * An entry with no call id is not recorded: the restore would have to emit a `function_call`
 * without one, which is not a valid item and could not be paired with its output anyway.
 */
export function rememberBridgeSearchReplay(
  scope: string | undefined,
  cellItemId: string,
  entry: BridgeSearchReplayEntry,
): void {
  if (!scope || cellItemId.length === 0 || entry.callId.length === 0) return;
  const key = keyFor(scope, cellItemId);
  const existing = entries.get(key);
  if (existing) drop(key, existing);
  const bytes = 2 * (
    key.length
    + entry.callId.length
    + (entry.sourceItemId?.length ?? 0)
    + entry.name.length
    + entry.argumentsText.length
    + entry.output.length
  );
  // A single oversized result is refused outright rather than evicting the whole store for it.
  if (bytes > MAX_TOTAL_BYTES) return;
  entries.set(key, { entry: { ...entry }, bytes, at: now() });
  totalBytes += bytes;
  sweep(now());
}

/**
 * Look up one recorded search without consuming it.
 *
 * The same cell is replayed on every subsequent turn of the conversation, so a consuming read
 * would restore the pair once and then silently stop. Expiry stays absolute: a conversation that
 * outlives the TTL degrades to today's behaviour (the hosted cell replays unchanged) rather than
 * pinning entries open for as long as anyone keeps talking.
 */
export function peekBridgeSearchReplay(
  scope: string | undefined,
  cellItemId: string,
): BridgeSearchReplayEntry | undefined {
  if (!scope || cellItemId.length === 0) return undefined;
  const key = keyFor(scope, cellItemId);
  const stored = entries.get(key);
  if (!stored) return undefined;
  if (now() - stored.at >= TTL_MS) {
    drop(key, stored);
    return undefined;
  }
  return stored.entry;
}

export function clearBridgeSearchReplayCacheForTests(clock?: (() => number) | null): void {
  entries.clear();
  totalBytes = 0;
  clockForTests = clock ?? null;
}
