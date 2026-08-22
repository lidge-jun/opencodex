import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFileAsync, getConfigDir, type AtomicWriteAsyncTestSeam } from "../config";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";

/**
 * Google-family thoughtSignature reasoning-replay cache.
 *
 * Gemini-3 interleaved thinking is stateless upstream: each model content part carries a
 * `thoughtSignature` that MUST be echoed back on the matching part in the next request, or the
 * upstream rejects the turn (HTTP 400). We observe signatures on the response stream, cache them
 * per `model + session`, and re-inject them into the outgoing `request.contents` on the next turn.
 *
 * Mirrors CLIProxyAPI `internal/runtime/executor/antigravity_reasoning_replay.go` and is also used
 * by Vertex with a transport/project/location-prefixed model identity. Gemini-only;
 * Claude-on-Antigravity uses inline signature sanitization instead (see google-antigravity-wire).
 */

interface ReplayCall {
  signature: string;
  sizeBytes: number;
  touchedAtMs: number;
}

interface ReplayEntry {
  /** thoughtSignature keyed by functionCall identity (name + canonical args). */
  byCall: Map<string, ReplayCall>;
  bytes: number;
  expiresAtMs: number;
  oldestAtMs: number | null;
  /** Most recent observe/apply activity; orders sessions under the snapshot cap. */
  lastActiveAtMs: number;
}

const MIN_SIGNATURE_LEN = 16;
const REPLAY_TTL_MS = 60 * 60 * 1000; // 1h
export const ANTIGRAVITY_REPLAY_MAX_ENTRIES = 10_240;
const REPLAY_EVICT_BATCH = 128;
const REPLAY_MAX_CALLS_PER_SESSION = 256;
export const ANTIGRAVITY_REPLAY_MAX_BYTES_PER_SESSION = 2 * 1024 * 1024;
export const ANTIGRAVITY_REPLAY_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const REPLAY_MAX_SIGNATURE_BYTES = 64 * 1024;
/** Fixed 64-hex outer key length, counted once per session entry. */
const REPLAY_SESSION_KEY_BYTES = 64;
const REPLAY_SNAPSHOT_FILE = "antigravity-replay.json";
const REPLAY_SNAPSHOT_VERSION = 1;
const REPLAY_SNAPSHOT_DEBOUNCE_MS = 2_000;
/** Upper bound on flush retries: mutations arriving faster than writes complete
 * must not let shutdown hang; the last completed write is already on disk. */
const REPLAY_FLUSH_MAX_ATTEMPTS = 8;
/** Write bound for the durable snapshot (mirrors the responses-state cap). */
const REPLAY_SNAPSHOT_MAX_BYTES = 24 * 1024 * 1024;
/** Refuse-to-parse ceiling for an existing snapshot file. */
const REPLAY_SNAPSHOT_REFUSE_BYTES = 32 * 1024 * 1024;

interface ReplayLimits {
  maxCallsPerSession: number;
  maxBytesPerSession: number;
  maxSignatureBytes: number;
}

const DEFAULT_REPLAY_LIMITS: ReplayLimits = {
  maxCallsPerSession: REPLAY_MAX_CALLS_PER_SESSION,
  maxBytesPerSession: ANTIGRAVITY_REPLAY_MAX_BYTES_PER_SESSION,
  maxSignatureBytes: REPLAY_MAX_SIGNATURE_BYTES,
};

const replayCache = new Map<string, ReplayEntry>();
const utf8 = new TextEncoder();
let replayLimits = { ...DEFAULT_REPLAY_LIMITS };
let replayBytes = 0;
let replayOldestSessionKey: string | undefined;
let replayOldestAt: number | null = null;
let replaySnapshotLoaded = false;
let replaySnapshotPersistTimer: ReturnType<typeof setTimeout> | null = null;
let replaySnapshotPersistGate: Promise<void> = Promise.resolve();
/** Mutation generation: bumped on every cache change that needs persisting. */
let replayMutationGeneration = 0;
/** Generation of the data the last successful snapshot write actually captured. */
let replayWrittenGeneration = 0;
let replaySnapshotWriteSeam: AtomicWriteAsyncTestSeam | undefined;
let replaySnapshotLoadDiscarded = false;
let replaySnapshotMaxBytes = REPLAY_SNAPSHOT_MAX_BYTES;

function replaySnapshotPath(): string {
  return join(getConfigDir(), REPLAY_SNAPSHOT_FILE);
}

