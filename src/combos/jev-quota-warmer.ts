/**
 * Background quota freshness for quota-aware JEV Combos.
 *
 * A JEV Combo with `decisionQuotaSignals: true` reads the cached provider quota rows
 * synchronously (level mode to order its candidates, route mode to annotate its options) and
 * treats a row older than 30 minutes as unknown. Those rows are otherwise refreshed only when
 * someone opens the dashboard or runs `ocx provider quota`, so an unattended proxy would soon
 * decide without quota at all. This timer keeps them warm with the same unforced
 * `fetchProviderQuotaReports` call the Providers page makes, which serves its own five-minute
 * cache and joins an in-flight refresh, and never runs on the request path.
 *
 * The refresh probes every configured provider, exactly as the Providers page does. It is not
 * narrowed to the Combo's targets: the report publish replaces the whole cached row set, so a
 * partial refresh would erase every other provider's row.
 *
 * Shape follows src/quota/reset-poller.ts: a module singleton with an unref'd timer whose gate
 * lives in the tick, so saving or removing such a Combo takes effect without a restart; with no
 * such Combo a tick reads config and does nothing else. This module has no static imports:
 * src/server/background-lifecycle.ts loads it at startup, and the config barrel and the quota
 * module are reserved for the tick.
 */

/**
 * Cadence floor. With `JITTER_MS` a wait is 12 to 15 minutes, well inside the 30-minute staleness
 * bound, and several proxies do not probe in lockstep.
 */
export const JEV_QUOTA_WARM_INTERVAL_MS = 12 * 60_000;
const JITTER_MS = 3 * 60_000;
/** First tick soon after startup, when the cache is still empty. */
const INITIAL_DELAY_MS = 60_000;

export interface WarmerDeps {
  loadConfig(): { combos?: Record<string, unknown> } & Record<string, unknown>;
  refresh(config: unknown): Promise<unknown>;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let detachShutdownHook: (() => void) | null = null;
/** Bumped by every start and stop, so a tick in flight across a stop cannot reschedule. */
let generation = 0;
let inFlight: Promise<void> | null = null;
let refreshCount = 0;
/** Test-only overrides installed by `startJevQuotaWarmer`; production resolves both lazily. */
let injectedDeps: WarmerDeps | undefined;
let intervalOverrideMs: number | undefined;

/** Whether any Combo relies on warm quota rows: a quota-aware JEV Combo, in either decision mode. */
export function configNeedsJevQuotaWarmth(config: { combos?: Record<string, unknown> } | undefined): boolean {
  return Object.values(config?.combos ?? {}).some(raw => {
    if (!raw || typeof raw !== "object") return false;
    const combo = raw as Record<string, unknown>;
    return combo.strategy === "jev" && combo.decisionQuotaSignals === true;
  });
}

async function defaultDeps(): Promise<WarmerDeps> {
  const [{ loadConfig }, { fetchProviderQuotaReports }] = await Promise.all([
    import("../config"),
    import("../providers/quota"),
  ]);
  return {
    loadConfig: () => loadConfig() as unknown as ReturnType<WarmerDeps["loadConfig"]>,
    refresh: config => fetchProviderQuotaReports(config as Parameters<typeof fetchProviderQuotaReports>[0]),
  };
}

function schedule(delayMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    void runTick();
  }, delayMs);
  // Never keep the process alive for a quota refresh.
  timer.unref?.();
}

function nextDelay(): number {
  return intervalOverrideMs ?? JEV_QUOTA_WARM_INTERVAL_MS + Math.floor(Math.random() * JITTER_MS);
}

async function tick(deps?: WarmerDeps): Promise<void> {
  const entryGeneration = generation;
  try {
    const resolved = deps ?? injectedDeps ?? await defaultDeps();
    if (entryGeneration !== generation) return;
    const config = resolved.loadConfig();
    if (!configNeedsJevQuotaWarmth(config)) return;
    refreshCount += 1;
    await resolved.refresh(config);
  } catch {
    // A failed refresh leaves the last rows in place; the next tick tries again.
  }
}

/** Single flight: a tick that finds one running joins it instead of starting a second refresh. */
function runTick(deps?: WarmerDeps): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = tick(deps).finally(() => {
    inFlight = null;
    // Whichever generation started this tick, a running warmer must always have a next tick:
    // a timer that fired and joined this flight left `timer` empty, and nothing else re-arms it.
    if (running && timer === null) schedule(nextDelay());
  });
  return inFlight;
}

/**
 * Idempotent. A second call while running is a no-op. `deps` and `intervalMs` exist for tests;
 * production passes nothing and the tick resolves config and the quota module itself.
 */
export function startJevQuotaWarmer(options: {
  initialDelayMs?: number;
  intervalMs?: number;
  deps?: WarmerDeps;
} = {}): void {
  if (running) return;
  running = true;
  generation += 1;
  injectedDeps = options.deps;
  intervalOverrideMs = options.intervalMs;
  schedule(options.initialDelayMs ?? INITIAL_DELAY_MS + Math.floor(Math.random() * JITTER_MS));
  const startedGeneration = generation;
  void import("../lib/optional-shutdown-hooks")
    .then(hooks => {
      // A stop (or restart) while the import was pending owns the hook slot now.
      if (!running || generation !== startedGeneration) return;
      detachShutdownHook = hooks.registerOptionalShutdownHook("jev-quota-warmer", stopJevQuotaWarmer);
    })
    .catch(() => {
      // Without the hook the unref'd timer still cannot delay exit.
    });
}

export function stopJevQuotaWarmer(): void {
  running = false;
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  detachShutdownHook?.();
  detachShutdownHook = null;
}

export function isJevQuotaWarmerRunning(): boolean {
  return running;
}

/** Test-only: run one tick now with injected config and refresh. */
export function runJevQuotaWarmerTickForTests(deps: WarmerDeps): Promise<void> {
  return runTick(deps);
}

/** Test-only: refreshes started so far; carries no quota data. */
export function jevQuotaWarmerRefreshCountForTests(): number {
  return refreshCount;
}

export function resetJevQuotaWarmerForTests(): void {
  stopJevQuotaWarmer();
  refreshCount = 0;
  injectedDeps = undefined;
  intervalOverrideMs = undefined;
}
