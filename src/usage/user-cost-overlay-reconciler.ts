/**
 * Cross-process reconciliation for user cost overlays.
 *
 * `refreshUserCostOverlays` is process-local by design: `ocx config set`
 * executes `saveConfig()` in the CLI process, and a direct `config.json` edit
 * runs no in-process code at all. A running proxy therefore keeps its previous
 * `activeUserCostOverlays()`/version until restart or another in-process
 * refresh.
 *
 * This module gives the long-lived server a lightweight stat-based poller:
 * when `config.json` changes on disk, it re-reads the persisted config, mirrors
 * the disk `modelCosts` rows into the live provider rows (so a later in-process
 * save cannot erase the external edit), and refreshes the overlay registry so
 * Logs/Usage estimates follow the edit without a restart.
 *
 * The reconciler is owner-scoped: every `startServer` acquires its own lease
 * (with its own live config), and the shared timer is torn down only when the
 * LAST owner stops. This mirrors `acquireServerBackgroundLifecycle` so stopping
 * one of several servers cannot kill reconciliation for the others.
 */
import { statSync } from "node:fs";

import { getConfigPath, readConfigDiagnostics } from "../config";
import type { OcxConfig, OcxProviderConfig } from "../types";
import {
  refreshPreservedProviderOwner,
  refreshUserCostOverlays,
  registerPreservedProviderOwner,
  setPreservedDiskOnlyProviders,
  unregisterPreservedProviderOwner,
} from "./user-cost-overlays";

/** Default poll cadence for external config edits. */
export const USER_COST_OVERLAY_RECONCILE_INTERVAL_MS = 5_000;

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconcileTimerMs = 0;
const owners = new Map<symbol, OcxConfig | null>();
const ownerIntervals = new Map<symbol, number>();
let lastStamp: { mtimeMs: number; size: number; ctimeMs: number; ino: number } | null = null;
let invalidReconcileCount = 0;

function configStamp(): { mtimeMs: number; size: number; ctimeMs: number; ino: number } | null {
  try {
    const stat = statSync(getConfigPath());
    return {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ctimeMs: stat.ctimeMs,
      ino: Number(stat.ino),
    };
  } catch {
    return null;
  }
}

/** Registered live configs plus an optional one-shot config, deduped by object identity. */
function liveConfigsForPreservation(extra?: OcxConfig | null): OcxConfig[] {
  const liveConfigs: OcxConfig[] = [];
  const seen = new Set<OcxConfig>();
  if (extra) {
    seen.add(extra);
    liveConfigs.push(extra);
  }
  for (const config of owners.values()) {
    if (!config || seen.has(config)) continue;
    seen.add(config);
    liveConfigs.push(config);
  }
  return liveConfigs;
}

/**
 * Mirror disk `modelCosts` rows into provider rows the live config already
 * knows. Providers added by the external edit are left out of the live config
 * (they would change the routing surface); their overlays still become active
 * because the registry below is refreshed from the disk config.
 */
function adoptDiskModelCosts(live: OcxConfig, disk: OcxConfig): void {
  if (!live.providers || !disk.providers) return;
  for (const [name, diskProvider] of Object.entries(disk.providers)) {
    const liveProvider = live.providers[name];
    if (!liveProvider) continue;
    if (diskProvider?.modelCosts === undefined) {
      delete liveProvider.modelCosts;
    } else {
      liveProvider.modelCosts = structuredClone(diskProvider.modelCosts);
    }
  }
}

/**
 * Remember provider rows present on disk that at least one live routing
 * config does NOT own. They stay out of the live configs that lack them
 * (adding them would change the routing surface), but
 * `persistConfigUnlocked` merges them back at serialization so ANY owner's
 * unrelated save preserves a provider row that another active owner owns.
 *
 * A row is preserved when it is missing from at least one live config: the
 * writer that lacks it would otherwise erase it. Rows every live config owns
 * need no protection because every writer carries them from its own config.
 */
