import { formatBucketHour } from "./ingest";
import { formatUtcDay, utcMidnightMs } from "./stats";
import type { D1Database } from "./types";

export const DAILY_INSTALLS_RETENTION_DAYS = 400;
export const RATE_LIMIT_RETENTION_HOURS = 2;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface PruneResult {
  deletedInstalls: number;
  deletedRateLimits: number;
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
  const results = await db.batch([
    db.prepare("DELETE FROM daily_installs WHERE day < ?1").bind(installCutoffDay),
    db.prepare("DELETE FROM rate_limits WHERE bucket_hour <= ?1").bind(rateLimitCutoffHour),
  ]);
  return {
    deletedInstalls: Number(results[0]?.meta?.changes ?? 0),
    deletedRateLimits: Number(results[1]?.meta?.changes ?? 0),
    installCutoffDay,
    rateLimitCutoffHour,
  };
}
