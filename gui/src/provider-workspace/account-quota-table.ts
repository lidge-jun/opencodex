/**
 * One row per account, one column per quota pool: the at-a-glance account table on the
 * Providers page. Pure data so the shape is testable without rendering.
 *
 * A pool is a registry entry, not a branch per provider: each entry names the window labels
 * (or standard fields) that carry its 5-hour and weekly readings, and a provider shows the
 * pools its accounts actually report.
 */

export type PoolWindow = "fiveHour" | "weekly";
export type PoolKey = "gemini" | "claudeGpt" | "argon" | "subscription";

interface QuotaWindowLike { label: string; percent: number; resetAt?: number }
export interface QuotaLike {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  customWindows?: readonly QuotaWindowLike[];
}

type Reading = { percent: number; resetAt?: number };
interface PoolSpec {
  key: PoolKey;
  /** Scarce pools are spent soonest-reset first; Gemini is effectively unlimited. */
  scarce: boolean;
  read(quota: QuotaLike): Partial<Record<PoolWindow, Reading>>;
}

const byLabel = (fiveHour: string, weekly: string) => (quota: QuotaLike) => {
  const find = (label: string) => quota.customWindows?.find(window => window.label === label);
  const out: Partial<Record<PoolWindow, Reading>> = {};
  const short = find(fiveHour);
  const long = find(weekly);
  if (short) out.fiveHour = short;
  if (long) out.weekly = long;
  return out;
};

export const QUOTA_POOLS: readonly PoolSpec[] = [
  { key: "gemini", scarce: false, read: byLabel("Gem", "Gem (Weekly)") },
  { key: "claudeGpt", scarce: true, read: byLabel("Cla", "Cla (Weekly)") },
  { key: "argon", scarce: false, read: byLabel("Argon", "Argon (Weekly)") },
  {
    key: "subscription",
    scarce: true,
    read: quota => ({
      ...(typeof quota.fiveHourPercent === "number" ? { fiveHour: { percent: quota.fiveHourPercent, resetAt: quota.fiveHourResetAt } } : {}),
      ...(typeof quota.weeklyPercent === "number" ? { weekly: { percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt } } : {}),
    }),
  },
];

/** Upstream tier ids seen in the wild, mapped to their product names. Anything else shows raw. */
const PLAN_NAMES: Readonly<Record<string, string>> = {
  "g1-pro-tier": "Pro",
  "free-tier": "Free",
  "standard-tier": "Standard",
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

/** `null` means upstream did not say; the caller renders "unknown plan" rather than a guess. */
export function planDisplayName(plan: string | null | undefined, planLabel?: string): string | null {
  if (planLabel?.trim()) return planLabel.trim();
  if (!plan?.trim()) return null;
  return PLAN_NAMES[plan.trim().toLowerCase()] ?? plan.trim();
}

export type AccountFlag = "ok" | "paused" | "reauth" | "rateLimited" | "quotaLimited" | "warning" | "probeFailed" | "slow" | "stale";

/** A probe slower than this is flagged; real Antigravity quota reads answer in about a second. */
export const SLOW_PROBE_MS = 8_000;

export interface QuotaTableAccount {
  id: string;
  label: string;
  plan?: string | null;
  planLabel?: string;
  active: boolean;
  paused: boolean;
  needsReauth?: boolean;
  health?: { status: string; reason?: string };
  quota?: QuotaLike | null;
  quotaUnavailable?: boolean;
  probe?: { status: string; latencyMs?: number };
}

export interface PoolCell {
  /** Remaining share, 0–100. */
  remaining: number;
  /** Epoch milliseconds. */
  resetAt?: number;
}

export interface QuotaTableRow {
  account: QuotaTableAccount;
  plan: string | null;
  flag: AccountFlag;
  /** Probe status when the flag came from a probe, for its label. */
  probeStatus?: string;
  cells: Partial<Record<PoolKey, Partial<Record<PoolWindow, PoolCell>>>>;
  /** Scarce pools whose soonest reset among usable accounts belongs to this row. */
  next: PoolKey[];
}

export interface QuotaTable {
  pools: PoolSpec[];
  rows: QuotaTableRow[];
}

/** Upstream resets arrive in seconds or milliseconds; QuotaBars reads them the same way. */
function toMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value > 10_000_000_000 ? value : value * 1000;
}

function clampRemaining(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function accountFlag(account: QuotaTableAccount): { flag: AccountFlag; probeStatus?: string } {
  if (account.paused) return { flag: "paused" };
  if (account.needsReauth || account.health?.status === "reauth_required") return { flag: "reauth" };
  if (account.health?.status === "cooldown") return { flag: account.health.reason === "rate_limit" ? "rateLimited" : "quotaLimited" };
  const probe = account.probe;
  if (probe && probe.status !== "ok" && probe.status !== "paused") return { flag: "probeFailed", probeStatus: probe.status };
  if (account.health?.status === "warning") return { flag: "warning" };
  if (probe?.status === "ok" && typeof probe.latencyMs === "number" && probe.latencyMs > SLOW_PROBE_MS) return { flag: "slow" };
  if (account.quotaUnavailable) return { flag: "stale" };
  return { flag: "ok" };
}

const USABLE: ReadonlySet<AccountFlag> = new Set(["ok", "slow", "stale", "warning"]);

/**
 * `strategy` is the pool's effective selection strategy. The `next` marker projects reset-first
 * ordering only, so any other (or unknown) strategy gets no marker rather than a wrong guess.
 */
export function buildQuotaTable(accounts: readonly QuotaTableAccount[], now = Date.now(), strategy?: string): QuotaTable {
  const rows: QuotaTableRow[] = accounts.map(account => {
    const cells: QuotaTableRow["cells"] = {};
    if (account.quota) {
      for (const pool of QUOTA_POOLS) {
        const readings = pool.read(account.quota);
        const cell: Partial<Record<PoolWindow, PoolCell>> = {};
        for (const window of ["fiveHour", "weekly"] as const) {
          const reading = readings[window];
          if (!reading || !Number.isFinite(reading.percent)) continue;
          const resetAt = toMs(reading.resetAt);
          cell[window] = { remaining: clampRemaining(reading.percent), ...(resetAt && resetAt > now ? { resetAt } : {}) };
        }
        if (cell.fiveHour || cell.weekly) cells[pool.key] = cell;
      }
    }
    return { account, plan: planDisplayName(account.plan, account.planLabel), ...accountFlag(account), cells, next: [] };
  });

  const pools = QUOTA_POOLS.filter(pool => rows.some(row => row.cells[pool.key]));
  // Mirror of reset-first: among accounts that can serve and still have headroom, the one whose
  // allowance expires first is used first, so nothing lapses unspent.
  for (const pool of strategy === "reset-first" ? pools.filter(spec => spec.scarce) : []) {
    let best: { row: QuotaTableRow; resetAt: number } | undefined;
    for (const row of rows) {
      const cell = row.cells[pool.key];
      if (!cell || !USABLE.has(row.flag)) continue;
      const windows = [cell.fiveHour, cell.weekly].filter((window): window is PoolCell => window !== undefined);
      if (windows.some(window => window.remaining <= 0)) continue;
      const resetAt = (cell.weekly ?? cell.fiveHour)?.resetAt;
      if (resetAt === undefined) continue;
      if (!best || resetAt < best.resetAt) best = { row, resetAt };
    }
    best?.row.next.push(pool.key);
  }
  return { pools, rows };
}

/** "45m", "3h 12m", "2d 5h"; under a minute reads "<1m". */
export function formatCountdown(resetAt: number, now = Date.now()): string {
  const minutes = Math.floor((resetAt - now) / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
