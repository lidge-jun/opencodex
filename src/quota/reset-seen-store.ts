/**
 * Durable "already notified" ledger plus a bounded ring of recent reset events.
 *
 * Exactly-once has to hold across a restart, because the whole point of a surprise reset is
 * that it happens while nobody is watching. An in-memory set would re-notify every reset
 * whose window is still open the next time the proxy starts.
 *
 * Deliberately NOT stored in config.json: this is high-frequency job state, and
 * mutatePersistedConfig fails closed when the config did not come from a file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Imported from the definition sites, NOT the ../config barrel. The barrel pulls 154 modules
// (~430 KB) including combos, account-store, pool-rotation and cursor discovery; these two
// cost 8. This store is reached from the once-per-pooled-response observation path, so the
// barrel would work directly against the boundary guard wp5 adds.
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import type { QuotaResetEvent, QuotaWindowObservation } from "./reset-detector";

const STATE_FILENAME = "quota-reset-state.json";
const PERSIST_DEBOUNCE_MS = 250;
/**
 * Longest a pending write may be deferred by continued activity. See schedulePersist.
 */
const MAX_PERSIST_DEFERRAL_MS = 1_000;

/**
 * Age floor for pruning a claimed key.
 *
 * 90 days, not 30: a monthly window's key is legitimately older than a month while still
 * current, and pruning it would let the same reset notify twice.
 */
const CLAIM_MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const MAX_CLAIMS = 512;
/**
 * Hard ceiling for the claim map.
 *
 * MAX_CLAIMS is the soft budget, honoured by evicting settled claims. When every claim is
 * still live there is nothing safe to evict, so without a hard stop the map — and the JSON
 * rewritten beside it — grows without limit. At this ceiling we evict the furthest-future
 * deadline and accept one theoretical duplicate, which is strictly better than unbounded growth.
 */
const HARD_MAX_CLAIMS = 2 * MAX_CLAIMS;
const MAX_RING_EVENTS = 100;
/** One row per (scope, accountTag). A large pool plus several providers stays well inside this. */
const MAX_OBSERVED_SCOPES = 64;

type ClaimRecord = {
  /** When the claim was made. */
  at: number;
  /** The window deadline this claim belongs to; a future value means the claim is live. */
  resetAt?: number;
};

type StateFile = {
  version: 1;
  claims: Record<string, ClaimRecord>;
  events: QuotaResetEvent[];
  /** Last observed windows per "scope\u0000accountTag". Absent in files written before this field. */
  observed?: Record<string, QuotaWindowObservation[]>;
  /** Per-install salt for account tagging. Created once, then stable. */
  accountSalt?: string;
};

const claims = new Map<string, ClaimRecord>();
let ring: QuotaResetEvent[] = [];
const observed = new Map<string, QuotaWindowObservation[]>();
let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** When the currently pending debounced write was FIRST scheduled, or null if none is pending. */
let firstDeferredPersistAt: number | null = null;
let accountSalt: string | null = null;

function statePath(): string {
  return join(getConfigDir(), STATE_FILENAME);
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const path = statePath();
    if (!existsSync(path)) return;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StateFile;
    if (!parsed || parsed.version !== 1) return;
    if (parsed.claims && typeof parsed.claims === "object") {
      for (const [key, record] of Object.entries(parsed.claims)) {
        if (!record || typeof record.at !== "number") continue;
        claims.set(key, {
          at: record.at,
          ...(typeof record.resetAt === "number" ? { resetAt: record.resetAt } : {}),
        });
      }
    }
    if (Array.isArray(parsed.events)) ring = parsed.events.slice(-MAX_RING_EVENTS);
    if (parsed.observed && typeof parsed.observed === "object") {
      for (const [key, windows] of Object.entries(parsed.observed)) {
        if (Array.isArray(windows)) observed.set(key, windows);
      }
    }
    if (typeof parsed.accountSalt === "string" && parsed.accountSalt.length >= 16) {
      accountSalt = parsed.accountSalt;
    }
  } catch {
    // A corrupt or partially written cache must never break a quota refresh. Starting empty
    // risks one duplicate notification; throwing here would break the write that triggered us.
    claims.clear();
    ring = [];
    observed.clear();
  }
}

/**
 * Per-install salt, created on first use and persisted.
 *
 * Without it an account tag is a bare unkeyed hash of an email — brute-forceable in tens of
 * guesses, which turns the webhook payload into an account-identity oracle for whoever
 * receives it. Salted, the tag stays stable for this install (so the persisted idempotence
 * key still works across restarts) and is unlinkable to anyone without the salt.
 */
export function quotaResetAccountSalt(): string {
  hydrate();
  if (accountSalt) return accountSalt;
  accountSalt = crypto.randomUUID().replaceAll("-", "");
  persistNow();
  return accountSalt;
}

function stateFileBody(): StateFile {
  return {
    version: 1,
    claims: Object.fromEntries(claims),
    events: ring,
    observed: Object.fromEntries(observed),
    ...(accountSalt !== null ? { accountSalt } : {}),
  };
}

