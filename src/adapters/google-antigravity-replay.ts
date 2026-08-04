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

function replayKey(model: string, sessionId: string): string {
  return `${model}::session:${sessionId}`;
}

/** Recursively canonicalize a JSON value: object keys sorted, arrays preserved. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>).sort()
    .map(k => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/** Stable identity for a functionCall part: name + recursively canonicalized args. */
function functionCallKey(name: unknown, args: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return undefined;
  let argsKey = "";
  try {
    argsKey = canonicalJson(args ?? {});
  } catch {
    argsKey = "";
  }
  return `${name}::${argsKey}`;
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
 * `parts` is the already-unwrapped `response.candidates[0].content.parts`.
 */
export function observeAntigravityReplay(model: string, sessionId: string, parts: unknown[]): void {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(parts) || parts.length === 0) return;
  const now = Date.now();
  deleteExpiredReplaySessions(now);
  const key = replayKey(model, sessionId);
  const entry = replayCache.get(key) ?? {
    byCall: new Map<string, ReplayCall>(),
    bytes: 0,
    expiresAtMs: 0,
    oldestAtMs: null,
  };
  let inserted = false;
  for (const raw of parts) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, unknown>;
    const sig = extractSignature(part);
    if (!sig) continue;
    const fc = part.functionCall as { name?: unknown; args?: unknown } | undefined;
    const ck = fc ? functionCallKey(fc.name, fc.args) : undefined;
    if (!ck) continue; // only function-call signatures are replayable by identity
    const signatureBytes = utf8.encode(sig).byteLength;
    const sizeBytes = utf8.encode(ck).byteLength + signatureBytes;
    if (signatureBytes > replayLimits.maxSignatureBytes || sizeBytes > replayLimits.maxBytesPerSession) continue;
    deleteReplayCall(entry, ck);
    entry.byCall.set(ck, { signature: sig, sizeBytes, touchedAtMs: now });
    entry.bytes += sizeBytes;
    replayBytes += sizeBytes;
    inserted = true;
  }
  if (!inserted) return;
  evictInnerCalls(entry);
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
  deleteExpiredReplaySessions(now);
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
  replayCache.clear();
  replayBytes = 0;
  replayOldestSessionKey = undefined;
  replayOldestAt = null;
}