function loadReplaySnapshotEntry(key: string, value: unknown): void {
  if (!/^[0-9a-f]{64}$/.test(key)) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as { byCall?: unknown; expiresAtMs?: unknown; lastActiveAtMs?: unknown };
  if (typeof rec.expiresAtMs !== "number" || !Number.isFinite(rec.expiresAtMs)) return;
  // Expired sessions are dropped at load; a stale snapshot is self-healing.
  if (rec.expiresAtMs <= Date.now()) {
    replaySnapshotLoadDiscarded = true;
    return;
  }
  if (!Array.isArray(rec.byCall)) return;
  const byCall = new Map<string, ReplayCall>();
  let bytes = REPLAY_SESSION_KEY_BYTES;
  for (const pair of rec.byCall) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") continue;
    if (!/^[0-9a-f]{64}$/.test(pair[0])) continue;
    const call = pair[1] as { signature?: unknown; touchedAtMs?: unknown } | null;
    if (!call || typeof call !== "object" || Array.isArray(call)) continue;
    if (typeof call.signature !== "string" || call.signature.length < MIN_SIGNATURE_LEN) continue;
    if (typeof call.touchedAtMs !== "number" || !Number.isFinite(call.touchedAtMs)) continue;
    // Never trust a serialized sizeBytes: a forged snapshot could claim a tiny
    // size for a huge signature and bypass every byte cap. Recompute from the
    // signature itself, exactly like the live write path.
    const signatureBytes = utf8.encode(call.signature).byteLength;
    if (signatureBytes > replayLimits.maxSignatureBytes) continue;
    const callBytes = utf8.encode(pair[0]).byteLength + signatureBytes;
    if (callBytes > replayLimits.maxBytesPerSession) continue;
    // A duplicated call key would overstate entry.bytes (the map keeps only the
    // last value) and could evict valid sessions; keep the first occurrence.
    if (byCall.has(pair[0])) {
      replaySnapshotLoadDiscarded = true;
      continue;
    }
    byCall.set(pair[0], {
      signature: call.signature,
      sizeBytes: callBytes,
      touchedAtMs: call.touchedAtMs,
    });
    bytes += callBytes;
  }
  if (byCall.size === 0) {
    replaySnapshotLoadDiscarded = true;
    return;
  }
  const lastActiveAtMs = typeof rec.lastActiveAtMs === "number" && Number.isFinite(rec.lastActiveAtMs)
    ? rec.lastActiveAtMs
    : rec.expiresAtMs;
  const entry: ReplayEntry = { byCall, bytes, expiresAtMs: rec.expiresAtMs, oldestAtMs: null, lastActiveAtMs };
  const loadedCallCount = entry.byCall.size;
  // Account BEFORE trimming: evictInnerCalls decrements the global byte count
  // through deleteReplayCall, so the entry must already be on the books.
  replayCache.set(key, entry);
  replayBytes += entry.bytes;
  // Same per-session caps as live writes, in case limits changed across versions.
  evictInnerCalls(entry);
  if (entry.byCall.size < loadedCallCount) replaySnapshotLoadDiscarded = true;
  if (entry.byCall.size === 0) {
    deleteReplaySession(key);
    return;
  }
  refreshReplaySessionCandidate(key, entry);
}

/**
 * Lazy load of the durable snapshot on first cache access, so signatures observed
 * before a proxy restart are available again once the session id re-derives to the
 * same key (the session id is anchored on the first user message text). Load is
 * best-effort: missing, corrupt, or oversized files start the cache empty.
 */
function ensureReplaySnapshotLoaded(): void {
  if (replaySnapshotLoaded) return;
  replaySnapshotLoaded = true;
  replaySnapshotLoadDiscarded = false;
  try {
    const path = replaySnapshotPath();
    if (!existsSync(path)) return;
    const stat = statSync(path);
    // Bound the read BEFORE parse: the 24 MiB write cap constrains snapshots this
    // process wrote, not a pre-existing oversized file.
    if (!stat.isFile() || stat.size > REPLAY_SNAPSHOT_REFUSE_BYTES) return;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; sessions?: unknown };
    if (raw.version !== REPLAY_SNAPSHOT_VERSION || !Array.isArray(raw.sessions)) return;
    for (const entry of raw.sessions) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
      loadReplaySnapshotEntry(entry[0], entry[1]);
    }
  } catch {
    // Missing/corrupt snapshot: start empty.
  }
  const sessionsAfterLoad = replayCache.size;
  // Load-time admission must respect the same global caps as live writes.
  evictIfNeeded();
  if (replayCache.size < sessionsAfterLoad) replaySnapshotLoadDiscarded = true;
  // Persist the cleaned state once: expired/over-limit sessions must not stay
  // on disk and be re-parsed (and re-dropped) after every restart.
  if (replaySnapshotLoadDiscarded) markReplayDirty();
  enforceAppOwnedMemoryBudget();
}