/**
 * Write immediately, for anything whose loss breaks correctness.
 *
 * A claim MUST NOT ride the debounce: the timer is unref'd, so a process exiting within
 * 250 ms of claiming — the common case when detection runs on the last pooled request before
 * shutdown — never writes it, and the next start re-notifies. That is precisely the
 * across-a-restart guarantee this store exists for, and a shutdown hook would not cover SIGKILL.
 *
 * Returns whether the write actually landed. The error is still swallowed rather than thrown —
 * a quota observation must not fail on a full disk — but a caller that treats success as
 * "durably claimed" needs to be told the difference.
 */
function persistNow(): boolean {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  firstDeferredPersistAt = null;
  try {
    atomicWriteFile(statePath(), `${JSON.stringify(stateFileBody())}\n`);
    return true;
  } catch {
    // Best-effort persistence only.
    return false;
  }
}

/**
 * Debounce with a MAXIMUM STALENESS cap.
 *
 * A plain re-arming debounce is starvable: it clears and re-sets the timer on every
 * observation, so any write cadence faster than the debounce pushes the deadline out forever.
 * Measured on the unfixed version: 75 observations at 40 ms intervals produced ZERO disk writes,
 * and 200 at 10 ms also produced zero. A busy pooled install that is then SIGKILLed (container
 * stop, OOM) loses its entire baseline and re-baselines on restart, silently missing any reset
 * that spans the gap — which defeats the across-a-restart guarantee this store exists for.
 *
 * So the deferral is bounded: once a write has been pending for MAX_PERSIST_DEFERRAL_MS, the
 * next call writes immediately instead of deferring again. At 0.29 ms per serialize-and-write,
 * a forced write every second under sustained load costs nothing measurable.
 *
 * Claims deliberately do NOT use this path — they write synchronously, because an unref'd timer
 * cannot be trusted to fire before process exit.
 */
function schedulePersist(): void {
  const now = Date.now();
  if (firstDeferredPersistAt === null) firstDeferredPersistAt = now;
  else if (now - firstDeferredPersistAt >= MAX_PERSIST_DEFERRAL_MS) {
    // persistNow clears the timer and resets the window below.
    persistNow();
    return;
  }
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    firstDeferredPersistAt = null;
    try {
      atomicWriteFile(statePath(), `${JSON.stringify(stateFileBody())}\n`);
    } catch {
      // Best-effort persistence, matching the codex quota cache.
    }
  }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/**
 * Drop claims that are both old and settled. A live deadline is never pruned.
 *
 * `now` comes from the wall clock, not from the caller's `at`: a backdated or clock-skewed
 * claim must not change the retention of unrelated keys.
 */
function prune(now = Date.now()): void {
  for (const [key, record] of claims) {
    // A claim with no deadline is UNKNOWN, not settled. Clockless windows are the common case
    // for credit-balance providers, so treating them as settled would make them the first
    // thing evicted. They still age out below, just without that preference.
    if (record.resetAt === undefined || record.resetAt > now) continue;
    if (now - record.at <= CLAIM_MAX_AGE_MS) continue;
    claims.delete(key);
  }
  for (const [key, record] of claims) {
    if (record.resetAt !== undefined) continue;
    if (now - record.at <= CLAIM_MAX_AGE_MS) continue;
    claims.delete(key);
  }
  if (claims.size <= MAX_CLAIMS) return;
  // Over budget: evict the oldest SETTLED claims only. Evicting a live one would trade a
  // memory bound for a duplicate notification, which is the bug this store prevents.
  const settled = [...claims.entries()]
    .filter(([, record]) => record.resetAt === undefined || record.resetAt <= now)
    .sort((left, right) => left[1].at - right[1].at);
  for (const [key] of settled) {
    if (claims.size <= MAX_CLAIMS) break;
    claims.delete(key);
  }
  if (claims.size <= HARD_MAX_CLAIMS) return;
  // Every remaining claim is live. Evict the furthest-future deadlines first: least likely to
  // be re-observed soon, so a duplicate there is least disruptive.
  const live = [...claims.entries()].sort(
    (left, right) => (right[1].resetAt ?? 0) - (left[1].resetAt ?? 0),
  );
  for (const [key] of live) {
    if (claims.size <= HARD_MAX_CLAIMS) break;
    claims.delete(key);
  }
}

/**
 * Atomically claim a reset key. Returns true for the FIRST caller only.
 *
 * One synchronous check-and-set rather than a separate has/mark pair: a poller tick and a
 * live pooled response can observe the same transition, and two callers that both read
 * "unseen" would both notify. There is no await inside, so with Bun's single-threaded turn
 * semantics this is indivisible with respect to other observers.
 */
