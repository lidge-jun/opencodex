/**
 * Half-open recovery for a held account, and the pool-wide retry/probe budget
 * that sits above it (#4546, wp3 follow-up).
 *
 * The transient hold (#4616) keeps a thread's binding while its account serves a
 * 5xx streak, and detours requests to a healthy sibling. What it cannot answer is
 * whether the held account is actually back: a soft-avoided account receives no
 * traffic, so the two-success clearing rule can only fire through the "held"
 * fallback, which hands the failing account back to every pinned thread at once.
 * This module is the bounded trial that closes that gap -- a single-holder probe
 * lease keyed on the health domain (the quota-cooldown domain already has its own
 * lease in src/codex/routing.ts and is a different thing).
 *
 * Three rules the lease enforces:
 *
 * - While an account is held, exactly one in-flight probe may test it. Every
 *   other request keeps the remembered detour, so a failed probe costs the
 *   caller nothing -- the detour's identity is never dropped to run the trial.
 * - The lease has a deadline and is released on success, failure, or expiry. A
 *   response that arrives after its lease was lost is STALE: it must not
 *   overwrite a newer binding or a newer failure state, so every lease carries
 *   the generation it was issued under and a settle that fails the fence
 *   mutates nothing.
 * - When every candidate is held the caller gets a typed "binding remembered,
 *   dispatch withheld" outcome -- not a send to an account already known to be
 *   failing.
 *
 * The pool-wide limiter exists because per-request send budgets do not prevent
 * a retry storm: thousands of requests each staying inside their own allowance
 * still compose into an unbounded rate against an already-failing upstream.
 * Recovery dispatches (retries and probes, never the initial send of a new
 * request) are admitted only while they stay under a ratio of observed initial
 * sends in a sliding window -- the standard overload-guidance shape.
 */

/** How long a granted probe may be in flight before its lease is forfeit. */
export const TRANSIENT_PROBE_LEASE_MS = 30_000;
/**
 * Minimum spacing between probes of the same held account. Without it every
 * request that follows a settled probe becomes the next probe, which is the
 * same storm the single-holder rule exists to bound -- just serialized.
 */
export const TRANSIENT_PROBE_INTERVAL_MS = 15_000;

/**
 * Grace kept on top of an entry's pacing and lease deadlines before it may be forgotten.
 * Inside it a late settle can still answer "expired" rather than "stale", which is the
 * distinction the settle contract exists to report.
 */
const PROBE_STATE_RETENTION_MS = 60_000;
/**
 * Hard ceiling on remembered accounts. Pacing state is per account id, and account ids churn
 * with configuration: without a ceiling a long-lived proxy accumulates one entry per id it
 * ever probed. Above the ceiling the entries whose pacing lapses soonest are dropped, which
 * at worst lets one dormant account be probed earlier than its interval; an entry holding a
 * LIVE lease is never dropped, because that would hand out a second concurrent probe and
 * break the single-holder rule the lease exists to enforce.
 */
export const MAX_TRANSIENT_PROBE_STATES = 1_024;
/** Below this the map is too small to be worth scanning on a grant. */
const PROBE_STATE_SWEEP_THRESHOLD = 64;
/**
 * Eviction target once the ceiling is reached. Clearing a block at a time keeps the ordering
 * pass off the common grant path: it runs once per block of new accounts instead of once per
 * grant forever after the first time the ceiling is touched.
 */
const PROBE_STATE_EVICTION_LOW_WATER = Math.floor(MAX_TRANSIENT_PROBE_STATES * 0.9);

export interface TransientProbeLease {
  readonly accountId: string;
  readonly leaseId: string;
  /** Epoch the lease was issued under; a settle must match the CURRENT epoch. */
  readonly generation: number;
  readonly expiresAt: number;
}

export type TransientProbeOutcome = "recovered" | "failed";

/**
 * What a settle did to the lease.
 *
 * - `applied`: the probe still held the lease inside its deadline; the caller
 *   may act on the outcome (clear the hold, or record the fresh failure).
 * - `stale`: the lease was already lost -- expired and re-issued, or invalidated
 *   by newer authoritative state. The result is dropped; nothing is overwritten.
 * - `expired`: the probe finished after its own deadline. The lease is dead
 *   either way; this answer exists so the caller can tell "lost a race" from
 *   "ran long".
 */
