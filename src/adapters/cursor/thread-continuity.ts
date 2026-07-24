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
