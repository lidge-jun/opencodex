/**
 * Cached "is an update available?" answer for the GUI sidebar badge.
 *
 * `/api/update/check` spawns `npm view` on every call (~1s, network-bound), so a
 * sidebar that polls it would spawn a process per tick on every page of the GUI.
 * The badge instead READS the 20h version cache the CLI update prompt already
 * maintains (`~/.opencodex/version.json`).
 *
 * This is deliberately read-only: it must never trigger a registry refresh. The GUI
 * polls it, so a refresh-on-read would let repeated polls launch repeated `npm view`
 * helpers with no coalescing. Cache warming stays with `ocx start`
 * (`triggerBackgroundRefreshIfStale` in `src/update/notify.ts`) and with the explicit
 * `/api/update/check` the user reaches by clicking the sidebar update button.
 */
import { currentVersion, defaultUpdateTag, detectInstall, type Channel } from "./index";
import { isNewer, isSourceBuildVersion, readVersionCache } from "./notify";

export interface UpdateBadge {
  /** True only when a newer version exists on the current channel. */
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  /** False for source checkouts, where the GUI cannot offer a one-click update. */
  canUpdate: boolean;
  /** True when no cached registry answer exists yet, so "no update" is unproven. */
  unknown: boolean;
}

export interface UpdateBadgeDeps {
  currentVersion: () => string;
  detectInstall: () => ReturnType<typeof detectInstall>;
  readCache: (channel: Channel) => ReturnType<typeof readVersionCache>;
}

const defaultDeps: UpdateBadgeDeps = {
  currentVersion,
  detectInstall,
  readCache: readVersionCache,
};

/**
 * Read-only badge state. Source checkouts and unknown versions report no update
 * rather than a dead badge the user cannot act on.
 */
export function readUpdateBadge(deps: UpdateBadgeDeps = defaultDeps): UpdateBadge {
  const current = deps.currentVersion();
  const installer = deps.detectInstall();
  const channel = defaultUpdateTag(current);
  const base: UpdateBadge = {
    updateAvailable: false,
    currentVersion: current,
    latestVersion: null,
    channel,
    canUpdate: installer !== "source",
    unknown: true,
  };
  // A source checkout has nothing to compare against, so "unknown" is not useful there.
  if (installer === "source" || current === "?" || isSourceBuildVersion(current)) {
    return { ...base, canUpdate: false, unknown: false };
  }

  const cache = deps.readCache(channel);
  if (!cache) return base;

  return {
    ...base,
    latestVersion: cache.latest_version,
    updateAvailable: isNewer(cache.latest_version, current, channel),
    unknown: false,
  };
}
