export type AccountPoolStrategy = "quota" | "round-robin" | "fill-first";

export const ACCOUNT_POOL_STRATEGIES: readonly AccountPoolStrategy[] = [
  "quota",
  "round-robin",
  "fill-first",
] as const;

/** Which cached usage bar the `quota` strategy scores. Mirrors `OcxAccountPoolQuotaWindow`. */
export type AccountPoolQuotaWindow = "five-hour" | "weekly" | "max-utilization";

export const ACCOUNT_POOL_QUOTA_WINDOWS: readonly AccountPoolQuotaWindow[] = [
  "five-hour",
  "weekly",
  "max-utilization",
] as const;

export const DEFAULT_ACCOUNT_POOL_STRATEGY: AccountPoolStrategy = "quota";
export const DEFAULT_ACCOUNT_POOL_QUOTA_WINDOW: AccountPoolQuotaWindow = "five-hour";
export const DEFAULT_ACCOUNT_POOL_STICKY_LIMIT = 1;
export const MIN_ACCOUNT_POOL_STICKY_LIMIT = 1;
export const MAX_ACCOUNT_POOL_STICKY_LIMIT = 100;

const STRATEGY_SET = new Set<string>(ACCOUNT_POOL_STRATEGIES);
const QUOTA_WINDOW_SET = new Set<string>(ACCOUNT_POOL_QUOTA_WINDOWS);

export function normalizeAccountPoolStrategy(value: unknown): AccountPoolStrategy {
  return typeof value === "string" && STRATEGY_SET.has(value)
    ? value as AccountPoolStrategy
    : DEFAULT_ACCOUNT_POOL_STRATEGY;
}

export function normalizeAccountPoolQuotaWindow(value: unknown): AccountPoolQuotaWindow {
  return typeof value === "string" && QUOTA_WINDOW_SET.has(value)
    ? value as AccountPoolQuotaWindow
    : DEFAULT_ACCOUNT_POOL_QUOTA_WINDOW;
}

export function normalizeAccountPoolStickyLimit(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_ACCOUNT_POOL_STICKY_LIMIT
    && value <= MAX_ACCOUNT_POOL_STICKY_LIMIT
    ? value
    : DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
}

/** Strict draft parse for sticky-limit inputs (1–100 integer). */
export function parseAccountPoolStickyLimitDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_ACCOUNT_POOL_STICKY_LIMIT && n <= MAX_ACCOUNT_POOL_STICKY_LIMIT ? n : null;
}

export type PoolStrategyFetch = (input: string, init: RequestInit) => Promise<Response>;

export async function putCodexPoolStrategy(
  apiBase: string,
  body: { strategy?: AccountPoolStrategy; stickyLimit?: number },
  fetchImpl: PoolStrategyFetch = (input, init) => fetch(input, init),
): Promise<{ ok: true; strategy: AccountPoolStrategy; stickyLimit: number } | { ok: false }> {
  if (body.strategy === undefined && body.stickyLimit === undefined) return { ok: false };
  try {
    const response = await fetchImpl(`${apiBase}/api/codex-auth/pool-strategy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
        ...(body.stickyLimit !== undefined ? { stickyLimit: body.stickyLimit } : {}),
      }),
    });
    if (!response.ok) return { ok: false };
    const json = await response.json() as {
      accountPoolStrategy?: unknown;
      accountPoolStickyLimit?: unknown;
    };
    return {
      ok: true,
      strategy: normalizeAccountPoolStrategy(json.accountPoolStrategy ?? body.strategy),
      stickyLimit: normalizeAccountPoolStickyLimit(json.accountPoolStickyLimit ?? body.stickyLimit),
    };
  } catch {
    return { ok: false };
  }
}
