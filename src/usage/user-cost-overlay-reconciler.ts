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
  refreshUserCostOverlays,
  setPreservedDiskOnlyProviders,
} from "./user-cost-overlays";

/** Default poll cadence for external config edits. */
export const USER_COST_OVERLAY_RECONCILE_INTERVAL_MS = 5_000;

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
const owners = new Map<symbol, OcxConfig | null>();
let lastStamp: { mtimeMs: number; size: number } | null = null;

function configStamp(): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(getConfigPath());
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
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
 * Remember provider rows present on disk but absent from every live routing
 * config. They stay out of the live configs (adding them would change the
 * routing surface), but `persistConfigUnlocked` merges them back at
 * serialization so an unrelated in-process save cannot erase the external
 * provider or its overlay.
 */
function rememberDiskOnlyProviders(liveConfigs: readonly OcxConfig[], disk: OcxConfig): void {
  const preserved: Record<string, OcxProviderConfig> = {};
  if (disk.providers) {
    const liveNames = new Set<string>();
    for (const live of liveConfigs) {
      for (const name of Object.keys(live.providers ?? {})) liveNames.add(name);
    }
    for (const [name, provider] of Object.entries(disk.providers)) {
      if (!liveNames.has(name) && provider) preserved[name] = structuredClone(provider);
    }
  }
  setPreservedDiskOnlyProviders(Object.keys(preserved).length > 0 ? preserved : null);
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
  const liveConfigs = [...owners.values()].filter(
    (config): config is OcxConfig => config !== null,
  );
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
    rememberDiskOnlyProviders([liveConfig], disk);
  }
  // Refresh from the DISK config: overlays for providers only added by the
  // external edit are display-only and must still resolve for historical rows.
  refreshUserCostOverlays(disk);
  return true;
}

function reconcileForOwners(): void {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source !== "file") return;
  const disk = diagnostics.config;
  const liveConfigs = [...owners.values()].filter((config): config is OcxConfig => config !== null);
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

/**
 * Start the stat-based reconciler. Each call registers an owner lease; the
 * shared timer starts with the first owner and stops when the last owner's
 * `stop()` releases it.
 */
export function startUserCostOverlayReconciler(
  options: { intervalMs?: number; liveConfig?: OcxConfig | null } = {},
): { stop(): void } {
  const token = Symbol("user-cost-overlay-reconciler");
  owners.set(token, options.liveConfig ?? null);
  const intervalMs = options.intervalMs ?? USER_COST_OVERLAY_RECONCILE_INTERVAL_MS;
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => {
      const stamp = configStamp();
      if (!stamp) return;
      if (lastStamp && lastStamp.mtimeMs === stamp.mtimeMs && lastStamp.size === stamp.size) return;
      lastStamp = stamp;
      try {
        reconcileForOwners();
      } catch {
        // Display-only reconciliation must never take the proxy down.
      }
    }, intervalMs);
    reconcileTimer.unref?.();
  }
  return {
    stop() {
      owners.delete(token);
      if (owners.size === 0) {
        if (reconcileTimer) clearInterval(reconcileTimer);
        reconcileTimer = null;
        lastStamp = null;
        // No live routing config remains, so nothing can keep disk-only
        // providers alive: clear the cache to prevent a later save from
        // resurrecting an externally deleted provider.
        setPreservedDiskOnlyProviders(null);
        return;
      }
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

/** Process-wide stop: releases every owner and the shared timer. */
export function stopUserCostOverlayReconciler(): void {
  owners.clear();
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  lastStamp = null;
  // No live routing config remains; drop preservation so a later save cannot
  // resurrect externally deleted providers.
  setPreservedDiskOnlyProviders(null);
}

/** Test-only reset for module-global reconciler state. */
export function resetUserCostOverlayReconcilerForTests(): void {
  stopUserCostOverlayReconciler();
}
