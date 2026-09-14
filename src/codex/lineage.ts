/**
 * Codex V2 conversation lineage: root, parent, child, grandchild (#4546, wp8).
 *
 * The pool affinity key used to prefer `x-codex-parent-thread-id`, which collapsed two different
 * identities into one map. A root bound under `app:HMAC(session, thread)` while every child bound
 * under the RAW parent id, so siblings shared one binding entry unrelated to the root's, and a
 * grandchild keyed on its own parent landed on a key nobody had ever bound. The proxy therefore
 * treated one workflow as unrelated strangers even while the provider saw a single prompt-cache
 * family.
 *
 * This module records the real relation -- each thread's own conversation key, its immediate
 * parent's thread id, and the transitive root -- scoped per authenticated caller, bounded, and
 * process-local like the binding map it feeds.
 *
 * What it is for, and what it is not for:
 *
 * - FIRST PLACEMENT. A child with no binding of its own may start where its family is already
 *   warm; see `pickLineageServingAccount` in ./routing. Once bound, the child is an ordinary
 *   binding, so a later move of the parent does not drag it.
 * - COST ATTRIBUTION. {@link codexThreadLineageLookup} and {@link codexLineageRootForRequest}
 *   answer which root workflow a conversation belongs to, so a grandchild's spend aggregates
 *   onto the root. No budget is implemented here.
 * - WORKER CLASSIFICATION, exposed but not rewired. Admission classifies header-only today: a
 *   request naming a parent plus a distinct `thread-id` is worker traffic, and a request without
 *   `thread-id` is interactive even when it belongs to a recorded fan-out.
 *   {@link codexLineageWorkflowLane} is the lineage-backed answer a later lane consumes.
 *
 * Scope is an HMAC of the caller's Authorization header under a process-local key, the same
 * posture as the affinity key itself. Two callers presenting identical thread ids can never read
 * each other's lineage, and no raw identifier or durable hash is stored.
 *
 * LIFETIME, stated plainly because the word "affinity" invites the opposite assumption: none of
 * this survives the process. The binding map is in memory, and the HMAC key above is fresh random
 * bytes taken at module load, so a restart does not merely forget the table -- it makes yesterday's
 * keys unreproducible. This is a warm-start hint for the life of one proxy process, never durable
 * account ownership, and nothing here should be read as a promise to a conversation that outlives
 * a restart.
 *
 * The one upgrade that is neither a fresh start nor an untouched process is a code swap under a
 * live conversation, where the binding map is still populated with entries made under the
 * pre-#4546 RAW parent key. Silently rebinding those cold is the exact defect this module exists
 * to prevent, so a request that names a parent carries {@link CodexThreadLineage.legacyConversationKey}
 * -- the key the old rule would have returned -- and routing adopts that binding once under the new
 * key and retires the legacy entry. It is a one-way migration, not a second lookup path.
 */
import { createHmac, randomBytes } from "node:crypto";
import { retainedUtf8Bytes } from "../lib/admission";

const CODEX_LINEAGE_COMPONENT_MAX_BYTES = 512;
const CODEX_LINEAGE_KEY = randomBytes(32);

/**
 * Mirrors `CODEX_THREAD_AFFINITY_IDLE_TTL_MS` in ./routing. Deliberately duplicated rather than
 * imported: lineage is a leaf module, and a value import from the routing module that consumes it
 * would turn an erased type-only edge into a real cycle.
 */
export const CODEX_LINEAGE_IDLE_TTL_MS = 24 * 60 * 60_000;
/** Records per authenticated scope, on the order of the binding map's own 2048-entry cap. */
export const CODEX_LINEAGE_MAX_ENTRIES = 2048;
/** Distinct authenticated callers retained. Without this the scope map is the unbounded one. */
export const CODEX_LINEAGE_MAX_SCOPES = 64;
/** Sibling hints kept per parent, most recently used first. */
export const CODEX_LINEAGE_MAX_SIBLINGS = 8;

const LOCAL_LINEAGE_SCOPE = "local";

export type CodexWorkflowLane = "worker" | "interactive";

