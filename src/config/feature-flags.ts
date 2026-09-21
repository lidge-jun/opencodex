import type { OcxConfig } from "../types";

export function websocketsEnabled(config: Pick<OcxConfig, "websockets">): boolean {
  return config.websockets === true;
}

/**
 * Opt-in Ultra Fast, read with the house `=== true` idiom so an absent key and a
 * malformed one both mean off.
 */
export function ultraFastTierEnabled(config: Pick<OcxConfig, "ultraFastTier">): boolean {
  return config.ultraFastTier === true;
}

/** Default-off aggregate request metrics; activation is fixed for one server process lifetime. */
export function metricsExportEnabled(config: Pick<OcxConfig, "metricsExport">): boolean {
  return config.metricsExport?.enabled === true;
}

/**
 * Default cadence for the opt-in catalog auto-refresh (issue #3630): one converge pass
 * per hour. Each pass spends a live /models call against every enabled provider, and
 * provider catalogs are themselves cached upstream for minutes, so an hour is fresh
 * enough for newly released models to appear without an `ocx sync`.
 */
export const CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS: number = 60 * 60_000;

/**
 * Floor under the configured cadence, for the same reason src/quota/reset-poller.ts has
 * MIN_INTERVAL_MS: below this the refresh buys no freshness — upstream caches have not
 * moved — and only multiplies the chance of a rate limit across every enabled provider.
 */
export const CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS: number = 15 * 60_000;

/**
 * Opt-in master switch, read with the house `=== true` idiom so an absent key and a
 * malformed one both mean off. Pure on purpose: the scheduler calls this from a
 * dynamically imported context, so it takes an explicit config slice and reads nothing
 * global.
 */
export function isCatalogAutoRefreshEnabled(
  config: Pick<OcxConfig, "catalogAutoRefresh">,
): boolean {
  return config.catalogAutoRefresh?.enabled === true;
}

/**
 * Resolved tick interval in milliseconds. An explicit `intervalMinutes: 0` returns 0 —
 * the section stays configured but the timer stays dormant — and any other value is
 * clamped up to CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS so a hand edit cannot outrun the
 * upstream catalog caches. Absent means the hourly default.
 */
export function resolveCatalogAutoRefreshIntervalMs(
  config: Pick<OcxConfig, "catalogAutoRefresh">,
): number {
  const minutes = config.catalogAutoRefresh?.intervalMinutes;
  if (minutes === undefined) return CATALOG_AUTO_REFRESH_DEFAULT_INTERVAL_MS;
  if (minutes === 0) return 0;
  return Math.max(CATALOG_AUTO_REFRESH_MIN_INTERVAL_MS, Math.floor(minutes * 60_000));
}
