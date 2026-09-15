import { isCodexAccountGenerationLive, readCodexAccountRecord } from "../account-store";
import { MAIN_CODEX_ACCOUNT_ID } from "../main-account";
import { retainedUtf8Bytes } from "../../lib/admission";
import { clearAllCodexPoolRefreshFailures } from "../pool-refresh-backoff";
import type { CodexThreadLineage } from "../lineage";
import type { CodexQuotaScope } from "./health-store";

export type ThreadAffinityEntry = {
  accountId: string;
  generation: number;
  createdAt: number;
  lastUsedAt: number;
  // Last time the bound account's quota threshold was re-evaluated for this
  // thread (interval-gated to avoid per-request flapping). See REEVAL_INTERVAL_MS.
  lastReevalAt: number;
  // When a transient failure streak first forced this thread onto another account
  // while the binding was HELD (#4546). Cleared the moment the bound account serves
  // again; once it ages past CODEX_TRANSIENT_AFFINITY_HOLD_MS the binding is
  // released through the ordinary path instead of detouring forever.
  transientHoldSince?: number;
  // Which account is serving this thread while its own is held under a transient hold.
  // Remembered rather than re-picked per request: under round-robin a fresh pick each turn
  // would walk the ring and start cold on every hop, which is the behaviour the hold exists
  // to prevent. Cleared with transientHoldSince when the bound account serves again.
  transientDetourAccountId?: string;
};

export type CodexThreadResolution =
  | { status: "selected"; accountId: string; affinity?: CodexAffinityDecision }
  | { status: "none"; affinity?: CodexAffinityDecision }
  | { status: "expired"; accountId: string; affinity?: CodexAffinityDecision };

/** What happened to this thread's binding on this request (#4546). */
export type CodexAffinityMove =
  /** Served by its own bound account, which was healthy. */
  | "reused"
  /** Served by its own bound account while something transient was wrong with it. */
  | "held"
  /** Served by another account while the binding stayed put. */
  | "detour"
  /** The binding was released and a different account took the thread. */
  | "rebound"
  /** There was no live binding; this request established one. */
  | "new_bind"
  /** The binding was released without a replacement on this request. */
  | "cleared";

/**
 * Why. A move is the expensive event -- it discards the prompt-cache prefix warmed on the old
 * account -- so the operator should not have to infer it from account labels across log lines,
 * which is how #4546 had to be diagnosed.
 */
export type CodexAffinityReason =
  | "healthy"
  | "quota_headroom"
  | "quota_refusal"
  | "transient"
  | "transient_hold_expired"
  | "unusable"
  | "paused"
  | "plan_excluded"
  | "cooldown"
  | "quota_avoided"
  | "generation"
  | "expired"
  | "model_lane"
  /** First placement followed the parent's CURRENT serving account (#4546, wp8). */
  | "lineage_parent"
  /** First placement followed a compatible sibling's current serving account. */
  | "lineage_sibling";

export interface CodexAffinityDecision {
  move: CodexAffinityMove;
  reason: CodexAffinityReason;
}

/** The decision to report once a binding has been released and selection starts over. */
export function affinityAfterRelease(
  threadId: string | null,
  releaseReason: CodexAffinityReason | undefined,
): CodexAffinityDecision {
  // Reported now, so it must not be reported again by the next request.
  clearPendingReleaseReason(threadId);
  return releaseReason === undefined
    ? { move: "new_bind", reason: "healthy" }
    : { move: "rebound", reason: releaseReason };
}

/**
 * What to report when selection produced no account at all. The binding is gone and nothing took
 * it, which is a `cleared`, and the pending reason is deliberately NOT consumed: a no-account
 * result reaches no auth context and therefore no usage entry, so the next resolve that does
 * produce one is the first place this release can actually be seen.
 */
export function affinityOnNoAccount(
  threadId: string | null,
  releaseReason: CodexAffinityReason | undefined,
): CodexAffinityDecision | undefined {
  if (releaseReason === undefined) return undefined;
  // Hand it forward as well as reporting it. A reason derived from the entry this request just
  // released lives only in a local, so without this the next resolve finds no entry and no
  // pending reason and calls the rebind a fresh healthy bind.
  notePendingReleaseReason(threadId, releaseReason);
  return { move: "cleared", reason: releaseReason };
}