function markReplayDirty(): void {
  replayMutationGeneration += 1;
  if (replaySnapshotPersistTimer) return;
  replaySnapshotPersistTimer = setTimeout(() => {
    void persistReplaySnapshotNow().catch(() => {
      // Redacted static message only: never echo the underlying error, which
      // can carry paths or other environment details.
      console.warn("[antigravity] replay snapshot persist failed; cached signatures will not survive a restart");
    });
  }, REPLAY_SNAPSHOT_DEBOUNCE_MS);
  (replaySnapshotPersistTimer as { unref?: () => void }).unref?.();
}

async function persistReplaySnapshotNow(): Promise<void> {
  if (replaySnapshotPersistTimer) {
    clearTimeout(replaySnapshotPersistTimer);
    replaySnapshotPersistTimer = null;
  }
  // Serialize writers so a flush and a debounced write cannot race on temps/ACL.
  const previous = replaySnapshotPersistGate;
  let release!: () => void;
  replaySnapshotPersistGate = new Promise<void>(resolve => { release = resolve; });
  await previous;
  const writeGeneration = replayMutationGeneration;
  try {
    const sessions: Array<[string, unknown]> = [];
    // Account for the bytes actually written, not just the entries: the document
    // is `{"version":N,"sessions":[...]}`, so the framing and the comma between
    // entries count against the cap too. Summing per-entry sizes alone let the
    // written file exceed replaySnapshotMaxBytes by a margin that grew with every
    // additional session.
    const prefix = `{"version":${JSON.stringify(REPLAY_SNAPSHOT_VERSION)},"sessions":[`;
    const suffix = "]}";
    const serialized: string[] = [];
    let total = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
    // Most-recently-active first so the sessions that survive the snapshot
    // byte cap are the ones actually in use (Map order is insertion order).
    for (const [key, entry] of [...replayCache].sort((a, b) => b[1].lastActiveAtMs - a[1].lastActiveAtMs)) {
      const byCall = [...entry.byCall].map(([callKey, call]) => [
        callKey,
        { signature: call.signature, touchedAtMs: call.touchedAtMs },
      ]);
      const persistEntry: [string, unknown] = [key, {
        byCall,
        expiresAtMs: entry.expiresAtMs,
        lastActiveAtMs: entry.lastActiveAtMs,
      }];
      const encoded = JSON.stringify(persistEntry);
      const size = Buffer.byteLength(encoded, "utf8") + (serialized.length > 0 ? 1 : 0);
      if (total + size > replaySnapshotMaxBytes) break;
      total += size;
      serialized.push(encoded);
      sessions.push(persistEntry);
    }
    serialized.reverse();
    const document = `${prefix}${serialized.join(",")}${suffix}`;
    // Defensive: the admitted entries are what we serialize, so this can only
    // trip if the accounting above and the payload below ever drift apart.
    if (Buffer.byteLength(document, "utf8") > replaySnapshotMaxBytes) {
      throw new Error("Antigravity replay snapshot exceeded its configured byte cap.");
    }
    mkdirSync(dirname(replaySnapshotPath()), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(replaySnapshotPath()), 0o700); } catch { /* best-effort (e.g. Windows) */ }
    await atomicWriteFileAsync(
      replaySnapshotPath(),
      document,
      undefined,
      replaySnapshotWriteSeam,
    );
    replayWrittenGeneration = writeGeneration;
  } finally {
    release();
  }
}

