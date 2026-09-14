/**
 * Opt-in periodic catalog refresh so newly released models appear without a
 * manual `ocx sync` (issue #3630).
 *
 * This is load-bearing, not a convenience. The served model set is otherwise
 * only rewritten by an explicit sync, a management mutation, or startup
 * convergence, so an overnight provider release stays invisible until someone
 * happens to run one of those. The overnight case is the whole reason the
 * scheduler exists.
 *
 * Shape follows src/quota/reset-poller.ts: a module-singleton unref'd interval
 * whose config gate lives in the callee, so toggling `enabled` or changing the
 * cadence takes effect on the next tick without a restart (the rationale
 * spelled out at src/oauth/token-guardian.ts:276). Importing this module at
 * startup must cost nothing — src/server/background-lifecycle.ts loads it
 * statically — so the config barrel, the admission snapshot, and the
 * convergence funnel are all dynamic import()s inside the tick.
 */

/**
 * Keep these numeric literals aligned with CATALOG_AUTO_REFRESH_* in src/config.ts.
 * They cannot be imported from there: this module is a static edge from
 * background-lifecycle, and the config barrel is a heavy import reserved for the tick.
 */
const DEFAULT_INTERVAL_MS = 60 * 60_000;
const MIN_INTERVAL_MS = 15 * 60_000;
/**
 * Commit-lock wait only. Gather already has per-provider timeouts, and automatic
 * callers fail fast and defer (ConvergeRequest.mode) rather than holding the
 * write lock across a slow tick.
 */
const TICK_DEADLINE_MS = 1_000;

let timer: ReturnType<typeof setInterval> | null = null;
let detachShutdownHook: (() => void) | null = null;
/** The bounded cadence the live timer was created with, so a tick can notice config drift. */
let liveIntervalMs: number | null = null;
/**
 * Bumped by every start and stop. A tick captures it on entry and re-checks before publishing,
 * so a converge still in flight when the timer stops cannot publish into the next generation.
 */
let generation = 0;
/** setInterval does not skip a firing while the previous callback is still awaiting. */
let inFlight = false;

/** Number of ticks that have run. Test-only observability; carries no catalog data. */
let tickCount = 0;

function boundedInterval(value: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

/** Re-arm the timer when the operator changed the cadence since it was created. */
function restartIfCadenceChanged(configured: number): void {
  if (timer === null || boundedInterval(configured) === liveIntervalMs) return;
  stopCatalogAutoRefresh();
  startCatalogAutoRefresh(configured);
}

async function tick(): Promise<void> {
  // An interval firing while the previous converge is still awaiting would stack
  // provider fetches precisely when a slow /models call is already in flight.
  if (inFlight) return;
  inFlight = true;
  const entryGeneration = generation;
  try {
    const {
      loadConfig,
      isCatalogAutoRefreshEnabled,
      resolveCatalogAutoRefreshIntervalMs,
    } = await import("../config");
    const config = loadConfig();
    if (!isCatalogAutoRefreshEnabled(config)) return;
    const configured = resolveCatalogAutoRefreshIntervalMs(config);
    // 0 is dormant: the section stays configured but this tick must not converge,
    // and the unref'd timer is left running so flipping the minutes back on is
    // picked up without a process restart.
    if (configured === 0) return;
    // A stop or restart landed while the config resolved: this tick no longer owns the timer,
    // so it must neither count as a refresh nor adopt a cadence for a generation that is gone.
    if (entryGeneration !== generation) return;
    // Adopt a changed cadence without a restart, which is why the config gate lives in the
    // callee at all. Only while this tick still owns the timer.
    restartIfCadenceChanged(configured);
    tickCount += 1;
    const [{ createManagementConvergeCodex }, { createCatalogConvergeRequest }] = await Promise.all([
      import("./management-convergence"),
      import("./catalog-admission"),
    ]);
    // A stop or restart landed while the funnel was loading: the result belongs to a
    // generation that no longer owns the timer, so it must not publish.
    if (entryGeneration !== generation) return;
    const converge = createManagementConvergeCodex(config);
    const outcome = await converge(createCatalogConvergeRequest({ deadlineMs: TICK_DEADLINE_MS }));
    if (entryGeneration !== generation) return;
    // createManagementConvergeCodex always projects catalog-only. Any other kind is a
    // funnel contract break, not something this scheduler should re-classify.
    if (outcome.kind !== "catalog-only") return;
    const { recordCatalogAutoRefreshOutcome } = await import("./catalog-refresh-status");
    recordCatalogAutoRefreshOutcome(outcome.catalogRefresh, outcome.changed);
    if (outcome.changed) {
      // Privacy scan: no provider names, model ids, paths, or account identifiers.
      console.info("[catalog-auto-refresh] served model set changed");
    }
  } catch {
    // A failed refresh is not an error worth surfacing: the next tick tries again.
  } finally {
    inFlight = false;
  }
}

/** Idempotent. A second call while running is a no-op, matching startQuotaResetPoller. */
export function startCatalogAutoRefresh(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  const bounded = boundedInterval(intervalMs);
  generation += 1;
  liveIntervalMs = bounded;
  timer = setInterval(() => void tick(), bounded);
  // Never keep the process alive for a catalog refresh.
  timer.unref?.();
  void import("../lib/optional-shutdown-hooks")
    .then(hooks => {
      detachShutdownHook = hooks.registerOptionalShutdownHook(
        "catalog-auto-refresh",
        stopCatalogAutoRefresh,
      );
    })
    .catch(() => {
      // Without the hook the unref'd timer still cannot delay exit.
    });
}

export function stopCatalogAutoRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  liveIntervalMs = null;
  generation += 1;
  detachShutdownHook?.();
  detachShutdownHook = null;
}

export function isCatalogAutoRefreshRunning(): boolean {
  return timer !== null;
}

/**
 * Adopt the operator's configured cadence at startup.
 *
 * The caller starts the scheduler synchronously with the default interval, because
 * resolving the config here would mean a static edge to ../config from a module
 * background-lifecycle imports at load time. Resolving it through import() keeps
 * that edge dynamic, at the cost of the timer running at the default for the few
 * microtasks before this settles.
 */
export async function syncCatalogAutoRefreshCadence(): Promise<void> {
  const { loadConfig, resolveCatalogAutoRefreshIntervalMs } = await import("../config");
  const configured = resolveCatalogAutoRefreshIntervalMs(loadConfig());
  // 0 is dormant: tick() already returns before converging, and the timer stays unref'd.
  if (configured === 0) return;
  restartIfCadenceChanged(configured);
}

/** Test-only: run one tick synchronously rather than waiting out the interval. */
export async function runCatalogAutoRefreshTickForTests(): Promise<void> {
  await tick();
}

export function catalogAutoRefreshTickCountForTests(): number {
  return tickCount;
}

/** Test-only: the bounded cadence the live timer is running at, or null when stopped. */
export function catalogAutoRefreshIntervalForTests(): number | null {
  return liveIntervalMs;
}

export function resetCatalogAutoRefreshForTests(): void {
  stopCatalogAutoRefresh();
  tickCount = 0;
}