export function claimQuotaReset(key: string, at: number, resetAt?: number): boolean {
  hydrate();
  if (claims.has(key)) return false;
  claims.set(key, { at, ...(resetAt !== undefined ? { resetAt } : {}) });
  prune();
  // prune() can evict the claim just added — an already-past deadline older than
  // CLAIM_MAX_AGE_MS qualifies — and an evicted claim is not a claim.
  if (!claims.has(key)) return false;
  // Synchronous: a lost claim means a duplicate notification after restart, and claims are
  // rare (one per real reset), so the write cost is irrelevant.
  // A failed write is reported rather than swallowed: the caller reads true as "safe to
  // dispatch", and an unpersisted claim re-notifies on the next start.
  return persistNow();
}

/** Read-only probe. Never used to gate a notification — see claimQuotaReset. */
export function hasSeenQuotaReset(key: string): boolean {
  hydrate();
  return claims.has(key);
}

export function recordQuotaResetEvent(event: QuotaResetEvent): void {
  hydrate();
  ring.push(event);
  if (ring.length > MAX_RING_EVENTS) ring = ring.slice(-MAX_RING_EVENTS);
  schedulePersist();
}

/** Recent events, newest first. */
export function listRecentQuotaResetEvents(limit = MAX_RING_EVENTS): QuotaResetEvent[] {
  hydrate();
  const bounded = Math.max(1, Math.min(limit, MAX_RING_EVENTS));
  return [...ring].reverse().slice(0, bounded);
}

function observedKey(scope: string, accountTag: string): string {
  return `${scope}\u0000${accountTag}`;
}

/**
 * Store the newly observed windows for one (scope, accountTag) and return what was there
 * before, or undefined on the first ever observation.
 *
 * The detector owns this map rather than borrowing a caller's previous value, because
 * neither upstream cache can supply one reliably. The provider report cache keys itself on a
 * digest that INCLUDES quota values and updatedAt (src/providers/quota.ts:193 via :155), so
 * its `previous` is empty precisely when a reset happened; and it is process-memory only, so
 * it has no answer at all after a restart. This map is keyed by identity and persisted.
 */
export function swapLastObservedWindows(
  scope: string,
  accountTag: string,
  windows: ReadonlyArray<QuotaWindowObservation>,
): ReadonlyArray<QuotaWindowObservation> | undefined {
  hydrate();
  const key = observedKey(scope, accountTag);
  const previous = observed.get(key);
  // Delete before set so the row moves to the END of the insertion order, making this a
  // true LRU. Re-setting an existing key does NOT move it in a Map, so without the delete
  // the eviction below removed the EARLIEST-INSERTED row — which on a real install is the
  // long-lived codex account observed on every response, while 63 transient rows survived.
  // Measured: the hottest scope was evicted and its next genuine scheduled reset was
  // silently missed, because a re-baselined row has no previous value to diff against.
  observed.delete(key);
  observed.set(key, windows.map(window => ({ ...window })));
  if (observed.size > MAX_OBSERVED_SCOPES) {
    // Least-recently-observed first. Evicting only costs a re-baseline, never a duplicate
    // notification, because the claim ledger is separate — but a re-baseline DOES cost the
    // next reset on that row, which is why picking the genuinely abandoned row matters.
    const oldest = observed.keys().next();
    if (!oldest.done && oldest.value !== key) observed.delete(oldest.value);
  }
  schedulePersist();
  return previous;
}

/**
 * Forget the baseline for one (scope, accountTag), or for every scope when no tag is given.
 *
 * Called when a quota row is deliberately cleared — reauth, sign-out, account removal. The
 * quota row and this baseline live in different files, so clearing only the former left the
 * observer holding the pre-clear percentages: the first fresh write after a reauth of a used
 * account then read as a surprise reset (measured 91% -> 0%). The existing regression test
 * missed it because it also called resetQuotaResetStoreForTests(), which real reauth does
 * not do — the test simulated something that never happens.
 *
 * Deliberately does NOT touch the claim ledger. A cleared row must not re-notify a reset it
 * already reported, and claims are what prevent that.
 */
export function forgetLastObservedWindows(scope: string, accountTag?: string): void {
  hydrate();
  if (accountTag !== undefined) {
    if (!observed.delete(observedKey(scope, accountTag))) return;
    schedulePersist();
    return;
  }
  // No tag: the caller cleared everything for this scope. The account tag is a salted hash,
  // so it cannot be reversed — matching on the scope prefix is the only available form.
  const prefix = `${scope}\u0000`;
  let removed = false;
  for (const key of [...observed.keys()]) {
    if (key.startsWith(prefix)) removed = observed.delete(key) || removed;
  }
  if (removed) schedulePersist();
}

/** Test-only: forget in-memory state so the next call re-reads OPENCODEX_HOME. */
export function resetQuotaResetStoreForTests(): void {
  claims.clear();
  ring = [];
  observed.clear();
  hydrated = false;
  accountSalt = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  firstDeferredPersistAt = null;
}

/** Test-only: flush the debounced write immediately. */
export function flushQuotaResetStoreForTests(): void {
  persistNow();
}

/** Test-only: claim-map size, for asserting retention bounds. Exposes no keys. */
export function claimCountForTests(): number {
  hydrate();
  return claims.size;
}
