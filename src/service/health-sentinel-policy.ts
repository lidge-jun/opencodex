/**
 * Health-unresponsiveness recovery policy for the opt-in service health sentinel (#6671).
 *
 * Every supervisor this repository installs restarts the proxy only when it exits: the Windows
 * Task Scheduler batch loop, launchd `KeepAlive`/`SuccessfulExit=false`, systemd
 * `Restart=on-failure` and the desktop app's `on_exit`. A proxy that stays alive with its port
 * listening while its event loop answers nothing is invisible to all of them. The sentinel turns
 * that state into an exit, and this module is the whole of its judgement: pure, clock-injected,
 * and free of I/O so every false-positive guard is testable on any platform.
 *
 * The guards, in the order they apply:
 * - nothing counts until the target has answered once as itself and the startup grace is over;
 *   the grace is elapsed time, so setting the clock back neither restarts nor extends it;
 * - only a probe that got no complete answer by its deadline counts. Any answer proves the event
 *   loop ran, and a refused or failed connection means the listener is closing, not hung;
 * - an answer from another pid means the port is no longer the target's: stand down for good;
 * - a probe that started far later than the cadence allows, that outlived its own deadline by
 *   far more than jitter, or during which the sentinel's own event loop ran late (sleep, or the
 *   sentinel itself paused or starved), discards the streak, because the timeout may belong to
 *   that pause rather than to the target;
 * - once a probe times out the next ones follow back to back, so a run of timeouts is one
 *   continuous unresponsive stretch rather than separate stalls that line up with the cadence;
 * - recovery needs both a run of consecutive timeouts and a minimum unhealthy span, which doubles
 *   for each recovery in the last hour, and a cap on recoveries per hour stands the sentinel down:
 *   a proxy that hangs again right after every restart is not fixed by killing it, and each kill
 *   loses the work it held. Nothing is ever replayed.
 */

export type HealthProbeOutcome =
  /** A complete status line and headers arrived before the deadline. */
  | { kind: "answered"; pid: number | null; startedAt: number; endedAt: number }
  /**
   * No complete answer by the deadline, whether or not the connection was accepted.
   * `sentinelLagMs` is how late the sentinel's own event loop ran during the probe: a sentinel
   * that was itself paused or starved cannot tell a silent target from its own silence.
   */
  | { kind: "timeout"; startedAt: number; endedAt: number; sentinelLagMs?: number }
  /** The connection was refused: nothing is listening. */
  | { kind: "refused"; startedAt: number; endedAt: number }
  /** Any other failure. */
  | { kind: "error"; startedAt: number; endedAt: number };

export type HealthSentinelTiming = {
  /** Time between the end of one answered probe and the start of the next. */
  intervalMs: number;
  /**
   * Time between a timed-out probe and the next. Short on purpose: back-to-back probes make a run
   * of timeouts mean one continuous unresponsive stretch, so recurring shorter stalls that happen
   * to line up with the cadence cannot add up to a recovery.
   */
  failureIntervalMs: number;
  /** A probe without a complete answer by this deadline is a timeout. */
  probeTimeoutMs: number;
  /** Counted from the sentinel's start; nothing counts before it ends. */
  startupGraceMs: number;
  /** Consecutive timeouts needed before a recovery. */
  failureThreshold: number;
  /** Minimum span from the first failing probe's start to the last one's end, before backoff. */
  minUnhealthyMs: number;
  /** Slack over the cadence (and over a probe's deadline) before a pause voids the streak. */
  suspendSlackMs: number;
  /** A timeout during which the sentinel's own loop ran later than this is not evidence. */
  lagToleranceMs: number;
  /** Window over which earlier recoveries raise the backoff and count toward the cap. */
  recoveryWindowMs: number;
  /** Recoveries within the window after which the sentinel stands down. */
  maxRecoveriesPerWindow: number;
  /** Ceiling on the backoff multiplier. */
  maxBackoffMultiplier: number;
  /**
   * Oldest the final failing observation may be when the kill is issued. Lease, history and log
   * work runs between the decision and the kill; evidence older than this is discarded.
   */
  maxEvidenceAgeMs: number;
};

export const DEFAULT_HEALTH_SENTINEL_TIMING: Readonly<HealthSentinelTiming> = Object.freeze({
  intervalMs: 30_000,
  failureIntervalMs: 1_000,
  probeTimeoutMs: 20_000,
  startupGraceMs: 120_000,
  failureThreshold: 3,
  minUnhealthyMs: 60_000,
  suspendSlackMs: 5_000,
  lagToleranceMs: 2_000,
  recoveryWindowMs: 60 * 60_000,
  maxRecoveriesPerWindow: 3,
  maxBackoffMultiplier: 8,
  maxEvidenceAgeMs: 5_000,
});

export type HealthSentinelDecision =
  | { action: "continue"; note?: string }
  | { action: "recover"; reason: string; consecutiveTimeouts: number; unhealthyMs: number }
  /** Stop acting for this target; the reason is logged once. */
  | { action: "stand_down"; reason: string };

export type HealthSentinelPolicyState = {
  readonly armed: boolean;
  readonly consecutiveTimeouts: number;
  readonly firstFailureStartedAt: number | null;
  readonly lastObservedAt: number | null;
  readonly stoodDown: string | null;
};

export type HealthSentinelPolicy = {
  observe(outcome: HealthProbeOutcome): HealthSentinelDecision;
  state(): HealthSentinelPolicyState;
  /** Minimum unhealthy span currently required, after backoff. */
  requiredUnhealthyMs(): number;
  /** How long to wait before the next probe: short while a failure streak is open. */
  nextDelayMs(): number;
};