export type TransientProbeSettle = "applied" | "stale" | "expired";

interface AccountProbeState {
  /** Bumped on every lease grant and every external invalidation. */
  generation: number;
  leaseId?: string;
  leaseExpiresAt?: number;
  lastProbeAt?: number;
  /**
   * Moment this account's pacing interval lapses, recorded at grant time from the interval
   * that grant actually used. Kept alongside `lastProbeAt` so cleanup honours a caller's
   * longer interval instead of assuming the default.
   */
  pacedUntil?: number;
  lastOutcome?: TransientProbeOutcome;
}

const probeStates = new Map<string, AccountProbeState>();
let probeLeaseSeq = 0;

function probeStateFor(accountId: string): AccountProbeState {
  let state = probeStates.get(accountId);
  if (!state) {
    state = { generation: 0 };
    probeStates.set(accountId, state);
  }
  return state;
}

function liveLease(state: AccountProbeState, now: number): boolean {
  return state.leaseId !== undefined && state.leaseExpiresAt !== undefined && state.leaseExpiresAt > now;
}

/**
 * Moment an entry stops carrying anything a future decision can read: its pacing interval and
 * any unsettled lease deadline, plus the grace above.
 */
function probeStateRetiresAt(state: AccountProbeState): number {
  return Math.max(state.pacedUntil ?? 0, state.leaseExpiresAt ?? 0) + PROBE_STATE_RETENTION_MS;
}

/**
 * Bound the remembered accounts. Called on the one path that can grow the map -- a grant is
 * the only insertion -- so the ceiling holds without a timer.
 *
 * The first pass drops only entries that can no longer change an answer: no live lease, the
 * pacing interval lapsed, and the grace elapsed. Re-creating such an entry later yields the
 * same decisions it would have produced, and a late settle against it still cannot be applied
 * because lease ids are issued from a monotonic counter and never repeat.
 */
function sweepProbeStates(now: number): void {
  if (probeStates.size <= PROBE_STATE_SWEEP_THRESHOLD) return;
  for (const [accountId, state] of probeStates) {
    if (liveLease(state, now)) continue;
    if (now >= probeStateRetiresAt(state)) probeStates.delete(accountId);
  }
  if (probeStates.size <= MAX_TRANSIENT_PROBE_STATES) return;
  // Still over the ceiling with nothing retired: churn is faster than the retention window.
  // Evict in retirement order so the entries closest to meaningless go first, and never one
  // holding a live lease.
  const evictable = Array.from(probeStates)
    .filter(([, state]) => !liveLease(state, now))
    .sort((a, b) => probeStateRetiresAt(a[1]) - probeStateRetiresAt(b[1]));
  let excess = probeStates.size - PROBE_STATE_EVICTION_LOW_WATER;
  for (const [accountId] of evictable) {
    if (excess <= 0) break;
    probeStates.delete(accountId);
    excess -= 1;
  }
}

/**
 * Grant the single in-flight probe for a held account, or null when another
 * probe is already out or the pacing interval has not elapsed. The grant bumps
 * the epoch, so a result from any earlier lease is stale the moment it lands.
 */
export function tryAcquireTransientProbe(
  accountId: string,
  now = Date.now(),
  options?: { leaseMs?: number; minIntervalMs?: number },
): TransientProbeLease | null {
  const state = probeStateFor(accountId);
  if (liveLease(state, now)) return null;
  const interval = options?.minIntervalMs ?? TRANSIENT_PROBE_INTERVAL_MS;
  if (state.lastProbeAt !== undefined && now - state.lastProbeAt < interval) return null;
  const leaseMs = options?.leaseMs ?? TRANSIENT_PROBE_LEASE_MS;
  const leaseId = `tprobe-${(probeLeaseSeq += 1).toString(36)}`;
  const expiresAt = now + Math.max(1, leaseMs);
  state.generation += 1;
  state.leaseId = leaseId;
  state.leaseExpiresAt = expiresAt;
  state.lastProbeAt = now;
  state.pacedUntil = now + Math.max(0, interval);
  // After the grant, not before it: the entry this call just wrote holds a live lease and is
  // therefore the one entry the sweep may never touch, so the ceiling is a real ceiling
  // rather than "the ceiling plus whatever was inserted after the scan".
  sweepProbeStates(now);
  return {
    accountId,
    leaseId,
    generation: state.generation,
    expiresAt,
  };
}

