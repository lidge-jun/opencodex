# 040 — WP4: poll consolidation + re-activation revalidation + measured tuning

Base: `codex/gui-hidden-pause` (WP3). Branch: `codex/gui-poll-consolidation`.
(Amended after audit round 1 — blockers #3/#11 folded in. Key design change:
cross-route freshness rides the session-cache seed path with a persisted
timestamp, NOT store survival — scheduleStoreEviction drops stores on route
change, so a store-level lastSettledAt alone could never fire on revisit.)
(Round 2: new-cache-wiring pages, module-level visibility listener, Startup
envelope migration, bucket lifecycle invariants folded in.)

Revert note (audit extra): this is the stack's top layer; rollback = drop this PR.
Nothing below it depends on it.

## Goal

Visible-tab overhead drops measurably against the 001/E0 baseline (48 req / 31s on
Dashboard; 9 concurrent 5s store timers), and returning to a previously visited tab
shows acceptably fresh data without manual refresh and without a skeleton flash
(S7). Every tuning decision is justified by a before/after measurement recorded in
this doc's D-phase addendum.

## File change map

- MODIFY `gui/src/client-resource.ts` — (a) module-level tick scheduler replacing
  per-store setInterval; (b) seed-freshness: `staleAfterMs` + `initialDataCachedAt`
  options, `lastSettledAt` on the store for in-page re-subscribes.
- MODIFY `gui/src/data-surface.ts` — `DataSurfaceOptions.staleAfterMs` /
  `initialDataCachedAt` pass-throughs (audit #3a: every target call site uses
  useDataSurface; without this the option literals fail typecheck).
- MODIFY `gui/src/session-list-cache.ts` — timestamped entry helpers (below).
- MODIFY seeding call sites (integrate entry helpers + staleAfterMs: 60_000):
  IntegrationsOverview.tsx:215-259, FileIntegrationPage.tsx:73/79, Combos.tsx:197,
  ApiKeys.tsx:175/181, ClaudeCode.tsx:83, ClaudeDesktop.tsx:211, Grok.tsx:93,
  Startup.tsx:206. NOTE (round 2): IntegrationsOverview and FileIntegrationPage have
  NO session-cache wiring today (verified by rg) — they GAIN write-on-success in
  their fetch callbacks + initialData/initialDataCachedAt seeding; this is new
  wiring, not migration. Startup's own envelope (StartupPageCache {data, warning,
  fix, tray}) carries no timestamp → migrate it to the entry envelope (siblings
  ride inside data). Product consequence recorded: Startup health already answers
  from a ~30s server-side cache (use-dashboard-data.ts:206-211), so
  staleAfterMs: 60_000 stacks to up to ~90s stale on revisit — accepted; revisit in
  the D addendum with the measurement.
- MODIFY `gui/src/pages/Logs.tsx` (:490) and `gui/src/pages/Debug.tsx` — interval
  tuning ONLY if the WP4 measurement shows they dominate; decision recorded in D.
- NEW `gui/tests/client-resource-scheduler.test.tsx`,
  NEW `gui/tests/client-resource-revalidate.test.tsx`,
  MODIFY `gui/tests/client-resource-poll.test.tsx` (cascade from per-store timer
  fields moving to buckets — expected stacked-PR churn, DEV-STACK-02).

## Change spec

### 1. Shared tick scheduler (client-resource.ts)

Before: one `setInterval` per polling store (9 live timers on Dashboard alone).
After: module-level scheduler —

    type Bucket = { timer: Timeout | null; stores: Set<Store<unknown>>; suspended: boolean };
    const pollBuckets = new Map<number, Bucket>();   // key = interval ms

`recomputePoll` registers/unregisters the store into its interval bucket instead of
owning a timer. The bucket's single timer iterates its stores and runs each store's
`pickPollEntry` per tick (per-store skip rules unchanged: in-flight skip, hidden
opt-out filter). WP3's suspend/resume moves to bucket granularity with the SAME two
guards (suspended buckets never re-arm on churn; a bucket created while hidden arms
nothing unless an opt-out store joins). Store-level `pollTimer`/`pollSuspended`
fields are removed; `scheduleStoreEviction` and `clearClientResourceStoresForTests`
updated to unregister from buckets.

Invariants kept: smallest subscriber interval wins per store; a store changes
buckets when its effective interval changes; per-listener pauseWhenHidden semantics
are evaluated per store inside the shared tick.

Bucket lifecycle (round 2): ONE module-level visibility listener iterates
`pollBuckets` (per-store listeners are removed with the per-store timers) — a
bucket created while hidden arms no timer but is still resumed by that listener.
Register/unregister/interval-change while a bucket is suspended update membership
only, never arm. An empty bucket is DELETED from pollBuckets (not merely
timer-cleared) — no slow leak of empty buckets; `clearClientResourceStoresForTests`
clears the map.

### 2. Re-activation freshness via the SEED path (audit #3 rewrite)

Route change unmounts the page → every store evicts (scheduleStoreEviction) →
revisit re-seeds from sessionStorage via `initialData`. So the freshness decision
belongs at seed time:

a) session-list-cache.ts gains:

    export type SessionListEntry<T> = { data: T; cachedAt: number | null };
    export function readSessionListCacheEntry<T>(key: string): SessionListEntry<T> | null;
    export function writeSessionListCacheEntry<T>(key: string, data: T): void;

Entry writes store `{ __ocxCachedAt: number, data }`; the entry reader accepts BOTH
the envelope and legacy raw values (cachedAt: null = unknown age = treat as stale →
quiet revalidate → self-healing migration, no broken caches).

