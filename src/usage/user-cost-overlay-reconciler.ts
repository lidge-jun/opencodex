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
let reconcileLiveConfig: OcxConfig | null = null;
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
 * Remember provider rows present on disk but absent from the live routing
 * config. They stay out of `liveConfig` (adding them would change the routing
 * surface), but `persistConfigUnlocked` merges them back at serialization so
 * an unrelated in-process save cannot erase the external provider or its
 * overlay.
 */
function rememberDiskOnlyProviders(live: OcxConfig, disk: OcxConfig): void {
  const preserved: Record<string, OcxProviderConfig> = {};
  if (disk.providers && live.providers) {
    for (const [name, provider] of Object.entries(disk.providers)) {
      if (!live.providers[name] && provider) preserved[name] = structuredClone(provider);
    }
  }
  setPreservedDiskOnlyProviders(Object.keys(preserved).length > 0 ? preserved : null);
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
    rememberDiskOnlyProviders(liveConfig, disk);
  }
  // Refresh from the DISK config: overlays for providers only added by the
  // external edit are display-only and must still resolve for historical rows.
  refreshUserCostOverlays(disk);
  return true;
}

/** Start the stat-based reconciler. Idempotent: a previous timer is stopped. */
export function startUserCostOverlayReconciler(
  options: { intervalMs?: number; liveConfig?: OcxConfig | null } = {},
): { stop(): void } {
  stopUserCostOverlayReconciler();
  reconcileLiveConfig = options.liveConfig ?? null;
  const intervalMs = options.intervalMs ?? USER_COST_OVERLAY_RECONCILE_INTERVAL_MS;
  reconcileTimer = setInterval(() => {
    const stamp = configStamp();
    if (!stamp) return;
    if (lastStamp && lastStamp.mtimeMs === stamp.mtimeMs && lastStamp.size === stamp.size) return;
    lastStamp = stamp;
    try {
      reconcileUserCostOverlaysFromDisk(reconcileLiveConfig);
    } catch {
      // Display-only reconciliation must never take the proxy down.
    }
  }, intervalMs);
  reconcileTimer.unref?.();
  return { stop: stopUserCostOverlayReconciler };
}

export function stopUserCostOverlayReconciler(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  reconcileLiveConfig = null;
  lastStamp = null;
}

/** Test-only reset for module-global reconciler state. */
export function resetUserCostOverlayReconcilerForTests(): void {
  stopUserCostOverlayReconciler();
}
