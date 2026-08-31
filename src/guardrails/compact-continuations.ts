import { createHash, type Hash } from "node:crypto";
import type { RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type {
  GuardrailsContinuationLease,
  GuardrailsContinuationScope,
} from "./continuations";
import type { GuardrailsPlaceholderState } from "./types";

const MAX_COMPACT_CONTINUATIONS = 1_000;
const MAX_COMPACT_CONTINUATION_BYTES = 8 * 1024 * 1024;
const COMPACT_CONTINUATION_TTL_MS = 60 * 60 * 1_000;
const MAX_FINGERPRINT_BYTES = 32 * 1024 * 1024;
const MAX_FINGERPRINT_DEPTH = 64;
const MAX_FINGERPRINT_NODES = 100_000;

interface CompactContinuationEntry {
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
  itemCount: number;
  key: string;
  lineageId: string;
  pins: number;
  policyRevision: string;
  sizeBytes: number;
  state?: GuardrailsPlaceholderState;
}

export type RememberGuardrailsCompactResult =
  | { status: "stored" | "duplicate" }
  | { status: "collision" | "expired" | "invalid" | "over_capacity" };

const entries = new Map<string, CompactContinuationEntry>();
let retainedBytes = 0;

function scopeKey(scope: GuardrailsContinuationScope): string {
  return JSON.stringify([
    scope.admissionKind,
    scope.admissionKind === "configured" ? scope.apiKeyDigest : null,
    scope.clientThreadDigest,
  ]);
}

function entryKey(scope: GuardrailsContinuationScope, itemCount: number, fingerprint: string): string {
  return `${scopeKey(scope)}\n${itemCount}\n${fingerprint}`;
}

interface FingerprintBudget {
  bytes: number;
  nodes: number;
}

function updateHash(hash: Hash, budget: FingerprintBudget, text: string): void {
  budget.bytes += Buffer.byteLength(text, "utf8");
  if (budget.bytes > MAX_FINGERPRINT_BYTES) throw new Error("compact fingerprint byte limit exceeded");
  hash.update(text);
}

function hashCanonicalJson(
  hash: Hash,
  budget: FingerprintBudget,
  value: unknown,
  depth: number,
): void {
  budget.nodes += 1;
  if (budget.nodes > MAX_FINGERPRINT_NODES || depth > MAX_FINGERPRINT_DEPTH) {
    throw new Error("compact fingerprint traversal limit exceeded");
  }
  if (value === null || typeof value !== "object") {
    updateHash(hash, budget, JSON.stringify(value) ?? "null");
    return;
  }
  if (Array.isArray(value)) {
    updateHash(hash, budget, "[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) updateHash(hash, budget, ",");
      hashCanonicalJson(hash, budget, value[index], depth + 1);
    }
    updateHash(hash, budget, "]");
    return;
  }
  updateHash(hash, budget, "{");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) updateHash(hash, budget, ",");
    const key = keys[index]!;
    updateHash(hash, budget, JSON.stringify(key));
    updateHash(hash, budget, ":");
    hashCanonicalJson(hash, budget, record[key], depth + 1);
  }
  updateHash(hash, budget, "}");
}

function compactFingerprint(items: readonly unknown[]): string | undefined {
  try {
    const hash = createHash("sha256");
    const budget = { bytes: 0, nodes: 0 };
    updateHash(hash, budget, "[");
    for (let index = 0; index < items.length; index += 1) {
      if (index > 0) updateHash(hash, budget, ",");
      hashCanonicalJson(hash, budget, items[index], 1);
    }
    updateHash(hash, budget, "]");
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function compactPrefixFingerprints(items: readonly unknown[]): Array<{ fingerprint: string; itemCount: number }> {
  try {
    const hash = createHash("sha256");
    const budget = { bytes: 0, nodes: 0 };
    const fingerprints: Array<{ fingerprint: string; itemCount: number }> = [];
    updateHash(hash, budget, "[");
    for (let index = 0; index < items.length; index += 1) {
      if (index > 0) updateHash(hash, budget, ",");
      hashCanonicalJson(hash, budget, items[index], 1);
      const prefix = hash.copy();
      prefix.update("]");
      fingerprints.push({ fingerprint: prefix.digest("hex"), itemCount: index + 1 });
    }
    return fingerprints;
  } catch {
    return [];
  }
}

function serializedBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : Buffer.byteLength(encoded, "utf8");
  } catch {
    return null;
  }
}