interface CodexLineageRecord {
  threadId: string;
  /** This thread's own pool binding key, byte-identical to what `codexPoolAffinityKey` returns. */
  conversationKey: string;
  /** Immediate parent's raw thread id, retained once seen even if a later turn omits the header. */
  parentThreadId?: string;
  /** Topmost ancestor's conversation key: a grandchild resolves to the root's, not its parent's. */
  rootSessionKey: string;
  lastUsedAt: number;
}

interface CodexLineageScope {
  /** threadId -> record, iterated oldest-first so TTL pruning and eviction stay amortised O(1). */
  records: Map<string, CodexLineageRecord>;
  /** conversationKey -> threadId, so cost attribution is a lookup instead of a scan. */
  threadIdByConversationKey: Map<string, string>;
  /** parentThreadId -> child thread ids, most recent first, capped. */
  childThreadIdsByParent: Map<string, string[]>;
  lastUsedAt: number;
}

/**
 * What placement and cost attribution are allowed to see. `parentConversationKey` is the parent's
 * OWN binding key -- either recorded, or derived from the shared session when the parent has not
 * been seen yet -- never the raw header value the old affinity key returned.
 */
export interface CodexThreadLineage {
  readonly conversationKey: string;
  readonly rootSessionKey: string;
  readonly parentThreadId?: string;
  readonly parentConversationKey?: string;
  /**
   * The key the pre-#4546 rule would have returned for this request -- the RAW parent id -- when
   * that differs from the key it binds under now. Present so routing can adopt a binding left by
   * the old rule exactly once; see the lifetime note at the top of this file.
   */
  readonly legacyConversationKey?: string;
  /** Siblings under the same declared parent, most recently used first. */
  readonly siblingConversationKeys: readonly string[];
}

/** The identity the pool affinity key and the lineage record are both derived from. */
export interface CodexConversationIdentity {
  readonly conversationKey: string;
  /** Thread id this request records under: its own, or the parent's on a parent-only request. */
  readonly recordThreadId: string;
  readonly sessionId?: string;
  readonly parentThreadId?: string;
  /** Raw parent id, i.e. the key the pre-#4546 rule returned for this request. */
  readonly legacyConversationKey?: string;
  /** True only when the request names a parent distinct from its own thread. */
  readonly declaresParent: boolean;
}

const lineageByScope = new Map<string, CodexLineageScope>();

/** A record is only evidence while it is live; an idle-expired one answers like no record. */
function liveLineageRecord(
  scope: CodexLineageScope | undefined,
  threadId: string,
  now: number,
): CodexLineageRecord | undefined {
  const record = scope?.records.get(threadId);
  return record !== undefined && now - record.lastUsedAt <= CODEX_LINEAGE_IDLE_TTL_MS
    ? record
    : undefined;
}

function boundedLineageComponent(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (retainedUtf8Bytes(normalized) > CODEX_LINEAGE_COMPONENT_MAX_BYTES) return undefined;
  return normalized;
}

/**
 * The single derivation behind both the pool affinity key and lineage records. Keeping it here,
 * rather than duplicated at the call site, is what guarantees a record's `conversationKey` is
 * byte-identical to the key the thread actually binds under.
 */
export function codexConversationKeyFor(familyId: string, threadId: string): string {
  return `app:${createHmac("sha256", CODEX_LINEAGE_KEY)
    .update("opencodex-app-pool-affinity-v1\0")
    .update(familyId)
    .update("\0")
    .update(threadId)
    .digest("base64url")}`;
}

