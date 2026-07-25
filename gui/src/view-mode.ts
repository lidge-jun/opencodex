/** Canonical Classic/Workspace preference for the GUI sidebar and supporting pages. */

export type ViewMode = "classic" | "workspace";

export const GLOBAL_VIEW_KEY = "ocx-global-view";
/** Prior canonical key from an earlier revision of this PR; still accepted once. */
export const LEGACY_GLOBAL_VIEW_KEY = "ocx-view";

export const LEGACY_PROVIDERS_VIEW_KEY = "ocx-providers-view";
export const LEGACY_DASHBOARD_VIEW_KEY = "ocx-dashboard-view";

export const LEGACY_PAGE_VIEW_KEYS: readonly string[] = [
  LEGACY_PROVIDERS_VIEW_KEY,
  "ocx-subagents-view",
  "ocx-storage-view",
  "ocx-codexauth-view",
  "ocx-apikeys-view",
  "ocx-claudecode-view",
  "ocx-usage-view",
  "ocx-logs-view",
  "ocx-models-view",
  LEGACY_DASHBOARD_VIEW_KEY,
];

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function isViewMode(value: string | null): value is ViewMode {
  return value === "classic" || value === "workspace";
}

/** Deterministic migration when the canonical key is missing. */
export function migrateLegacyViewMode(storage: StorageLike): ViewMode {
  // Prefer pages that implement Workspace in this build, then classic.
  for (const key of [LEGACY_DASHBOARD_VIEW_KEY, LEGACY_PROVIDERS_VIEW_KEY] as const) {
    const value = storage.getItem(key);
    if (isViewMode(value)) return value;
  }
  return "classic";
}

/** Read the canonical mode without writing. */
export function readViewMode(storage: StorageLike = localStorage): ViewMode {
  try {
    const global = storage.getItem(GLOBAL_VIEW_KEY);
    if (isViewMode(global)) return global;
    const legacyGlobal = storage.getItem(LEGACY_GLOBAL_VIEW_KEY);
    if (isViewMode(legacyGlobal)) return legacyGlobal;
    return migrateLegacyViewMode(storage);
  } catch {
    return "classic";
  }
}

/** Persist canonical mode and keep legacy per-page keys in sync for deep links. */
export function writeViewMode(mode: ViewMode, storage: StorageLike = localStorage): void {
  try {
    storage.setItem(GLOBAL_VIEW_KEY, mode);
    storage.setItem(LEGACY_GLOBAL_VIEW_KEY, mode);
    for (const key of LEGACY_PAGE_VIEW_KEYS) {
      storage.setItem(key, mode);
    }
  } catch {
    /* ignore quota / private-mode failures */
  }
}

/** One-time migrate + persist; returns the mode that was stored. */
export function ensureMigratedViewMode(storage: StorageLike = localStorage): ViewMode {
  const mode = readViewMode(storage);
  writeViewMode(mode, storage);
  return mode;
}

export function toggleViewMode(mode: ViewMode): ViewMode {
  return mode === "workspace" ? "classic" : "workspace";
}

export function providersHashForViewMode(mode: ViewMode): string {
  return mode === "workspace" ? "providers/workspace" : "providers";
}

export function viewModeFromProvidersHash(rawHash: string): ViewMode | null {
  if (rawHash === "providers/workspace") return "workspace";
  if (rawHash === "providers") return "classic";
  return null;
}

/**
 * Providers hash to passively replace when the global Classic/Workspace preference
 * changes while Providers is active. Returns null when already aligned / not on Providers.
 * Callers must use replaceHash — never navigateHash — so Back is not trapped on a
 * Classic/Workspace variant that the preference immediately rewrites.
 */
export function providersHashForGlobalViewChange(
  currentHash: string,
  nextMode: ViewMode,
  pageIsProviders: boolean,
): string | null {
  if (!pageIsProviders) return null;
  const wanted = providersHashForViewMode(nextMode);
  const raw = currentHash.replace(/^#\/?/, "");
  return raw === wanted ? null : wanted;
}