function remove(key: string, allowPinned = false): number {
  const entry = entries.get(key);
  if (!entry || (entry.pins > 0 && !allowPinned)) return 0;
  entries.delete(key);
  retainedBytes = Math.max(0, retainedBytes - entry.sizeBytes);
  return entry.sizeBytes;
}

function prune(now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now && (entry.pins === 0 || entry.state === undefined)) {
      remove(key, entry.state === undefined);
    }
  }
  while (entries.size > MAX_COMPACT_CONTINUATIONS || retainedBytes > MAX_COMPACT_CONTINUATION_BYTES) {
    const oldest = [...entries.entries()]
      .filter(([, entry]) => entry.pins === 0 && entry.state !== undefined)
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
    if (!oldest) break;
    remove(oldest[0]);
  }
}

function planAdmission(sizeBytes: number): string[] | null {
  let projectedBytes = retainedBytes + sizeBytes;
  let projectedCount = entries.size + 1;
  const evictions: string[] = [];
  const candidates = [...entries.entries()]
    .filter(([, entry]) => entry.pins === 0 && entry.state !== undefined)
    .sort((left, right) => left[1].createdAt - right[1].createdAt);
  for (const [key, entry] of candidates) {
    if (projectedBytes <= MAX_COMPACT_CONTINUATION_BYTES
      && projectedCount <= MAX_COMPACT_CONTINUATIONS) break;
    evictions.push(key);
    projectedBytes -= entry.sizeBytes;
    projectedCount -= 1;
  }
  return projectedBytes <= MAX_COMPACT_CONTINUATION_BYTES
    && projectedCount <= MAX_COMPACT_CONTINUATIONS
    ? evictions
    : null;
}

function leaseEntry(entry: CompactContinuationEntry): GuardrailsContinuationLease {
  const state = entry.state;
  if (!state) throw new Error("Guardrails compact continuation fingerprint is ambiguous");
  entry.pins += 1;
  let released = false;
  return {
    expiresAt: entry.expiresAt,
    lineageId: entry.lineageId,
    policyRevision: entry.policyRevision,
    state: structuredClone(state),
    release() {
      if (released) return;
      released = true;
      entry.pins = Math.max(0, entry.pins - 1);
      if (entries.get(entry.key) !== entry) return;
      if (entry.expiresAt <= Date.now()) remove(entry.key);
      else prune();
    },
  };
}

function poisonEntry(entry: CompactContinuationEntry): void {
  if (entry.state === undefined) return;
  const sizeBytes = serializedBytes({
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    fingerprint: entry.fingerprint,
    itemCount: entry.itemCount,
    key: entry.key,
    lineageId: entry.lineageId,
    pins: 0,
    policyRevision: entry.policyRevision,
    state: undefined,
  });
  if (sizeBytes === null) throw new Error("Guardrails compact continuation fingerprint is ambiguous");
  delete entry.state;
  retainedBytes = Math.max(0, retainedBytes - entry.sizeBytes + sizeBytes);
  entry.sizeBytes = sizeBytes;
}

