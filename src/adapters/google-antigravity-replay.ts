import { createHash } from "node:crypto";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";

/**
 * Antigravity (Cloud Code Assist) thoughtSignature reasoning-replay cache.
 *
 * Gemini-3 interleaved thinking is stateless upstream: each model content part carries a
 * `thoughtSignature` that MUST be echoed back on the matching part in the next request, or the
 * upstream rejects the turn (HTTP 400). We observe signatures on the response stream, cache them
 * per `model + session`, and re-inject them into the outgoing `request.contents` on the next turn.
 *
 * Mirrors CLIProxyAPI `internal/runtime/executor/antigravity_reasoning_replay.go`. Gemini-only;
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
  for (const [key, entry] of replayCache) if (entry.expiresAtMs <= now) deleteReplaySession(key);
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
 * A signature on a standalone thought part is paired with the next functionCall in the same
 * array (#897); a call's own signature takes precedence and an unpaired one is dropped.
 * `parts` is the already-unwrapped `response.candidates[0].content.parts`.
 */
export function observeAntigravityReplay(model: string, sessionId: string, parts: unknown[]): void {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(parts) || parts.length === 0) return;
  const now = Date.now();
  deleteExpiredReplaySessionsThrottled(now);
  const key = replayKey(model, sessionId);
  const existing = replayCache.get(key);
  const entry = existing ?? {
    byCall: new Map<string, ReplayCall>(),
    bytes: REPLAY_SESSION_KEY_BYTES,
    expiresAtMs: 0,
    oldestAtMs: null,
  };
  let inserted = false;
  let pendingThoughtSig: string | undefined;
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
    pendingThoughtSig = undefined;
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
  if (!inserted) return;
  // Charge the fixed outer key only when the session is actually stored.
  if (!existing) replayBytes += REPLAY_SESSION_KEY_BYTES;
  evictInnerCalls(entry);
  if (entry.byCall.size === 0) {
    // The fixed session overhead can exceed the per-session cap on its own
    // (test-sized limits): an entry holding zero calls is unusable — drop it
    // instead of retaining an unevictable shell.
    if (existing) deleteReplaySession(key);
    else replayBytes -= REPLAY_SESSION_KEY_BYTES;
    return;
  }
  entry.expiresAtMs = now + REPLAY_TTL_MS;
  replayCache.set(key, entry);
  refreshReplaySessionCandidate(key, entry);
  evictIfNeeded();
  enforceAppOwnedMemoryBudget();
}

/**
 * Re-inject cached thought signatures into the outgoing `request.contents`, matched by functionCall
 * identity across ALL model turns (not just the last one). Only fills a functionCall part that
 * lacks a real signature. Returns the same array reference (mutated in place).
 */
export function applyAntigravityReplay(model: string, sessionId: string, contents: unknown[]): unknown[] {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(contents)) return contents;
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
      const call = ck ? entry.byCall.get(ck) : undefined;
      if (call && ck) {
        part.thoughtSignature = call.signature;
        entry.byCall.delete(ck);
        entry.byCall.set(ck, { ...call, touchedAtMs: now });
        touched = true;
      }
    }
  }
  if (touched) refreshReplaySessionCandidate(replayKey(model, sessionId), entry);
  return contents;
}

/** Drop the cache entry when upstream rejects a signature (clear-on-invalid). */
export function clearAntigravityReplay(model: string, sessionId: string): void {
  deleteReplaySession(replayKey(model, sessionId));
}

export function antigravityReplayMetrics(): {
  sessions: number;
  calls: number;
  totalBytes: number;
  largestSessionBytes: number;
} {
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
  return {
    count: replayCache.size,
    bytes: replayBytes,
    evictableBytes: replayBytes,
    pinnedBytes: 0,
    oldestAt: replayOldestAt,
  };
}

export function evictOldestAntigravityReplayForBudget(): number {
  return replayOldestSessionKey === undefined ? 0 : deleteReplaySession(replayOldestSessionKey);
}

export function setAntigravityReplayLimitsForTests(limits?: Partial<ReplayLimits>): void {
  __resetAntigravityReplayCache();
  replayLimits = limits ? { ...DEFAULT_REPLAY_LIMITS, ...limits } : { ...DEFAULT_REPLAY_LIMITS };
}

/** Test seam. */
export function __resetAntigravityReplayCache(): void {
  lastLazySweepAt = Number.NEGATIVE_INFINITY;
  replayCache.clear();
  replayBytes = 0;
  replayOldestSessionKey = undefined;
  replayOldestAt = null;
}