/**
 * Resolve a request's conversation identity, or undefined when it carries no bindable thread
 * identity at all.
 *
 * The set of requests that produce NO key is deliberately unchanged from the pre-#4546 rule: a
 * bare `thread-id` with neither a session nor a parent stays unbound, exactly as the Desktop
 * fallback required both halves of its pair. Only the VALUE moves, and only for requests that
 * name a parent:
 *
 * - root (`session-id` + `thread-id`) -> HMAC(session, thread), unchanged;
 * - child (parent + own `thread-id`) -> HMAC(session ?? parent, thread), previously the raw parent
 *   id, which is what made siblings share one entry and made a child's first turn land on a key
 *   the root had never bound;
 * - parent-only (no `thread-id`) -> the parent's OWN recorded key when this scope has one, and
 *   otherwise HMAC(session ?? parent, parent).
 *
 * That last case is the one with a trap in it. A parent-only turn belongs to the parent's
 * conversation, so it has to land on the binding the parent is already using -- but the parent's
 * key is HMAC(session, thread), and HMAC(parent, parent) reproduces it only when the session id
 * and the thread id are the same string. Codex's own root happens to satisfy that, which is
 * exactly why deriving the key looks correct until a caller whose session differs from its thread
 * starts a COLD conversation on every parent-only turn and overwrites the parent's record on the
 * way through. So the recorded key wins, the session-derived key is the fallback that reproduces
 * it when the parent has not been seen in this scope, and the raw parent id is never the answer.
 */
export function codexConversationIdentity(
  headers: Headers,
  now = Date.now(),
): CodexConversationIdentity | undefined {
  const threadId = boundedLineageComponent(headers.get("thread-id"));
  const sessionId = boundedLineageComponent(headers.get("session-id"));
  const parentThreadId = boundedLineageComponent(headers.get("x-codex-parent-thread-id"));

  if (threadId === undefined) {
    if (parentThreadId === undefined) return undefined;
    const recorded = liveLineageRecord(
      lineageByScope.get(codexLineageScopeKey(headers)),
      parentThreadId,
      now,
    );
    return {
      conversationKey: recorded?.conversationKey
        ?? codexConversationKeyFor(sessionId ?? parentThreadId, parentThreadId),
      recordThreadId: parentThreadId,
      ...(sessionId !== undefined ? { sessionId } : {}),
      legacyConversationKey: parentThreadId,
      declaresParent: false,
    };
  }
  const familyId = sessionId ?? parentThreadId;
  if (familyId === undefined) return undefined;
  return {
    conversationKey: codexConversationKeyFor(familyId, threadId),
    recordThreadId: threadId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
    ...(parentThreadId !== undefined ? { legacyConversationKey: parentThreadId } : {}),
    declaresParent: parentThreadId !== undefined && parentThreadId !== threadId,
  };
}

/**
 * Which authenticated caller this request's lineage belongs to. The bearer is never stored; an
 * unauthenticated (loopback-trusted) request lands in the single local scope.
 */
export function codexLineageScopeKey(headers: Headers): string {
  const authorization = headers.get("authorization")?.trim();
  if (!authorization) return LOCAL_LINEAGE_SCOPE;
  return `auth:${createHmac("sha256", CODEX_LINEAGE_KEY)
    .update("opencodex-lineage-scope-v1\0")
    .update(authorization)
    .digest("base64url")}`;
}

function dropLineageRecord(scope: CodexLineageScope, threadId: string): void {
  const record = scope.records.get(threadId);
  if (record === undefined) return;
  scope.records.delete(threadId);
  if (scope.threadIdByConversationKey.get(record.conversationKey) === threadId) {
    scope.threadIdByConversationKey.delete(record.conversationKey);
  }
  if (record.parentThreadId === undefined) return;
  const siblings = scope.childThreadIdsByParent.get(record.parentThreadId);
  if (siblings === undefined) return;
  const remaining = siblings.filter(id => id !== threadId);
  if (remaining.length === 0) scope.childThreadIdsByParent.delete(record.parentThreadId);
  else scope.childThreadIdsByParent.set(record.parentThreadId, remaining);
}

/** Records are held in least-recently-used order, so the expired ones are a prefix. */
function pruneLineageScope(scope: CodexLineageScope, now: number): void {
  for (const [threadId, record] of scope.records) {
    if (now - record.lastUsedAt <= CODEX_LINEAGE_IDLE_TTL_MS) break;
    dropLineageRecord(scope, threadId);
  }
  while (scope.records.size > CODEX_LINEAGE_MAX_ENTRIES) {
    const oldest = scope.records.keys().next();
    if (oldest.done === true) break;
    dropLineageRecord(scope, oldest.value);
  }
}