export function rememberGuardrailsCompactContinuation(options: {
  expiresAt?: number;
  items: readonly unknown[];
  lineageId: string;
  policyRevision: string;
  scope: GuardrailsContinuationScope | undefined;
  state: GuardrailsPlaceholderState;
}): RememberGuardrailsCompactResult {
  if (!options.scope
    || options.items.length === 0
    || options.state.replacements.length === 0
    || options.lineageId.trim().length === 0
    || !/^[0-9a-f]{64}$/.test(options.policyRevision)) return { status: "invalid" };
  const fingerprint = compactFingerprint(options.items);
  if (!fingerprint) return { status: "invalid" };
  const key = entryKey(options.scope, options.items.length, fingerprint);
  const state = structuredClone(options.state);
  const now = Date.now();
  const expiresAt = Math.min(
    options.expiresAt ?? now + COMPACT_CONTINUATION_TTL_MS,
    now + COMPACT_CONTINUATION_TTL_MS,
  );
  if (expiresAt <= now) return { status: "expired" };
  prune(now);
  const existing = entries.get(key);
  if (existing) {
    if (existing.state !== undefined
      && existing.lineageId === options.lineageId
      && existing.policyRevision === options.policyRevision
      && JSON.stringify(existing.state) === JSON.stringify(state)) {
      return { status: "duplicate" };
    }
    poisonEntry(existing);
    return { status: "collision" };
  }
  const entryBase = {
    createdAt: now,
    expiresAt,
    fingerprint,
    itemCount: options.items.length,
    key,
    lineageId: options.lineageId,
    pins: 0,
    policyRevision: options.policyRevision,
    state,
  };
  const sizeBytes = serializedBytes(entryBase);
  if (sizeBytes === null || sizeBytes > MAX_COMPACT_CONTINUATION_BYTES) return { status: "over_capacity" };
  const evictions = planAdmission(sizeBytes);
  if (!evictions) return { status: "over_capacity" };
  for (const eviction of evictions) remove(eviction);
  entries.set(key, { ...entryBase, sizeBytes });
  retainedBytes += sizeBytes;
  return { status: "stored" };
}

export function retainGuardrailsCompactContinuation(
  input: unknown,
  scope: GuardrailsContinuationScope | undefined,
): GuardrailsContinuationLease | undefined {
  if (!scope || !Array.isArray(input) || input.length === 0) return undefined;
  const now = Date.now();
  prune(now);
  const prefixes = compactPrefixFingerprints(input);
  for (let index = prefixes.length - 1; index >= 0; index -= 1) {
    const prefix = prefixes[index]!;
    const entry = entries.get(entryKey(scope, prefix.itemCount, prefix.fingerprint));
    if (!entry || entry.expiresAt <= now) continue;
    if (entry.state === undefined) return undefined;
    if (entry.state.replacements.length === 0) continue;
    entries.delete(entry.key);
    entries.set(entry.key, entry);
    return leaseEntry(entry);
  }
  return undefined;
}

export function sweepExpiredGuardrailsCompactContinuations(at = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of entries) {
    if (entry.expiresAt > at || (entry.pins > 0 && entry.state !== undefined)) continue;
    if (remove(key, entry.state === undefined) > 0) removed += 1;
  }
  return removed;
}

export function guardrailsCompactContinuationRetainedStoreSnapshot(): RetainedStoreSnapshot {
  let evictableBytes = 0;
  let pinnedBytes = 0;
  let oldestAt: number | null = null;
  for (const entry of entries.values()) {
    if (entry.pins > 0 || entry.state === undefined) {
      pinnedBytes += entry.sizeBytes;
      continue;
    }
    evictableBytes += entry.sizeBytes;
    if (oldestAt === null || entry.createdAt < oldestAt) oldestAt = entry.createdAt;
  }
  return {
    count: entries.size,
    bytes: retainedBytes,
    evictableBytes,
    pinnedBytes,
    oldestAt,
  };
}

export function evictOldestGuardrailsCompactContinuationForBudget(): number {
  const oldest = [...entries.entries()]
    .filter(([, entry]) => entry.pins === 0 && entry.state !== undefined)
    .sort((left, right) => left[1].createdAt - right[1].createdAt)[0];
  return oldest ? remove(oldest[0]) : 0;
}

export function clearGuardrailsCompactContinuationsForTests(): void {
  entries.clear();
  retainedBytes = 0;
}