/** Side-effect-free mirror of {@link tryAcquireTransientProbe} eligibility. */
export function canAcquireTransientProbe(
  accountId: string,
  now = Date.now(),
  options?: { minIntervalMs?: number },
): boolean {
  const state = probeStates.get(accountId);
  if (!state) return true;
  if (liveLease(state, now)) return false;
  const interval = options?.minIntervalMs ?? TRANSIENT_PROBE_INTERVAL_MS;
  return state.lastProbeAt === undefined || now - state.lastProbeAt >= interval;
}

/**
 * Report a probe's outcome. Only the current lease holder inside its deadline
 * applies: anything else is a late answer from a probe that already lost, and
 * dropping it is what keeps it from overwriting a newer binding or a newer
 * failure state. An applied settle clears the lease so the next probe is paced
 * by the interval, not by the expiry.
 */
export function settleTransientProbe(
  lease: TransientProbeLease,
  outcome: TransientProbeOutcome,
  now = Date.now(),
): TransientProbeSettle {
  const state = probeStates.get(lease.accountId);
  if (!state || state.leaseId !== lease.leaseId || state.generation !== lease.generation) {
    return "stale";
  }
  // `>=`, matching liveLease: at exactly the deadline the lease is already gone, so applying
  // the outcome there would let a probe act on a lease the grant path would refuse to
  // recognise -- two answers to the same instant.
  if (now >= lease.expiresAt) return "expired";
  state.leaseId = undefined;
  state.leaseExpiresAt = undefined;
  state.lastOutcome = outcome;
  return "applied";
}

/**
 * Hand a lease back with no outcome -- the probe never reached upstream, so
 * there is nothing to record. Only the holder may release; a stale lease is
 * already dead and needs no cleanup.
 */
export function releaseTransientProbe(lease: TransientProbeLease): void {
  const state = probeStates.get(lease.accountId);
  if (!state || state.leaseId !== lease.leaseId || state.generation !== lease.generation) return;
  state.leaseId = undefined;
  state.leaseExpiresAt = undefined;
}

/**
 * Fence the epoch against newer authoritative state. A fresh failure recorded
 * through the ordinary outcome path, or a binding that moved on, must not be
 * overwritten by a probe result that was issued before it -- bumping the epoch
 * makes every outstanding lease stale without waiting for its deadline.
 */
export function invalidateTransientProbe(accountId: string): void {
  const state = probeStates.get(accountId);
  if (!state) return;
  state.generation += 1;
  state.leaseId = undefined;
  state.leaseExpiresAt = undefined;
}

export interface TransientProbeDiagnostics {
  readonly held: boolean;
  readonly generation: number;
  readonly leaseId?: string;
  readonly leaseExpiresAt?: number;
  readonly lastProbeAt?: number;
  readonly lastOutcome?: TransientProbeOutcome;
}

/** Current lease state for one account, for diagnostics. Never mutates. */
export function transientProbeDiagnostics(accountId: string, now = Date.now()): TransientProbeDiagnostics {
  const state = probeStates.get(accountId);
  if (!state) return { held: false, generation: 0 };
  return {
    held: liveLease(state, now),
    generation: state.generation,
    ...(state.leaseId !== undefined ? { leaseId: state.leaseId, leaseExpiresAt: state.leaseExpiresAt } : {}),
    ...(state.lastProbeAt !== undefined ? { lastProbeAt: state.lastProbeAt } : {}),
    ...(state.lastOutcome !== undefined ? { lastOutcome: state.lastOutcome } : {}),
  };
}

/** Test seam: lease state is module-global and must not leak between cases. */
export function clearTransientProbeLeasesForTests(): void {
  probeStates.clear();
}

/**
 * How many accounts currently carry probe state. Diagnostic, and the assertion surface for
 * the {@link MAX_TRANSIENT_PROBE_STATES} bound.
 */
export function transientProbeStateCount(): number {
  return probeStates.size;
}

