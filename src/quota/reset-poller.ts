/**
 * Opt-in idle refresh so a reset is noticed while nobody is looking.
 *
 * This is load-bearing, not a convenience. fetchProviderQuotaReports has exactly one caller
 * — the GET /api/provider-quotas route — so with no dashboard open and no CLI invocation it
 * never runs, no second snapshot exists, and an overnight reset passes unobserved. That
 * overnight case is the whole reason the subsystem exists.
 *
 * Shape follows src/storage/policy-scheduler.ts: a module-singleton unref'd interval whose
 * config gate lives in the callee, so toggling `enabled` takes effect on the next tick
 * without a restart (the rationale spelled out at src/oauth/token-guardian.ts:276).
 */

const DEFAULT_INTERVAL_MS = 15 * 60_000;
/**
 * Above the 5-minute provider cache TTL and the 10-minute per-account TTL, so one tick costs
 * at most one upstream probe per window rather than hammering a quota endpoint that
 * rate-limits (src/providers/quota.ts:1425 records an observed 429 under repeated probing).
 */
export const MIN_INTERVAL_MS = 10 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let detachShutdownHook: (() => void) | null = null;
/** The bounded cadence the live timer was created with, so a tick can notice config drift. */
let liveIntervalMs: number | null = null;
/**
 * Bumped by every start and stop. A tick captures it on entry and re-checks before publishing,
 * so a probe still in flight when the poller stops cannot publish into the next generation.
 */
let generation = 0;
/** setInterval does not skip a firing while the previous callback is still awaiting. */
let inFlight = false;

/** Number of ticks that have run. Test-only observability; carries no quota data. */
let tickCount = 0;

function boundedInterval(value: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

/** Re-arm the timer when the operator changed the cadence since it was created. */
function restartIfCadenceChanged(configured: number): void {
  if (timer === null || boundedInterval(configured) === liveIntervalMs) return;
  stopQuotaResetPoller();
  startQuotaResetPoller(configured);
}

async function tick(): Promise<void> {
  // An interval firing while the previous probe is still awaiting would double the upstream
  // load precisely when it is already slow.
  if (inFlight) return;
  inFlight = true;
  const entryGeneration = generation;
  try {
    const { isQuotaResetNotificationEnabled, resolveQuotaResetPollMs } = await import(
      "./reset-notify-config"
    );
    // Re-sync the sink on every tick, before the enable check bails out. This is what makes
    // enabling or disabling notifications take effect without a restart: an install that starts
    // with the section absent has no sink, and the seams therefore skip all work, so something
    // has to notice the operator turned it on. Cheap — the resolver is mtime-cached.
    const { syncQuotaResetActivation } = await import("./reset-activation");
    await syncQuotaResetActivation();
    if (!isQuotaResetNotificationEnabled()) return;
    const configured = resolveQuotaResetPollMs();
    if (configured === 0) return;
    // A stop or restart landed while the config resolved: this tick no longer owns the timer,
    // so it must neither count as a probe nor adopt a cadence for a generation that is gone.
    if (entryGeneration !== generation) return;
    // Adopt a changed cadence without a restart, which is why the config gate lives in the
    // callee at all. Only while this tick still owns the timer.
    restartIfCadenceChanged(configured);
    tickCount += 1;
    const [{ loadConfig }, { fetchProviderQuotaReports }] = await Promise.all([
      import("../config"),
      import("../providers/quota"),
    ]);
    // A stop or restart landed while this probe was in flight: the result belongs to a
    // generation that no longer owns the timer, so it must not publish.
    if (entryGeneration !== generation) return;
    // Forced: an unforced call would be served from the 5-minute cache and produce no new
    // observation at all.
    await fetchProviderQuotaReports(loadConfig(), true);
  } catch {
    // A failed probe is not an error worth surfacing: the next tick tries again.
  } finally {
    inFlight = false;
  }
}

/** Idempotent. A second call while running is a no-op, matching startStorageCleanupScheduler. */
export function startQuotaResetPoller(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  const bounded = boundedInterval(intervalMs);
  generation += 1;
  liveIntervalMs = bounded;
  timer = setInterval(() => void tick(), bounded);
  // Never keep the process alive for a quota probe.
  timer.unref?.();
  void import("../lib/optional-shutdown-hooks")
    .then(hooks => {
      detachShutdownHook = hooks.registerOptionalShutdownHook(
        "quota-reset-poller",
        stopQuotaResetPoller,
      );
    })
    .catch(() => {
      // Without the hook the unref'd timer still cannot delay exit.
    });
}

export function stopQuotaResetPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  liveIntervalMs = null;
  generation += 1;
  detachShutdownHook?.();
  detachShutdownHook = null;
}

export function isQuotaResetPollerRunning(): boolean {
  return timer !== null;
}

/**
 * Adopt the operator's configured cadence at startup.
 *
 * The caller starts the poller synchronously with the default interval, because resolving the
 * config here would mean a static edge to ../config from a module the quota boundary guard
 * requires to have none. Resolving it through import() keeps that edge dynamic, at the cost of
 * the timer running at the default for the few microtasks before this settles.
 */
export async function syncQuotaResetPollerCadence(): Promise<void> {
  const { resolveQuotaResetPollMs } = await import("./reset-notify-config");
  const configured = resolveQuotaResetPollMs();
  // 0 is passive-only: tick() already returns before probing, and the timer stays unref'd.
  if (configured === 0) return;
  restartIfCadenceChanged(configured);
}

/** Test-only: run one tick synchronously rather than waiting out the interval. */
export async function runQuotaResetPollerTickForTests(): Promise<void> {
  await tick();
}

export function quotaResetPollerTickCountForTests(): number {
  return tickCount;
}

/** Test-only: the bounded cadence the live timer is running at, or null when stopped. */
export function quotaResetPollerIntervalForTests(): number | null {
  return liveIntervalMs;
}

export function resetQuotaResetPollerForTests(): void {
  stopQuotaResetPoller();
  tickCount = 0;
}