/** Flush any pending debounced snapshot write (graceful shutdown / deterministic tests). */
export async function flushAntigravityReplay(): Promise<void> {
  // Persist until the durable generation catches up with the latest mutation:
  // a change that lands while a writer is in flight must not be lost when
  // shutdown exits right after the first write completes.
  for (let attempt = 0; attempt < REPLAY_FLUSH_MAX_ATTEMPTS; attempt += 1) {
    if (replaySnapshotPersistTimer || replayMutationGeneration > replayWrittenGeneration) {
      await persistReplaySnapshotNow();
    }
    // No pending timer: still await any in-flight write so shutdown does not race it.
    await replaySnapshotPersistGate;
    if (replayMutationGeneration === replayWrittenGeneration && replaySnapshotPersistTimer === null) return;
  }
  // Budget exhausted without convergence. Resolving here would tell
  // drainAndShutdown() the snapshot is durable while the latest thought
  // signature may never have reached disk, so shutdown diagnostics would claim
  // a durability we cannot demonstrate. Reject instead, with fixed text: the
  // shutdown path logs this message, so it must not carry session, model, or
  // signature detail.
  throw new Error("Antigravity replay snapshot flush did not converge.");
}

/**
 * Fixed-size identity for a (model, sessionId) pair: SHA-256 over
 * length-prefixed UTF-16 code units fed incrementally (no separator ambiguity
 * — `("a\0b","c")` and `("a","b\0c")` derive different keys — and no raw
 * model/session strings retained as Map keys, which the byte caps never
 * counted).
 */
/**
 * Injective string feed for key derivation: length-prefixed in CODE UNITS,
 * then each code unit as two little-endian bytes. TextEncoder/UTF-8 would
 * fold lone surrogates into U+FFFD, colliding distinct strings (e.g.
 * "�" and "�") into the same key.
 */
function updateHashWithString(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(value.length));
  hash.update("\0");
  const buf = Buffer.allocUnsafe(8192);
  let offset = 0;
  for (let index = 0; index < value.length; index += 1) {
    buf.writeUInt16LE(value.charCodeAt(index), offset);
    offset += 2;
    if (offset === buf.length) {
      hash.update(buf);
      offset = 0;
    }
  }
  if (offset > 0) hash.update(buf.subarray(0, offset));
}

function replayKey(model: string, sessionId: string): string {
  const hash = createHash("sha256");
  updateHashWithString(hash, model);
  updateHashWithString(hash, sessionId);
  return hash.digest("hex");
}

/** Canonical output exceeding this budget is rejected DURING the walk — the
 * pre-fix path materialized an unbounded canonical string before admission. */
const REPLAY_MAX_CANONICAL_ARGS_BYTES = 64 * 1024;
const CANONICAL_OVERFLOW = Symbol("canonical-overflow");

/** Byte-identical output to the old recursive canonicalJson, written incrementally. */
/**
 * Key-count pre-check: every object key costs at least 4 canonical bytes
 * (two quotes, colon, separator), so a wider object ALWAYS overflows the
 * canonical budget — skip the sort and the walk. Object.keys allocation
 * itself is linear and irreducible in JS (there is no streaming key API),
 * but it is transient and never sorted or walked past this bound.
 */
const CANONICAL_MAX_KEYS_PER_OBJECT = REPLAY_MAX_CANONICAL_ARGS_BYTES / 4;

/** Test-only scan instrumentation: proves overflow aborts the walk near the
 * cap instead of scanning/materializing the whole input. */
let canonicalScanUnitsForTests = 0;
export function canonicalScanUnitsForTestsValue(): number {
  return canonicalScanUnitsForTests;
}
export function resetCanonicalScanUnitsForTests(): void {
  canonicalScanUnitsForTests = 0;
}

const MAX_CANONICAL_DEPTH = 128;

function writeCanonicalJson(value: unknown, sink: (chunk: string) => void, depth = 0): void {
  canonicalScanUnitsForTests += 1;
  // Depth overflow is the same class as byte overflow: skip replay for this
  // call instead of exhausting the stack on a pathological argument shape.
  if (depth > MAX_CANONICAL_DEPTH) throw CANONICAL_OVERFLOW;
  if (typeof value === "string") {
    writeJsonStringEscaped(value, sink);
    return;
  }
  if (value === null || typeof value !== "object") {
    sink(JSON.stringify(value) ?? "null");
    return;
  }
  if (Array.isArray(value)) {
    sink("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) sink(",");
      // Array.prototype.map parity: holes produce NOTHING between the commas
      // (old output `[1,,3]`), while an explicit undefined element is "null".
      if (index in value) writeCanonicalJson(value[index], sink, depth + 1);
    }
    sink("]");
    return;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > CANONICAL_MAX_KEYS_PER_OBJECT) throw CANONICAL_OVERFLOW;
  keys.sort();
  sink("{");
  keys.forEach((k, index) => {
    if (index > 0) sink(",");
    writeJsonStringEscaped(k, sink);
    sink(":");
    writeCanonicalJson((value as Record<string, unknown>)[k], sink, depth + 1);
  });
  sink("}");
}

