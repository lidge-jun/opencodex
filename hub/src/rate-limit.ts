import type { Database } from "bun:sqlite";
import { hmacDigest } from "./security";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class HubRateLimiter {
  constructor(private readonly db: Database, private readonly digestSecret: string) {}

  consume(scope: string, subject: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    if (!/^[a-z0-9._:-]{1,80}$/.test(scope) || !subject || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1_000) {
      throw new Error("invalid_rate_limit_policy");
    }
    const subjectDigest = hmacDigest(this.digestSecret, `rate-limit:${scope}`, subject);
    const update = this.db.transaction(() => {
      const row = this.db.query(`SELECT request_count, window_started_at, blocked_until
        FROM hub_rate_limits WHERE scope = ? AND subject_digest = ?`)
        .get(scope, subjectDigest) as { request_count: number; window_started_at: number; blocked_until: number } | null;
      if (row?.blocked_until && row.blocked_until > now) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((row.blocked_until - now) / 1000)) };
      }
      const withinWindow = Boolean(row && now - row.window_started_at < windowMs);
      const requestCount = withinWindow && row ? row.request_count + 1 : 1;
      const windowStartedAt = withinWindow && row ? row.window_started_at : now;
      const blockedUntil = requestCount > limit ? windowStartedAt + windowMs : 0;
      this.db.query(`INSERT INTO hub_rate_limits(scope, subject_digest, request_count, window_started_at, blocked_until)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(scope, subject_digest) DO UPDATE SET
          request_count = excluded.request_count,
          window_started_at = excluded.window_started_at,
          blocked_until = excluded.blocked_until`)
        .run(scope, subjectDigest, requestCount, windowStartedAt, blockedUntil);
      return blockedUntil > now
        ? { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) }
        : { allowed: true, retryAfterSeconds: 0 };
    });
    return update();
  }
}
