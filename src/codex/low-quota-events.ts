/** Bounded event projection owned by one live low-quota registration. */
export type LowQuotaEvent = {
  accountId: string;
  window: "short" | "weekly";
  percentUsed: number;
  resetAt: number | null;
  timestamp: number;
  status: "pending" | "logged" | "delivered" | "succeeded" | "failed" | "cancelled";
  delivery: "notice" | "pause-save";
};

const CAPACITY = 100;

export function createLowQuotaEventLedger(): {
  publish(event: LowQuotaEvent): void;
  list(limit?: number): LowQuotaEvent[];
} {
  const events: LowQuotaEvent[] = [];
  return {
    publish(event) {
      events.unshift({ ...event });
      if (events.length > CAPACITY) events.length = CAPACITY;
    },
    list(limit = 20) {
      return events.slice(0, Math.max(0, Math.min(CAPACITY, limit))).map(event => ({ ...event }));
    },
  };
}