export const CODEX_THREAD_AFFINITY_IDLE_TTL_MS = 24 * 60 * 60_000;
export const CODEX_THREAD_AFFINITY_MAX_ENTRIES = 2048;
const MAX_AFFINITY_COMPONENT_BYTES = 512;
// Min interval between quota threshold re-evaluations for a single bound thread.
// Well under the 5h/weekly quota windows, but enough to stop per-request flapping.
export const CODEX_THREAD_AFFINITY_REEVAL_INTERVAL_MS = 60_000;

/**
 * How long a live binding outlives a TRANSIENT failure streak on its own account (#4546).
 *
 * Being unable to send right now is not the same as losing ownership of the conversation.
 * A 5xx streak is frequently provider-wide rather than account-specific, and deleting the
 * binding for it discards a prompt-cache prefix that the next turn then pays for again --
 * the same cost the quota threshold used to impose, arriving through a different door.
 * So the request detours to another account while the binding is held here.
 *
 * Bounded, because an unbounded hold is its own defect: an account that never recovers
 * would keep a thread detouring indefinitely while the conversation's real warm prefix
 * accumulates somewhere else. Ten minutes is longer than the whole soft-avoid escalation
 * ladder up to its final step, so an ordinary outage resolves inside the hold and a
 * genuine one converts to a real rebind instead of a permanent detour.
 */
export const CODEX_TRANSIENT_AFFINITY_HOLD_MS = 10 * 60_000;

/**
 * Requests without a resolved native model retain the historic one-account-per-
 * thread behavior. Requests with a known quota scope get an independent
 * affinity so a Reserve failover cannot displace the same thread's Terra/Luna
 * account (and vice versa).
 */
type BaseThreadAffinityScope = CodexQuotaScope | "legacy";
type ModelDetourAffinityScope = `model-detour:${BaseThreadAffinityScope}:${string}`;
type ThreadAffinityScope = BaseThreadAffinityScope | ModelDetourAffinityScope;

function isModelDetourAffinityScope(scope: ThreadAffinityScope): scope is ModelDetourAffinityScope {
  return scope.startsWith("model-detour:");
}
const LEGACY_THREAD_AFFINITY_SCOPE = "legacy" as const;
const threadAccountMap = new Map<string, Map<ThreadAffinityScope, ThreadAffinityEntry>>();
let threadAffinityEntryTotal = 0;

/**
 * Which pool account minted the conversation's carried OpenAI state
 * (`previous_response_id`, encrypted reasoning, provider conversation/file ids).
 * Keyed by the same affinity key as {@link threadAccountMap}, bounded the same
 * way, and process-local — raw account ids never reach a log.
 */
type ConversationStateIssuerEntry = {
  accountId: string;
  lastUsedAt: number;
};
const conversationStateIssuerMap = new Map<string, ConversationStateIssuerEntry>();

export function clearThreadAccountMap(): void {
  threadAccountMap.clear();
  threadAffinityEntryTotal = 0;
  // A refresh cooldown is per-account runtime state learned alongside these bindings. Leaving it
  // behind here keeps an account out of selection after the roster it belonged to is gone.
  clearAllCodexPoolRefreshFailures();
  conversationStateIssuerMap.clear();
}

export function clearConversationStateIssuerMap(): void {
  conversationStateIssuerMap.clear();
}

export function clearThreadAccountMapForAccount(
  accountId: string,
  reason: CodexAffinityReason = "unusable",
): void {
  for (const [threadId, affinities] of threadAccountMap) {
    for (const [scope, entry] of affinities) {
      if (entry.accountId === accountId && affinities.delete(scope)) {
        threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
        notePendingReleaseReason(threadId, reason);
      }
    }
    if (affinities.size === 0) threadAccountMap.delete(threadId);
  }
}

