/**
 * In-process fallback store pairing raw reasoning text with the tool call it
 * preceded (issue #950).
 *
 * DeepSeek thinking mode requires the assistant's original `reasoning_content`
 * to be replayed on every continuation of a tool-call turn. The bridge records
 * the raw reasoning here when it closes a reasoning block and a tool call
 * follows; the openai-chat adapter re-attaches it when a `tool_calls`
 * assistant message is about to serialize without thinking parts (compacted
 * history, lost assistant turn, orphan-repaired tool results).
 *
 * Entries are scoped by an optional conversation identity in addition to the
 * call id: provider-generated ids like `call_1` are not globally unique, so a
 * process-wide key would let one conversation's reasoning bleed into another
 * when ids collide (CodeRabbit P1 on #971).
 *
 * Privacy: entries hold reasoning text. By default they live in memory only —
 * never logged or exported. Operators may opt into a bounded, TTL'd disk spill
 * (OPENCODEX_REASONING_REPLAY_PERSIST=1, optional
 * OPENCODEX_REASONING_REPLAY_FILE override) so a proxy restart mid-round can
 * still replay a call's reasoning; the spill file is written atomically with
 * best-effort 0600 permissions. Diagnostics expose counters only, never
 * reasoning text. The store is bounded by entry count, total bytes, and TTL,
 * so a long-lived proxy cannot grow without limit.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveOpenCodexConfigDir } from "../lib/config-dir";

const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 256 * 1024;
const TTL_MS = 60 * 60 * 1000;
// Clock-skew tolerance when validating spilled timestamps: entries dated more
// than this far in the future are rejected as invalid rather than trusted.
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const PERSIST_DEBOUNCE_MS = 750;
const PERSIST_ENV = "OPENCODEX_REASONING_REPLAY_PERSIST";
const PERSIST_FILE_ENV = "OPENCODEX_REASONING_REPLAY_FILE";

interface CacheEntry {
  text: string;
  bytes: number;
  at: number;
}

interface PersistedEntry {
  scope: string;
  callId: string;
  text: string;
  at: number;
}

interface PersistFile {
  v: 1;
  savedAt: number;
  entries: PersistedEntry[];
}

const entries = new Map<string, CacheEntry>();
let totalBytes = 0;
let clockForTests: (() => number) | null = null;
let hits = 0;
let misses = 0;
const bareSerializationsByModel = new Map<string, number>();
let persistEnabled = persistFlagFromEnv();
let persistPath = persistPathFromEnv();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistWrites = 0;
let persistLastError: string | undefined;

const now = (): number => clockForTests?.() ?? Date.now();
const keyFor = (callId: string, scope: string | undefined): string =>
  `${scope ?? "global"}\u0000${callId}`;

function persistFlagFromEnv(): boolean {
  const raw = process.env[PERSIST_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** Shared resolution (OPENCODEX_HOME or ~/.opencodex) — see src/lib/config-dir.ts. */
function defaultPersistPath(): string {
  return join(resolveOpenCodexConfigDir(), "reasoning-replay-cache.json");
}

function persistPathFromEnv(): string {
  const raw = process.env[PERSIST_FILE_ENV]?.trim();
  return raw && raw.length > 0 ? raw : defaultPersistPath();
}

/**
 * Record the raw reasoning text that preceded the given tool call.
 *
 * Expired entries are swept on insert so the TTL bound holds even when a call
 * id is never read again.
 */
export function rememberReasoningForCall(callId: string, text: string, scope?: string): void {
  rememberReasoningAt(callId, text, scope, now());
}

function rememberReasoningAt(callId: string, text: string, scope: string | undefined, at: number): void {
  if (!callId || typeof text !== "string" || text.length === 0) return;
  const bytes = Buffer.byteLength(text, "utf8");
  // A single entry larger than the whole budget would immediately evict itself.
  if (bytes > MAX_TOTAL_BYTES) return;
  // Delete every due entry first so expired reasoning cannot linger until a
  // later peek or capacity eviction.
  for (const [key, entry] of entries) {
    if (at - entry.at >= TTL_MS) {
      entries.delete(key);
      totalBytes -= entry.bytes;
    }
  }
  const key = keyFor(callId, scope);
  const previous = entries.get(key);
  if (previous) totalBytes -= previous.bytes;
  entries.set(key, { text, bytes, at });
  totalBytes += bytes;
  // Evict oldest-first until both caps hold (never evict the entry just written
  // while it is the only one — the loop guards on size > 1).
  while ((totalBytes > MAX_TOTAL_BYTES || entries.size > MAX_ENTRIES) && entries.size > 1) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [candidateKey, entry] of entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = candidateKey;
      }
    }
    if (oldestKey === undefined) break;
    const evicted = entries.get(oldestKey)!;
    totalBytes -= evicted.bytes;
    entries.delete(oldestKey);
  }
  if (persistEnabled) schedulePersist();
}

/**
 * Read the recorded reasoning for a call id without removing it: retries after
 * a failed continuation reuse the same fallback.
 */
export function peekReasoningForCall(callId: string, scope?: string): string | undefined {
  if (!callId) return undefined;
  const key = keyFor(callId, scope);
  const entry = entries.get(key);
  if (!entry) {
    misses += 1;
    return undefined;
  }
  if (now() - entry.at >= TTL_MS) {
    entries.delete(key);
    totalBytes -= entry.bytes;
    misses += 1;
    return undefined;
  }
  hits += 1;
  return entry.text;
}

