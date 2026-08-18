# 010 — WP1: client-resource request deadline + wedge recovery (H1)

Base: `dev`. Branch: `codex/gui-resource-deadline`. Depends on: nothing.

## Goal

No fetch on the client-resource data path may pend forever. Every attempt gets a
deadline; on expiry the store SETTLES as a failure (never sticks in
loading/refreshing), polled stores retry on the next tick automatically, cold
non-polled stores land in the existing `failed-cold` error surface instead of an
infinite skeleton.

## File change map

- MODIFY `gui/src/client-resource.ts` — deadline plumbing (below).
- MODIFY `gui/src/bounded-fetch.ts` — no API change; reused by client-resource.
  (Search evidence: `rg "AbortSignal.any|AbortSignal.timeout" gui/src` → bounded-fetch.ts
  is the existing owner of the timeout-compose pattern; MemoryObservabilityCard and
  use-add-codex-account-oauth already use it. Extending it beats a new helper.)
- NEW `gui/tests/client-resource-deadline.test.tsx` — regression tests.
- MODIFY `gui/tests/client-resource-poll.test.tsx` — only if a shared helper moves.

No server changes. No i18n changes (no new copy: failure states reuse the existing
data-surface error banners).

## Change spec

(Amended after audit round 1 — blockers 1/5/6/7/11 folded in. Key design change:
the deadline is a Promise.race inside runFetch, NOT bounded-fetch composition, so
it also bounds fetchers that drop the signal and cannot re-wedge via the
manual-fallback abort path.)

### 1. Options + constant (client-resource.ts)

Add to `ClientResourceOptions` (after `pauseWhenHidden`, actual line :352):

    /** Per-attempt deadline. Default DEFAULT_REQUEST_DEADLINE_MS. A timed-out attempt
     *  settles as a failure so a hung endpoint can never wedge the store (H1). */
    deadlineMs?: number;

Module level:

    /** Endpoints documented as slow finish in ~5s; 30s leaves generous headroom. */
    const DEFAULT_REQUEST_DEADLINE_MS = 30_000;
    /** Abort reason sentinel distinguishing the deadline from owner aborts. */
    const RESOURCE_TIMEOUT = "ocx-resource-deadline";

### 2. Per-listener options object (replaces positional sprawl — audit #11)

`subscribeResource` currently positional (key, fetcher, pollMs, onStoreChange,
pauseWhenHidden) becomes:

    type ListenerRegistration<T> = {
      fetcher: (signal: AbortSignal) => Promise<T>;
      pollMs?: number;
      pauseWhenHidden?: boolean;
      deadlineMs?: number;
    };
    subscribeResource(key, onStoreChange, registration: ListenerRegistration<T>)

The per-listener maps (pollByListener / pauseWhenHiddenByListener /
fetcherByListener) gain `deadlineByListener`; all are set/cleared together in
registration (~:304-308) and teardown (~:322-326). Where several subscribers share
one key with different values, first-registrant-wins is NOT the rule — the pickers
read the CHOSEN listener's value per fetch (existing per-listener semantics,
extended; see §6 for why shared keys still get uniform overrides).

### 3. Entry pickers carry the deadline

`pickPollEntry` / `pickFetcherEntry` return type gains
`deadlineMs: number | undefined` read from `deadlineByListener` for the chosen
listener.

### 4. runFetch: deadline via Promise.race + abort-reason sentinel (core change)

Before (~:208-260): `const controller = new AbortController(); store.inflight =
controller; await fetcher(controller.signal)` — no deadline; the settle guards read
`controller.signal.aborted`.

After:

    const controller = new AbortController();
    store.inflight = controller;
    const gen = ++store.generation;
    let timedOut = false;
    const deadlineMs = options?.deadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
    const timer = setTimeout(() => { timedOut = true; controller.abort(RESOURCE_TIMEOUT); }, deadlineMs);
    try {
      const data = await Promise.race([
        fetcher(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            if (timedOut) reject(new Error(`resource request timed out after ${deadlineMs}ms`));
            else resolve(null as never);   // owner abort frees the race frame immediately (round 2)
          }, { once: true });
        }),
      ]);
      ...existing success settle...
    } catch (error) {
      if (gen !== store.generation) return;
      if (controller.signal.aborted && !timedOut) return;   // owner abort: replace/unmount — unchanged
      ...existing failure settle (timeout lands here: error/loading:false/refreshing:false/lastAttemptOk:false)...
    } finally {
      clearTimeout(timer);
      ...existing inflight clear + emit...
    }

Why race instead of bounded-fetch composition (audit #1 + #5):
- The manual fallback of createBoundedFetch aborts the SAME controller the guards
  read, so a timeout would early-return and never settle (re-wedge). The
  `timedOut` flag + reason sentinel make timeout and owner-abort distinguishable on
  every runtime, no AbortSignal.any dependency.
- Fetchers that drop the signal (Subagents.tsx:117) cannot be aborted — but the
  race still settles the store failed at the deadline; the orphaned fetch is
  discarded by the generation guard when it eventually lands.

### 5. Callers plumb the deadline — COMPLETE list (audit #7)

- subscribeResource cold-start fetch (:313-316) — the registering listener's value.
- poll tick (interval callback, :169-174) — entry.deadlineMs from pickPollEntry.
- visibility make-up fetch (:185-204) — entry.deadlineMs from pickFetcherEntry.
- unsubscribe-replacement fetch (:336) — entry.deadlineMs from pickFetcherEntry.
- `refresh()` (:411-418) — the refreshing listener's own deadlineMs (read via
  listenerRef from deadlineByListener, not a frozen option).
- `useClientResource` passes options.deadlineMs into the registration and includes
  it in the subscribe useCallback deps; `useDataSurface` gains the
  `DataSurfaceOptions.deadlineMs` pass-through (data-surface.ts:39-48).