b) ClientResourceOptions/DataSurfaceOptions gain:

    staleAfterMs?: number;          // opt-in; absent = today's always-revalidate seed semantics
    initialDataCachedAt?: number | null;   // age evidence for the seed

c) Seed path (seedClientResourceIfEmpty / setClientResourceData's seed branch):
when a seed lands with `initialDataCachedAt` and the (first) subscriber's
`staleAfterMs`: age < staleAfterMs → seed WITHOUT `seedNeedsRevalidate` (no
fetch on revisit at all); age ≥ → seed WITH `seedNeedsRevalidate` (existing quiet
revalidate on mount: seeded data stays visible, `refreshing` only — no skeleton
flash either way). First-subscriber-wins for staleAfterMs on shared keys (audit
#11; all opted-in sites here use disjoint keys).

d) Store `lastSettledAt` is still tracked (success settle + setClientResourceData)
and consulted in subscribeResource's 0→1 transition for stores that SURVIVED
(in-page enabled-gate re-subscribes): same staleAfterMs comparison, quiet
revalidate when stale.

### 3. Measured interval tuning (decision at this cycle's P re-verification)

Measure first (CDP, same protocol as 001/E0) with WP1-WP3 landed. Only if Logs
auto-refresh (2s, limit=2000) or Debug (1s+2s) dominate the visible-tab rate do
their defaults change; any change is a one-line constant + test update, recorded
with the measurement. No freshness-affecting change without the numbers.

## Tests

client-resource-scheduler.test.tsx:
1. N stores sharing an interval fire on one timer (advance happy-dom timers once,
   all N fetchers ran).
2. store interval change moves it between buckets; an empty bucket is removed from
   pollBuckets (bucket-count probe, not just timer-clear).
3. hidden suspends bucket timers; visible re-arms + per-store make-up (WP3 parity);
   churn while suspended arms nothing (WP3 audit #4 guard, bucket port).
4. per-store in-flight skip still applies inside a shared tick.
4b. mount-while-hidden in bucket form (WP3 test 9 ported): bucket created while
   hidden arms no timer; module-level listener still resumes it on visible with a
   make-up fetch.
client-resource-revalidate.test.tsx:
5. seed younger than staleAfterMs → NO fetch on subscribe (fresh seed).
6. seed older / legacy untimestamped cache → exactly one quiet revalidate; seeded
   data visible throughout (refreshing true, showSkeleton false via
   classifyDataSurface).
7. no staleAfterMs → today's always-revalidate seed behavior (regression guard).
8. surviving store re-subscribe younger than staleAfterMs → no refetch; older →
   one quiet refetch (lastSettledAt path).
session-list-cache entry tests (extend the existing cache test file if present,
else add cases to client-resource-revalidate.test.tsx):
9. entry write→read round-trip carries cachedAt; legacy raw value reads as
   cachedAt:null; round-trip the NEW IntegrationsOverview/FileIntegrationPage
   payload shapes and the migrated Startup envelope.

## Verifiers

- Focused new tests + client-resource suites + `cd gui && bun run build`
- Measurement: repeat 001/E0 (31s Dashboard dwell, CDP count) → before/after table
  in the D addendum.
- Browser revisit flow (matches the seed mechanism): open Integrations (seeds
  cache), switch to Dashboard, wait >60s, return → observe exactly one
  /api/client-integrations* request with the seeded content visible the whole time
  (no skeleton); repeat within 60s → zero requests.

## Out of scope (WP4)

Server-side endpoint merging, render-level memoization audits, virtualization
tuning, bundle-size work.

## D addendum — landed (2026-08-16/17)

Implementation: commit d6ea35ef0.

### Measurement (CDP, sandboxed instance on :5198, same protocol as 001/E0)

| Scenario | Before | After |
|---|---|---|
| Dashboard, 31s dwell, visible | 57 requests / 9 concurrent 5s timers | 57 requests / **1** shared 5s timer |
| Integrations revisit inside 60s | full refetch of 8 overview resources, skeletons on mount | **0 requests, 0 skeletons** |
| Hidden tab (any page) | WP3 guarantee | unchanged: zero timers, zero requests |

The visible-tab request count is deliberately unchanged: bucketing removes wakeups,
not cadence, and freshness (not volume) is what a live dashboard is for. The real
volume win is the revisit path — previously every tab hop re-fetched everything
because `scheduleStoreEviction` drops the store on route change.

### Interval tuning decision (§3)

No cadence changed. The measurement does not show Logs (2s) or Debug (1s+2s)
dominating: they are page-gated (`enabled: tab === "logs"` / `active`), so they
contribute nothing unless the user is looking at them, and both are now
visibility-paused and in-flight-guarded by WP3. Changing a freshness-affecting
default without the numbers supporting it would be exactly the kind of unforced
regression this section exists to prevent.

### Deviations from spec

- The spec assumed the Integrations pages would gain hand-written cache wiring.
  Ten resources across two files needed the identical seed+write pair, so
  `useDataSurface` gained an opt-in `sessionCacheKey` instead and the pages pass a
  key. Same mechanism, one implementation.
- `startVisibilityPoll` schedules through `window.setInterval` when available. The
  migrated pollers all used the window timer and their tests intercept it there;
  the bare global bound to a different scope and broke nine tests (found by running
  the full suite, fixed before commit).

### Verification

- `cd gui && bun test tests` → **922 pass / 0 fail** (157 files), exit 0.
- `bun run lint`, `bun run lint:i18n`, `bun run build` → all green.
- Browser: revisit flow measured above; dashboard poll wave unchanged and healthy.