function rememberDiskOnlyProviders(liveConfigs: readonly OcxConfig[], disk: OcxConfig): void {
  const preserved: Record<string, OcxProviderConfig> = {};
  if (disk.providers && liveConfigs.length > 0) {
    for (const [name, provider] of Object.entries(disk.providers)) {
      if (!provider) continue;
      const ownedByAll = liveConfigs.every(live => Object.hasOwn(live.providers ?? {}, name));
      if (!ownedByAll) preserved[name] = structuredClone(provider);
    }
  }
  setPreservedDiskOnlyProviders(Object.keys(preserved).length > 0 ? preserved : null);
  // Update only registered server owners. One-shot callers without a lease do
  // not become deletion authorities merely by asking for a reconciliation.
  for (const live of liveConfigs) refreshPreservedProviderOwner(live, disk);
}

/**
 * Re-read the persisted config and recompute the disk-only provider
 * preservation registry against the CURRENT owner set. Used when an owner
 * stops but others remain: a newer owner may have owned a provider that an
 * older owner still treats as disk-only, and the registry must reflect the
 * remaining owners rather than the stale pre-stop snapshot.
 *
 * A missing or transiently invalid file leaves the registry untouched so a
 * bad write cannot erase preservation state.
 */
function recomputePreservedDiskOnlyProviders(): void {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source !== "file") return;
  const liveConfigs = liveConfigsForPreservation();
  if (liveConfigs.length > 0) {
    rememberDiskOnlyProviders(liveConfigs, diagnostics.config);
  } else {
    // No live routing configuration remains to protect disk-only providers;
    // clear the cache so a later save cannot resurrect externally deleted rows.
    setPreservedDiskOnlyProviders(null);
  }
}

/**
 * Re-read the persisted config and make external overlay edits live.
 *
 * Returns `false` (and leaves the registry untouched) when the file is missing
 * or invalid, so a transient bad write cannot wipe display-only prices.
 */
export function reconcileUserCostOverlaysFromDisk(liveConfig?: OcxConfig | null): boolean {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source !== "file") return false;
  const disk = diagnostics.config;
  if (liveConfig) {
    adoptDiskModelCosts(liveConfig, disk);
    // A one-shot caller is not the whole process. Existing server owners still
    // participate in global preservation or this call can drop protection for
    // a provider absent from an older live projection.
    rememberDiskOnlyProviders(liveConfigsForPreservation(liveConfig), disk);
  } else {
    // No live routing config was supplied: mirror the owners path so a stale
    // preservation registry cannot resurrect externally deleted providers on
    // the next saveConfig. Registered owners still protect disk-only rows;
    // without any, preservation is cleared.
    const liveConfigs = liveConfigsForPreservation();
    if (liveConfigs.length > 0) {
      for (const live of liveConfigs) adoptDiskModelCosts(live, disk);
      rememberDiskOnlyProviders(liveConfigs, disk);
    } else {
      setPreservedDiskOnlyProviders(null);
    }
  }
  // Refresh from the DISK config: overlays for providers only added by the
  // external edit are display-only and must still resolve for historical rows.
  refreshUserCostOverlays(disk);
  return true;
}

function reconcileForOwners(): void {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source !== "file") {
    if (diagnostics.source === "fallback") invalidReconcileCount += 1;
    return;
  }
  const disk = diagnostics.config;
  const liveConfigs = liveConfigsForPreservation();
  if (liveConfigs.length > 0) {
    for (const live of liveConfigs) adoptDiskModelCosts(live, disk);
    rememberDiskOnlyProviders(liveConfigs, disk);
  } else {
    // Overlay-only refresh with no live routing configuration: do not treat
    // every disk provider as protected, and do not let a stale preservation
    // cache resurrect providers that were intentionally removed.
    setPreservedDiskOnlyProviders(null);
  }
  refreshUserCostOverlays(disk);
}

/** Test-only observation that proves the timer actually read an invalid config fallback. */
export function userCostOverlayInvalidReconcileCountForTests(): number {
  return invalidReconcileCount;
}

