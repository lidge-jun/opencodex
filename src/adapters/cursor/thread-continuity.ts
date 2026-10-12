/**
 * Bounded in-memory overrides for Cursor conversation continuity.
 *
 * When an invalid_argument recovery mints a fresh conversation id for a store:false
 * thread-identified client, later turns without previous_response_id must reuse that
 * recovered id instead of recomputing the stale deterministic thread hash.
 */

import { createHash } from "node:crypto";

const OVERRIDE_TTL_MS = 60 * 60 * 1000;
const OVERRIDE_MAX_ENTRIES = 2048;

const overrides = new Map<string, { conversationId: string; updatedAt: number }>();
const conversationRewrites = new Map<string, { to: string; root: string; updatedAt: number }>();

function rewriteKey(conversationId: string, identityScope?: string): string {
  const identity = createHash("sha256").update(identityScope?.trim() || "local").digest("hex");
  return `${identity}\0${conversationId}`;
}

function pruneRewrites(at: number): void {
  for (const [key, entry] of conversationRewrites) {
    if (at - entry.updatedAt > OVERRIDE_TTL_MS) conversationRewrites.delete(key);
  }
  while (conversationRewrites.size > OVERRIDE_MAX_ENTRIES) {
    const oldest = conversationRewrites.keys().next().value;
    if (oldest === undefined) break;
    conversationRewrites.delete(oldest);
  }
}

export function rememberCursorConversationRewrite(from: string, to: string, identityScope?: string): void {
  if (!from || !to || from === to) return;
  const at = now();
  pruneRewrites(at);
  const scope = rewriteKey("", identityScope);
  const root = conversationRewrites.get(rewriteKey(from, identityScope))?.root ?? from;
  const redirects = [...conversationRewrites].filter(([key, entry]) => key.startsWith(scope) && entry.root === root);
  for (const [key] of redirects) {
    conversationRewrites.delete(key);
    conversationRewrites.set(key, { to, root, updatedAt: at });
  }
  conversationRewrites.set(rewriteKey(from, identityScope), { to, root, updatedAt: at });
  conversationRewrites.set(rewriteKey(to, identityScope), { to, root, updatedAt: at });
  pruneRewrites(at);
}

export function resolveCursorConversationRewrite(conversationId: string, identityScope?: string): string {
  const at = now();
  pruneRewrites(at);
  const key = rewriteKey(conversationId, identityScope);
  const entry = conversationRewrites.get(key);
  if (!entry) return conversationId;
  conversationRewrites.delete(key);
  conversationRewrites.set(key, { ...entry, updatedAt: at });
  return entry.to;
}

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
  conversationRewrites.clear();
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

/** Max next-turn conversation-id rotations after incomplete client-tool streams per retained scope. */
export const CURSOR_INCOMPLETE_TOOL_REMINT_MAX = 3;
export const CURSOR_INCOMPLETE_TOOL_REMINT_TTL_MS = CURSOR_OVERFLOW_REMINT_TTL_MS;
export const CURSOR_INCOMPLETE_TOOL_REMINT_MAX_ENTRIES = CURSOR_OVERFLOW_REMINT_MAX_ENTRIES;

type IncompleteToolRemintState = {
  remintCount: number;
  updatedAt: number;
};

/**
 * One bounded next-turn remint allowance, keyed by retained thread scope.
 *
 * Each recovery reason owns its own instance. Sharing one budget would let a cheap, frequent
 * failure spend the allowance that a rarer, more expensive recovery depends on.
 */
function createCursorRemintBudget(max: number, ttlMs: number, maxEntries: number) {
  const byScope = new Map<string, IncompleteToolRemintState>();

  const prune = (at: number): void => {
    for (const [scopeKey, entry] of byScope) {
      if (at - entry.updatedAt > ttlMs) byScope.delete(scopeKey);
    }
    while (byScope.size > maxEntries) {
      const oldest = byScope.keys().next().value;
      if (oldest === undefined) break;
      byScope.delete(oldest);
    }
  };

  return {
    /** Record one remint; returns false when this budget is exhausted. */
    record(scopeKey: string): boolean {
      const at = now();
      prune(at);
      const existing = byScope.get(scopeKey);
      if (existing && existing.remintCount >= max) {
        existing.updatedAt = at;
        byScope.delete(scopeKey);
        byScope.set(scopeKey, existing);
        return false;
      }
      const entry = existing ?? { remintCount: 0, updatedAt: at };
      entry.remintCount += 1;
      entry.updatedAt = at;
      byScope.delete(scopeKey);
      byScope.set(scopeKey, entry);
      prune(at);
      return true;
    },
    clear(scopeKey: string): void {
      byScope.delete(scopeKey);
    },
    clearForTests(): void {
      byScope.clear();
    },
    countForTests(): number {
      prune(now());
      return byScope.size;
    },
  };
}