/**
 * What a request may do while its bound account is held.
 *
 * - `probe`: this caller holds the lease and may send ONE trial to the held
 *   account.
 * - `detour`: a probe is already out (or was refused); keep the remembered
 *   detour. The detour's identity survives the whole probing window -- a failed
 *   trial must not cost the caller its working route.
 * - `withheld`: every candidate is held. The binding is remembered and dispatch
 *   is refused; `retryAt` is the earliest moment a probe could next go out.
 *   Sending anyway here is exactly the "must not send, sends anyway" defect the
 *   hold was added to close.
 */
export type HeldAccountDispatch =
  | { kind: "probe"; lease: TransientProbeLease }
  | { kind: "detour"; accountId: string }
  | { kind: "withheld"; boundAccountId: string; detourAccountId?: string; retryAt: number };

/**
 * Decide what a request bound to a held account may do this turn. The probe is
 * tried first -- somebody has to find out whether the account is back, and the
 * lease guarantees it is exactly one somebody. Everyone else keeps the detour,
 * and a caller with no detour left is told to wait rather than sent at an
 * account already known to be failing.
 */
export function resolveHeldAccountDispatch(input: {
  boundAccountId: string;
  detourAccountId?: string;
  now?: number;
  leaseMs?: number;
  minProbeIntervalMs?: number;
  backpressure?: PoolBackpressureLimiter;
}): HeldAccountDispatch {
  const now = input.now ?? Date.now();
  const limiter = input.backpressure ?? sharedPoolBackpressure();
  // The lease check runs before the budget charge: a probe another holder already has out is
  // not a dispatch, and charging the pool for it would shrink the recovery budget by phantom
  // sends. Between the check and the grant there is no await, so eligibility cannot change.
  if (
    canAcquireTransientProbe(input.boundAccountId, now, {
      ...(input.minProbeIntervalMs !== undefined ? { minIntervalMs: input.minProbeIntervalMs } : {}),
    })
    && limiter.tryPermitProbeDispatch(now)
  ) {
    const lease = tryAcquireTransientProbe(input.boundAccountId, now, {
      ...(input.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
      ...(input.minProbeIntervalMs !== undefined ? { minIntervalMs: input.minProbeIntervalMs } : {}),
    });
    if (lease) return { kind: "probe", lease };
  }
  if (input.detourAccountId !== undefined && input.detourAccountId !== input.boundAccountId) {
    return { kind: "detour", accountId: input.detourAccountId };
  }
  return {
    kind: "withheld",
    boundAccountId: input.boundAccountId,
    ...(input.detourAccountId !== undefined ? { detourAccountId: input.detourAccountId } : {}),
    // Both bounds, not just the probe pacing. A request refused by the RATIO has no probe state
    // of its own yet, so `nextProbeAt` answered `now` and the refusal told the caller to try
    // again immediately -- a withheld dispatch that busy-loops is the same load as the dispatch
    // it refused. The limiter is the only thing that knows when its window moves.
    retryAt: Math.max(
      nextProbeAt(input.boundAccountId, now, input.minProbeIntervalMs),
      limiter.nextRecoveryAt(now),
    ),
  };
}

/** Earliest moment a probe of this account could next be granted. */
function nextProbeAt(accountId: string, now: number, minIntervalMs?: number): number {
  const state = probeStates.get(accountId);
  if (!state) return now;
  const interval = minIntervalMs ?? TRANSIENT_PROBE_INTERVAL_MS;
  const paced = state.lastProbeAt !== undefined ? state.lastProbeAt + interval : now;
  const leased = liveLease(state, now) ? state.leaseExpiresAt! : now;
  return Math.max(paced, leased);
}

/* ------------------------------------------------------------------ */
/* Pool-wide recovery backpressure                                     */
/* ------------------------------------------------------------------ */

export interface PoolBackpressurePolicy {
  /** Sliding window the ratio is measured over. */
  readonly windowMs: number;
  /**
   * Recovery dispatches (retries + probes) admitted per observed initial send.
   * 0.2 is the standard overload-guidance budget: at most one recovery send for
   * every five new requests.
   */
  readonly maxRetryRatio: number;
  /**
   * Floor under the ratio so a quiet pool can still recover: with almost no
   * traffic a strict ratio admits nothing, which would wedge every held
   * account behind a probe that can never run.
   */
  readonly minRecoveryAllowance: number;
}

export const DEFAULT_POOL_BACKPRESSURE_POLICY: PoolBackpressurePolicy = {
  windowMs: 10_000,
  maxRetryRatio: 0.2,
  minRecoveryAllowance: 3,
};

export interface PoolBackpressureState {
  readonly windowMs: number;
  readonly initialSends: number;
  readonly recoveryDispatches: number;
  /** Dispatches admitted under the current window's allowance. */
  readonly allowance: number;
  /** Lifetime refusals, including windows already rotated out. */
  readonly refusedTotal: number;
  readonly ratioLimit: number;
}

export interface PoolBackpressureLimiter {
  /** A new request's FIRST send. Always recorded, never refused. */
  recordInitialSend(now?: number): void;
  /** Admit one retry dispatch, or refuse when the window's ratio is spent. */
  tryPermitRetryDispatch(now?: number): boolean;
  /** Admit one probe dispatch under the same shared recovery budget. */
  tryPermitProbeDispatch(now?: number): boolean;
  /**
   * Earliest moment this limiter could admit another recovery dispatch.
   *
   * A refusal has to hand back a time, or the caller has nothing to wait on and busy-loops
   * against a pool that is already failing -- which is the load this limiter exists to remove.
   * `now` when the allowance is not spent; otherwise the moment the oldest bucket still inside
   * the window falls out of it, which is strictly in the future and is a real change point
   * rather than a guess.
   */
  nextRecoveryAt(now?: number): number;
  state(now?: number): PoolBackpressureState;
}

const BACKPRESSURE_BUCKETS = 10;

/**
 * Ratio limiter over a bucketed sliding window. Buckets give a sliding answer
 * without keeping per-event state: the window is the sum of the buckets whose
 * span falls inside it, and grant/refuse decisions read that sum.
 */
export function createPoolBackpressureLimiter(
  policy: PoolBackpressurePolicy = DEFAULT_POOL_BACKPRESSURE_POLICY,
): PoolBackpressureLimiter {
  const bucketMs = Math.max(1, Math.floor(policy.windowMs / BACKPRESSURE_BUCKETS));
  const buckets: Array<{ start: number; initials: number; recoveries: number }> = [];
  let refusedTotal = 0;

  function bucketFor(now: number): { start: number; initials: number; recoveries: number } {
    const start = Math.floor(now / bucketMs) * bucketMs;
    const last = buckets[buckets.length - 1];
    if (last && last.start === start) return last;
    while (buckets.length > 0 && buckets[0]!.start <= start - policy.windowMs) buckets.shift();
    const bucket = { start, initials: 0, recoveries: 0 };
    buckets.push(bucket);
    return bucket;
  }

  function totals(now: number): { initials: number; recoveries: number } {
    let initials = 0;
    let recoveries = 0;
    for (const bucket of buckets) {
      if (bucket.start <= now - policy.windowMs) continue;
      initials += bucket.initials;
      recoveries += bucket.recoveries;
    }
    return { initials, recoveries };
  }

  function allowanceFor(initials: number): number {
    return Math.max(policy.minRecoveryAllowance, Math.floor(initials * policy.maxRetryRatio));
  }

  function tryPermit(now: number): boolean {
    const bucket = bucketFor(now);
    const { initials, recoveries } = totals(now);
    if (recoveries + 1 > allowanceFor(initials)) {
      refusedTotal += 1;
      return false;
    }
    bucket.recoveries += 1;
    return true;
  }

  function nextRecoveryAt(now: number): number {
    const { initials, recoveries } = totals(now);
    if (recoveries + 1 <= allowanceFor(initials)) return now;
    // The window has to move before another recovery fits. The earliest that can happen is the
    // moment the oldest bucket still inside it leaves, and every such bucket started after
    // `now - windowMs`, so the answer is always strictly in the future.
    for (const bucket of buckets) {
      if (bucket.start <= now - policy.windowMs) continue;
      return bucket.start + policy.windowMs;
    }
    return now + policy.windowMs;
  }

  return {
    recordInitialSend(now = Date.now()): void {
      bucketFor(now).initials += 1;
    },
    tryPermitRetryDispatch(now = Date.now()): boolean {
      return tryPermit(now);
    },
    tryPermitProbeDispatch(now = Date.now()): boolean {
      return tryPermit(now);
    },
    nextRecoveryAt(now = Date.now()): number {
      return nextRecoveryAt(now);
    },
    state(now = Date.now()): PoolBackpressureState {
      const { initials, recoveries } = totals(now);
      return {
        windowMs: policy.windowMs,
        initialSends: initials,
        recoveryDispatches: recoveries,
        allowance: allowanceFor(initials),
        refusedTotal,
        ratioLimit: policy.maxRetryRatio,
      };
    },
  };
}

let sharedLimiter: PoolBackpressureLimiter | undefined;

/**
 * The process-wide limiter every recovery dispatch shares. A per-request
 * limiter cannot see the storm, which is the entire reason this layer exists.
 */
export function sharedPoolBackpressure(): PoolBackpressureLimiter {
  sharedLimiter ??= createPoolBackpressureLimiter();
  return sharedLimiter;
}

/**
 * Point the shared limiter at a different policy. The ceiling is deliberately
 * configurable here and not yet plumbed into OcxConfig -- the wiring lane owns
 * that seam; this is the knob it turns.
 */
export function configureSharedPoolBackpressure(policy: PoolBackpressurePolicy): void {
  sharedLimiter = createPoolBackpressureLimiter(policy);
}

/** Test seam: the shared limiter is module-global. */
export function resetSharedPoolBackpressureForTests(): void {
  sharedLimiter = undefined;
}

/**
 * Forget every account's probe pacing AND the shared recovery window.
 *
 * Called when the pool's routing state is reset wholesale -- a roster change, a config reload,
 * an account removal. Both halves describe a pool that no longer exists: pacing is keyed on
 * account ids that may be gone, and the window's buckets count sends made by a roster that
 * changed underneath them. Keeping either across such a reset lets one context's recovery
 * decisions govern the next one, which is also how it leaks between test files.
 *
 * This is the production reset. The two `ForTests` seams above stay separate because a test
 * frequently wants exactly one half of it.
 */
export function clearPoolRecoveryState(): void {
  probeStates.clear();
  sharedLimiter = undefined;
}

/**
 * What one physical send IS, as far as the recovery window is concerned.
 *
 * The window measures recovery traffic against observed demand, so it needs the distinction
 * made where the send happens -- and the transport wrapper cannot make it. That layer sees a
 * URL and an init; whether this is a conversation's first attempt, its third retry, or the one
 * trial admitted against a held account is knowledge only the caller has. So the caller names
 * it, and the classification lives here with the window rather than in the transport, which
 * owns no routing policy and has an enforced import boundary saying so.
 *
 * - `initial`: a new request's first send. Recorded, never refused -- it is the denominator,
 *   and refusing it would make this a throughput cap rather than a recovery bound.
 * - `retry`: a re-send of a request that already reached upstream once. Admitted only while
 *   recovery traffic stays under its ratio of observed demand.
 * - `probe`: the half-open trial against a held account. It ALREADY paid at selection, inside
 *   {@link resolveHeldAccountDispatch}; charging it again would bill one send twice and shrink
 *   the very budget it was admitted from.
 */
export type PoolRecoveryDispatchClass = "initial" | "retry" | "probe";

export interface PoolRecoveryDispatchDecision {
  readonly admitted: boolean;
  /**
   * Earliest moment another recovery dispatch could be admitted. `now` when the send was
   * admitted; otherwise a real change point strictly in the future, so a refused caller has
   * something to wait on instead of busy-looping against a pool that is already failing.
   */
  readonly retryAt: number;
}

/**
 * Admit one physical send against the process-wide recovery window.
 *
 * Per-request send budgets cannot see a storm: thousands of requests each staying inside their
 * own allowance still compose into an unbounded rate against one failing upstream. This is the
 * layer above them, and it is shared by construction.
 */
export function classifyPoolRecoveryDispatch(
  dispatchClass: PoolRecoveryDispatchClass,
  now = Date.now(),
  limiter: PoolBackpressureLimiter = sharedPoolBackpressure(),
): PoolRecoveryDispatchDecision {
  if (dispatchClass === "initial") {
    limiter.recordInitialSend(now);
    return { admitted: true, retryAt: now };
  }
  if (dispatchClass === "probe") return { admitted: true, retryAt: now };
  return limiter.tryPermitRetryDispatch(now)
    ? { admitted: true, retryAt: now }
    : { admitted: false, retryAt: limiter.nextRecoveryAt(now) };
}
