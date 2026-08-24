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

/** Max conversation-id remints after the first surfaced overflow (senpi cap). */
export const CURSOR_OVERFLOW_REMINT_MAX = 3;

type OverflowRemintState = {
  surfaced: boolean;
  remintCount: number;
  skip: boolean;
};

const overflowRemintByScope = new Map<string, OverflowRemintState>();

function overflowRemintEntry(scopeKey: string): OverflowRemintState {
  const existing = overflowRemintByScope.get(scopeKey);
  if (existing) return existing;
  const fresh: OverflowRemintState = { surfaced: false, remintCount: 0, skip: false };
  overflowRemintByScope.set(scopeKey, fresh);
  return fresh;
}

/**
 * Stable scope for overflow remint accounting. Thread-identified clients key by
 * thread + identity; conversation-only clients key by the base conversation id
 * captured before any remint (wire id may rotate).
 */
export function cursorOverflowRemintScopeKey(
  parsed: {
    _clientThreadId?: string;
    _cursorIdentityScope?: string;
  },
  baseConversationId?: string,
): string | null {
  if (parsed._clientThreadId) {
    return `overflow\0${cursorThreadScopeKey(parsed._clientThreadId, parsed._cursorIdentityScope)}`;
  }
  const base = baseConversationId?.trim();
  if (!base) return null;
  const scope = parsed._cursorIdentityScope?.trim() || "local";
  return `overflow\0${scope}\0conv\0${base}`;
}

/** True until the first overflow for this scope has been surfaced for Codex compact. */
export function shouldSurfaceCursorOverflowFirst(scopeKey: string): boolean {
  return overflowRemintEntry(scopeKey).surfaced !== true;
}

export function markCursorOverflowSurfaced(scopeKey: string): void {
  const entry = overflowRemintEntry(scopeKey);
  entry.surfaced = true;
}

export function shouldSkipCursorOverflowRemint(scopeKey: string): boolean {
  const entry = overflowRemintByScope.get(scopeKey);
  if (!entry) return false;
  return entry.skip === true || entry.remintCount >= CURSOR_OVERFLOW_REMINT_MAX;
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
