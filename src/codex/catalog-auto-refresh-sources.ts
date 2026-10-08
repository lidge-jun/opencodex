import type { OcxConfig } from "../types";

const SOURCE_WAIT_MS = 15_000;
const PROCESS_WAIT_MS = 1_000;

/**
 * A source failure or slow roster must not prevent publication from existing evidence. The signal
 * aborts when the wait bound passes or the step ends, so a late source cannot publish afterwards.
 */
async function bestEffortSource(step: (active: () => boolean, signal: AbortSignal) => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const controller = new AbortController();
  try {
    await Promise.race([
      Promise.resolve().then(() => step(() => active, controller.signal)),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, SOURCE_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Convergence can still use the last confirmed source snapshots.
  } finally {
    active = false;
    controller.abort();
    clearTimeout(timer);
  }
}

/** Settle source observations before admission captures them; gather itself never probes. */
export async function refreshCatalogAutoRefreshSources(
  config: OcxConfig,
  current: () => boolean,
): Promise<void> {
  // Runtime selection also supplies the roster's trusted client version after an upgrade.
  await bestEffortSource(async (active, signal) => {
    const { loadBundledCodexCatalogAsync } = await import("./catalog/bundled");
    if (active() && current()) await loadBundledCodexCatalogAsync({}, () => active() && current(), signal);
  });
  if (!current()) return;
  await bestEffortSource(async active => {
    const { ensureCodexEntitlementFreshness } = await import("./model-entitlements");
    if (active() && current()) await ensureCodexEntitlementFreshness(config, { waitMs: SOURCE_WAIT_MS });
  });
  if (!current()) return;
  // The entitlement roster above is asked under the installed client version, which upstream's
  // rollout gate can hide a new model from (GPT-6.1 Sol was invisible to 0.158 on release day).
  // Discovery asks as a newer client so an unpinned native reaches the converge below.
  await bestEffortSource(async (active, signal) => {
    const { discoverCodexNativeRoster } = await import("./model-entitlements");
    // A stopped scheduler generation aborts too, so a stale tick cannot record discoveries.
    if (active() && current()) await discoverCodexNativeRoster(config, { signal, isCurrent: () => active() && current() });
  });
}

/** Observation only: running sessions own static copies and require an operator restart. */
export async function catalogAutoRefreshReloadRequired(changed = true): Promise<boolean> {
  try {
    const { listCodexAppServerProcesses, collectCodexAppServerCatalogStateWithin } = await import("./app-server-processes");
    // A cold Windows start-time walk can miss a short deadline. The changed-set hint
    // needs only the bounded process listing, so it does not depend on that walk.
    if (changed) return listCodexAppServerProcesses().length > 0;
    const status = await collectCodexAppServerCatalogStateWithin(PROCESS_WAIT_MS);
    return status.state === "stale" || status.state === "unknown";
  } catch {
    // Failure to observe a restart cannot clear a previously recorded requirement.
    return !changed;
  }
}
