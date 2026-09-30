/**
 * Default-on periodic catalog refresh so newly released models appear without a
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
const INITIAL_DELAY_MS = 3 * 60_000;
/**
 * Commit-lock wait only. Gather already has per-provider timeouts, and automatic
 * callers fail fast and defer (ConvergeRequest.mode) rather than holding the
 * write lock across a slow tick.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { OcxConfig } from "../types";

const TICK_DEADLINE_MS = 1_000;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
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

/** Read only a regular file, with a byte limit even if it grows after the stat. */
function readBoundedRegularFile(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.size > maxBytes) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return length > maxBytes ? null : bytes.subarray(0, length).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A background observation must not use journaledInjectedCatalogPath(), which cleans invalid journals. */
function readJournaledCatalogPath(journalPath: string): string | null {
  const bytes = readBoundedRegularFile(journalPath, MAX_JOURNAL_BYTES);
  if (bytes === null) return null;
  try {
    const journal: unknown = JSON.parse(bytes);
    if (!journal || typeof journal !== "object" || Array.isArray(journal)) return null;
    const record = journal as Record<string, unknown>;
    return record.version === 1 && typeof record.injectedCatalogPath === "string" && record.injectedCatalogPath.trim()
      ? record.injectedCatalogPath
      : null;
  } catch {
    return null;
  }
}

function usableCatalogPath(path: string | null): string | null {
  if (!path) return null;
  const bytes = readBoundedRegularFile(path, MAX_CATALOG_BYTES);
  if (bytes === null) return null;
  try {
    const catalog: unknown = JSON.parse(bytes);
    return catalog && typeof catalog === "object" && Array.isArray((catalog as { models?: unknown }).models)
      ? path : null;
  } catch {
    return null;
  }
}

/** Testable path decision with no journal mutation or catalog write. */
export function selectDriftHealCatalogPath(
  journalPath: string,
  defaultCatalogPath: string,
  resolvePath: (path: string) => string,
): string | null {
  const recorded = readJournaledCatalogPath(journalPath);
  return usableCatalogPath(recorded ? resolvePath(recorded) : null)
    ?? usableCatalogPath(defaultCatalogPath);
}

/** Repair only the missing config roots; catalog convergence remains the later tick step. */
async function healCodexConfigDrift(config: OcxConfig, entryGeneration: number): Promise<"none" | "healed" | "not-healed"> {
  const [{ codexConfigDrift }, { JOURNAL_PATH, journaledInjectedOpenaiBaseUrl, journaledInjectedRealtimeWsBaseUrl }, { shouldSyncCodexOnStart }, { injectCodexConfig }, { DEFAULT_CATALOG_PATH, resolveCodexConfigPath }, { loadConfig }, { inspectNativeCodexOwnership }] =
    await Promise.all([
      import("./config-drift-heal"),
      import("./journal"),
      import("./desired-state"),
      import("./inject"),
      import("./paths"),
      import("../config"),
      import("../integrations/native/ownership-preflight"),
    ]);
  const capturedSettings = JSON.stringify(config);
  const current = () => entryGeneration === generation && JSON.stringify(loadConfig()) === capturedSettings;
  if (!current()) return "none";
  if (!shouldSyncCodexOnStart(config)) return "none";
  const journaled = {
    injectedOpenaiBaseUrl: journaledInjectedOpenaiBaseUrl({ readOnly: true }),
    injectedRealtimeWsBaseUrl: journaledInjectedRealtimeWsBaseUrl({ readOnly: true }),
  };
  const drift = codexConfigDrift(() => journaled);
  if (!drift.drifted) return "none";
  const { readRuntimePort } = await import("../config/process-state");
  if (!current()) return "none";
  const runtime = readRuntimePort(process.pid);
  if (!runtime) return "not-healed";
  const catalogPath = selectDriftHealCatalogPath(JOURNAL_PATH, DEFAULT_CATALOG_PATH, resolveCodexConfigPath);
  if (!current()) return "none";
  // Keep the missing routing roots visible to the next tick. Catalog-only convergence below
  // may recreate the file now, but it does not re-inject config.toml in this tick.
  if (catalogPath === null) return "not-healed";
  // Ownership is probed directly, not through admission: admission can refuse on the
  // config or generation authority before it ever inspects native ownership, and a
  // veto that rides that result would let those refusals pass on a foreign home.
  const serviceHomeOwned = () => inspectNativeCodexOwnership().ownership === "owned";
  if (!serviceHomeOwned()) return "not-healed";
  await injectCodexConfig(runtime.port, config, {
    catalogPath,
    lockTimeoutMs: TICK_DEADLINE_MS,
    beforeClientWrite: () => {
      if (!current()) throw new Error("Catalog drift heal tick is stale");
      if (!serviceHomeOwned()) throw new Error("Catalog drift heal lost service-home ownership");
    },
  }).catch(() => null);
  if (!current()) return "none";
  return codexConfigDrift(() => journaled).drifted ? "not-healed" : "healed";
}