const incompleteToolRemintBudget = createCursorRemintBudget(
  CURSOR_INCOMPLETE_TOOL_REMINT_MAX,
  CURSOR_INCOMPLETE_TOOL_REMINT_TTL_MS,
  CURSOR_INCOMPLETE_TOOL_REMINT_MAX_ENTRIES,
);

/** Incomplete-tool and overflow recovery share ownership scope, but keep independent budgets. */
export function cursorIncompleteToolRemintScopeKey(
  threadOwner: string | undefined,
  identityScope?: string,
): string | null {
  return cursorOverflowRemintScopeKey(threadOwner, identityScope);
}

/** Record one incomplete-tool remint; returns false when the independent cap is exhausted. */
export function recordCursorIncompleteToolRemint(scopeKey: string): boolean {
  return incompleteToolRemintBudget.record(scopeKey);
}

/** A clean turn replenishes this recovery without changing the overflow retry budget. */
export function clearCursorIncompleteToolRemint(scopeKey: string): void {
  incompleteToolRemintBudget.clear(scopeKey);
}

export function clearCursorIncompleteToolRemintForTests(): void {
  incompleteToolRemintBudget.clearForTests();
}

export function cursorIncompleteToolRemintCountForTests(): number {
  return incompleteToolRemintBudget.countForTests();
}

/**
 * Max next-turn rotations after a MID-STREAM envelope echo, per retained scope.
 *
 * Deliberately a separate budget from the incomplete-tool allowance. A mid-stream echo is a
 * cheap, repeatable formatting failure, while an incomplete client-tool stream is a rarer
 * structural one; on a shared counter a model that echoes every turn would spend the budget
 * that incomplete-tool recovery depends on. Bounding it at all is the point: the echo has
 * already reached the client and cannot be quarantined, so without a cap a persistently
 * echoing model would remint the conversation on every single turn, forever.
 */
export const CURSOR_ENVELOPE_ECHO_REMINT_MAX = 3;
export const CURSOR_ENVELOPE_ECHO_REMINT_TTL_MS = CURSOR_OVERFLOW_REMINT_TTL_MS;
export const CURSOR_ENVELOPE_ECHO_REMINT_MAX_ENTRIES = CURSOR_OVERFLOW_REMINT_MAX_ENTRIES;

const envelopeEchoRemintBudget = createCursorRemintBudget(
  CURSOR_ENVELOPE_ECHO_REMINT_MAX,
  CURSOR_ENVELOPE_ECHO_REMINT_TTL_MS,
  CURSOR_ENVELOPE_ECHO_REMINT_MAX_ENTRIES,
);

/** Echo recovery shares ownership scope with overflow and incomplete-tool, budget apart. */
export function cursorEnvelopeEchoRemintScopeKey(
  threadOwner: string | undefined,
  identityScope?: string,
  conversationId?: string,
): string | null {
  if (conversationId) {
    pruneRewrites(now());
    const root = conversationRewrites.get(rewriteKey(conversationId, identityScope))?.root ?? conversationId;
    return `echo\0${rewriteKey(root, identityScope)}`;
  }
  return cursorOverflowRemintScopeKey(threadOwner, identityScope);
}

/** Record one envelope-echo remint; returns false when the independent cap is exhausted. */
export function recordCursorEnvelopeEchoRemint(scopeKey: string): boolean {
  return envelopeEchoRemintBudget.record(scopeKey);
}

/** A turn that completed without an echo replenishes only this budget. */
export function clearCursorEnvelopeEchoRemint(scopeKey: string): void {
  envelopeEchoRemintBudget.clear(scopeKey);
}

export function clearCursorEnvelopeEchoRemintForTests(): void {
  envelopeEchoRemintBudget.clearForTests();
}

export function cursorEnvelopeEchoRemintCountForTests(): number {
  return envelopeEchoRemintBudget.countForTests();
}
