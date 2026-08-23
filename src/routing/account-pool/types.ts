export const ACCOUNT_POOL_MAX_FAILOVERS = 3;

export type AccountPoolPickReason =
  | "affinity"
  | "active"
  | "lowest-usage"
  | "round-robin"
  | "fill-first"
  | "only-eligible"
  | "none"
  | "all-cooled"
  | "disabled";

export interface AccountPoolPlugin {
  readonly poolKey: string;
  sessionKeyFromRequest(input: {
    sessionIdHeader?: string | null;
    threadIdHeader?: string | null;
    clientThreadId?: string | null;
    promptCacheKey?: string | null;
    promptCacheKeyIsSharedCohort?: boolean;
  }): string | null;
  listEligibleAccountIds(now: number): string[];
  usageScore?(accountId: string): number;
}

export interface CooldownRegistry {
  set(accountId: string, until: number, meta?: { source?: string; reason?: string }): void;
  get(accountId: string, now?: number): { until: number; reason?: string; source?: string } | null;
  clear(accountId: string): void;
  sweep(now?: number): number;
}
