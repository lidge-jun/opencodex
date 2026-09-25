/** The badge only reads package cache. Server and explicit checks produce it;
 * missing, wrong-channel, and 40-hour-old cache answers are unknown. */
import { currentVersion, defaultUpdateTag, detectInstall, type Channel } from "./index";
import { CACHE_MAX_AGE_MS, isNewer, isSourceBuildVersion, readVersionCache } from "./notify";

export interface UpdateBadge {
  /** True only when a newer version exists on the current channel. */
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  channel: Channel;
  installer: ReturnType<typeof detectInstall> | "desktop";
  /** False for source checkouts, where the GUI cannot offer a one-click update. */
  canUpdate: boolean;
  /** True when no cached registry answer exists yet, so "no update" is unproven. */
  unknown: boolean;
}

export interface UpdateBadgeDeps {
  currentVersion: () => string;
  detectInstall: () => ReturnType<typeof detectInstall>;
  readCache: (channel: Channel) => ReturnType<typeof readVersionCache>;
  now?: () => number;
}

const defaultDeps: UpdateBadgeDeps = {
  currentVersion,
  detectInstall,
  readCache: readVersionCache,
  now: Date.now,
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
    installer,
    canUpdate: installer !== "source" && installer !== "mise",
    unknown: true,
  };
  // A source checkout has nothing to compare against, so "unknown" is not useful there.
  if (installer === "source" || current === "?" || isSourceBuildVersion(current)) {
    return { ...base, canUpdate: false, unknown: false };
  }

  const cache = deps.readCache(channel);
  if (!cache) return base;
  const checked = Date.parse(cache.last_checked_at);
  const now = deps.now?.() ?? Date.now();
  if (!Number.isFinite(checked) || checked > now || now - checked >= CACHE_MAX_AGE_MS) return base;

  return {
    ...base,
    latestVersion: cache.latest_version,
    updateAvailable: isNewer(cache.latest_version, current, channel),
    unknown: false,
  };
}