/**
 * JSON.stringify string escaping, streamed in small chunks so the budget can
 * reject mid-string — calling JSON.stringify on a multi-MiB primitive would
 * materialize its full escaped form before the sink could refuse it.
 * Semantics mirror JSON.stringify for strings exactly (ES2019 JSON
 * superset): quotes/backslash and control characters are escaped, LONE
 * surrogates become \uXXXX, and valid surrogate pairs pass through raw.
 */
function writeJsonStringEscaped(value: string, sink: (chunk: string) => void): void {
  sink('"');
  let buffer = "";
  for (const cp of value) {
    canonicalScanUnitsForTests += 1;
    const code = cp.codePointAt(0)!;
    let escaped: string;
    if (cp === '"') escaped = '\\"';
    else if (cp === "\\") escaped = "\\\\";
    else if (cp === "\b") escaped = "\\b";
    else if (cp === "\f") escaped = "\\f";
    else if (cp === "\n") escaped = "\\n";
    else if (cp === "\r") escaped = "\\r";
    else if (cp === "\t") escaped = "\\t";
    else if (code < 0x20) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    // Lone surrogates: JSON.stringify emits \uXXXX (a raw one would decode
    // back as U+FFFD and collide with real U+FFFD content).
    else if (code >= 0xd800 && code <= 0xdfff) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
    else escaped = cp;
    buffer += escaped;
    if (buffer.length >= 4096) {
      sink(buffer);
      buffer = "";
    }
  }
  if (buffer.length > 0) sink(buffer);
  sink('"');
}

/** Bounded canonicalization: null on overflow (skip replay for that call). */
function canonicalJsonBounded(value: unknown, maxBytes: number): string | null {
  let written = 0;
  const parts: string[] = [];
  const sink = (chunk: string) => {
    written += utf8.encode(chunk).byteLength;
    if (written > maxBytes) throw CANONICAL_OVERFLOW;
    parts.push(chunk);
  };
  try {
    writeCanonicalJson(value, sink);
  } catch (error) {
    if (error === CANONICAL_OVERFLOW) return null;
    throw error;
  }
  return parts.join("");
}

/**
 * Stable identity for a functionCall part: fixed-size SHA-256 over
 * length-prefixed name + canonical args. Overflow during canonicalization
 * skips replay for that call (never materializes an unbounded string); other
 * canonicalization failures keep the old name-only fallback semantics.
 */
function functionCallKey(name: unknown, args: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  let canonical: string | null;
  try {
    canonical = canonicalJsonBounded(args ?? {}, REPLAY_MAX_CANONICAL_ARGS_BYTES);
  } catch {
    canonical = "";
  }
  if (canonical === null) return undefined;
  const hash = createHash("sha256");
  updateHashWithString(hash, name);
  updateHashWithString(hash, canonical);
  return hash.digest("hex");
}

/** Test-only key-derivation seam: the fixed-key regression cannot go red
 * through snapshot.bytes (that metric never counted raw outer keys). */
export function antigravityReplayKeyForTests(model: string, sessionId: string): string {
  return replayKey(model, sessionId);
}

export function antigravityFunctionCallKeyForTests(name: unknown, args: unknown): string | undefined {
  return functionCallKey(name, args);
}

/** Test-only bounded-canonicalization seam: proves mid-walk rejection without
 * materializing the escaped form (allocation guard). */
export function antigravityCanonicalJsonBoundedForTests(value: unknown, maxBytes: number): string | null {
  return canonicalJsonBounded(value, maxBytes);
}

/** Test-only: the ACTUAL internal session keys, so tests can prove raw
 * model/session strings are never retained as Map keys. */
export function antigravityReplaySessionKeysForTests(): string[] {
  return [...replayCache.keys()];
}

function extractSignature(part: Record<string, unknown>): string | undefined {
  const direct = part.thoughtSignature ?? part.thought_signature;
  if (typeof direct === "string" && direct.length >= MIN_SIGNATURE_LEN) return direct;
  const extra = part.extra_content as { google?: { thought_signature?: unknown } } | undefined;
  const nested = extra?.google?.thought_signature;
  if (typeof nested === "string" && nested.length >= MIN_SIGNATURE_LEN) return nested;
  return undefined;
}

