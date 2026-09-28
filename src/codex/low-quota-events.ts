/** Process-local, bounded projection for authenticated management readers. */
export type LowQuotaEvent = {
  accountId: string;
  window: "short" | "weekly";
  percentUsed: number;
  resetAt: number | null;
  timestamp: number;
  status: "pending" | "delivered" | "failed" | "cancelled";
  delivery: "notice" | "pause-save";
};

const CAPACITY = 100;
const events: LowQuotaEvent[] = [];

export function publishLowQuotaEvent(event: LowQuotaEvent): void {
  events.unshift({ ...event });
  if (events.length > CAPACITY) events.length = CAPACITY;
}

export function listLowQuotaEvents(limit = 20): LowQuotaEvent[] {
  return events.slice(0, Math.max(0, Math.min(CAPACITY, limit))).map(event => ({ ...event }));
}

export function clearLowQuotaEventsForTests(): void {
  events.length = 0;
}