// ── Opt-in disk spill (issue #950 robustness: survive proxy restarts) ────────

function schedulePersist(): void {
  if (!persistEnabled) return;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    writePersisted();
  }, PERSIST_DEBOUNCE_MS);
}

/** Synchronously flush the opt-in spill file (debounced writes call this too). */
export function flushReasoningReplayCache(): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  writePersisted();
}

function writePersisted(): void {
  if (!persistEnabled) return;
  try {
    const payload: PersistFile = {
      v: 1,
      savedAt: now(),
      entries: [...entries.entries()].map(([key, entry]) => {
        const sep = key.indexOf("\u0000");
        return {
          scope: sep === -1 ? "global" : key.slice(0, sep),
          callId: sep === -1 ? key : key.slice(sep + 1),
          text: entry.text,
          at: entry.at,
        };
      }),
    };
    try {
      mkdirSync(dirname(persistPath), { recursive: true });
    } catch { /* best-effort */ }
    // Unique temp name + 0600 at creation, then atomic rename: a concurrent
    // reader can never observe a half-written spill, and the final file never
    // depends on a post-rename chmod that a rename may not preserve.
    const tmpPath = `${persistPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    writeFileSync(tmpPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, persistPath);
    try { chmodSync(persistPath, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
    persistWrites += 1;
    persistLastError = undefined;
    cleanupStaleTempFiles();
  } catch (err) {
    persistLastError = err instanceof Error ? err.message : String(err);
  }
}

/** Remove temp files left behind by a crashed writer (unique names mean they
 * can never be confused with a live write, but they should still be reclaimed). */
function cleanupStaleTempFiles(): void {
  try {
    const dir = dirname(persistPath);
    const base = basename(persistPath);
    const cutoff = now() - 10 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${base}.`) || name === base) continue;
      const full = join(dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort */ }
}

function loadPersisted(): void {
  if (!persistEnabled || !existsSync(persistPath)) return;
  let raw: string;
  try {
    raw = readFileSync(persistPath, "utf8");
  } catch {
    return; // unreadable spill is not worth failing the proxy over
  }
  let data: Partial<PersistFile>;
  try {
    data = JSON.parse(raw) as Partial<PersistFile>;
  } catch {
    return; // corrupt spill file: treat as empty, overwrite on next flush
  }
  if (data?.v !== 1 || !Array.isArray(data.entries)) return;
  const at = now();
  // Malformed, expired, or future-dated entries are dropped and the spill is
  // rewritten so the file cannot accumulate junk that every reload re-parses.
  let dirty = false;
  for (const entry of data.entries) {
    if (!entry || typeof entry.callId !== "string" || typeof entry.text !== "string" || entry.text.length === 0) {
      dirty = true;
      continue;
    }
    const entryAt = typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : at;
    if (entryAt - at > MAX_FUTURE_SKEW_MS) {
      dirty = true; // future-dated timestamps are invalid
      continue;
    }
    if (at - entryAt >= TTL_MS) {
      dirty = true; // expired
      continue;
    }
    rememberReasoningAt(entry.callId, entry.text, typeof entry.scope === "string" ? entry.scope : undefined, entryAt);
  }
  if (dirty) writePersisted();
}

// ── Privacy-safe diagnostics (counters only, never reasoning text) ───────────

/** Count a bare tool-call continuation serialized for a preserveReasoningContentModels model (#950). */
export function recordBareToolCallSerialization(modelId: string): void {
  if (!modelId) return;
  bareSerializationsByModel.set(modelId, (bareSerializationsByModel.get(modelId) ?? 0) + 1);
}

export interface ReasoningReplayStats {
  entries: number;
  totalBytes: number;
  hits: number;
  misses: number;
  bareSerializationsByModel: Record<string, number>;
  persistence: {
    enabled: boolean;
    path: string;
    writes: number;
    lastError?: string;
  };
}

/** Counters and bounds only — never reasoning text (issue #950 privacy checklist). */
export function getReasoningReplayStats(): ReasoningReplayStats {
  return {
    entries: entries.size,
    totalBytes,
    hits,
    misses,
    bareSerializationsByModel: Object.fromEntries(bareSerializationsByModel),
    persistence: {
      enabled: persistEnabled,
      path: persistPath,
      writes: persistWrites,
      ...(persistLastError !== undefined ? { lastError: persistLastError } : {}),
    },
  };
}

// Boot-time rehydration when persistence is opted in.
if (persistEnabled) loadPersisted();

// Synchronous best-effort flush so a normal process exit does not strand a
// just-recorded call's reasoning when persistence is opted in (P2: flush
// before exit). Bounded by the same caps as every other write.
process.on("exit", () => {
  if (persistEnabled) writePersisted();
});

// ── Test seams ────────────────────────────────────────────────────────────────

/** Test-only: reset the cache and optionally pin the clock. */
export function clearReasoningReplayCacheForTests(clock?: (() => number) | null): void {
  entries.clear();
  totalBytes = 0;
  hits = 0;
  misses = 0;
  bareSerializationsByModel.clear();
  clockForTests = clock ?? null;
}

/** Test-only: toggle the opt-in spill (loads the file when enabling). */
export function setReasoningReplayPersistenceForTests(enabled: boolean, path?: string): void {
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  persistEnabled = enabled;
  if (path !== undefined && path.length > 0) persistPath = path;
  if (enabled) loadPersisted();
}
