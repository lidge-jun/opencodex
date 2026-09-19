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

/**
 * One entry of refusal evidence.
 *
 * `generation` is the credential generation the refusal was observed under (#4952). Evidence
 * is about a CREDENTIAL, not an account id: reauthenticating the same internal account can
 * swap the subscription underneath it, so a refusal from the previous credential says nothing
 * about the replacement. Carrying the generation lets a reader ignore superseded evidence and
 * lets a late reply from an older generation be refused rather than applied.
 *
 * It is OPTIONAL because not every account that can be refused has one. A `main-pool` context
 * — the stored main login taking part in rotation — carries a real `accountId` and a
 * `writerGeneration`, but no pool credential generation, because its credential lives in
 * `auth.json` rather than the pool store. Dropping its evidence would have silently reverted
 * #4906 for that account: the pool would re-send the same model to the login that just refused
 * it, on every request, forever. An entry without a generation is account-scoped, and the
 * generation fences below simply do not apply to it. This is the same rule the quota writer
 * already uses in `core-codex-account.ts`, where an absent credential generation skips the
 * liveness check instead of discarding the write.
 */
interface ObservedDenial {
  expiresAt: number;
  generation?: number;
}

/** `accountId\u0000modelId` -> entry. Insertion order is the eviction order. */
const observedDenials = new Map<string, ObservedDenial>();

/** Whether `generation` is still the account's live credential. */
type GenerationLiveCheck = (accountId: string, generation: number) => boolean;

/**
 * Opens one liveness check.
 *
 * A FACTORY rather than a bare predicate because the production implementation reads the
 * credential store, and a lookup can ask about several accounts. Loading once per lookup and
 * closing over that snapshot is the shape `loadCodexAccountRecordSnapshot` exists for; a bare
 * predicate would reload and reparse the whole store per row, on the request path.
 *
 * Injected rather than imported at module scope so this stays a leaf module: `account-store`
 * reads the credential file, and a unit test of this map should not have to stand one up.
 */
type GenerationLiveCheckFactory = () => GenerationLiveCheck;

let beginGenerationLiveCheck: GenerationLiveCheckFactory = () => () => true;

/** Wire the liveness predicate. Called once at startup; tests substitute their own. */
export function setObservedDenialGenerationCheck(begin: GenerationLiveCheckFactory): void {
  beginGenerationLiveCheck = begin;
}

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
  generation: number | undefined,
  now = Date.now(),
): void {
  // A refusal dispatched under generation G can arrive after G+1 has been saved. Reject it
  // BEFORE touching the map at all, not merely when this key already holds newer evidence:
  // with no entry for this key the stale row would otherwise be inserted, and at the entry
  // bound it would evict a valid row that nothing can restore (#4952).
  if (generation !== undefined && !beginGenerationLiveCheck()(accountId, generation)) return;
  const key = denialKey(accountId, modelId);
  const existing = observedDenials.get(key);
  // Second fence, for the window where the replacement credential has been dispatched but the
  // store read above still answers live. Both sides must name a generation to be comparable;
  // an account-scoped entry is not older or newer than a credential-scoped one.
  if (existing !== undefined && existing.generation !== undefined && generation !== undefined
    && existing.generation > generation) return;
  // Delete before set so the refreshed entry moves to the back of the eviction order.
  observedDenials.delete(key);
  observedDenials.set(key, { expiresAt: now + OBSERVED_DENIAL_TTL_MS, generation });
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
export function clearObservedCodexModelDenial(
  accountId: string,
  modelId: string,
  generation: number | undefined,
): void {
  const key = denialKey(accountId, modelId);
  const existing = observedDenials.get(key);
  if (!existing) return;
  // The mirror of the write fence: a success dispatched under G arriving after G+1 was
  // refused must not clear the replacement's evidence (#4952). Equal generations clear,
  // because that is the ordinary "this account just served this model" case.
  if (existing.generation !== undefined && generation !== undefined
    && existing.generation > generation) return;
  observedDenials.delete(key);
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
  options: { excludeAccountIds?: ReadonlySet<string> } = {},
): ReadonlySet<string> | undefined {
  if (!modelId) return undefined;
  const denied = new Set<string>();
  // Opened lazily and at most once: a lookup that matches no credential-scoped row must not
  // read the credential store at all.
  let isLive: GenerationLiveCheck | undefined;
  for (const [key, entry] of [...observedDenials]) {
    if (entry.expiresAt <= now) {
      observedDenials.delete(key);
      continue;
    }
    // Model and the caller's exclusion fence FIRST. The issue asks for identity validation
    // after the exclusion read, and an excluded account — a draining profile switch, or a
    // request-owned credential — must produce no credential-store read on its behalf.
    if (modelIdOfDenialKey(key) !== modelId) continue;
    const accountId = accountIdOfDenialKey(key);
    if (options.excludeAccountIds?.has(accountId)) continue;
    if (entry.generation !== undefined) {
      isLive ??= beginGenerationLiveCheck();
      // Superseded evidence stops denying the replacement. It is SKIPPED, not deleted: the
      // predicate cannot tell "this account reauthenticated" from "the credential store could
      // not be read", and deleting on the second would throw away valid evidence that a
      // transient read failure was never entitled to touch. Skipping already delivers the
      // routing outcome the issue asks for, on every read, without depending on the
      // conditional account-wide forget that cannot run when no roster was ever cached.
      // Superseded rows still leave by TTL, by eviction, and by the account-wide forget.
      if (!isLive(accountId, entry.generation)) continue;
    }
    denied.add(accountId);
  }
  return denied.size > 0 ? denied : undefined;
}

export function resetObservedCodexModelDenialsForTests(): void {
  observedDenials.clear();
  beginGenerationLiveCheck = () => () => true;
}