/**
 * Recoveries recorded inside the window ending at `now`. An entry dated after `now` counts as
 * recent: it means the wall clock was set back after it was written, and dropping it would let a
 * clock rollback (or a restart after one) lift the hourly cap. It keeps counting until the clock
 * passes it by a full window, which errs toward not killing.
 */
export function recentRecoveryCount(history: readonly number[], now: number, windowMs: number): number {
  return history.filter(at => Number.isFinite(at) && now - at < windowMs).length;
}

/** The unhealthy span required after `recent` recoveries: doubled per recovery, capped. */
export function requiredUnhealthySpan(timing: HealthSentinelTiming, recent: number): number {
  const multiplier = Math.min(timing.maxBackoffMultiplier, 2 ** Math.max(0, recent));
  return timing.minUnhealthyMs * multiplier;
}

export function createHealthSentinelPolicy(input: {
  targetPid: number;
  startedAt: number;
  /** Epoch-ms of earlier recoveries for this installation, newest last. */
  recoveryHistory: readonly number[];
  timing?: Partial<HealthSentinelTiming>;
}): HealthSentinelPolicy {
  const timing: HealthSentinelTiming = { ...DEFAULT_HEALTH_SENTINEL_TIMING, ...input.timing };
  let armed = false;
  let streak = 0;
  let firstFailureStartedAt: number | null = null;
  let lastObservedAt: number | null = null;
  let stoodDown: string | null = null;
  let required = timing.minUnhealthyMs;
  // Startup grace is measured as elapsed time, accumulated from forward clock movement only, so a
  // wall clock set back after (or during) the grace cannot reopen it and hold off recovery for as
  // long as the clock was moved.
  let graceElapsedMs = 0;
  let graceClock = input.startedAt;
  const noteGraceProgress = (at: number) => {
    if (at > graceClock) graceElapsedMs += at - graceClock;
    graceClock = at;
  };

  const resetStreak = () => {
    streak = 0;
    firstFailureStartedAt = null;
  };

  const standDown = (reason: string): HealthSentinelDecision => {
    stoodDown = reason;
    resetStreak();
    return { action: "stand_down", reason };
  };

  const observe = (outcome: HealthProbeOutcome): HealthSentinelDecision => {
    if (stoodDown !== null) return { action: "stand_down", reason: stoodDown };
    noteGraceProgress(outcome.startedAt);
    const previous = lastObservedAt;
    lastObservedAt = outcome.endedAt;
    let note: string | undefined;
    if (previous !== null && streak > 0 && outcome.startedAt - previous > timing.failureIntervalMs + timing.suspendSlackMs) {
      // The sentinel overslept its cadence (a suspended machine, or the sentinel itself starved),
      // so the timeouts counted so far may belong to that pause rather than to the target.
      resetStreak();
      note = "observation gap; failure streak discarded";
    }
    switch (outcome.kind) {
      case "answered": {
        if (outcome.pid !== null && outcome.pid !== input.targetPid) {
          return standDown("another process answers the health endpoint");
        }
        if (outcome.pid === input.targetPid) armed = true;
        resetStreak();
        return { action: "continue", note };
      }
      case "refused":
      case "error":
        resetStreak();
        return { action: "continue", note };
      case "timeout": {
        if (!armed) return { action: "continue", note: note ?? "not armed: the target has not answered yet" };
        if (graceElapsedMs < timing.startupGraceMs) {
          return { action: "continue", note: note ?? "startup grace" };
        }
        if (
          outcome.endedAt - outcome.startedAt > timing.probeTimeoutMs + timing.suspendSlackMs
          || outcome.endedAt < outcome.startedAt
          || (previous !== null && outcome.startedAt < previous)
        ) {
          // The probe outlived its own deadline by far more than scheduling jitter, or the wall
          // clock ran backwards: its timing spanned a pause or a clock step, so this timeout says
          // nothing about the target.
          resetStreak();
          return { action: "continue", note: "probe spanned a pause; failure streak discarded" };
        }
        if ((outcome.sentinelLagMs ?? 0) > timing.lagToleranceMs) {
          // The sentinel itself stalled during the probe (paused, starved, or the machine slept),
          // so the deadline may have expired while nobody was listening for the answer.
          resetStreak();
          return { action: "continue", note: "probe spanned a pause; failure streak discarded" };
        }
        streak += 1;
        if (firstFailureStartedAt === null) firstFailureStartedAt = outcome.startedAt;
        const unhealthyMs = outcome.endedAt - firstFailureStartedAt;
        const recent = recentRecoveryCount(input.recoveryHistory, outcome.endedAt, timing.recoveryWindowMs);
        required = requiredUnhealthySpan(timing, recent);
        if (streak < timing.failureThreshold || unhealthyMs < required) return { action: "continue", note };
        if (recent >= timing.maxRecoveriesPerWindow) {
          return standDown(`${recent} recoveries in the last ${Math.round(timing.recoveryWindowMs / 60_000)} minutes; not recovering again`);
        }
        const decision: HealthSentinelDecision = {
          action: "recover",
          reason: `no health answer for ${streak} consecutive probes over ${Math.round(unhealthyMs / 1000)}s`,
          consecutiveTimeouts: streak,
          unhealthyMs,
        };
        resetStreak();
        return decision;
      }
    }
  };

  return {
    observe,
    state: () => ({ armed, consecutiveTimeouts: streak, firstFailureStartedAt, lastObservedAt, stoodDown }),
    requiredUnhealthyMs: () => required,
    nextDelayMs: () => (streak > 0 ? timing.failureIntervalMs : timing.intervalMs),
  };
}