function deleteReplaySession(key: string): number {
  const entry = replayCache.get(key);
  if (!entry) return 0;
  replayCache.delete(key);
  replayBytes -= entry.bytes;
  if (replayOldestSessionKey === key) recomputeReplayOldestCandidate();
  return entry.bytes;
}

function recomputeReplayOldestCandidate(): void {
  replayOldestSessionKey = undefined;
  replayOldestAt = null;
  for (const [key, entry] of replayCache) {
    if (entry.oldestAtMs === null || (replayOldestAt !== null && entry.oldestAtMs >= replayOldestAt)) continue;
    replayOldestSessionKey = key;
    replayOldestAt = entry.oldestAtMs;
  }
}

function refreshReplaySessionCandidate(key: string, entry: ReplayEntry): void {
  entry.oldestAtMs = entry.byCall.values().next().value?.touchedAtMs ?? null;
  if (replayOldestSessionKey === key) {
    recomputeReplayOldestCandidate();
    return;
  }
  if (entry.oldestAtMs !== null && (replayOldestAt === null || entry.oldestAtMs < replayOldestAt)) {
    replayOldestSessionKey = key;
    replayOldestAt = entry.oldestAtMs;
  }
}

function deleteExpiredReplaySessions(now: number): void {
  let deleted = false;
  for (const [key, entry] of replayCache) {
    if (entry.expiresAtMs > now) continue;
    deleteReplaySession(key);
    deleted = true;
  }
  // Expiry is a durable mutation too: rewrite the snapshot so opaque thought
  // signatures do not remain at rest after their in-memory TTL has elapsed.
  if (deleted) markReplayDirty();
}

/**
 * The lazy per-call expiry scan is O(sessions); at the 10,240-session cap
 * every observe/apply would rescan the whole map — O(n²) under load. The 60s
 * state-store sweeper is already the periodic expiry authority, so lazy scans
 * are throttled to at most one per interval (expired entries may linger a few
 * extra seconds; TTL is fuzzy at that scale by design).
 */
const LAZY_SWEEP_INTERVAL_MS = 30_000;
let lastLazySweepAt = Number.NEGATIVE_INFINITY;

function deleteExpiredReplaySessionsThrottled(now: number): void {
  if (now - lastLazySweepAt < LAZY_SWEEP_INTERVAL_MS) return;
  lastLazySweepAt = now;
  deleteExpiredReplaySessions(now);
}

export function sweepExpiredAntigravityReplay(now = Date.now()): number {
  const before = replayCache.size;
  deleteExpiredReplaySessions(now);
  return before - replayCache.size;
}

function deleteReplayCall(entry: ReplayEntry, callKey: string): number {
  const call = entry.byCall.get(callKey);
  if (!call) return 0;
  entry.byCall.delete(callKey);
  entry.bytes -= call.sizeBytes;
  replayBytes -= call.sizeBytes;
  return call.sizeBytes;
}

function evictInnerCalls(entry: ReplayEntry): void {
  while (
    entry.byCall.size > replayLimits.maxCallsPerSession
    || entry.bytes > replayLimits.maxBytesPerSession
  ) {
    const oldest = entry.byCall.keys().next().value;
    if (oldest === undefined) break;
    deleteReplayCall(entry, oldest);
  }
}

function evictIfNeeded(): void {
  if (replayCache.size > ANTIGRAVITY_REPLAY_MAX_ENTRIES) {
    const oldest = [...replayCache.entries()]
      .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)
      .slice(0, REPLAY_EVICT_BATCH);
    for (const [key] of oldest) deleteReplaySession(key);
  }
  while (replayBytes > ANTIGRAVITY_REPLAY_MAX_TOTAL_BYTES) {
    const oldestKey = [...replayCache.entries()]
      .sort((a, b) => a[1].expiresAtMs - b[1].expiresAtMs)[0]?.[0];
    if (oldestKey === undefined) return;
    deleteReplaySession(oldestKey);
  }
}

/** Gemini/Flash/Agent use the replay cache; Claude does not (inline sanitization instead). */
export function antigravityUsesReplayCache(model: string): boolean {
  return !/claude/i.test(model);
}

/**
 * Observe a parsed CCA chunk's `candidates[0].content.parts` and record thought signatures keyed by
 * the functionCall identity (name + args). Accumulates across the whole session so a sequential
 * multi-step tool loop keeps EVERY prior call's signature, not just the latest part-index slot.
 * A signature on a standalone thought part applies to the functionCall parts that follow it in
 * the same array AND to later arrays of the same turn: streaming splits a thought part and its
 * calls across SSE chunks, so `carriedThoughtSig` threads the still-unpaired signature from the
 * previous chunk and the return value hands the remainder to the next one (#897, #2125). A call's
 * own signature always takes precedence over a carried one.
 * `parts` is the already-unwrapped `response.candidates[0].content.parts`.
 */