### 6. Known-slow overrides — at ALL subscribers of shared keys (audit #6)

`pickFetcherEntry` picks the first registered listener, so an override on one
subscriber of a shared key is mount-order-dependent. Set `deadlineMs: 60_000` at
EVERY subscriber of `usage-summary-30d:<base>:all`:
use-dashboard-data.ts:~268, Providers.tsx:~114, AddProviderModal.tsx:~83,
ProviderWorkspaceShell.tsx:~178. And `deadlineMs: 60_000` at the Models catalog
resource (Models.tsx useDataSurface at :379; live discovery documented slow at
:406-408). Everything else takes the 30s default.

### 7. Signal-drop audit (audit #5)

`rg "fetch(" gui/src/pages gui/src/components gui/src/hooks` cross-checked against
client-resource loader functions; every loader must pass the signal. Confirmed
offender today: Subagents.tsx:117 → thread `signal` into its fetch (same line). Any
further offenders found in B are fixed in the same commit and listed in D.

## Behavior after

| Scenario | Before | After |
|---|---|---|
| Hung endpoint, polled store | skeleton/spinner forever, ticks skip (E1) | settles failed ≤ deadline; next tick retries; self-heals |
| Hung endpoint, cold non-polled store | infinite skeleton (E3) | `failed-cold` error surface with the page's retry affordance |
| Slow-but-healthy endpoint (< deadline) | eventually succeeds | unchanged |
| Unmount/replace mid-flight | abort, no settle | unchanged (abort path untouched) |
| Signal-dropping loader (Subagents) | wedge even with deadline | race settles the store; orphan discarded by generation guard |

Accepted terminal state (audit extra): a MOUNTED non-polled store that settles
failed does not auto-refetch when the network heals (no poll tick) — the user
retries via the surface's existing refresh control (Storage.tsx:1410 renders it on
showError). Auto-heal on re-activation is WP4's staleAfterMs, not WP1.

## Tests (NEW gui/tests/client-resource-deadline.test.tsx)

Harness: copy the happy-dom Window + act() + waitFor pattern from
client-resource-poll.test.tsx (globals swap, clearClientResourceStoresForTests).

1. `never-settling fetcher settles failed within the deadline` — fetcher returns a
   promise that never resolves, deadlineMs: 50; waitFor snapshot.lastAttemptOk ===
   false && error instanceof Error && loading === false && refreshing === false.
2. `polled store self-heals after a timed-out attempt` — attempt 1 never settles,
   attempts 2+ resolve "ok"; pollMs: 40, deadlineMs: 50; waitFor data === "ok"
   with zero manual refresh calls. Assert fetcher call count >= 2.
3. `timed-out cold store shows the error surface, not a skeleton` — drive
   classifyDataSurface on the settled snapshot: kind === "failed-cold",
   showSkeleton false, showError true.
4. `unmount during the deadline window still takes the abort path` — mount with a
   never-settling fetcher, unmount before deadline, assert no failure settle
   stomps a remounted subscriber (abort semantics regression guard).
5. `manual refresh after timeout recovers immediately` — after (1), call refresh()
   with a resolving fetcher; waitFor data.
6. `signal-dropping fetcher is bounded by the race` (audit #5) — fetcher that
   never resolves AND ignores the signal still settles failed at the deadline.
7. `owner abort after the deadline fired cannot masquerade as failure` (audit #1
   guard semantics) — deadline fires, then a replace/unmount abort lands before the
   rejection propagates: exactly one settle, and it is the timeout failure; a
   subsequent owner-abort of a HEALTHY in-flight request never settles failed.

Activation scenarios (C-ACTIVATION-GROUNDING-01): the deadline path is the new
conditional branch — tests 1/2/3 trigger it for real with a never-settling fetcher
and observe the settle; the live browser check repeats 001/E1 and observes
recovery without reload.

## Verifiers

- `cd gui && bun test tests/client-resource-deadline.test.tsx tests/client-resource-poll.test.tsx tests/data-surface.test.tsx`
- `cd gui && bun run build`
- Browser: repeat 001 E1 (stall /api/settings): the affected card must reach an
  error/settled state ≤ 30s and resume polling; no permanent skeleton.

## Out of scope (WP1)

Auth-path deadline (WP2), visibility clearing (WP3), interval consolidation (WP4),
fetcher-resolves-undefined normalization (S5 — noted, no live offender).

## D addendum — landed (2026-08-16)

Implementation: commits 0e5194cff (all §1-§7 changes + tests) and c704eecf5
(indent nit from the implementation review).

Verification evidence:
- `cd gui && bun test tests/client-resource-deadline.test.tsx` → 7 pass / 0 fail;
  combined with client-resource-poll, data-surface, page-loading-contract,
  storage-loading-race, startup-usage-loading-race, startup-revisit-cache,
  models-*, providers/add-provider/subagents suites → 70 pass / 0 fail total.
- `cd gui && bun run build` → green (tsc -b + vite).
- Browser E1 re-run (CDP stall on /api/settings): under the old code the wedged
  store produced ZERO retries; with the deadline the store settles and retries on
  a measured 35s cycle (request timestamps: +34.96s, +35.0s = 30s deadline + 5s
  poll tick), and a reload showed the full healthy 5s poll wave.
- Implementation audit: binding review round r2 (explorer subagent) — PASS, no
  High/Critical; accepted Low: usage-summary:codex keeps the 30s default (single
  subscriber, still bounded).

Deviation from spec: none in mechanism. The race's abort-listener else-resolve
(round-2 audit addition) is what frees owner-aborted frames for signal-dropping
fetchers; confirmed covered by test 4's unmount path.
