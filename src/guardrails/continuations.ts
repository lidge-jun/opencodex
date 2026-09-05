import { createHash } from "node:crypto";
import type { RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type { GuardrailsPlaceholderState } from "./types";

const MAX_CONTINUATIONS = 1_000;
const MAX_CONTINUATION_BYTES = 8 * 1024 * 1024;
const CONTINUATION_TTL_MS = 60 * 60 * 1_000;
const SCOPE_ID_INPUT_MAX = 4_096;
const SCOPE_ID_DIGEST_LENGTH = 32;

export interface GuardrailsContinuationScope {
  admissionKind: "configured" | "environment" | "loopback";
  apiKeyDigest?: string;
  clientThreadDigest: string;
}

interface ContinuationEntry {
  createdAt: number;
  expiresAt: number;
  key: string;
  lineageId: string;
  pins: number;
  policyRevision: string;
  responseId: string;
  sizeBytes: number;
  state?: GuardrailsPlaceholderState;
}

export interface GuardrailsContinuationLease {
  readonly expiresAt: number;
  readonly lineageId: string;
  readonly policyRevision: string;
  readonly state: GuardrailsPlaceholderState;
  release(): void;
}

export type RememberGuardrailsContinuationResult =
  | { status: "stored"; lease: GuardrailsContinuationLease }
  | { status: "collision" | "expired" | "invalid" | "over_capacity" };

const entries = new Map<string, ContinuationEntry>();
let retainedBytes = 0;

export class GuardrailsContinuationConflictError extends Error {
  constructor() {
    super("Guardrails continuation mappings conflict");
  }
}

function cloneState(state: GuardrailsPlaceholderState): GuardrailsPlaceholderState {
  return structuredClone(state);
}

export function mergeGuardrailsContinuationStates(
  ...states: Array<GuardrailsPlaceholderState | undefined>
): GuardrailsPlaceholderState | undefined {
  const present = states.filter((state): state is GuardrailsPlaceholderState => state !== undefined);
  if (present.length === 0) return undefined;
  const byPlaceholder = new Map<string, GuardrailsPlaceholderState["replacements"][number]>();
  const byOriginal = new Map<string, GuardrailsPlaceholderState["replacements"][number]>();
  for (const state of present) {
    for (const replacement of state.replacements) {
      const existing = byPlaceholder.get(replacement.placeholder);
      if (existing && (existing.original !== replacement.original
        || existing.placeholderType !== replacement.placeholderType
        || existing.dataType !== replacement.dataType)) {
        throw new GuardrailsContinuationConflictError();
      }
      const originalOwner = byOriginal.get(replacement.original);
      if (originalOwner && originalOwner.placeholder !== replacement.placeholder) {
        throw new GuardrailsContinuationConflictError();
      }
      byPlaceholder.set(replacement.placeholder, structuredClone(replacement));
      byOriginal.set(replacement.original, structuredClone(replacement));
    }
  }
  return {
    replacements: [...byPlaceholder.values()],
    reservedPlaceholders: [...new Set(present.flatMap(state => state.reservedPlaceholders))],
  };
}

function normalizedId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function opaqueScopeId(value: unknown): string | undefined {
  const normalized = normalizedId(value);
  if (!normalized || normalized.length > SCOPE_ID_INPUT_MAX) return undefined;
  return createHash("sha256").update(normalized).digest("hex").slice(0, SCOPE_ID_DIGEST_LENGTH);
}

export function createGuardrailsContinuationScope(
  admissionKind: unknown,
  apiKeyId: unknown,
  clientThreadId: unknown,
): GuardrailsContinuationScope | undefined {
  const thread = opaqueScopeId(clientThreadId);
  if (!thread || (admissionKind !== "configured" && admissionKind !== "environment" && admissionKind !== "loopback")) {
    return undefined;
  }
  if (admissionKind === "configured") {
    const keyId = opaqueScopeId(apiKeyId);
    return keyId ? {
      admissionKind,
      apiKeyDigest: keyId,
      clientThreadDigest: thread,
    } : undefined;
  }
  return { admissionKind, clientThreadDigest: thread };
}

function scopeKey(scope: GuardrailsContinuationScope): string {
  return JSON.stringify([
    scope.admissionKind,
    scope.admissionKind === "configured" ? scope.apiKeyDigest : null,
    scope.clientThreadDigest,
  ]);
}

function entryKey(responseId: string, scope: GuardrailsContinuationScope): string {
  return `${scopeKey(scope)}\n${responseId}`;
}

function sizeOf(value: unknown): number | null {
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
  retainedBytes -= entry.sizeBytes;
  entries.delete(key);
  if (retainedBytes < 0) retainedBytes = 0;
  return entry.sizeBytes;
}

function prune(now = Date.now()): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now && (entry.pins === 0 || entry.state === undefined)) {
      remove(key, entry.state === undefined);
    }
  }
  while (entries.size > MAX_CONTINUATIONS || retainedBytes > MAX_CONTINUATION_BYTES) {
    const oldest = [...entries.entries()]
      .filter(([, entry]) => entry.pins === 0)
      .sort((left, right) => {
        const stateOrder = Number(right[1].state !== undefined) - Number(left[1].state !== undefined);
        return stateOrder || left[1].createdAt - right[1].createdAt;
      })[0];
    if (!oldest) break;
    remove(oldest[0]);
  }
}

