import { randomBytes } from "node:crypto";
import type { CircuitBreakerKind, SecurityCircuitBreaker } from "./types";
import type { SecurityDatabase } from "./db";

const ERROR_TRIP_THRESHOLD = 5;

export function breakerId(campaignId: string, kind: CircuitBreakerKind): string {
  return `brk_${campaignId}_${kind}`;
}

export function ensureBreaker(db: SecurityDatabase, campaignId: string, kind: CircuitBreakerKind, now = new Date()): SecurityCircuitBreaker {
  const existing = db.getBreaker(campaignId, kind);
  if (existing) return existing;
  const row: SecurityCircuitBreaker = {
    id: breakerId(campaignId, kind),
    campaign_id: campaignId,
    kind,
    state: "CLOSED",
    trip_count: 0,
    updated_at: now.toISOString(),
  };
  db.upsertBreaker(row);
  return row;
}

export function isBreakerOpen(db: SecurityDatabase, campaignId: string): boolean {
  return db.listBreakers(campaignId).some(b => b.state === "OPEN");
}

export function tripBreaker(
  db: SecurityDatabase,
  campaignId: string,
  kind: CircuitBreakerKind,
  now = new Date(),
): SecurityCircuitBreaker {
  const current = ensureBreaker(db, campaignId, kind, now);
  const next: SecurityCircuitBreaker = {
    ...current,
    state: "OPEN",
    trip_count: current.trip_count + 1,
    last_tripped_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  db.upsertBreaker(next);
  return next;
}

export function recordError(
  db: SecurityDatabase,
  campaignId: string,
  now = new Date(),
): SecurityCircuitBreaker | null {
  const current = ensureBreaker(db, campaignId, "error", now);
  const nextCount = current.trip_count + 1;
  const next: SecurityCircuitBreaker = {
    ...current,
    trip_count: nextCount,
    state: nextCount >= ERROR_TRIP_THRESHOLD ? "OPEN" : current.state,
    last_tripped_at: nextCount >= ERROR_TRIP_THRESHOLD ? now.toISOString() : current.last_tripped_at,
    updated_at: now.toISOString(),
    id: current.id || `brk_${randomBytes(4).toString("hex")}`,
  };
  db.upsertBreaker(next);
  return next.state === "OPEN" ? next : null;
}

export function resetBreaker(db: SecurityDatabase, campaignId: string, kind: CircuitBreakerKind, now = new Date()): void {
  const current = ensureBreaker(db, campaignId, kind, now);
  db.upsertBreaker({
    ...current,
    state: "CLOSED",
    trip_count: 0,
    last_tripped_at: undefined,
    updated_at: now.toISOString(),
  });
}
