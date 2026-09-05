# wp2 — Detection core

Pure detection plus the durable store that makes "exactly once" true across restarts.
Nothing in this phase touches an existing call path; it closes with its own tests green.

## NEW `src/quota/reset-detector.ts`

Pure functions only: no imports from `config`, no clock of its own, no I/O. `now` is a
parameter so tests drive time instead of waiting for it.

```ts
/** One observed usage window, normalized away from provider-specific field names. */
export type QuotaWindowObservation = {
  /** Closed-union window identity. Custom provider windows arrive as "custom:<label>". */
  readonly window: string;
  /** 0-100 used percent, already normalized. Absent when upstream stopped reporting it. */
  readonly percent?: number;
  /** Epoch ms. Absent when upstream declares no clock, or declared a sentinel. */
  readonly resetAt?: number;
};

export type QuotaResetKind = "scheduled" | "surprise";

export type QuotaResetEvent = {
  readonly kind: QuotaResetKind;
  /** "codex" or a provider name. Never an account id. */
  readonly scope: string;
  /** Opaque, non-identifying account discriminator (see accountTag below). */
  readonly accountTag: string;
  readonly window: string;
  readonly percentBefore?: number;
  readonly percentAfter?: number;
  readonly previousResetAt?: number;
  readonly resetAt?: number;
  /** When WE noticed. Deliberately not "when the reset happened" — see 000_plan.md. */
  readonly detectedAt: number;
  /** Idempotence key: scope|accountTag|window|resetAtBucket. */
  readonly key: string;
};

/**
 * A drop smaller than this is rounding noise or a same-window correction, not a reset.
 * 5 points is deliberately coarse: upstream percents are integers and a genuine window
 * rollover drops by tens of points, so nothing real sits under this floor.
 */
export const MIN_SURPRISE_DROP_PERCENT = 5;

export function detectQuotaReset(input: {
  readonly scope: string;
  readonly accountTag: string;
  readonly previous: QuotaWindowObservation | undefined;
  readonly next: QuotaWindowObservation;
  readonly now: number;
}): QuotaResetEvent | null;
```

### Decision order (first match wins, and no-prev short-circuits before everything)

1. `previous === undefined` -> `null`. A first observation is a baseline. This single line is
   what stops trap 2 (writers do not hydrate), trap 3 (delete-then-readd), and trap 5
   (account switch) from manufacturing events.
2. Window identity differs -> `null` (caller error; defensive).
3. `previous.resetAt !== undefined && now >= previous.resetAt` and the percent did not
   rise -> `"scheduled"`. The window's own clock expired. A drop is not required: a window
   that rolls over while unused legitimately reports the same low percent, and the expired
   deadline is the evidence.
4. `previous.resetAt` still in the future, and either
   (a) `percentBefore - percentAfter >= MIN_SURPRISE_DROP_PERCENT`, or
   (b) `next.resetAt > previous.resetAt`
   -> `"surprise"`. Upstream moved the window before its own deadline.
5. Anything else -> `null`. Includes usage rising, sub-threshold noise, an unchanged
   snapshot, and a percent that vanished (upstream stopped reporting the window).

`resetAtBucket` is `String(next.resetAt ?? "none")`. Keying on the NEW deadline is what
makes repeated observation of the same post-reset state idempotent: every later poll of the
same window computes the same key.

### `accountTag`

Events must not carry account identity (privacy), yet must distinguish accounts (trap 5).
A short non-reversible digest of the account key serves both: stable within a process
lifetime and across restarts, meaningless outside. Derived with `Bun.hash` rendered as
base36, truncated to 8 chars. Not a secret and not reversible to an email.

## NEW `src/quota/reset-seen-store.ts`

```ts
/**
 * Atomically claim a reset key. Returns true for the FIRST caller only.
 *
 * One synchronous check-and-set, not a separate has/mark pair: a poller tick and a live
 * pooled response can observe the same transition concurrently, and two callers that both
 * read "unseen" would both notify. Synchronous because Bun runs one JS turn at a time, so
 * a function with no await inside is indivisible with respect to other observers.
 */
export function claimQuotaReset(key: string, at: number): boolean;
/** Read-only probe for tests and the operator surface. Never used to gate a notification. */
export function hasSeenQuotaReset(key: string): boolean;
/** Ring of recent events for the operator surface (wp4). Newest last. */
export function recordQuotaResetEvent(event: QuotaResetEvent): void;
export function listRecentQuotaResetEvents(limit?: number): QuotaResetEvent[];
export function resetQuotaResetStoreForTests(): void;
```

Persistence: `join(getConfigDir(), "quota-reset-state.json")`, version 1, written with
`atomicWriteFile` (mode 0600) under the same 250 ms trailing debounce as the codex quota
cache (`QUOTA_PERSIST_DEBOUNCE_MS` at `src/codex/quota.ts:43`; the scheduler itself is at
`:493`). Deliberately NOT `config.json`: this is high-frequency
job state, and `mutatePersistedConfig` fails closed when config came from anywhere but a
file. Hydration is lazy-once, mirroring `src/codex/quota.ts:473`, and a corrupt or
version-mismatched file is discarded rather than throwing — a broken cache must never break
quota refresh.

Bounds: 512 seen keys and 100 ring events, both FIFO. Pruning is age-based (90 days) and
skips any key whose `resetAt` is still in the future. A monthly window's key can
legitimately be older than a month while remaining current, so pruning on age alone would
drop a live key and let the same reset notify twice — which is the one thing this store
exists to prevent. The stored value is therefore `{ at, resetAt }`, not a bare timestamp.

When the 512-key bound is hit, eviction takes the oldest key whose `resetAt` has passed;
if every key is live the store refuses to grow and logs nothing. Silently evicting a live
key to honour a bound would trade a memory limit for a correctness bug.

## NEW `tests/quota-reset-detector.test.ts`

Drives the detector directly with fixture snapshots and a fixed `now`:

- scheduled rollover: prev 96% resetAt T, now T+1min, next 2% -> `kind === "scheduled"`
- scheduled with no drop: prev 3% resetAt T, now T+1min, next 3% -> `"scheduled"`
- surprise drop: prev 96% resetAt T+2h, now T, next 4% -> `kind === "surprise"`
- surprise deadline jump: prev resetAt T+2h, next resetAt T+9h, percent flat -> `"surprise"`
- usage increase 40% -> 65% -> `null`
- rounding noise 61% -> 58% inside an unexpired window -> `null` (below the 5-point floor)
- `previous === undefined` at 0% -> `null` (cold start / reauth / account switch)
- vanished percent -> `null`
- identical key for two observations of the same post-reset window
- `accountTag` differs for two account keys, and contains no "@"

## NEW `tests/quota-reset-seen-store.test.ts`

- `claimQuotaReset` returns true once and false on every repeat for the same key
- two claims interleaved without an await between them yield exactly one true
- a fresh hydration (store reset + reload from the same `OPENCODEX_HOME`) still reports
  the key seen — the restart proof for criterion c-4
- a corrupt file hydrates to empty without throwing
- ring keeps the newest 100 and drops the oldest
- a key older than 90 days whose `resetAt` has passed is pruned
- a key older than 90 days whose `resetAt` is still in the future is KEPT

## Accept criteria

`bun test tests/quota-reset-detector.test.ts tests/quota-reset-seen-store.test.ts` exits 0,
`bun x tsc --noEmit` exits 0, and no file outside `src/quota/` and `tests/` changed.
Activation evidence for wp2 is the scheduled and surprise assertions naming the returned
`kind` — the fired-path artifact C-ACTIVATION-GROUNDING-01 requires.
