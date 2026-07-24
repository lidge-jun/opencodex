import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { OcxProviderContinuationState } from "../types";

const MAX_STORED_RESPONSES = 1_000;
const RESPONSE_TTL_MS = 60 * 60 * 1_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Entries whose serialized size exceeds this are kept in memory but skipped on disk: inputs can
 * carry base64 `input_image` data URLs, and one screenshot-heavy thread must not balloon the file. */
const SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TOTAL_MAX_BYTES = 24 * 1024 * 1024;

interface StoredResponseState {
  createdAt: number;
  items: unknown[];
  /** v2 provider-keyed continuation metadata. */
  providers?: OcxProviderContinuationState;
  /** v1 Cursor-only metadata, accepted only while loading old snapshots. */
  conversationId?: string;
  cursorCheckpointUsable?: boolean;
}

const states = new Map<string, StoredResponseState>();
// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. The parser uses this boundary to acknowledge historical compaction markers exactly once.
const replayedInputPrefixLengths = new WeakMap<object, number>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

/**
 * Best-effort disk snapshot so previous_response_id chains survive a proxy restart (the
 * dominant expansion-miss cause: an in-memory-only store dies with the process, and the next
 * chained turn then reaches the upstream as a naked delta). Load is lazy on first store access;
 * persistence is debounced + unref'd so the hot path never blocks and the process can exit.
 * Every disk failure is swallowed — the snapshot is a cache, not a source of truth.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const path = snapshotPath();
    if (!existsSync(path)) return;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.states)) return;
    for (const entry of raw.states) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, state] = entry as [unknown, unknown];
      if (typeof id !== "string" || !state || typeof state !== "object") continue;
      const rec = state as StoredResponseState;
      if (typeof rec.createdAt !== "number" || !Array.isArray(rec.items)) continue;
      const providers = rec.providers ?? (rec.conversationId
        ? {
            cursor: {
              conversationId: rec.conversationId,
              ...(rec.cursorCheckpointUsable !== undefined
                ? { checkpointUsable: rec.cursorCheckpointUsable }
                : {}),
            },
          }
        : undefined);
      states.set(id, {
        createdAt: rec.createdAt,
        items: rec.items,
        ...(providers ? { providers } : {}),
      });
    }
    pruneResponses();
  } catch {
    /* missing/corrupt snapshot: start empty */
  }
}

function persistNow(path: string): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  try {
    const entries: [string, StoredResponseState][] = [];
    let total = 0;
    // Newest-first so the most recent chains survive both caps.
    for (const entry of [...states].reverse()) {
      const size = JSON.stringify(entry).length;
      if (size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
      if (total + size > SNAPSHOT_TOTAL_MAX_BYTES) break;
      total += size;
      entries.push(entry);
    }
    entries.reverse();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // mkdirSync's mode only applies on creation — re-harden an existing config dir so the
    // conversation-content snapshot never lands in a group/world-readable directory.
    try { chmodSync(dirname(path), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    atomicWriteFile(path, JSON.stringify({ version: 2, states: entries }));
  } catch {
    /* best-effort: disk trouble must never affect request handling */
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  // Resolve the target path NOW: tests (and anything else) may swap OPENCODEX_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  pendingPersistPath = snapshotPath();
  const path = pendingPersistPath;
  persistTimer = setTimeout(() => persistNow(path), SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export function flushResponseState(): void {
  if (!persistTimer) return;
  // Use the path captured when the write was scheduled — OPENCODEX_HOME may have moved since.
  persistNow(pendingPersistPath ?? snapshotPath());
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (at - state.createdAt > RESPONSE_TTL_MS) states.delete(id);
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    states.delete(oldest);
  }
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) return body;
  const expanded = {
    ...request,
    input: [...previous.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, previous.items.length);
  return expanded;
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

export function previousResponseConversationId(responseId: string | undefined): string | undefined {
  return previousResponseProviderState(responseId)?.cursor?.conversationId;
}

export function previousResponseProviderState(responseId: string | undefined): OcxProviderContinuationState | undefined {
  if (!responseId) return undefined;
  ensureLoaded();
  pruneResponses();
  const providers = states.get(responseId)?.providers;
  return providers ? structuredClone(providers) : undefined;
}

export interface ResponseStateMetrics {
  /** Number of retained continuation entries currently in RAM. */
  count: number;
  /** Sum of serialized item bytes across all entries. Because expanded previous_response_id chains
   * share prefix item references, this is an UPPER bound on true heap (it re-counts shared history),
   * never an under-count — safe to use as a memory-pressure signal. */
  totalBytes: number;
  /** Serialized item bytes of the single largest entry (a long chain's head, or an image-heavy turn). */
  largestBytes: number;
  /** Age of the oldest retained entry, in ms (0 when the store is empty). */
  oldestAgeMs: number;
}

/**
 * Observe-only snapshot of the in-RAM continuation store. Additive and side-effect free — it does
 * NOT lazy-load the disk snapshot, prune, or evict — so a diagnostics endpoint or benchmark harness
 * can sample it without perturbing request handling. This is the instrumentation seam for deciding
 * whether RAM growth originates in this store (JS heap) or in the runtime allocator (native).
 */
export function responseStateMetrics(): ResponseStateMetrics {
  const at = now();
  let totalBytes = 0;
  let largestBytes = 0;
  let oldestCreatedAt = at;
  for (const state of states.values()) {
    let bytes = 0;
    try {
      bytes = JSON.stringify(state.items).length;
      if (state.providers) bytes += JSON.stringify(state.providers).length;
    } catch {
      /* unserializable entry (should not happen): count as 0 rather than throw in a metrics path */
    }
    totalBytes += bytes;
    if (bytes > largestBytes) largestBytes = bytes;
    if (state.createdAt < oldestCreatedAt) oldestCreatedAt = state.createdAt;
  }
  return {
    count: states.size,
    totalBytes,
    largestBytes,
    oldestAgeMs: states.size > 0 ? at - oldestCreatedAt : 0,
  };
}

export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown },
  providerState?: OcxProviderContinuationState | string,
  opts?: { force?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store stays in-memory with a 1h TTL, so this is a proxy-internal continuation cache, not
  // real server-side response storage.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  const normalizedProviderState: OcxProviderContinuationState = typeof providerState === "string"
    ? { cursor: { conversationId: providerState } }
    : structuredClone(providerState ?? {});
  if (normalizedProviderState.cursor?.conversationId) {
    normalizedProviderState.cursor.checkpointUsable = !response.output.some(item => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
    });
  }
  states.set(response.id, {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    // Always preserve the Cursor conversation id so the next tool-result turn can continue the SAME
    // Cursor conversation (multi-turn continuation). Separately track whether Cursor's own
    // checkpoint/cache is safe to reuse: a turn that ended with a pending client tool call produced an
    // incomplete agent turn on the Cursor side (we suspended without a real mcpResult), so its
    // checkpoint must not be reused — but the conversation id string itself is still valid.
    ...(Object.keys(normalizedProviderState).length > 0 ? { providers: normalizedProviderState } : {}),
  });
  pruneResponses();
  schedulePersist();
}

/** Memory-only reset (simulates a process restart: the snapshot file survives). */
export function clearResponseStateMemoryForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  states.clear();
  loaded = false;
}

export function clearResponseStateForTests(): void {
  clearResponseStateMemoryForTests();
  try {
    unlinkSync(snapshotPath());
  } catch {
    /* no snapshot on disk */
  }
}