function pruneConversationStateIssuers(now: number): void {
  for (const [key, entry] of conversationStateIssuerMap) {
    if (now - entry.lastUsedAt > CODEX_THREAD_AFFINITY_IDLE_TTL_MS) {
      conversationStateIssuerMap.delete(key);
    }
  }
  while (conversationStateIssuerMap.size > CODEX_THREAD_AFFINITY_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of conversationStateIssuerMap) {
      if (entry.lastUsedAt < oldestAt) {
        oldestAt = entry.lastUsedAt;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    conversationStateIssuerMap.delete(oldestKey);
  }
}

/**
 * Record the pool account that just issued carried conversation state for this
 * binding key. In-memory only; the id is never written to a request log.
 */
export function rememberConversationStateIssuer(
  bindingKey: string,
  accountId: string,
  now = Date.now(),
): void {
  if (!bindingKey.trim() || !accountId.trim()) return;
  if (!admissibleAffinityComponent(bindingKey) || !admissibleAffinityComponent(accountId)) return;
  pruneConversationStateIssuers(now);
  conversationStateIssuerMap.set(bindingKey, { accountId, lastUsedAt: now });
  pruneConversationStateIssuers(now);
}

/** Last account that minted carried state for this binding, if still in the TTL window. */
export function peekConversationStateIssuer(
  bindingKey: string,
  now = Date.now(),
): string | undefined {
  if (!bindingKey.trim() || !admissibleAffinityComponent(bindingKey)) return undefined;
  pruneConversationStateIssuers(now);
  const entry = conversationStateIssuerMap.get(bindingKey);
  if (!entry) return undefined;
  entry.lastUsedAt = now;
  return entry.accountId;
}

/**
 * Why a binding was released, held until that thread's next resolve can report it (#4546).
 *
 * A release and the request that pays for it are two different moments: a 429 clears the pin
 * inside the outcome recorder, and the next request arrives with nothing left to explain why it
 * is starting cold. Bounded, because it is a diagnostic and must not become a leak.
 */
const pendingReleaseReasons = new Map<string, CodexAffinityReason>();
const MAX_PENDING_RELEASE_REASONS = 4096;

function notePendingReleaseReason(threadId: string | null, reason: CodexAffinityReason): void {
  if (threadId === null) return;
  if (!pendingReleaseReasons.has(threadId) && pendingReleaseReasons.size >= MAX_PENDING_RELEASE_REASONS) {
    const oldest = pendingReleaseReasons.keys().next();
    if (!oldest.done) pendingReleaseReasons.delete(oldest.value);
  }
  pendingReleaseReasons.set(threadId, reason);
}

export function peekPendingReleaseReason(threadId: string | null): CodexAffinityReason | undefined {
  if (threadId === null) return undefined;
  return pendingReleaseReasons.get(threadId);
}

/**
 * Forget a release only once it has actually been reported.
 *
 * Consuming it at derivation time lost it whenever selection then failed to produce an account:
 * a no-account return carries no payload, so the release went unrecorded and the next successful
 * resolve claimed a fresh healthy bind (#4598). A release survives until some resolve reports it.
 */
function clearPendingReleaseReason(threadId: string | null): void {
  if (threadId !== null) pendingReleaseReasons.delete(threadId);
}

function threadAffinityScope(quotaScope?: CodexQuotaScope): BaseThreadAffinityScope {
  return quotaScope ?? LEGACY_THREAD_AFFINITY_SCOPE;
}

function admissibleAffinityComponent(value: string): boolean {
  return retainedUtf8Bytes(value) <= MAX_AFFINITY_COMPONENT_BYTES;
}

function modelDetourAffinityScope(
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): ModelDetourAffinityScope | undefined {
  const canonicalModelId = modelId?.trim().toLowerCase();
  if (!canonicalModelId || !admissibleAffinityComponent(canonicalModelId)) return undefined;
  return `model-detour:${threadAffinityScope(quotaScope)}:${canonicalModelId}`;
}

function getThreadAffinityForScope(
  threadId: string,
  scope: ThreadAffinityScope,
): ThreadAffinityEntry | undefined {
  if (!admissibleAffinityComponent(threadId)) return undefined;
  return threadAccountMap.get(threadId)?.get(scope);
}

export function getThreadAffinity(threadId: string, quotaScope?: CodexQuotaScope): ThreadAffinityEntry | undefined {
  return getThreadAffinityForScope(threadId, threadAffinityScope(quotaScope));
}

export function getModelDetourAffinity(
  threadId: string,
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): ThreadAffinityEntry | undefined {
  const scope = modelDetourAffinityScope(modelId, quotaScope);
  return scope ? getThreadAffinityForScope(threadId, scope) : undefined;
}

function deleteThreadAffinityForScope(threadId: string, scope: ThreadAffinityScope): void {
  if (!admissibleAffinityComponent(threadId)) return;
  const affinities = threadAccountMap.get(threadId);
  if (!affinities) return;
  if (affinities.delete(scope)) {
    threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
  }
  if (affinities.size === 0) threadAccountMap.delete(threadId);
}

export function deleteThreadAffinity(threadId: string, quotaScope?: CodexQuotaScope): void {
  deleteThreadAffinityForScope(threadId, threadAffinityScope(quotaScope));
}

export function deleteModelDetourAffinity(
  threadId: string,
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): void {
  const scope = modelDetourAffinityScope(modelId, quotaScope);
  if (scope) deleteThreadAffinityForScope(threadId, scope);
}

/** Remove only the matching failed account's affinities for one thread. */
export function deleteThreadAffinitiesForAccount(threadId: string, accountId: string): void {
  if (!admissibleAffinityComponent(threadId) || !admissibleAffinityComponent(accountId)) return;
  const affinities = threadAccountMap.get(threadId);
  if (!affinities) return;
  for (const [scope, entry] of affinities) {
    if (entry.accountId === accountId && affinities.delete(scope)) {
      threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
    }
  }
  if (affinities.size === 0) threadAccountMap.delete(threadId);
}

function threadAffinityEntryCount(): number {
  return threadAffinityEntryTotal;
}

export function isThreadAffinityExpired(entry: ThreadAffinityEntry, now: number): boolean {
  return now - entry.lastUsedAt > CODEX_THREAD_AFFINITY_IDLE_TTL_MS;
}

export function isThreadAffinityGenerationLive(entry: ThreadAffinityEntry): boolean {
  if (entry.accountId === MAIN_CODEX_ACCOUNT_ID) return entry.generation === 0;
  return isCodexAccountGenerationLive(entry.accountId, entry.generation);
}

/** Generations this account's affinity entries are bound at. Test observability only. */
export function debugCodexAffinityGenerations(accountId: string): number[] {
  const generations: number[] = [];
  for (const affinities of threadAccountMap.values()) {
    for (const entry of affinities.values()) {
      if (entry.accountId === accountId) generations.push(entry.generation);
    }
  }
  return generations;
}

/**
 * Advance this account's affinity entries from the generation a rejected credential
 * was bound under to the generation its own refresh produced.
 *
 * A 401 refresh-and-replay keeps the request on the same account, but the CAS write
 * moves the credential from G to G+1, and {@link isThreadAffinityGenerationLive}
 * demands exact equality — so without this the entry the replay just preserved is
 * dead on the next request. Not quarantining an account is not the same as keeping
 * its affinity.
 *
 * Lineage is proven by the CALLER, which must pass only a generation its own refresh
 * produced. Re-deriving it here from `replacedAt` cannot work: the caller reads that
 * field after the refresh and this function would re-read the same record, so the
 * comparison is tautological and an external replacement passes it. An external
 * replacement must retire the affinity, because that credential may belong to a
 * different upstream identity.
 */
export function handOffThreadAffinityGeneration(
  accountId: string,
  fromGeneration: number,
  toGeneration: number,
): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return false;
  if (toGeneration !== fromGeneration + 1) return false;
  const record = readCodexAccountRecord(accountId);
  if (!record?.credential || record.deletedAt != null) return false;
  if (record.generation !== toGeneration) return false;
  let handedOff = false;
  for (const affinities of threadAccountMap.values()) {
    for (const entry of affinities.values()) {
      if (entry.accountId !== accountId || entry.generation !== fromGeneration) continue;
      entry.generation = toGeneration;
      handedOff = true;
    }
  }
  return handedOff;
}