/** Number of ticks that have run. Test-only observability; carries no catalog data. */
let tickCount = 0;

function boundedInterval(value: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.floor(value));
}

/** Re-arm the timer when the operator changed the cadence since it was created. */
function restartIfCadenceChanged(configured: number): void {
  if (timer === null || boundedInterval(configured) === liveIntervalMs) return;
  clearInterval(timer);
  liveIntervalMs = boundedInterval(configured);
  timer = setInterval(() => void tick(), liveIntervalMs);
  timer.unref?.();
}

async function tick(): Promise<void> {
  // An interval firing while the previous converge is still awaiting would stack
  // provider fetches precisely when a slow /models call is already in flight.
  if (inFlight) return;
  inFlight = true;
  const entryGeneration = generation;
  try {
    const {
      armDetachedConfigBaseline,
      loadConfig,
      isCatalogAutoRefreshEnabled,
      resolveCatalogAutoRefreshIntervalMs,
    } = await import("../config");
    const config = loadConfig();
    // Convergence can persist model-discovery fields after awaiting provider /models.
    // Arm this independently loaded snapshot as detached so the save rebases every
    // field — listener binding and disk-only keys included — against what is on disk
    // by then, and concurrent hand edits survive the tick.
    armDetachedConfigBaseline(config);
    if (!isCatalogAutoRefreshEnabled(config)) return;
    const configured = resolveCatalogAutoRefreshIntervalMs(config);
    // 0 is dormant: the section stays configured but this tick must not converge,
    // and the unref'd timer is left running so flipping the minutes back on is
    // picked up without a process restart.
    if (configured === 0) return;
    // The default-on case belongs to installs whose local Codex client this proxy manages. With
    // the integration off (or on a hub or sibling), an absent section keeps the old opt-in
    // meaning: no background converge may write the native Codex home unasked. An explicit
    // `enabled: true` still refreshes, as it did before the default flipped.
    const { shouldSyncCodexOnStart } = await import("./desired-state");
    const codexManaged = shouldSyncCodexOnStart(config);
    if (!codexManaged && config.catalogAutoRefresh?.enabled !== true) return;
    // A stop or restart landed while the config resolved: this tick no longer owns the timer,
    // so it must neither count as a refresh nor adopt a cadence for a generation that is gone.
    if (entryGeneration !== generation) return;
    // Adopt a changed cadence without a restart, which is why the config gate lives in the
    // callee at all. Only while this tick still owns the timer.
    restartIfCadenceChanged(configured);
    tickCount += 1;
    // Config-surface healing precedes catalog work: a desktop app rewrite that stripped the
    // injected routing keys leaves the catalog file untouched, so the converge below would
    // report "no change" while Codex serves its native model picker. Re-injecting through the
    // standard sync rewrites the keys, re-journals the baseline, and only runs when the
    // integration is on and this install is allowed to manage its local client.
    const heal = await healCodexConfigDrift(config, entryGeneration);
    if (entryGeneration !== generation) return;
    if (heal === "healed") {
      console.info("[catalog-auto-refresh] injected Codex config keys were rewritten externally; re-injected");
    } else if (heal === "not-healed") {
      console.info("[catalog-auto-refresh] injected Codex config keys were rewritten externally; not re-injected this tick");
    }
    const { refreshCatalogAutoRefreshSources, catalogAutoRefreshReloadRequired } =
      await import("./catalog-auto-refresh-sources");
    if (entryGeneration !== generation) return;
    // Codex sources read Codex credentials and probe its binary; only a managed client needs them.
    if (codexManaged) await refreshCatalogAutoRefreshSources(config, () => entryGeneration === generation);
    if (entryGeneration !== generation) return;
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
    const { recordCatalogAutoRefreshOutcome, lastCatalogAutoRefreshOutcome } = await import("./catalog-refresh-status");
    const reloadRequired = (outcome.changed || lastCatalogAutoRefreshOutcome()?.reloadRequired === true)
      ? await catalogAutoRefreshReloadRequired(outcome.changed) : false;
    if (entryGeneration !== generation) return;
    recordCatalogAutoRefreshOutcome(outcome.catalogRefresh, outcome.changed, reloadRequired);
    if (outcome.changed) {
      // Privacy scan: no provider names, model ids, paths, or account identifiers.
      console.info(reloadRequired
        ? "[catalog-auto-refresh] served model set changed; running Codex sessions keep the old list until restarted (ocx sync --restart-codex)"
        : "[catalog-auto-refresh] served model set changed");
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
  const startedGeneration = generation;
  initialTimer = setTimeout(() => {
    if (startedGeneration !== generation) return;
    initialTimer = null;
    return tick();
  }, INITIAL_DELAY_MS);
  initialTimer.unref?.();
  void import("../lib/optional-shutdown-hooks")
    .then(hooks => {
      if (startedGeneration !== generation) return;
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
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
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
  const entryGeneration = generation;
  const { loadConfig, resolveCatalogAutoRefreshIntervalMs } = await import("../config");
  if (entryGeneration !== generation) return;
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