function planAdmission(
  sizeBytes: number,
  replacing: ContinuationEntry | undefined,
): string[] | null {
  let projectedBytes = retainedBytes - (replacing?.sizeBytes ?? 0) + sizeBytes;
  let projectedCount = entries.size - (replacing ? 1 : 0) + 1;
  const evictions: string[] = [];
  const candidates = [...entries.entries()]
    .filter(([key, entry]) => key !== replacing?.key && entry.pins === 0)
    .sort((left, right) => {
      const stateOrder = Number(right[1].state !== undefined) - Number(left[1].state !== undefined);
      return stateOrder || left[1].createdAt - right[1].createdAt;
    });
  for (const [key, entry] of candidates) {
    if (projectedBytes <= MAX_CONTINUATION_BYTES && projectedCount <= MAX_CONTINUATIONS) break;
    evictions.push(key);
    projectedBytes -= entry.sizeBytes;
    projectedCount -= 1;
  }
  return projectedBytes <= MAX_CONTINUATION_BYTES && projectedCount <= MAX_CONTINUATIONS
    ? evictions
    : null;
}

function leaseEntry(entry: ContinuationEntry): GuardrailsContinuationLease {
  const state = entry.state;
  if (!state) throw new GuardrailsContinuationConflictError();
  entry.pins += 1;
  let released = false;
  return {
    expiresAt: entry.expiresAt,
    lineageId: entry.lineageId,
    policyRevision: entry.policyRevision,
    state: cloneState(state),
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

function poisonEntry(entry: ContinuationEntry): void {
  if (entry.state === undefined) return;
  const sizeBytes = sizeOf({
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
    key: entry.key,
    lineageId: entry.lineageId,
    policyRevision: entry.policyRevision,
    responseId: entry.responseId,
    state: undefined,
  });
  if (sizeBytes === null) throw new GuardrailsContinuationConflictError();
  delete entry.state;
  retainedBytes = Math.max(0, retainedBytes - entry.sizeBytes + sizeBytes);
  entry.sizeBytes = sizeBytes;
}

/**
 * Store mappings only in process memory. Unlike the ordinary Responses replay cache,
 * these mappings include original values and must never enter spill/snapshot files.
 */
export function rememberGuardrailsContinuation(options: {
  expiresAt?: number;
  lineageId: string;
  policyRevision: string;
  responseId: unknown;
  scope: GuardrailsContinuationScope | undefined;
  state: GuardrailsPlaceholderState;
}): RememberGuardrailsContinuationResult {
  const responseId = normalizedId(options.responseId);
  const lineageId = normalizedId(options.lineageId);
  const policyRevision = normalizedId(options.policyRevision);
  if (!responseId || !lineageId || !policyRevision || !options.scope || options.state.replacements.length === 0) {
    return { status: "invalid" };
  }
  const now = Date.now();
  const expiresAt = Math.min(options.expiresAt ?? now + CONTINUATION_TTL_MS, now + CONTINUATION_TTL_MS);
  if (expiresAt <= now) return { status: "expired" };
  prune(now);
  const key = entryKey(responseId, options.scope);
  const existing = entries.get(key);
  if (existing && existing.state === undefined) return { status: "collision" };
  if (existing && (existing.lineageId !== lineageId || existing.pins > 0)) {
    poisonEntry(existing);
    return { status: "collision" };
  }

  const state = cloneState(options.state);
  const sizeBytes = sizeOf({
    createdAt: now,
    expiresAt,
    key,
    lineageId,
    policyRevision,
    responseId,
    state,
  });
  if (sizeBytes === null || sizeBytes > MAX_CONTINUATION_BYTES) return { status: "over_capacity" };
  const evictions = planAdmission(sizeBytes, existing);
  if (!evictions) return { status: "over_capacity" };
  if (existing) remove(key);
  for (const eviction of evictions) remove(eviction);
  const entry: ContinuationEntry = {
    createdAt: now,
    expiresAt,
    key,
    lineageId,
    pins: 0,
    policyRevision,
    responseId,
    sizeBytes,
    state,
  };
  entries.set(key, entry);
  retainedBytes += sizeBytes;
  const lease = leaseEntry(entry);
  return { status: "stored", lease };
}

export function retainGuardrailsContinuation(
  responseId: unknown,
  scope: GuardrailsContinuationScope | undefined,
): GuardrailsContinuationLease | undefined {
  const normalizedResponseId = normalizedId(responseId);
  if (!normalizedResponseId || !scope) return undefined;
  const now = Date.now();
  prune(now);
  const entry = entries.get(entryKey(normalizedResponseId, scope));
  if (!entry || entry.expiresAt <= now || entry.state === undefined) return undefined;
  entries.delete(entry.key);
  entries.set(entry.key, entry);
  return leaseEntry(entry);
}

export function sweepExpiredGuardrailsContinuations(at = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of entries) {
    if (entry.expiresAt > at || (entry.pins > 0 && entry.state !== undefined)) continue;
    if (remove(key, entry.state === undefined) > 0) removed += 1;
  }
  return removed;
}

export function guardrailsContinuationRetainedStoreSnapshot(): RetainedStoreSnapshot {
  let evictableBytes = 0;
  let pinnedBytes = 0;
  let oldestAt: number | null = null;
  for (const entry of entries.values()) {
    if (entry.pins > 0) {
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

export function evictOldestGuardrailsContinuationForBudget(): number {
  const oldest = [...entries.entries()]
    .filter(([, entry]) => entry.pins === 0)
    .sort((left, right) => {
      const stateOrder = Number(right[1].state !== undefined) - Number(left[1].state !== undefined);
      return stateOrder || left[1].createdAt - right[1].createdAt;
    })[0];
  return oldest ? remove(oldest[0]) : 0;
}

/** Test-only bounded-memory observability; intentionally excludes mapping contents. */
export function guardrailsContinuationStatsForTests(): {
  entries: number;
  retainedBytes: number;
  pinnedBytes: number;
} {
  prune();
  const snapshot = guardrailsContinuationRetainedStoreSnapshot();
  return {
    entries: snapshot.count,
    retainedBytes: snapshot.bytes,
    pinnedBytes: snapshot.pinnedBytes,
  };
}

export function clearGuardrailsContinuationsForTests(): void {
  entries.clear();
  retainedBytes = 0;
}
