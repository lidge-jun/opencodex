/**
 * Bounded in-memory overrides for Cursor conversation continuity.
 *
 * When an invalid_argument recovery mints a fresh conversation id for a store:false
 * thread-identified client, later turns without previous_response_id must reuse that
 * recovered id instead of recomputing the stale deterministic thread hash.
 */

const OVERRIDE_TTL_MS = 60 * 60 * 1000;
const OVERRIDE_MAX_ENTRIES = 2048;

const overrides = new Map<string, { conversationId: string; updatedAt: number }>();

function now(): number {
  return Date.now();
}

function prune(at: number): void {
  for (const [key, entry] of overrides) {
    if (at - entry.updatedAt > OVERRIDE_TTL_MS) overrides.delete(key);
    else break; // Map iterates insertion order; refreshed entries are moved to the end
  }
  while (overrides.size > OVERRIDE_MAX_ENTRIES) {
    const oldest = overrides.keys().next().value;
    if (oldest === undefined) break;
    overrides.delete(oldest);
  }
}

/** Scope key for a client thread, optionally namespaced by authenticated tenant/operator identity. */
export function cursorThreadScopeKey(threadId: string, identityScope?: string): string {
  const scope = identityScope?.trim() || "local";
  return `${scope}\0${threadId}`;
}

export function rememberCursorThreadConversation(
  threadId: string,
  conversationId: string,
  identityScope?: string,
): void {
  const key = cursorThreadScopeKey(threadId, identityScope);
  const at = now();
  overrides.delete(key);
  overrides.set(key, { conversationId, updatedAt: at });
  prune(at);
}

export function lookupCursorThreadConversation(
  threadId: string,
  identityScope?: string,
): string | undefined {
  const key = cursorThreadScopeKey(threadId, identityScope);
  const entry = overrides.get(key);
  if (!entry) return undefined;
  const at = now();
  if (at - entry.updatedAt > OVERRIDE_TTL_MS) {
    overrides.delete(key);
    return undefined;
  }
  overrides.delete(key);
  overrides.set(key, { conversationId: entry.conversationId, updatedAt: at });
  return entry.conversationId;
}

export function clearCursorThreadContinuityForTests(): void {
  overrides.clear();
}

/** Max conversation-id remints after the first surfaced overflow per retained scope. */
export const CURSOR_OVERFLOW_REMINT_MAX = 3;
export const CURSOR_OVERFLOW_REMINT_TTL_MS = 60 * 60 * 1000;
export const CURSOR_OVERFLOW_REMINT_MAX_ENTRIES = 2_048;

type OverflowRemintState = {
  surfaced: boolean;
  remintCount: number;
  skip: boolean;
  updatedAt: number;
};

const overflowRemintByScope = new Map<string, OverflowRemintState>();

function pruneOverflowRemints(at: number): void {
  for (const [scopeKey, entry] of overflowRemintByScope) {
    if (at - entry.updatedAt > CURSOR_OVERFLOW_REMINT_TTL_MS) overflowRemintByScope.delete(scopeKey);
  }
  while (overflowRemintByScope.size > CURSOR_OVERFLOW_REMINT_MAX_ENTRIES) {
    const oldest = overflowRemintByScope.keys().next().value;
    if (oldest === undefined) break;
    overflowRemintByScope.delete(oldest);
  }
}

function overflowRemintEntry(scopeKey: string): OverflowRemintState {
  const at = now();
  pruneOverflowRemints(at);
  const existing = overflowRemintByScope.get(scopeKey);
  if (existing) {
    existing.updatedAt = at;
    overflowRemintByScope.delete(scopeKey);
    overflowRemintByScope.set(scopeKey, existing);
    return existing;
  }
  const fresh: OverflowRemintState = { surfaced: false, remintCount: 0, skip: false, updatedAt: at };
  overflowRemintByScope.set(scopeKey, fresh);
  pruneOverflowRemints(at);
  return fresh;
}

/** Stable client-thread ownership survives conversation remints; wire ids alone do not. */
export function cursorOverflowRemintScopeKey(
  threadOwner: string | undefined,
  identityScope?: string,
): string | null {
  if (!threadOwner) return null;
  return `overflow\0${cursorThreadScopeKey(threadOwner, identityScope)}`;
}

/** True until the first overflow for this scope has been surfaced for Codex compact. */
export function shouldSurfaceCursorOverflowFirst(scopeKey: string): boolean {
  pruneOverflowRemints(now());
  return overflowRemintByScope.get(scopeKey)?.surfaced !== true;
}

export function markCursorOverflowSurfaced(scopeKey: string): void {
  const entry = overflowRemintEntry(scopeKey);
  entry.surfaced = true;
}

export function shouldSkipCursorOverflowRemint(scopeKey: string): boolean {
  const at = now();
  pruneOverflowRemints(at);
  const entry = overflowRemintByScope.get(scopeKey);
  if (entry) {
    entry.updatedAt = at;
    overflowRemintByScope.delete(scopeKey);
    overflowRemintByScope.set(scopeKey, entry);
  }
  return entry?.skip === true || (entry?.remintCount ?? 0) >= CURSOR_OVERFLOW_REMINT_MAX;
}

/** Record one overflow remint; returns false when the cap is exhausted. */
export function recordCursorOverflowRemint(scopeKey: string): boolean {
  const entry = overflowRemintEntry(scopeKey);
  if (entry.skip || entry.remintCount >= CURSOR_OVERFLOW_REMINT_MAX) {
    entry.skip = true;
    return false;
  }
  entry.remintCount += 1;
  return true;
}

export function clearCursorOverflowRemintForTests(): void {
  overflowRemintByScope.clear();
}

export function cursorOverflowRemintCountForTests(): number {
  pruneOverflowRemints(now());
  return overflowRemintByScope.size;
}