function pruneLineageScopes(now: number): void {
  for (const [scopeKey, scope] of lineageByScope) {
    if (now - scope.lastUsedAt <= CODEX_LINEAGE_IDLE_TTL_MS) break;
    lineageByScope.delete(scopeKey);
  }
  while (lineageByScope.size > CODEX_LINEAGE_MAX_SCOPES) {
    const oldest = lineageByScope.keys().next();
    if (oldest.done === true) break;
    lineageByScope.delete(oldest.value);
  }
}

function touchLineageScope(scopeKey: string, now: number): CodexLineageScope {
  const existing = lineageByScope.get(scopeKey);
  const scope: CodexLineageScope = existing ?? {
    records: new Map<string, CodexLineageRecord>(),
    threadIdByConversationKey: new Map<string, string>(),
    childThreadIdsByParent: new Map<string, string[]>(),
    lastUsedAt: now,
  };
  if (existing !== undefined) lineageByScope.delete(scopeKey);
  scope.lastUsedAt = now;
  lineageByScope.set(scopeKey, scope);
  pruneLineageScopes(now);
  pruneLineageScope(scope, now);
  return scope;
}

/**
 * The lineage view for one identity inside one scope, computed without writing anything.
 *
 * A parent seen for the first time through one of its children is derived rather than invented:
 * the child knows the shared session, so HMAC(session, parent) reproduces the key the parent
 * binds under. Once the parent has actually been recorded, its own key wins.
 *
 * Depth is transitive by construction -- a grandchild inherits its parent's resolved root instead
 * of re-deriving one hop -- so a workflow never scatters across several roots.
 */
function lineageFor(
  scope: CodexLineageScope | undefined,
  identity: CodexConversationIdentity,
  now: number,
): CodexThreadLineage {
  const previous = liveLineageRecord(scope, identity.recordThreadId, now);
  // A turn that omits the parent header does not orphan a thread whose parent is already known.
  // That retention is the whole of the lineage-backed worker answer below.
  const parentThreadId = identity.declaresParent
    ? identity.parentThreadId
    : previous?.parentThreadId;

  const parentRecord = parentThreadId !== undefined
    ? liveLineageRecord(scope, parentThreadId, now)
    : undefined;
  const parentConversationKey = parentThreadId === undefined
    ? undefined
    : parentRecord?.conversationKey
      ?? codexConversationKeyFor(identity.sessionId ?? parentThreadId, parentThreadId);
  const rootSessionKey = parentConversationKey === undefined
    ? identity.conversationKey
    : parentRecord?.rootSessionKey ?? parentConversationKey;

  const siblingConversationKeys: string[] = [];
  if (parentThreadId !== undefined && scope !== undefined) {
    for (const siblingThreadId of scope.childThreadIdsByParent.get(parentThreadId) ?? []) {
      if (siblingThreadId === identity.recordThreadId) continue;
      const sibling = liveLineageRecord(scope, siblingThreadId, now);
      if (sibling !== undefined) siblingConversationKeys.push(sibling.conversationKey);
    }
  }

  // Only a key the old rule would have produced AND that this request no longer uses is a
  // migration candidate. A root's key is unchanged, so it never carries one.
  const legacyConversationKey = identity.legacyConversationKey !== undefined
    && identity.legacyConversationKey !== identity.conversationKey
    ? identity.legacyConversationKey
    : undefined;

  return {
    conversationKey: identity.conversationKey,
    rootSessionKey,
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
    ...(parentConversationKey !== undefined ? { parentConversationKey } : {}),
    ...(legacyConversationKey !== undefined ? { legacyConversationKey } : {}),
    siblingConversationKeys,
  };
}

/**
 * Read this request's lineage without recording it.
 *
 * A preview must see what the final resolution will see, but it must not be the thing that
 * creates the record: preview runs before auth has decided whether this request may hold Pool
 * state at all, and a record written there would outlive a decision to hold none.
 */
export function resolveCodexThreadLineage(
  headers: Headers,
  now = Date.now(),
): CodexThreadLineage | undefined {
  const identity = codexConversationIdentity(headers, now);
  if (identity === undefined) return undefined;
  return lineageFor(lineageByScope.get(codexLineageScopeKey(headers)), identity, now);
}