/** Smallest poll interval across all active owners (the effective cadence). */
function effectiveIntervalMs(): number {
  let min = Number.POSITIVE_INFINITY;
  for (const interval of ownerIntervals.values()) {
    if (interval < min) min = interval;
  }
  return min === Number.POSITIVE_INFINITY ? USER_COST_OVERLAY_RECONCILE_INTERVAL_MS : min;
}

/**
 * Keep the shared timer on the effective minimum cadence across owners. A
 * later owner may request a smaller interval, which restarts the timer; when
 * an owner stops, the cadence relaxes back up to the smallest still-active
 * owner's request. The timer therefore never outlives or ignores an owner's
 * faster polling need, and never polls faster than the active set requires.
 */
function syncReconcileTimer(): void {
  const intervalMs = effectiveIntervalMs();
  if (reconcileTimer && reconcileTimerMs === intervalMs) return;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = setInterval(() => {
    const stamp = configStamp();
    if (!stamp) return;
    if (
      lastStamp
      && lastStamp.mtimeMs === stamp.mtimeMs
      && lastStamp.size === stamp.size
      && lastStamp.ctimeMs === stamp.ctimeMs
      && lastStamp.ino === stamp.ino
    ) return;
    lastStamp = stamp;
    try {
      reconcileForOwners();
    } catch {
      // Display-only reconciliation must never take the proxy down.
    }
  }, intervalMs);
  reconcileTimer.unref?.();
  reconcileTimerMs = intervalMs;
}

/**
 * Start the stat-based reconciler. Each call registers an owner lease; the
 * shared timer starts with the first owner and stops when the last owner's
 * `stop()` releases it.
 */
export function startUserCostOverlayReconciler(
  options: { intervalMs?: number; liveConfig?: OcxConfig | null } = {},
): { stop(): void } {
  const token = Symbol("user-cost-overlay-reconciler");
  const liveConfig = options.liveConfig ?? null;
  owners.set(token, liveConfig);
  ownerIntervals.set(token, options.intervalMs ?? USER_COST_OVERLAY_RECONCILE_INTERVAL_MS);
  if (liveConfig) registerPreservedProviderOwner(liveConfig);
  syncReconcileTimer();
  return {
    stop() {
      const ownedConfig = owners.get(token) ?? null;
      owners.delete(token);
      ownerIntervals.delete(token);
      if (ownedConfig) unregisterPreservedProviderOwner(ownedConfig);
      if (owners.size === 0) {
        if (reconcileTimer) clearInterval(reconcileTimer);
        reconcileTimer = null;
        reconcileTimerMs = 0;
        lastStamp = null;
        // No live routing config remains, so nothing can keep disk-only
        // providers alive: clear the cache to prevent a later save from
        // resurrecting an externally deleted provider.
        setPreservedDiskOnlyProviders(null);
        return;
      }
      syncReconcileTimer();
      // Other owners remain: recompute preservation against their live
      // configs. A newer owner may have owned providers that an older owner
      // still sees as disk-only; without this recompute the older owner's next
      // unrelated save could erase them.
      try {
        recomputePreservedDiskOnlyProviders();
      } catch {
        // Preservation is display-only; a failed recompute must not break stop.
      }
    },
  };
}

/**
 * Process-wide stop: releases EVERY owner's lease and the shared timer.
 * Intended for tests and full process teardown. A per-server shutdown must
 * call its own owner-scoped `stop()` handle instead — this function would
 * otherwise tear down reconciliation (and disk-only preservation) for every
 * other server still running in the same process.
 */
export function stopUserCostOverlayReconciler(): void {
  for (const config of owners.values()) {
    if (config) unregisterPreservedProviderOwner(config);
  }
  owners.clear();
  ownerIntervals.clear();
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  reconcileTimerMs = 0;
  lastStamp = null;
  // No live routing config remains; drop preservation so a later save cannot
  // resurrect externally deleted providers.
  setPreservedDiskOnlyProviders(null);
}

/** Test-only reset for module-global reconciler state. */
export function resetUserCostOverlayReconcilerForTests(): void {
  stopUserCostOverlayReconciler();
  invalidReconcileCount = 0;
}