export function observeAntigravityReplay(
  model: string,
  sessionId: string,
  parts: unknown[],
  carriedThoughtSig?: string,
): string | undefined {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(parts) || parts.length === 0) return carriedThoughtSig;
  ensureReplaySnapshotLoaded();
  const now = Date.now();
  deleteExpiredReplaySessionsThrottled(now);
  const key = replayKey(model, sessionId);
  const existing = replayCache.get(key);
  const entry = existing ?? {
    byCall: new Map<string, ReplayCall>(),
    bytes: REPLAY_SESSION_KEY_BYTES,
    expiresAtMs: 0,
    oldestAtMs: null,
    lastActiveAtMs: 0,
  };
  let inserted = false;
  let pendingThoughtSig: string | undefined = carriedThoughtSig;
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    const sig = extractSignature(part);
    const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
    if (!fc) {
      // A signature on a standalone thought part pairs with the NEXT functionCall in this
      // array: thought parts are stripped from replayed history, so the call part is the only
      // carrier that survives (#897). Non-thought parts keep their own signature in history.
      if (sig && part.thought === true) pendingThoughtSig = sig;
      continue;
    }
    const callSig = sig ?? pendingThoughtSig; // a signature on the call part itself wins
    if (!callSig) continue;
    const ck = functionCallKey(fc.name, fc.args);
    if (!ck) continue; // only function-call signatures are replayable by identity
    const signatureBytes = utf8.encode(callSig).byteLength;
    const sizeBytes = utf8.encode(ck).byteLength + signatureBytes;
    if (signatureBytes > replayLimits.maxSignatureBytes || sizeBytes > replayLimits.maxBytesPerSession) continue;
    deleteReplayCall(entry, ck);
    entry.byCall.set(ck, { signature: callSig, sizeBytes, touchedAtMs: now });
    entry.bytes += sizeBytes;
    replayBytes += sizeBytes;
    inserted = true;
  }
  if (!inserted) return pendingThoughtSig;
  // Charge the fixed outer key only when the session is actually stored.
  if (!existing) replayBytes += REPLAY_SESSION_KEY_BYTES;
  evictInnerCalls(entry);
  if (entry.byCall.size === 0) {
    // The fixed session overhead can exceed the per-session cap on its own
    // (test-sized limits): an entry holding zero calls is unusable — drop it
    // instead of retaining an unevictable shell.
    if (existing) {
      deleteReplaySession(key);
      markReplayDirty();
    } else {
      replayBytes -= REPLAY_SESSION_KEY_BYTES;
    }
    return pendingThoughtSig;
  }
  entry.expiresAtMs = now + REPLAY_TTL_MS;
  entry.lastActiveAtMs = now;
  replayCache.set(key, entry);
  refreshReplaySessionCandidate(key, entry);
  evictIfNeeded();
  enforceAppOwnedMemoryBudget();
  markReplayDirty();
  return pendingThoughtSig;
}

/**
 * Re-inject cached thought signatures into the outgoing `request.contents`, matched by functionCall
 * identity across ALL model turns (not just the last one). Only fills a functionCall part that
 * lacks a real signature. Returns the same array reference (mutated in place).
 */