/** Record this request's thread relation and return the resolved lineage. */
export function recordCodexThreadLineage(
  headers: Headers,
  now = Date.now(),
): CodexThreadLineage | undefined {
  const identity = codexConversationIdentity(headers, now);
  if (identity === undefined) return undefined;
  const scope = touchLineageScope(codexLineageScopeKey(headers), now);
  const lineage = lineageFor(scope, identity, now);
  const parentThreadId = lineage.parentThreadId;

  // Re-insert rather than mutate: the records map doubles as the LRU order.
  dropLineageRecord(scope, identity.recordThreadId);
  scope.records.set(identity.recordThreadId, {
    threadId: identity.recordThreadId,
    conversationKey: identity.conversationKey,
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
    rootSessionKey: lineage.rootSessionKey,
    lastUsedAt: now,
  });
  scope.threadIdByConversationKey.set(identity.conversationKey, identity.recordThreadId);
  if (parentThreadId !== undefined) {
    const siblings = (scope.childThreadIdsByParent.get(parentThreadId) ?? [])
      .filter(id => id !== identity.recordThreadId);
    siblings.unshift(identity.recordThreadId);
    scope.childThreadIdsByParent.set(parentThreadId, siblings.slice(0, CODEX_LINEAGE_MAX_SIBLINGS));
  }
  pruneLineageScope(scope, now);

  return lineage;
}

/**
 * Cost-attribution lookup for other layers: which root workflow owns this conversation key.
 * Scoped like the records, so a caller can only ever resolve inside its own scope, and read-only
 * -- reading a lineage for accounting must not extend its lifetime.
 */
export function codexThreadLineageLookup(
  conversationKey: string,
  scopeKey: string,
  now = Date.now(),
): { conversationKey: string; rootSessionKey: string; parentThreadId?: string } | undefined {
  const scope = lineageByScope.get(scopeKey);
  if (scope === undefined) return undefined;
  const threadId = scope.threadIdByConversationKey.get(conversationKey);
  if (threadId === undefined) return undefined;
  const record = scope.records.get(threadId);
  if (record === undefined || now - record.lastUsedAt > CODEX_LINEAGE_IDLE_TTL_MS) return undefined;
  return {
    conversationKey: record.conversationKey,
    rootSessionKey: record.rootSessionKey,
    ...(record.parentThreadId !== undefined ? { parentThreadId: record.parentThreadId } : {}),
  };
}

/**
 * The root a request's spend belongs to, for a caller holding headers rather than a key. An
 * unrecorded conversation is its own root, so this never answers null for a bindable request and
 * an accounting layer has no reason to invent one.
 */
export function codexLineageRootForRequest(headers: Headers, now = Date.now()): string | undefined {
  const identity = codexConversationIdentity(headers, now);
  if (identity === undefined) return undefined;
  return codexThreadLineageLookup(identity.conversationKey, codexLineageScopeKey(headers), now)
    ?.rootSessionKey
    ?? identity.conversationKey;
}

/**
 * The lineage-backed worker/interactive answer.
 *
 * Admission classifies header-only today: a request is worker traffic only when it names a parent
 * AND a distinct `thread-id`, so a fan-out turn that stopped sending the parent header reads as
 * interactive. This keeps that rule and adds what the headers could not say -- a thread already
 * recorded with a parent is worker traffic. Nothing here changes admission; a later lane consumes
 * it.
 */
export function codexLineageWorkflowLane(headers: Headers, now = Date.now()): CodexWorkflowLane {
  const threadId = boundedLineageComponent(headers.get("thread-id"));
  const parentThreadId = boundedLineageComponent(headers.get("x-codex-parent-thread-id"));
  if (parentThreadId !== undefined && threadId !== undefined && threadId !== parentThreadId) {
    return "worker";
  }
  if (threadId === undefined) return "interactive";
  const record = lineageByScope.get(codexLineageScopeKey(headers))?.records.get(threadId);
  return record !== undefined
    && now - record.lastUsedAt <= CODEX_LINEAGE_IDLE_TTL_MS
    && record.parentThreadId !== undefined
    ? "worker"
    : "interactive";
}

/** Test-only reset; production state is process-local and dies with the process. */
export function clearCodexThreadLineageForTests(): void {
  lineageByScope.clear();
}
