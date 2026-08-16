# 030 — WP3: hidden tab ≈ zero cost

Base: `codex/gui-auth-unwedge` (WP2). Branch: `codex/gui-hidden-pause`.
(Amended after audit round 1 — blockers #4/#8/#9 folded in.)
(Round 2: pollSuspended teardown-clear + listener-installation rule folded in.)

## Goal

While `document.visibilityState === "hidden"` the dashboard does (a) zero network
requests and (b) zero interval wakeups, except explicit opt-outs whose purpose is
off-screen detection (restart-reconnect). On return: one make-up refresh per
resource, then normal cadence. Measured target: CDP request count over 30s hidden
== only opt-out endpoints (today: raw pollers keep firing; client-resource timers
keep waking even when every tick is skipped).

## File change map

- MODIFY `gui/src/client-resource.ts` — suspend/resume poll timers on visibility.
- NEW `gui/src/visibility-poll.ts` — shared visibility-aware interval helper.
  Search evidence: `rg "setInterval" gui/src` → 9 raw pollers each hand-roll
  setInterval/clearInterval; no shared helper exists (`rg -l "visibilitychange"
  gui/src` → only client-resource.ts). One new tiny module replaces nine copies of
  the pattern; no existing owner to extend.
- MODIFY the raw pollers (migration, all mechanical):
  `gui/src/pages/Debug.tsx` (:157, + in-flight guard + signal at :115),
  `gui/src/components/provider-workspace/ProviderSettings.tsx` (:162, + signal/bounded at :156),
  `gui/src/pages/CodexAuth.tsx` (:154, + signal at :123),
  `gui/src/components/CodexAccountPickerSetting.tsx` (:42, + signal at :24),
  `gui/src/components/DefaultModeRequestUserInputSetting.tsx` (:47, + signal at :32),
  `gui/src/pages/Models.tsx` (:413 loadV2 loop, + signal at :298),
  `gui/src/hooks/useCodexAccountPool.ts` (:342 interval, + signals at :222/:250),
  `gui/src/components/use-add-codex-account-oauth.ts` (:177 OAuth login-status 2s →
  migrate to the helper; signal/bound/guard already exist so it is mechanical —
  audit #9; a hidden tab cannot complete OAuth and the visible make-up tick checks
  status immediately on return),
  `gui/src/components/MemoryObservabilityCard.tsx` (:277 memory 5s poll → pause when hidden;
  :342 reconnect loop stays visible-agnostic, documented below).
- NEW `gui/tests/visibility-poll.test.ts`.
- MODIFY `gui/tests/client-resource-poll.test.tsx` — extend the existing hidden-skip
  tests (fetch count frozen while hidden; churn + mount-hidden guards; make-up on
  visible), reusing its setVisibility helper (:64-74).

## Change spec

### 1. client-resource: real suspension (not just skipped ticks)

Store gains `pollSuspended: boolean`. NEW `suspendPollTimer(store)` clears ONLY
the timer and sets the flag — unlike `clearPollTimer` it KEEPS
`store.pollIntervalMs`, because clearing it would let hidden-phase subscriber churn
(StrictMode, tab mounts) re-arm a fresh interval through recomputePoll's
changed-interval path (audit #4).

`ensureVisibilityListener`'s handler becomes bidirectional:

    const onVisibility = () => {
      if (store.pollIntervalMs === undefined) return;
      if (documentIsHidden()) {
        if (anyOptOut(store)) return;          // opt-out polls keep their timer
        suspendPollTimer(store);               // interval gone: zero wakeups
        return;
      }
      if (store.pollSuspended) {
        store.pollSuspended = false;
        recomputePoll(store);                  // re-arms: pollIntervalMs intact
      }
      const entry = pickFetcherEntry(store);   // existing make-up fetch (+ entry.deadlineMs, WP1)
      if (entry) void runFetch(store, entry.fetcher, { replaceInflight: false, owner: entry.owner, deadlineMs: entry.deadlineMs });
    };

`anyOptOut(store)`: true when any polling listener has
`pauseWhenHiddenByListener.get(listener) === false` (the update-job restart poll,
use-dashboard-data.ts:440, keeps its 1.5s cadence while hidden — its whole purpose
is noticing the restarted server; it self-terminates with the job).

`recomputePoll` two guards (audit #4/#8):
- While `store.pollSuspended`: recompute bookkeeping (`pollIntervalMs` may change
  with churn) but NEVER arm a timer.
- At arm time: if `documentIsHidden() && !anyOptOut(store)`, set
  `pollSuspended` instead of arming — a store first subscribed while the tab is
  already hidden must not create a live timer (audit #8).

Two teardown rules (round 2):
- `recomputePoll`'s `pollMs === undefined` branch AND `scheduleStoreEviction` both
  reset `pollSuspended = false`. Otherwise a store whose last poller leaves while
  hidden keeps the flag with the visibility listener gone, and the next polling
  subscriber hits the never-arm guard with nothing left to resume it — the store
  would never poll again.
- `ensureVisibilityListener` is installed whenever a polling subscriber exists,
  REGARDLESS of whether a timer was armed — a mount-while-hidden store has no timer
  but MUST still hold the listener, or its resume/make-up path never fires.

### 2. NEW gui/src/visibility-poll.ts

    export type VisibilityPollOptions = {
      /** Default true: hidden tabs neither tick nor hold a timer. */
      pauseWhenHidden?: boolean;
      /** Fire once on start. Default false (existing pollers keep their first-run code). */
      immediate?: boolean;
    };
    /** Returns stop(). Interval exists only while visible (unless opted out);
     *  visible-again fires one make-up tick immediately, then resumes the cadence. */
    export function startVisibilityPoll(callback: () => void, intervalMs: number, options?: VisibilityPollOptions): () => void;

Implementation: one `visibilitychange` listener per active poll; hidden →
clearInterval; visible → callback() + setInterval. SSR/test-safe
(`typeof document === "undefined"` → plain interval). Callback errors remain the
caller's concern (all migrated callbacks catch or are made to).

### 3. Raw-poller migrations (mechanical, per site)

Pattern per file: delete `setInterval`/`clearInterval` pairs; the effect returns
`startVisibilityPoll(tick, MS)`. Each tick gains, where missing:
- an in-flight guard (ProviderSettings, Debug: skip while the previous tick pends —
  Debug's unguarded 1s poll is explorer finding S6),
- the AbortSignal threaded into fetch (all sites marked NO in 002),
- `createBoundedFetch` for the 2s/1s hot pollers (ProviderSettings 10s bound,
  Debug 10s bound).

MemoryObservabilityCard: the 5s memory poll pauses when hidden (nobody reads the
paint); the 1.5s reconnect loop is LEFT running while hidden — it exists to flip the
restart banner the moment the server answers, it is bounded (5s fetch, 120s
give-up), and it only runs while a restart is actually in progress. Decision
recorded; no code change beyond a comment.

## Behavior after

| Scenario | Before | After |
|---|---|---|
| Tab hidden 10 min on Dashboard | 9 store timers wake ~1.5/s skipping ticks + raw pollers fire for real | zero timers, zero requests |
| Tab visible again | next tick whenever it lands | immediate make-up fetch per resource, then cadence |
| Restart update job while hidden | 1.5s poll keeps running | unchanged (opt-out) |
| Debug tab hidden | 1s + 2s fetches continue, hung ones stack | zero; guarded + bounded on return |
| Mount while already hidden | timer arms, ticks skipped | no timer; make-up on visible |

## Tests

visibility-poll.test.ts (happy-dom, setVisibility pattern from
client-resource-poll.test.tsx:64-74):
1. ticks on cadence while visible; 2. hidden → zero calls across 5 intervals;
3. visible → exactly one immediate make-up call then cadence resumes;
4. pauseWhenHidden:false keeps ticking while hidden; 5. stop() removes the listener
   and timer while hidden (no zombie wakeup).
client-resource-poll.test.tsx additions:
6. polled store: hidden → fetch count frozen (not just skipped-tick), visible →
   one make-up fetch + cadence resumes (extends the existing pauseWhenHidden tests);
7. opt-out subscriber present → store keeps polling while hidden (mixed subscriber
   case, per-listener semantics preserved);
8. subscriber churn while hidden (unmount one of two subscribers) must NOT re-arm
   a timer (audit #4);
9. first subscribe while already hidden arms no timer and still fires the make-up
   fetch on visible (audit #8).
10. last polling subscriber leaves WHILE hidden → a later polling subscriber must
    resume correctly: make-up fetch on visible, timer armed (round-2 blocker —
    pollSuspended teardown-clear).

Activation scenarios: tests 2/3/6/8/9 trigger the suspend/resume/guard branches
for real; browser check = hidden-tab request count (see below).

## Verifiers

- `cd gui && bun test tests/visibility-poll.test.ts tests/client-resource-poll.test.tsx tests/client-resource-deadline.test.tsx tests/logs-auto-refresh.test.tsx tests/debug-cache-revisit.test.tsx tests/add-codex-account-oauth.test.tsx tests/models-workspace-panels.test.tsx`
  (final list re-derived at B via `rg -l "<touched module>" tests/` for every
  migrated file — audit task-6 nit)
- `cd gui && bun run build`
- Browser: in-app browser cannot background tabs (001/E4) → measurement is a
  happy-dom integration count + a manual real-Chrome spot check documented in D.

## Out of scope (WP3)

Request-count reduction on visible tabs (WP4), re-activation staleness (WP4),
server push (SSE) migration.

## D addendum — landed (2026-08-16/17)

Implementation: commits 955d90b34 (suspension state machine, visibility-poll.ts,
nine poller migrations, 9 new tests) and 794466b10 (round-5 audit fixes).

Audit history: binding round r5 returned FAIL first —

- HIGH: the Debug 1s tail poll lost its `useEffectEvent` dispatch in the migration,
  so a stream switch (provider→usage, both enabled) kept polling the OLD stream:
  wrong entries appended into the new buffer, the shared `logGenerationRef` bumped
  by stale ticks cancelling the new stream's initial load, and corrupted `afterRef`
  seqs. Fixed by dispatching the tick through `useEffectEvent` again — every tick
  reads the latest `fetchLogs` while the interval stays pinned to
  `[active, follow, streamEnabled]`.
- MEDIUM: `recomputePoll` never re-evaluated `anyOptOut` in its keep-countdown and
  suspended branches, so an opt-out subscriber leaving while hidden left a timer
  waking with nothing eligible, and an opt-out joining a suspended store never ran
  until visible. Both branches now re-check `documentIsHidden() && !anyOptOut`.

Round 2 PASS: the reviewer enumerated all four recomputePoll paths (teardown /
unchanged-interval / suspended / changed-interval) against the failure shapes —
no visible store ends timerless, no hidden non-opt-out store keeps a timer, the
listener is never lost while a poll is registered, and the suspended fall-through
cannot double-arm. Also folded in: abort signals for the three remaining 30s
pollers, `loadShadowCall` clearing in `finally`, and a throw guard in
`startVisibilityPoll` (without it a throwing make-up tick would skip `arm()` and
kill the cadence permanently).

Verification evidence:
- `cd gui && bun test` over the 22 touched-surface suites → 146 pass / 0 fail.
- `bun run lint` (oxlint) and `bun run build` (tsc -b + vite) green.
- Hidden-tab proof is the happy-dom timer probe (`hasPollTimerForTests`), not live
  emulation: as 001/E4 predicted, the in-app browser keeps background tabs
  `visible`, `Emulation.setPageVisibilityState` is not exposed through the raw CDP
  channel, and page-context `visibilityState` patching does not stick because
  evaluation runs in an isolated world. Fetch-count assertions alone cannot see
  this guarantee (a skipped tick looks identical to no tick), which is exactly why
  the timer probe exists.
- Visible-tab baseline re-measured after the change (12s dwell on Dashboard,
  sandboxed instance): unchanged cadence, no regression in request volume — the
  reduction work is WP4's.