function pruneExpiredThreadAffinities(now: number): void {
  for (const [threadId, affinities] of threadAccountMap) {
    for (const [scope, entry] of affinities) {
      if (isThreadAffinityExpired(entry, now) && affinities.delete(scope)) {
        threadAffinityEntryTotal = Math.max(0, threadAffinityEntryTotal - 1);
      }
    }
    if (affinities.size === 0) threadAccountMap.delete(threadId);
  }
}

function pruneLruThreadAffinities(): void {
  if (threadAffinityEntryCount() <= CODEX_THREAD_AFFINITY_MAX_ENTRIES) return;
  while (threadAffinityEntryCount() > CODEX_THREAD_AFFINITY_MAX_ENTRIES) {
    let oldestThreadId: string | null = null;
    let oldestScope: ThreadAffinityScope | null = null;
    let oldestLastUsedAt = Number.POSITIVE_INFINITY;
    let oldestIsDetour = false;
    for (const [threadId, affinities] of threadAccountMap) {
      for (const [scope, entry] of affinities) {
        const candidateIsDetour = isModelDetourAffinityScope(scope);
        if (
          (candidateIsDetour && !oldestIsDetour)
          || (candidateIsDetour === oldestIsDetour && entry.lastUsedAt < oldestLastUsedAt)
        ) {
          oldestThreadId = threadId;
          oldestScope = scope;
          oldestLastUsedAt = entry.lastUsedAt;
          oldestIsDetour = candidateIsDetour;
        }
      }
    }
    if (!oldestThreadId || !oldestScope) return;
    deleteThreadAffinityForScope(oldestThreadId, oldestScope);
  }
}

