# 070 — wp7: Automatic Child updates (notify sweep and auto-when-idle)

> **Revision 2 (audit r1).** Folds H1 (registration per 000 "Test registration rule"), H3 (050's `createLinkBackoff`
> keyed by link and target version for refused/failed/offline/busy/uncertain/unsupported outcomes; candidates rotate by
> least-recent attempt; at most 3 automatic attempts per link and target before a manual Update is required), H4 (a
> Windows Child is a candidate only for route `desktop-request`, admitted by 080, A5), M6 (`activeJob`), M11 (docs
> disclose A1 and A5; a Desktop request item can hold the one-at-a-time lane about 25 minutes, and why that is
> acceptable), L12 (verifier facts) and L13 (a preview-channel Child below the Home's stable version moves to the
> Home's version; the Child has no local opt-out in this unit).

> **Revision 4 (CodeRabbit on #8500).** Folds 4529522103 (the backoff is built with `countOn:
> UPDATE_ATTEMPT_CAP_STATES`; audit r2 R1 below stated the rule, and 050's helper now implements it), 4529522106 (the
> per-link, per-target count is persisted as `autoUpdateAttempts` after each counted outcome, the cap writes
> `suppressedTarget` from `onItem` at once, and a restart restores the count), 4529522112 (recovery reads
> `pendingUpdateRecovery`, which 030 writes apart from `lastOperation`; a link with an unexpired record is never a
> candidate) and 4529521944 (once a recovery observe shows no update in flight, the sweep submits one pinned sync
> without a restart to restore routing, then clears the record; it never re-applies).

- **Work-phase:** wp7. **Depends on:** wp5 ([050](050_auto_catalog_fanout.md): policy file with `updates`, the
  Child-ops host and its poll hook), and through it wp3 ([030](030_child_operations.md): engine and update runner),
  wp2 ([020](020_signals_visibility.md): observe, activity) and wp1 ([010](010_foundations.md): plan classifier).
- **Class:** C4. The Home starts updates on other machines by default (lead amendment A1). Independent review and
  explicit security review are required.

**Outcome.** With the default policy `updates: "auto-when-idle"`, a stable Home keeps its Home-initiated Children on
its own version without anyone pressing a button, the way GOAT keeps managed OpenCodex installs current: Home first,
then one Child at a time, only while the Child is idle. Concretely the Home observes every eligible Child on start
(after a jittered delay) and every 6 hours; when the Home is a stable release that has served its version for 10
minutes, it submits one `update` job at a time (`trigger:"auto"`) for a Child whose latest observation says the plan
can apply, whose target is the Home's version, that has relayed no model request for `idleAfterMs` (default 10
minutes), whose last failure was not a rollback to this target (`suppressedTarget`), and that is not GOAT-managed.
An `uncertain` outcome (from any update, manual or automatic) is re-observed at 2, 5 and 15 minutes and never
re-applied in between. `updates: "notify"` keeps the sweep and the "Update available" badge and never applies;
`"off"` runs neither. The docs state the default and show how to switch with `ocx link policy --updates notify|off`
or the dashboard policy panel (060).

**IN:** `src/link/child-update-sweep.ts` (new), engine `onItemFinished` listener, host wiring in
`src/link/child-ops-host.ts`, docs (guide, CLI reference, 7 locales each), `skills/ocx` hand page,
`structure/remote-link.md`, tests.

**OUT:** Desktop `desktop-request` updates (080; the sweep treats route `desktop-request` as owner-action until 080
adds it to the eligible routes), updating `ocx-child` (D10), Windows orchestrated updates (refused, D20),
Child-initiated links, any `src/update/*` change, GUI (060 renders the badge and the panel), updating the Home
itself (the Home's own updater is unchanged; "Home first" is a precondition, not an action).

## Interfaces consumed

| Producer | Symbol | Used for |
|---|---|---|
| wp5 `child-policy.ts` | `readChildPolicy().policy.updates`, `idleAfterMs` | mode and idle threshold |
| wp5 `child-ops-host.ts` | `ChildOpsHostBinding`, scheduler `afterPoll` | 5-minute evaluation tick |
| wp3 engine | `submit`, `whenDone` (wp5), `activeJob` | jobs; this phase adds `onItemFinished` |
| wp5 `src/link/child-ops-scheduler.ts` | `createLinkBackoff`, `LinkBackoff` | per-link backoff keyed by target version, attempt count, least-recent rotation (H3) |
| wp3 runner | `runUpdateItem` with `trigger:"auto"` | re-observes, then re-checks idle, `suppressedTarget` and `updateInFlight` at apply time (030 2.3) |
| wp2 | `observe` op, observation fields `installedVersion`, `targetVersion`, `installKind`, `updateRoute`, `updateReason` | candidate selection |
| wp1 | `ChildObservation.suppressedTarget`, `lastOperation` | suppression, restart recovery |

## 1. File change map

| Path | Kind | Purpose | Anchor |
|---|---|---|---|
| src/link/child-update-sweep.ts | NEW | Notify sweep, auto-when-idle selection, uncertain re-observe schedule | — |
| src/link/child-ops-engine.ts | MODIFY | `onItemFinished(listener)` | wp3 `finishItem` |
| src/link/child-ops-host.ts | MODIFY | Create, start and stop the sweep; pass `afterPoll` | wp5 file |
| docs-site/src/content/docs/guides/remote-link.md + fr, ja, ko, ru, tr, zh-cn, zh-tw | MODIFY | "Automatic Child updates" subsection | wp5's policy subsection |
| docs-site/src/content/docs/reference/cli/lifecycle.md + same 7 locales | MODIFY | `--updates` semantics under `ocx link policy` | wp5 section |
| skills/ocx/references/05_remote_hub.md, 04_failure_semantics.md | MODIFY | Automatic updates and the `uncertain` rule | wp3/wp5 sections |
| structure/remote-link.md | MODIFY | Sweep behaviour and guards | wp5 paragraph |
| tests/clients/link-child-update-sweep.test.ts | NEW | Section 5 | — |
| tests/clients/link-child-ops-engine.test.ts | MODIFY | `onItemFinished` case | wp3 file |
| scripts/test-layout/layout-clients.json, tests/fixtures/test-layout-expected.json | MODIFY | Register the new test (000 "Test registration rule") | before each closing `}` |

## 2. Changes

### 2.1 src/link/child-ops-engine.ts (MODIFY)

```ts
export type ChildItemListener = (job: Readonly<ChildJob>, item: Readonly<ChildJobItem>) => void;
// ChildOpsEngine gains:
  /** Called after every item reaches a terminal state, manual or automatic. Returns an unsubscribe. */
  onItemFinished(listener: ChildItemListener): () => void;
```
Implementation: a `Set<ChildItemListener>`; `finishItem` (030 2.2) calls each listener with `structuredClone`d values
inside `try/catch` after the `lastOperation` write, so a throwing listener never affects the job.

### 2.2 src/link/child-update-sweep.ts (NEW, full exported API and core logic)

```ts
import { compareStrictSemver, parseStrictSemver } from "../lib/strict-semver";
import type { ChildOpsEngine } from "./child-ops-engine";
import type { ChildJob, ChildJobItem, ChildOpsEnv } from "./child-ops-types";
import type { ChildPolicyRead } from "./child-policy";
import { createLinkBackoff, type LinkBackoff } from "./child-ops-scheduler";

export const SWEEP_INTERVAL_MS = 21_600_000;            // 6 h, the Desktop updater's cadence (updater.rs:448-456)
export const SWEEP_START_MIN_MS = 60_000;
export const SWEEP_START_JITTER_MS = 240_000;           // first sweep 1–5 min after the host starts
export const HOME_FIRST_MS = 600_000;                   // the Home serves its version 10 min before any Child update
export const REOBSERVE_DELAYS_MS = [120_000, 300_000, 900_000] as const;
// Revision 4: the uncertain-recovery window (UNCERTAIN_RECOVERY_WINDOW_MS, 1 h) lives in 030's child-ops-runners.ts, which
// writes pendingUpdateRecovery with its `until`; this file reads `until` and needs no constant of its own.
/** H3: outcomes that back an automatic update off (5 min doubling to 6 h, 050), keyed by link and target version. */
// Audit r2 R1: transient "busy" (link active, update-in-flight, plan-expired) and "offline" grow the backoff delay
// but never count toward the 3-attempt cap, so they cannot suppress a target.
export const UPDATE_BACKOFF_STATES: ReadonlySet<string> = new Set(["refused", "failed", "offline", "busy", "uncertain", "unsupported"]);
export const UPDATE_ATTEMPT_CAP_STATES: ReadonlySet<string> = new Set(["refused", "failed", "uncertain", "unsupported"]);
/** H3: automatic attempts per link and target before only a manual Update may try again. */
export const MAX_AUTO_UPDATE_ATTEMPTS = 3;
/** Routes the sweep may update automatically. 080 adds "desktop-request" (A5). */
export const AUTO_UPDATE_ROUTES: ReadonlySet<string> = new Set(["orchestrated"]);

export interface ChildUpdateSweepDeps {
  engine: ChildOpsEngine;
  env: () => ChildOpsEnv;
  readPolicy: () => ChildPolicyRead;
  homeStartedAt: number;                                // epoch ms the Home process started
  random: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  /** Test seam; production uses createLinkBackoff({ growOn: UPDATE_BACKOFF_STATES, countOn: UPDATE_ATTEMPT_CAP_STATES }). */
  backoff?: LinkBackoff;
}

export interface ChildUpdateSweep {
  start(): void;
  stop(): void;
  /** 050's afterPoll: selects at most one Child to update. */
  onPoll(): Promise<void>;
  /** Test seams. */
  sweepForTest(): Promise<ChildJob | null>;
  pendingReobserve(linkId: string): number;              // remaining scheduled observes
}

export function homeAutoUpdateAllowed(homeVersion: string, homeStartedAt: number, now: number): "ok" | "prerelease" | "home-first" | "version-unknown" {
  const parsed = parseStrictSemver(homeVersion);
  if (!parsed) return "version-unknown";
  if (parsed.prerelease.length > 0) return "prerelease";        // preview/dev Homes never auto-update Children
  return now - homeStartedAt >= HOME_FIRST_MS ? "ok" : "home-first";
}

export function createChildUpdateSweep(deps: ChildUpdateSweepDeps): ChildUpdateSweep {
  const reobserve = new Map<string, unknown[]>();       // linkId -> pending timer handles
  const backoff = deps.backoff ?? createLinkBackoff({ growOn: UPDATE_BACKOFF_STATES, countOn: UPDATE_ATTEMPT_CAP_STATES });
  let interval: unknown = null;
  let startTimer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let applying = false;
  let stopped = true;

  const mode = () => deps.readPolicy().policy.updates;

  const sweep = async (): Promise<ChildJob | null> => {
    if (stopped || mode() === "off") return null;
    const env = deps.env();
    const ids = env.readStore().links
      .filter(link => link.direction === "hub-initiated" && !deps.engine.activeJob(link.id))
      .map(link => link.id);
    if (ids.length === 0) return null;
    const result = deps.engine.submit({ op: "observe", linkIds: ids, restart: "none", trigger: "auto" }, env);
    return result.ok ? deps.engine.whenDone(result.job.jobId) : null;
  };

  const scheduleReobserve = (linkId: string): void => {
    for (const handle of reobserve.get(linkId) ?? []) deps.clearTimeout(handle);
    const handles = REOBSERVE_DELAYS_MS.map((delay, index) => deps.setTimeout(() => {
      const left = (reobserve.get(linkId) ?? []).filter(handle => handle !== handles[index]);
      if (left.length === 0) reobserve.delete(linkId); else reobserve.set(linkId, left);
      if (stopped || deps.engine.activeJob(linkId)) return;
      deps.engine.submit({ op: "observe", linkIds: [linkId], restart: "none", trigger: "auto" }, deps.env());
    }, delay));
    reobserve.set(linkId, handles);
  };

  /** Revision 4 (4529522106): memory and file agree; the file wins after a restart (memory starts at 0). */
  const attemptsFor = (env: ChildOpsEnv, linkId: string, target: string): number => {
    const saved = env.readObservation(linkId)?.autoUpdateAttempts;
    return Math.max(backoff.attempts(linkId, target), saved?.target === target ? saved.count : 0);
  };

  /** Revision 4 (4529521944, 4529522112): recovery of an uncertain update, driven by the persisted record. */
  const recover = (env: ChildOpsEnv, job: Readonly<ChildJob>, item: Readonly<ChildJobItem>): void => {
    const pending = env.readObservation(item.linkId)?.pendingUpdateRecovery;
    if (!pending) return;
    if (Date.parse(pending.until) <= env.now()) { env.writeObservation(item.linkId, { pendingUpdateRecovery: null }); return; }
    // A recovery observe that sees no update in flight ⇒ one pinned sync, no restart, to restore routing. Never an update.
    // Revision 5 (final review r2): gate on the plan's own updateInFlight (010 ChildObservation). null (no plan probe)
    // means "unknown": do nothing and let the next scheduled re-observe or expiry decide.
    if (job.op === "observe" && item.state === "succeeded" && env.readObservation(item.linkId)?.updateInFlight === false) {
      if (!deps.engine.activeJob(item.linkId)) deps.engine.submit({ op: "sync", linkIds: [item.linkId], restart: "none", trigger: "auto" }, env);
      return;
    }
    // A Desktop record (desktopRequestId set) is cleared only by 080's status reconciliation or expiry.
    if (job.op === "sync" && item.state === "succeeded" && !pending.desktopRequestId) env.writeObservation(item.linkId, { pendingUpdateRecovery: null });
  };

  const onItem = (job: Readonly<ChildJob>, item: Readonly<ChildJobItem>): void => {
    const env = deps.env();
    if (job.op !== "update") { recover(env, job, item); return; }
    if (item.state === "uncertain") scheduleReobserve(item.linkId);
    // H3: automatic attempts feed the backoff and the cap; a manual success clears them as well.
    const target = item.toVersion ?? env.homeVersion;
    if (item.state === "succeeded" || item.state === "up-to-date") {
      backoff.record(item.linkId, target, item, env.now(), null);
      env.writeObservation(item.linkId, { autoUpdateAttempts: null });
      return;
    }
    if (job.trigger !== "auto") return;
    backoff.record(item.linkId, target, item, env.now(), null);
    if (!UPDATE_ATTEMPT_CAP_STATES.has(item.state)) return;
    // This outcome is already in memory (record above); the file adds it to whatever survived a restart.
    const saved = env.readObservation(item.linkId)?.autoUpdateAttempts;
    const count = Math.max(backoff.attempts(item.linkId, target), (saved?.target === target ? saved.count : 0) + 1);
    env.writeObservation(item.linkId, { autoUpdateAttempts: { target, count } });
    // The cap is enforced here, not when the link next becomes a candidate, so a restart in between cannot reset it.
    if (count >= MAX_AUTO_UPDATE_ATTEMPTS) env.writeObservation(item.linkId,
      { suppressedTarget: target, updateReason: "update-attempts-exhausted", autoUpdateAttempts: null });
  };

  /**
   * One candidate per poll; the runner re-checks everything at apply time. H3: eligible links are tried least recently
   * attempted first, so one Child that keeps failing cannot starve the others, and a link in backoff is skipped.
   */
  const candidate = (env: ChildOpsEnv): string | null => {
    const home = parseStrictSemver(env.homeVersion);
    if (!home) return null;
    const eligible: string[] = [];
    for (const link of env.readStore().links) {
      if (link.direction !== "hub-initiated" || link.childKind === "ephemeral") continue;
      if (deps.engine.activeJob(link.id) || reobserve.has(link.id)) continue;
      const seen = env.readObservation(link.id);
      // Revision 4 (4529522112): an unresolved uncertain update blocks re-apply until its record is cleared or expires.
      if (seen?.pendingUpdateRecovery && Date.parse(seen.pendingUpdateRecovery.until) > env.now()) continue;
      if (!seen || !AUTO_UPDATE_ROUTES.has(seen.updateRoute) || seen.installKind === "goat") continue;
      // H4: a Windows Child can only take the Desktop request route; orchestrated apply is refused there (D20).
      if (link.remotePlatform === "windows" && seen.updateRoute !== "desktop-request") continue;
      if (seen.targetVersion !== env.homeVersion || seen.suppressedTarget === env.homeVersion) continue;
      const installed = parseStrictSemver(seen.installedVersion);
      if (!installed || compareStrictSemver(installed, home) >= 0) continue;  // never sideways or down
      if (env.wireState(link.id) !== "connected" || env.activity(link.id)?.idle !== true) continue;
      if (backoff.blocked(link.id, env.homeVersion, env.now(), null)) continue;
      if (attemptsFor(env, link.id, env.homeVersion) >= MAX_AUTO_UPDATE_ATTEMPTS) {
        // Normally already written by onItem; kept for a count restored from the file. A manual Update clears it.
        env.writeObservation(link.id, { suppressedTarget: env.homeVersion, updateReason: "update-attempts-exhausted" });
        continue;
      }
      eligible.push(link.id);
    }
    eligible.sort((a, b) => (backoff.lastAttemptAt(a) ?? -1) - (backoff.lastAttemptAt(b) ?? -1));   // stable: ties keep store order
    return eligible[0] ?? null;
  };

  const onPoll = async (): Promise<void> => {
    if (stopped || applying || mode() !== "auto-when-idle") return;
    const env = deps.env();
    if (homeAutoUpdateAllowed(env.homeVersion, deps.homeStartedAt, env.now()) !== "ok") return;
    const linkId = candidate(env);
    if (!linkId) return;
    applying = true;                                     // one Child at a time across polls
    try {
      const result = deps.engine.submit({ op: "update", linkIds: [linkId], restart: "none", trigger: "auto" }, env);
      if (result.ok) await deps.engine.whenDone(result.job.jobId);
    } finally { applying = false; }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = deps.engine.onItemFinished(onItem);
      // A Home restarted during an uncertain update re-observes it instead of trusting the stale verdict. Revision 4
      // (4529522112): read pendingUpdateRecovery, which the first scheduled observe does not overwrite (lastOperation it does).
      const env = deps.env();
      for (const link of env.readStore().links) {
        const pending = env.readObservation(link.id)?.pendingUpdateRecovery;
        if (pending && Date.parse(pending.until) > env.now()) scheduleReobserve(link.id);
      }
      startTimer = deps.setTimeout(() => { startTimer = null; void sweep().catch(() => null); },
        SWEEP_START_MIN_MS + Math.floor(deps.random() * SWEEP_START_JITTER_MS));
      interval = deps.setInterval(() => { void sweep().catch(() => null); }, SWEEP_INTERVAL_MS);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribe?.(); unsubscribe = null;
      if (startTimer !== null) deps.clearTimeout(startTimer);
      if (interval !== null) deps.clearInterval(interval);
      for (const handles of reobserve.values()) for (const handle of handles) deps.clearTimeout(handle);
      reobserve.clear();
      startTimer = interval = null;
    },
    onPoll,
    sweepForTest: sweep,
    pendingReobserve: linkId => reobserve.get(linkId)?.length ?? 0,
  };
}
```
Why each guard exists:
- **Stable Home only** (`prerelease.length > 0` ⇒ no auto updates): GOAT's "preview/dev never auto-update" (002 `4).
- **Home first, 10 minutes:** the Home has run its own version long enough to fail visibly before it pushes that
  version to a Child. Measured from the Home process start, because the served version only changes with a restart.
