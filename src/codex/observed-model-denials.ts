/**
 * Per-account model denials observed from an authenticated upstream refusal.
 *
 * [Decision Log]
 * - 목적과 의도: Keep the one piece of account-specific model evidence that is never stale --
 *   the upstream's own refusal -- instead of discarding it after a single retry.
 * - 기존 구현 및 제약 조건: `cachedDeniedCodexAccountIdsForModel` reads authenticated `/models`
 *   rosters, and those entries expire five minutes after they are fetched
 *   (`MODEL_ROSTER_TTL_MS`). Nothing on the flagship request path refills them, because
 *   `resolveCodexModelEntitlements` is awaited only for `ACCOUNT_GATED_NATIVE_OPENAI_MODELS`,
 *   which no longer holds the flagships. So the denial set is usually absent, the #4797
 *   ordering rules become the identity function, and the pool picks on quota alone (#4906).
 * - 검토한 주요 대안: Fetch a roster on the flagship request path, lengthen the roster TTL, or
 *   infer availability from the account's plan name.
 * - 선택한 방식: Record the exact upstream unsupported-model refusal per (account, model) and
 *   let selection read it alongside the roster.
 * - 다른 대안 대신 이 방식을 선택한 이유: A roster fetch on the request path puts an
 *   authenticated upstream call in front of the most commonly requested models in the product,
 *   which is what the cache-only contract exists to prevent. A longer TTL keeps a shard's
 *   stale absence around for longer without adding any evidence. A plan name proves nothing
 *   about a grant -- `available_in_plans` for `gpt-6-astra` lists `free` while free accounts
 *   are refused -- and #3022 is what happened the last time availability was inferred rather
 *   than observed.
 * - 장점, 단점 및 영향: A refusal is spent once and then remembered, so the pool stops
 *   re-sending a model to the account that just refused it. The evidence is confirmed rather
 *   than inferred, it is still only an ordering preference, and it is overridden by any
 *   positive roster grant for the same pair.
 *
 * What this deliberately is NOT: an eligibility filter. Readers treat these ids exactly like
 * roster denials -- `withoutModelDeniedAccounts` restores them when filtering would empty the
 * candidate list, and `preferModelEntitledAccount` leaves the active account alone when no
 * entitled alternative exists. No model is hidden from any catalog and no request is refused
 * before dispatch, so the 2026-09-04 owner decision that the flagships fail open is untouched.
 */

/**
 * Six hours, against a five-minute roster TTL.
 *
 * The asymmetry is the point. A roster entry is a snapshot of an answer that may simply not
 * have arrived yet, so it expires quickly and absence means "unknown". A refusal is an answer:
 * upstream named this model and this account and said no. It still expires, because a rollout
 * can reach an account between two requests, and the two faster paths back are a positive
 * roster grant (which overrides this outright) and a successful response from the same account
 * for the same model (which clears the entry).
 */
const OBSERVED_DENIAL_TTL_MS = 6 * 60 * 60_000;

/** Bounded like the roster cache: pool size times flagship count, with room to spare. */
const OBSERVED_DENIAL_MAX_ENTRIES = 512;

/** `accountId\u0000modelId` -> expiry. Insertion order is the eviction order. */
const observedDenials = new Map<string, number>();

function denialKey(accountId: string, modelId: string): string {
  return `${accountId}\u0000${modelId}`;
}

function accountIdOfDenialKey(key: string): string {
  return key.slice(0, key.indexOf("\u0000"));
}

function modelIdOfDenialKey(key: string): string {
  return key.slice(key.indexOf("\u0000") + 1);
}

/**
 * Remember that `accountId` was refused `modelId` by its own authenticated upstream.
 *
 * Re-recording refreshes the entry rather than extending an older one, so a pair that keeps
 * being refused stays remembered and one that stops being refused ages out.
 */
export function recordObservedCodexModelDenial(
  accountId: string,
  modelId: string,
  now = Date.now(),
): void {
  const key = denialKey(accountId, modelId);
  // Delete before set so the refreshed entry moves to the back of the eviction order.
  observedDenials.delete(key);
  observedDenials.set(key, now + OBSERVED_DENIAL_TTL_MS);
  while (observedDenials.size > OBSERVED_DENIAL_MAX_ENTRIES) {
    const oldest = observedDenials.keys().next();
    if (oldest.done) break;
    observedDenials.delete(oldest.value);
  }
}

/**
 * Forget one pair, because the account just served the model.
 *
 * A success is newer and stronger evidence than the refusal that preceded it: whatever the
 * entitlement was when upstream refused, it is not that now.
 */
export function clearObservedCodexModelDenial(accountId: string, modelId: string): void {
  observedDenials.delete(denialKey(accountId, modelId));
}

/**
 * Forget every pair for one account, because its credential changed.
 *
 * A reauthenticated account can be a different subscription entirely, so evidence gathered
 * under the previous credential says nothing about this one -- the same reasoning
 * `invalidateCodexModelEntitlementsForAccount` applies to cached rosters.
 */
export function forgetObservedCodexModelDenialsForAccount(accountId: string | null | undefined): void {
  if (!accountId) return;
  for (const key of [...observedDenials.keys()]) {
    if (accountIdOfDenialKey(key) === accountId) observedDenials.delete(key);
  }
}

/**
 * Accounts refused `modelId` within the retention window.
 *
 * Returns `undefined` rather than an empty set when nothing is recorded, matching
 * `cachedDeniedCodexAccountIdsForModel`: a caller must not be able to read "no evidence" as
 * "nobody is denied".
 */
export function observedDeniedCodexAccountIdsForModel(
  modelId: string | undefined,
  now = Date.now(),
): ReadonlySet<string> | undefined {
  if (!modelId) return undefined;
  const denied = new Set<string>();
  for (const [key, expiresAt] of [...observedDenials]) {
    if (expiresAt <= now) {
      observedDenials.delete(key);
      continue;
    }
    if (modelIdOfDenialKey(key) === modelId) denied.add(accountIdOfDenialKey(key));
  }
  return denied.size > 0 ? denied : undefined;
}

export function resetObservedCodexModelDenialsForTests(): void {
  observedDenials.clear();
}
