# Service Health Recovery

Opt-in recovery of a managed service proxy that stays alive, keeps its port listening, and stops
answering `/healthz` (#6671). Background service launchers and their exit-based restart policies
are owned by [Background Service And Sidecars](service-and-sidecars.md); this page owns only the
sentinel that turns a hung proxy into an exit those policies already handle.

## Why exit is the only lever

Every manager restarts the proxy only when it exits: the Task Scheduler batch `:loop`
(`src/service/windows-taskxml.ts`), launchd `KeepAlive`/`SuccessfulExit=false`, systemd
`Restart=on-failure`, WinSW `onfailure restart`, and the desktop app's `on_exit` (its watchdog
treats timeouts as inconclusive). The in-process memory watchdog shares the stalled event loop and
only warns. Terminating the hung process reuses every existing restart path unchanged.

## Activation

`serviceHealthRecovery` follows the `metricsExport` config contract: an optional strict object with
one optional boolean, `enabled`, enabled only by literal `true`, degraded to absence by the load
schema when malformed, and rejected at the live-write boundary by
`serviceHealthRecoveryConfigError` in `src/config/diagnostics.ts`. It is read once per process.

`src/service/health-sentinel-launch.ts` spawns the sentinel from the `ocx start` path after startup
reconciliation, only for a managed service child (`isManagedServiceEnvironment`) that is not a
sibling; a standalone binary runs it through the private `__health-sentinel` argv handled in
`src/cli/index.ts` before dispatch. The sentinel gets an allowlisted environment (no service token,
no proxy variables) carrying the target pid and absolute runtime-record, history, log and
service-state paths, and a stdin pipe whose write end only the proxy holds: parent exit is EOF.
`runDrainStartHooks` (`src/lib/optional-shutdown-hooks.ts`), which `drainAndShutdown` calls as soon
as a drain begins, and `syncCleanup` both stop it, so a deliberate stop whose drain stalls stays a
stop; a drain that began during startup prevents the spawn (`didRunDrainStartHooks`). A replacement prints one line when the history shows its predecessor was recovered recently.

## Policy

`src/service/health-sentinel-policy.ts` is the whole judgement, pure and clock-injected:

- arm only after an answer naming the target pid (logged once as `watching pid … on port …`), and
  after a 120 s grace, measured as elapsed time so a clock set back cannot reopen or extend it;
- count only probe timeouts; any HTTP answer (including a package-tree fence 503), a refusal or an
  error resets the streak; an answer from another pid stands the sentinel down;
- after a timeout, probe back to back (1 s), so a streak is one continuous unresponsive stretch and
  recurring shorter stalls aligned with the 30 s cadence cannot add up;
- recover at 3 timeouts and 60 s of span (about 62 s of continuous silence with a 20 s deadline);
  the span doubles per recovery in the last hour. The cap of 3 recoveries per hour is checked when
  a later streak qualifies (threshold and span both met): instead of recovering, the sentinel then
  stands down for the rest of the proxy's life. It does not stand down earlier, at startup.
  A recovery dated after the current time (the clock was set back) counts as recent until the
  clock passes it by a full window, so a rollback or a restart after one cannot lift the cap;
- a probe that started late or outlived its deadline by more than 5 s, a clock that ran
  backwards, or a probe during which the sentinel's own event loop ran more than 2 s late
  (wall-clock lag monitor, so sleep counts) voids the streak.

`src/service/health-sentinel-probe.ts` asks `/healthz` through `directLocalHttpFetch`.

## Binding the kill to the proxy

`src/service/health-sentinel-main.ts` never kills a bare number:

- Windows opens a kernel32 handle on the parent at startup through `bun:ffi`
  (`src/service/health-sentinel-windows.ts`), accepts it only if that process was created before the
  sentinel, and terminates through it. The open handle keeps the id from being reused. libuv's
  kill-on-close Job is not relied on: libuv ignores a failed Job assignment. Caveat: the handle is
  opened after the spawn, and the creation times compared are wall-clock times. If, in that
  short window at sentinel startup, the proxy exits, its id is reissued, and the clock is set back
  far enough that the new process appears to be older than the sentinel, the handle binds to that
  process and a later recovery would terminate it. A handle created by the proxy and inherited by
  the sentinel would close this gap; Bun's spawn does not offer one today.
- POSIX checks the live `process.ppid` immediately before SIGKILL. SIGTERM cannot run on a stuck
  loop and is a clean exit to systemd. This binding is probabilistic: if the sentinel is descheduled
  between that check and `kill` while the parent exits, is reaped, and a new process receives the
  same id, the signal reaches that process. Bun exposes no pidfd or process handle on POSIX.

The final runtime-record re-read and the durable `intent` write run under the service ownership
mutation lease (`src/service/ownership-mutation-lease.mjs`, 500 ms wait, no subprocess); a busy lease
defers. Right before the kill the runner re-checks that the last failing observation is at most
5 s old on the wall clock (and not in the future); older evidence is discarded, the `intent` entry is
settled as `skipped`, and a fresh failing streak is required. The lease is released before the kill, because on Windows the sentinel may end with the
proxy and a held lease would delay the replacement's startup. Every history write takes the lease.
`service-health-recovery.json` is written through an fsynced temp file, rename and (POSIX) directory
fsync where storage errors fail the write, fails closed when unreadable or unwritable, and settles each entry as `terminated`,
`unconfirmed`, `failed` or `skipped`. No synchronous subprocess runs in the sentinel, and it subscribes to the target's exit once:
each probe or sleep races an `AbortSignal` whose listener is removed when the race settles, so a
sentinel watching a healthy proxy for months holds no per-probe state. Nothing is
replayed: requests the hung process held are lost as in a crash.

## Coverage

`tests/service/service-health-sentinel-policy.test.ts` (guards and negative controls, including
phase-aligned recurring stalls), `-runner` (ordering, fail-closed paths, lease), `-launch` (gate,
environment, drain hook, config admission) and `-process` (the real launcher and sentinel against a
fixture that stops answering, on every CI OS).
