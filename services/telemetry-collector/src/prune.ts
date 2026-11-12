import { formatBucketHour } from "./ingest";
import { formatUtcDay, utcMidnightMs } from "./stats";
import type { D1Database } from "./types";

export const DAILY_INSTALLS_RETENTION_DAYS = 400;
export const RATE_LIMIT_RETENTION_HOURS = 2;
/** Profile rows older than this are deleted, and so is a profile that has not submitted for this long. */
export const PROFILE_DAYS_RETENTION_DAYS = 400;
/** A profile that never submitted anything is deleted after this many days (handle squatting). */
export const PROFILE_UNUSED_RETENTION_DAYS = 14;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface PruneResult {
  deletedInstalls: number;
  deletedRateLimits: number;
  deletedProfiles: number;
  installCutoffDay: string;
  rateLimitCutoffHour: string;
}

export async function pruneCollectorTables(
  db: D1Database,
  now: number = Date.now(),
): Promise<PruneResult> {
  const installCutoffDay = formatUtcDay(
    utcMidnightMs(now) - DAILY_INSTALLS_RETENTION_DAYS * DAY_MS,
  );
  const rateLimitCutoffHour = formatBucketHour(
    now - RATE_LIMIT_RETENTION_HOURS * HOUR_MS,
  );
  const profileDaysCutoff = formatUtcDay(utcMidnightMs(now) - PROFILE_DAYS_RETENTION_DAYS * DAY_MS);
  const unusedCutoff = formatUtcDay(utcMidnightMs(now) - PROFILE_UNUSED_RETENTION_DAYS * DAY_MS);
  const staleProfiles =
    "SELECT id FROM profiles WHERE (last_submit_day IS NULL AND created_day < ?1) OR last_submit_day < ?2";
  const results = await db.batch([
    db.prepare("DELETE FROM daily_installs WHERE day < ?1").bind(installCutoffDay),
    db.prepare("DELETE FROM rate_limits WHERE bucket_hour <= ?1").bind(rateLimitCutoffHour),
    db.prepare("DELETE FROM profile_rate_limits WHERE bucket_hour <= ?1").bind(rateLimitCutoffHour),
    db.prepare(`DELETE FROM profile_day_families WHERE day < ?3 OR profile_id IN (${staleProfiles})`).bind(unusedCutoff, profileDaysCutoff, profileDaysCutoff),
    db.prepare(`DELETE FROM profile_days WHERE day < ?3 OR profile_id IN (${staleProfiles})`).bind(unusedCutoff, profileDaysCutoff, profileDaysCutoff),
    db.prepare("DELETE FROM profiles WHERE (last_submit_day IS NULL AND created_day < ?1) OR last_submit_day < ?2").bind(unusedCutoff, profileDaysCutoff),
  ]);
  return {
    deletedInstalls: Number(results[0]?.meta?.changes ?? 0),
    deletedRateLimits: Number(results[1]?.meta?.changes ?? 0),
    deletedProfiles: Number(results[5]?.meta?.changes ?? 0),
    installCutoffDay,
    rateLimitCutoffHour,
  };
}