- **Target = Home version, strictly newer than installed:** the runner passes `--version <home>` and the Child refuses a
  downgrade; the sweep additionally never submits when installed ≥ Home.
- **Idle:** checked here and again by `runUpdateItem` just before apply (030 2.3), with the policy's `idleAfterMs`.
- **One at a time:** `applying` plus single-link jobs; the engine also runs `update` items one at a time.
- **`suppressedTarget`:** set by the runner after a rollback (exit 11), and by the sweep when a link reaches
  `MAX_AUTO_UPDATE_ATTEMPTS` for this target (reason `update-attempts-exhausted`); only a manual update clears it.
- **Backoff and rotation (H3):** a refused, failed, offline, busy, uncertain or unsupported automatic attempt backs that
  link off for that target (5 min doubling to 6 h, 050's helper); candidates are taken least recently attempted first. A
  Child that fails every time (for example `deadline-passed` before 030 fixed the clock, or a broken install) costs at
  most three attempts of two SSH calls each per target, instead of two SSH calls every five minutes forever, and never
  blocks the Children behind it in the store. Revision 4: the delay lives in memory, the count is persisted as
  `autoUpdateAttempts` after each counted outcome, and reaching the cap writes `suppressedTarget` at once, so a Home
  restart neither resets the count nor skips the suppression.
- **Uncertain ⇒ re-observe, never re-apply:** a link with a pending schedule, or with an unexpired
  `pendingUpdateRecovery` (Revision 4, persisted by 030 apart from `lastOperation`), is not a candidate; the observe at
  2/5/15 min refreshes `installedVersion` and `updateInFlight`. When one of those observes sees no update in flight,
  the sweep submits one pinned sync without a restart (it restores routing an unsupervised stop may have removed) and
  clears the record when that sync succeeds; the record also lapses after its hour. Recovery runs in every `updates`
  mode, because it applies nothing: the host starts the sweep object whenever it runs, and only `sweep` and `onPoll`
  check the mode. Once installed equals the Home version the link is no longer a candidate; if the update really
  failed, a later poll may try again, and a second rollback suppresses the target.
- **GOAT-managed Children skipped:** `installKind === "goat"` (010 classification from the serving path), so GOAT and the
  Home never race. Desktop qualifies only after 080 adds `"desktop-request"` to `AUTO_UPDATE_ROUTES` (A5); until then it
  is owner-action. A Windows Child qualifies only through that route (H4). mise, source and ocx-child never qualify.

### 2.3 src/link/child-ops-host.ts (MODIFY, wp5 file)

```ts
import { createChildUpdateSweep } from "./child-update-sweep";
...
  const engine = sharedChildOpsEngine();
  const sweep = createChildUpdateSweep({
    engine, env, readPolicy: () => readChildPolicy(),
    homeStartedAt: Date.now() - Math.round(process.uptime() * 1000),
    random: Math.random,
    setTimeout: (fn, ms) => unref(setTimeout(fn, ms)), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => unref(setInterval(fn, ms)), clearInterval: h => clearInterval(h as ReturnType<typeof setInterval>),
  });
  const scheduler = createChildOpsScheduler({ ...schedulerDeps, afterPoll: () => sweep.onPoll() });
  scheduler.start();
  sweep.start();
  return () => { sweep.stop(); scheduler.stop(); };
```
The env's `activity` uses the policy's `idleAfterMs`: `binding.activity(id, now)` is 020's `isLinkIdle(snapshot, now,
policy.idleAfterMs)` (020 exports `isLinkIdle` and `DEFAULT_IDLE_AFTER_MS`); wp5 already threads the policy value, and
this phase relies on it for the auto path.

## 3. Deviations from 004 and 000

1. **Default `auto-when-idle`** (A1) instead of D17's `notify`. The guards above are the ones A1 lists.
2. **Re-observe schedule lives in the sweep**, not the engine (D12 puts "schedule observes at 2/5/15 min" in the item
   flow). The engine stays free of timers; the sweep subscribes to every finished item, so manual uncertain
   updates are re-observed too. Consequence: with `updates: "off"` the sweep still starts and still re-observes uncertain
   items (observation only), but never sweeps or applies.
3. **The sweep observes only links without an active job** and does not jitter per link: the engine already runs observe
   three at a time, one SSH session each, at most every 6 hours.
4. **"Home first" is a precondition on the Home's uptime at its version**, not an orchestration of the Home's own update:
   the Home's updater is another subsystem (`src/update/*`, out of scope).

5. **Backoff, rotation and an attempt cap (audit H3).** D17 retries an eligible Child at every poll. The sweep reuses
   050's `createLinkBackoff` keyed by link and target version, takes candidates least recently attempted first, and
   stops after `MAX_AUTO_UPDATE_ATTEMPTS` (3) per link and target by writing `suppressedTarget` with reason
   `update-attempts-exhausted`; the next manual Update clears it.
6. **Preview-channel Children (audit L13).** The target is always the Home's version. A Child on a preview channel whose
   installed version is below the Home's stable version is a candidate and moves to the Home's stable version (the Child
   refuses only a downgrade). This unit gives the Child no local opt-out: the control is the Home policy
   (`--updates notify|off`), which the docs state.
7. **A Desktop request holds the lane (audit M11).** After 080 a `desktop-request` item waits for the Desktop app's own
   download and install, up to about 25 minutes (080 "Runner"). The sweep runs one Child at a time by design (a bad
   release should reach one Child, then the next), so a slow Desktop Child delays the others by at most that long per
   6-hour sweep; that is the price of never updating two Children at once, and it is accepted.

Engine method names are 020's (`activeJob`; `whenDone` returns `null` where `job()` returns `undefined`).

## 4. Field chains (PLAN-FIELD-CHAIN-01)

| Field / value | Created | Serialized | Deserialized | Consumers |
|---|---|---|---|---|
| `policy.updates` (`off`, `notify`, `auto-when-idle`; default `auto-when-idle`) | 050 `updateChildPolicy` / defaults | `child-policy.json` | 050 `readChildPolicy` | `sweep()` (off ⇒ no sweep), `onPoll()` (only `auto-when-idle` applies); GUI panel (060); docs |
| Observe jobs `trigger:"auto"` | `sweep()`, re-observe timers | engine job, `lastOperation` | 030 validator | `?children=1` rows (020): `versionSkew` + `update.route` give the "Update available" badge (060) |
| Update jobs `trigger:"auto"` | `onPoll()` | same | same | 030 `runUpdateItem` auto branch (idle, suppression); GUI label (060) |
| `suppressedTarget` | 030 runner on rollback | observations file | 010 reader | `candidate()` skip; manual update clears it (030) |
| `lastOperation.state === "uncertain"` (op update) | 030 engine | observations file | 010 reader | `start()` restart recovery |
| Re-observe schedule | `onItem` listener | N/A, memory | N/A | `candidate()` exclusion, `pendingReobserve` (tests) |
| `homeAutoUpdateAllowed` verdict | sweep | N/A | N/A | `onPoll()` only; not surfaced (060 may show "Updates wait for the Home's own version to settle" from the same function if it wants) |

## 5. Tests

**tests/clients/link-child-update-sweep.test.ts (NEW; fails before implementation: module missing).** Fake timers via
deps, fake engine (records `submit`, resolves `whenDone`, lets the test fire `onItemFinished`), fake env with an
in-memory store and observations. Register `"link-child-update-sweep.test.ts": "clients"` per 000 "Test registration rule"
(one line before the closing `}` of `layout-clients.json` and of `test-layout-expected.json`; never `layout.json`).
- `churn` (H3): one eligible link whose update item ends `refused/deadline-passed` ⇒ no submit for it at +5 min − 1 s,
  one at +5 min, then not before +10 min; `busy` and `offline` back off the same way; after three automatic attempts the
  sweep submits nothing for that target and `writeObservation` received `{ suppressedTarget: <home>, updateReason:
  "update-attempts-exhausted" }`; a manual `succeeded` item for the link resets the count.
- `starvation` (H3): links A, B, C eligible in store order, A fails every time ⇒ the next two polls submit B then C (least
  recently attempted first), and A only after its backoff ends.
- `windows predicate` (H4): a `remotePlatform: "windows"` record with route `orchestrated` is never submitted; with route
  `desktop-request` it is skipped while `AUTO_UPDATE_ROUTES` lacks that route (wp7) and submitted once the test adds it
  (what 080 does).
- `preview Child` (L13): installed `2.100.0-preview.3`, Home `2.100.0` ⇒ submitted; installed `2.101.0-preview.1` ⇒ not.
- `first sweep after 1–5 minutes`: `random() = 0` ⇒ observe job at 60 s; `random() = 0.999` ⇒ before 300 s; then every 6 h.
- `sweep covers hub-initiated links without an active job`; client-initiated and held links are not in `linkIds`.
- `off`: no observe job at start or at 6 h; `notify`: observe jobs, and `onPoll()` never submits `update`.
- `auto-when-idle` candidate rules, each with one link that differs from an eligible one in exactly one field:
  prerelease Home `2.101.0-preview.1`; Home started 9 min ago (then 10 min ⇒ submitted); not idle; tunnel `reconnecting`;
  `updateRoute: "owner-action"`; `installKind: "goat"`; `targetVersion` ≠ Home; `suppressedTarget` = Home;
  `installedVersion` = Home and > Home; Windows record with route orchestrated; ephemeral record; active job ⇒ none submitted; the eligible
  link ⇒ exactly one `update` job with `trigger:"auto"`, `restart:"none"`, one link id.
- `one at a time`: two eligible links, `whenDone` held open ⇒ a second `onPoll()` submits nothing; after release the next
  poll submits the second link.
- `uncertain update re-observes at 2, 5 and 15 minutes`: fire `onItemFinished` with an update item `uncertain` (manual
  trigger) ⇒ observe jobs at +120 s, +300 s, +900 s; during the window the link is not a candidate; after the window, with
  the observation still behind, the next poll may submit it again.
- `restart recovery`: `lastOperation` `{op:"update", state:"uncertain", finishedAt: 20 min ago}` ⇒ re-observe scheduled at
  start; 2 h ago ⇒ not scheduled.
- `stop clears everything`: after `stop()` no timer fires a submit and `pendingReobserve` is 0.
**tests/clients/link-child-ops-engine.test.ts (MODIFY, wp3 file):** `onItemFinished fires once per terminal item, after
lastOperation, and a throwing listener does not change the job`.
**Host wiring** is covered by 050's `tests/lab/link-child-ops-no-timer.test.ts`: extend its "one link" case to assert the
sweep's start timer and 6-hour interval exist only while the host runs.

Revision 4 cases in the sweep test file:
- `busy never spends the cap` (4529522103): three automatic `busy/link-active` items ⇒ `autoUpdateAttempts` unchanged,
  `suppressedTarget` null, the link eligible again after its backoff.
- `count survives a restart` (4529522106): two automatic `failed` items, then a new sweep instance over the same
  observation file and a fresh backoff; a third `failed` item ⇒ `suppressedTarget` written by `onItem` with
  `update-attempts-exhausted`, before any later candidate scan.
- `recovery survives a restart` (4529522112): an `uncertain` item writes `pendingUpdateRecovery`; one recovery observe
  replaces `lastOperation`; a new sweep instance still schedules the re-observes and `candidate` skips the link until
  `until`.
- `recovery restores routing` (4529521944): a recovery observe with no update in flight ⇒ one `sync` job with
  `restart: "none"` and no `update` job; its success clears `pendingUpdateRecovery`; with `updates: "off"` the same
  happens.

## 6. Docs and source-of-truth sync

- **docs-site English, `guides/remote-link.md`**, new `### Automatic Child updates` under 050's policy subsection, stating:
  the default is `auto-when-idle`; what happens (Home first for 10 minutes, stable Homes only, one Child at a time, only
  after `idleAfterMs` without a relayed model request, target is always the Home's version, never a downgrade, a
  rolled-back version is not retried automatically, an unclear result is re-checked at 2, 5 and 15 minutes and never
  re-applied); that a failing Child is retried with backoff and at most three times per version before a manual Update is
  needed; that a Child on a preview channel below the Home's stable version moves to the Home's version and that the
  Child itself has no opt-out (the Home policy is the control); that from the release that ships 080 on both sides, Desktop
  Children (Windows included) install the Home's version automatically through their own signed updater (A5), and one
  such update can take about 25 minutes while the others wait; which Children are never updated automatically
  (Windows Children that are not Desktop installs, Desktop Children before both sides run 080,
  GOAT-managed, mise, source checkouts, `ocx-child`, Child-initiated links) and what the row shows instead; and how to
  change it: `ocx link policy --updates notify` (badge only), `ocx link policy --updates off` (no sweep), or the
  Remote Link policy panel. `reference/cli/lifecycle.md` documents the three `--updates` values under `ocx link policy`.
  The same edits in `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw` (14 files); `cd docs-site && bun run build`.
- **skills/ocx**: `05_remote_hub.md` adds "Automatic Child updates are on by default on a stable Home; an agent must not
  change `--updates` without the operator's request"; `04_failure_semantics.md` adds the `uncertain` rule (re-observe,
  never re-apply). No capability change, so `bun run skill:surface` is unaffected (it still passes the check).
- **structure/remote-link.md**: the 050 paragraph gains the sweep and its guards, bound to
  `tests/clients/link-child-update-sweep.test.ts` in the manifest's invariant list; `bun run structure:check`.
- **GUI**: none here (060 shows the badge, the "automatic" label and the panel).

## 7. Enforcement bypass record (PLAN-BYPASS-NAMED-01)

| Guard | Tier | Executing surface | Known bypass | Residual risk | Wording |
|---|---|---|---|---|---|
| Stable Home only | Runtime | `homeAutoUpdateAllowed` | A stable-tagged build made from a local branch | It is still the Home's own version | "only stable releases update Children automatically" |
| Home first, 10 min | Runtime | same | Measures process uptime, not health | A Home that is up but degraded still pushes its version | "after the Home has run its version for 10 minutes" |
| Idle | Heuristic | 020 activity + 030 runner re-check | Sees only relayed traffic | An open but quiet Codex window on the Child is interrupted by the update's restart | "when the Child has sent no model request for N minutes" |
| One at a time | Runtime | `applying`, single-link jobs, engine width 1 | A manual `ocx link update --all` runs alongside (also one at a time, but a second job) | Two Children updating at once; the per-link lock still holds | "the Home starts at most one automatic update at a time" |
| No retry after rollback | Runtime | `suppressedTarget` | Manual update clears it | Intended | "a version that rolled back is not retried automatically" |
| Uncertain ⇒ re-observe | Runtime | sweep schedule; Child `updateInFlight` and mutex | A Home restart after the 1-hour window | The next poll may re-apply after the Child finished on its own; the plan would then say up-to-date | "re-checked at 2, 5 and 15 minutes, never re-applied in between" |
| GOAT-managed skipped | Heuristic | 010 classification from the serving path | GOAT installs elsewhere than `.local/share/goat/opencodex` | Both orchestrators may act; the Child's update mutex serializes them | "Children managed by GOAT are left to GOAT" |

## 8. Verifiers (PLAN-VERIFIER-REAL-01)

| Command | Result on 00680193cb (2026-11-11) | Reads this phase's target? |
|---|---|---|
| `bun run typecheck` | exit 0, no type errors in 2,379 files | Yes after implementation |
| `bun test tests/lab/core-link-boundary.test.ts tests/cli/cli-link.test.ts tests/cli/sync-fanout.test.ts tests/cli/cli-capabilities-arguments.test.ts tests/codex-integration/catalog-auto-refresh-client-fanout.test.ts` | exit 0, 46 pass / 0 fail | core-link-boundary: no core file may reach `src/link` (the sweep is under `src/link`) |
| `bun run structure:check` | revision 1: exit 1 on 00680193cb (pre-existing 603-line doc); audit r1 on 61151e3457: exit 0 | Yes; it must stay 0 |
| `bun test tests/clients/link-child-update-sweep.test.ts` | new; fails before implementation | Yes |
| NOT RUN: `bun run privacy:scan`, `cd docs-site && bun run build`, `bun run test:changed`, full suite | PR gates / CI | — |

## 9. Acceptance criteria

1. With the default policy on a stable Home up for 10 minutes, one connected, idle, npm Child at 2.99.0 whose observation
   says `orchestrated` for target 2.100.0 gets exactly one `update` job (`trigger:"auto"`) at the next poll (sweep test),
   and 030's runner applies through the package launcher (030 A4 fixture).
2. On a prerelease Home, or within 10 minutes of Home start, no update job is submitted.
3. `ocx link policy --updates notify` stops automatic updates and keeps the 6-hour observe sweep; `--updates off` stops both.
4. A Child whose last update rolled back to 2.100.0 is not updated automatically to 2.100.0; a manual update still works.
5. An `uncertain` update is followed by observe jobs at 2, 5 and 15 minutes and by no update job for that link in between.
6. GOAT-managed, Windows, mise, source and `ocx-child` Children never receive an automatic update job; a Desktop Child receives one only after 080 (A5).
7. The English guide states the default and both switches; the seven translations say the same.

## 10. Security review notes, risks and Windows

- **Review trigger:** default-on remote updates (A1). What bounds them: the same pinned SSH channel and the Child's own
  updater as manual updates (030, D20); target fixed to the Home's version; Child-side guards (`--expect-plan`, 120 s
  `--not-after`, update mutex, `updateInFlight`, downgrade refusal); the post-update `--expect-link` sync.
- **Consenting principal:** the operator who linked the Child with their SSH key; the docs say not to link a machine you do
  not own and show the one-line opt-out.
- **Risks:** (1) An update restarts the Child's OpenCodex and ends relayed turns that started after the idle check; the
  runner re-checks idle immediately before apply, which narrows the window to seconds. (2) A bad release spreads to every
  idle Child within hours; stable-only, Home-first and one-at-a-time slow it, and a rollback stops it per Child. (3) The
  Home process clock drives every timer; a suspended laptop Home simply resumes its schedule.
- **Windows:** a Windows Child is a candidate only when its observed route is `desktop-request`, which 080 adds to
  `AUTO_UPDATE_ROUTES` (A5, audit H4); orchestrated apply stays refused (`windows-apply`, and the runner refuses it after
  its Desktop branch). The observe sweep runs for every Windows Child and the badge shows the owner action. A Windows Home
  runs the sweep with the same timers and `SshRunner`.
- **Churn bound (H3):** automatic attempts per Child and target are capped at three with exponential backoff, so a
  persistently failing Child costs at most six SSH sessions per release instead of two every five minutes.


## Upgrade behaviour and release notes

A1 changes behaviour on upgrade: a Home that installs this release starts updating idle eligible Children to its
own version without being asked. The release notes (090) and `docs-site/src/content/docs/guides/remote-link.md`
(plus its seven translations) must say so in the first paragraph about updates and give the opt-out:
`ocx link policy --updates notify` (or `off`), or the Remote Link policy panel (060). 090 carries the executable step
that puts this, the default-on catalog fan-out (050) and A5 into the GitHub release body.


## Revision 3 (audit r2 residuals)

- R1: attempts() counts only outcomes in UPDATE_ATTEMPT_CAP_STATES; busy and offline still grow the per-link backoff but never exhaust the cap. Test: three consecutive busy/update-in-flight results leave suppressedTarget null and the link eligible after its backoff.
- R4: a Windows link whose remotePlatform is not yet recorded can pass the candidate check with an orchestrated route; the engine discovers the platform, ends unsupported/windows-apply and the item counts toward the cap. It fails safe; accepted as is.


## Revision 5 (final review r2 on #8500)

- recover() now reads ChildObservation.updateInFlight (new in 010, from plan.updateInFlight). Before this, it compared
  updateReason to "update-in-flight", a value no observation holds, so the gate was always open.
- A recovery sync no longer clears a pendingUpdateRecovery that carries desktopRequestId; 080's status reconciliation
  or expiry clears it, as 080 states.
- Tests added to the recovery cases: (a) an observe whose plan reports updateInFlight true submits no sync and keeps the
  record; (b) updateInFlight null (inspect-only observe) submits no sync; (c) a Desktop record with desktopRequestId
  survives a successful recovery sync and is cleared only by a terminal status answer.