export function applyAntigravityReplay(model: string, sessionId: string, contents: unknown[]): unknown[] {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(contents)) return contents;
  ensureReplaySnapshotLoaded();
  const now = Date.now();
  deleteExpiredReplaySessionsThrottled(now);
  const entry = replayCache.get(replayKey(model, sessionId));
  if (!entry) {
    return contents;
  }
  let touched = false;
  for (const c of contents as { role?: string; parts?: unknown[] }[]) {
    if (!c || typeof c !== "object" || c.role !== "model" || !Array.isArray(c.parts)) continue;
    for (const raw of c.parts) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (!fc) continue;
      if (part.thoughtSignature !== undefined || part.thought_signature !== undefined) continue;
      const ck = functionCallKey(fc.name, fc.args);
      let call = ck ? entry.byCall.get(ck) : undefined;
      let matchedKey = ck;
      if (!call && typeof fc.name === "string" && typeof fc.args === "object" && fc.args !== null) {
        // Freeform / custom tool replay unwrap:
        // The client replays custom_tool_call with arguments: { input: "..." }.
        // Upstream was invoked with args: { input: "..." } or raw string or parsed JSON.
        const argsObj = fc.args as Record<string, unknown>;
        if (typeof argsObj.input === "string") {
          const trimmedInput = argsObj.input.trim();
          if (
            trimmedInput.length <= REPLAY_MAX_CANONICAL_ARGS_BYTES
            && utf8.encode(trimmedInput).byteLength <= REPLAY_MAX_CANONICAL_ARGS_BYTES
          ) {
            try {
              const parsedInput = JSON.parse(trimmedInput);
            if (parsedInput && typeof parsedInput === "object") {
              const altKey = functionCallKey(fc.name, parsedInput);
              if (altKey && entry.byCall.has(altKey)) {
                call = entry.byCall.get(altKey);
                matchedKey = altKey;
              }
            }
            } catch {
              // not JSON, keep default
            }
          }
        }
      }
      if (call && matchedKey) {
        part.thoughtSignature = call.signature;
        entry.byCall.delete(matchedKey);
        entry.byCall.set(matchedKey, { ...call, touchedAtMs: now });
        touched = true;
      }
    }
  }
  if (touched) {
    entry.lastActiveAtMs = now;
    refreshReplaySessionCandidate(replayKey(model, sessionId), entry);
    markReplayDirty();
  }
  return contents;
}

/** Drop the cache entry when upstream rejects a signature (clear-on-invalid). */
export function clearAntigravityReplay(model: string, sessionId: string): void {
  ensureReplaySnapshotLoaded();
  if (deleteReplaySession(replayKey(model, sessionId)) > 0) markReplayDirty();
}

export function antigravityReplayMetrics(): {
  sessions: number;
  calls: number;
  totalBytes: number;
  largestSessionBytes: number;
} {
  ensureReplaySnapshotLoaded();
  let calls = 0;
  let largestSessionBytes = 0;
  for (const entry of replayCache.values()) {
    calls += entry.byCall.size;
    largestSessionBytes = Math.max(largestSessionBytes, entry.bytes);
  }
  return { sessions: replayCache.size, calls, totalBytes: replayBytes, largestSessionBytes };
}

export function antigravityReplayRetainedStoreSnapshot(): {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
} {
  ensureReplaySnapshotLoaded();
  return {
    count: replayCache.size,
    bytes: replayBytes,
    evictableBytes: replayBytes,
    pinnedBytes: 0,
    oldestAt: replayOldestAt,
  };
}

export function evictOldestAntigravityReplayForBudget(): number {
  ensureReplaySnapshotLoaded();
  const removed = replayOldestSessionKey === undefined ? 0 : deleteReplaySession(replayOldestSessionKey);
  if (removed > 0) markReplayDirty();
  return removed;
}

export function setAntigravityReplayLimitsForTests(limits?: Partial<ReplayLimits>): void {
  __resetAntigravityReplayCache();
  replayLimits = limits ? { ...DEFAULT_REPLAY_LIMITS, ...limits } : { ...DEFAULT_REPLAY_LIMITS };
}

/** Test-only write seam (mirrors AtomicWriteAsyncTestSeam usage elsewhere). */
export function setAntigravityReplayWriteSeamForTests(seam: AtomicWriteAsyncTestSeam | undefined): void {
  replaySnapshotWriteSeam = seam;
}

/** Test-only snapshot byte cap (mirrors the limits seam). */
export function setAntigravityReplaySnapshotMaxBytesForTests(maxBytes: number): void {
  replaySnapshotMaxBytes = maxBytes;
}

/** Test seam. */
export function __resetAntigravityReplayCache(): void {
  if (replaySnapshotPersistTimer) {
    clearTimeout(replaySnapshotPersistTimer);
    replaySnapshotPersistTimer = null;
  }
  replaySnapshotLoaded = false;
  lastLazySweepAt = Number.NEGATIVE_INFINITY;
  replayCache.clear();
  replayBytes = 0;
  replayOldestSessionKey = undefined;
  replayOldestAt = null;
  replayMutationGeneration = 0;
  replayWrittenGeneration = 0;
  replaySnapshotWriteSeam = undefined;
  replaySnapshotLoadDiscarded = false;
  replaySnapshotMaxBytes = REPLAY_SNAPSHOT_MAX_BYTES;
}