function bindThreadAffinityForScope(
  threadId: string,
  accountId: string,
  now: number,
  scope: ThreadAffinityScope,
): void {
  if (!admissibleAffinityComponent(threadId) || !admissibleAffinityComponent(accountId)) return;
  const record = accountId === MAIN_CODEX_ACCOUNT_ID ? undefined : readCodexAccountRecord(accountId);
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && (!record?.credential || record.deletedAt != null)) return;
  pruneExpiredThreadAffinities(now);
  const affinities = threadAccountMap.get(threadId) ?? new Map<ThreadAffinityScope, ThreadAffinityEntry>();
  const previous = affinities.get(scope);
  affinities.set(scope, {
    accountId,
    generation: accountId === MAIN_CODEX_ACCOUNT_ID ? 0 : record!.generation,
    createdAt: previous?.createdAt ?? now,
    lastUsedAt: now,
    lastReevalAt: now,
  });
  if (!previous) threadAffinityEntryTotal += 1;
  threadAccountMap.set(threadId, affinities);
  pruneLruThreadAffinities();
}

export function bindThreadAffinity(
  threadId: string,
  accountId: string,
  now: number,
  quotaScope?: CodexQuotaScope,
): void {
  bindThreadAffinityForScope(threadId, accountId, now, threadAffinityScope(quotaScope));
}

export function bindModelDetourAffinity(
  threadId: string,
  accountId: string,
  now: number,
  modelId: string | undefined,
  quotaScope?: CodexQuotaScope,
): void {
  const scope = modelDetourAffinityScope(modelId, quotaScope);
  if (scope) bindThreadAffinityForScope(threadId, accountId, now, scope);
}

/** Read-only view of one thread's scope-keyed affinity entries. */
export function getThreadAffinityScopes(
  threadId: string,
): ReadonlyMap<ThreadAffinityScope, ThreadAffinityEntry> | undefined {
  return threadAccountMap.get(threadId);
}

/**
 * Move one scope's binding from the pre-#4546 RAW parent key onto the key this thread uses now.
 *
 * Bindings and the key that derives them are process-local, so an ordinary restart already
 * discards every binding and there is nothing to migrate. The case this exists for is the
 * narrow one: a code swap under a live conversation, where the map still holds entries made by
 * the old rule. Rebinding those cold is precisely the defect the lineage work exists to prevent,
 * so the conversation keeps its account and the legacy entry is retired in the same step.
 *
 * One way, once. The legacy entry is deleted even when it was dead on arrival, because nothing
 * can reach it again under the new rule and an orphan only spends an LRU slot a live
 * conversation needs. Only the account moves: a transient hold describes a failure happening
 * right now, and the ordinary path re-derives it on this very request.
 */
function adoptLegacyAffinityForScope(
  threadId: string,
  legacyKey: string,
  now: number,
  scope: ThreadAffinityScope,
): void {
  if (getThreadAffinityForScope(threadId, scope) !== undefined) return;
  const legacy = getThreadAffinityForScope(legacyKey, scope);
  if (legacy === undefined) return;
  if (!isThreadAffinityExpired(legacy, now) && isThreadAffinityGenerationLive(legacy)) {
    bindThreadAffinityForScope(threadId, legacy.accountId, now, scope);
  }
  deleteThreadAffinityForScope(legacyKey, scope);
}

/** Both lanes of the legacy migration: the ordinary binding and this request's model detour. */
export function adoptLegacyLineageAffinity(
  threadId: string,
  lineage: CodexThreadLineage | undefined,
  now: number,
  quotaScope?: CodexQuotaScope,
  modelId?: string,
): void {
  const legacyKey = lineage?.legacyConversationKey;
  if (legacyKey === undefined || legacyKey === threadId) return;
  adoptLegacyAffinityForScope(threadId, legacyKey, now, threadAffinityScope(quotaScope));
  const detourScope = modelDetourAffinityScope(modelId, quotaScope);
  if (detourScope) adoptLegacyAffinityForScope(threadId, legacyKey, now, detourScope);
}
