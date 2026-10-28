/**
 * The pooled windows of one provider, computed from the account windows this Home already holds.
 *
 * Pure: no cache, store or clock is read here. The caller hands in each account's mapped windows
 * (an elapsed window is already gone) with its routing eligibility and capacity weight, so the pool
 * no longer depends on whether an active provider-quota read happened to warm the report cache.
 *
 * Per window id, over the accounts automatic routing may pick, with fresh readings only:
 *
 *   usedPercent = Σ(weight × usedPercent) / Σ(weight)
 *
 * which is the same configured-weight estimate `aggregateCodexPoolCapacity` gives the dashboard,
 * with the same freshness bound. A window with no reading, a reading older than that bound, or a
 * reset that has passed never contributes, so unknown is never averaged in as 0%. The result is
 * `estimated`, and its `observedAt` is the oldest contributing observation: a pooled window never
 * looks fresher than the evidence under it.
 *
 * An average can show headroom while no account can run (one account blocked on its 5-hour window,
 * another on its weekly). `exhausted` therefore states the routing verdict separately: true when
 * every eligible account is known to be blocked for this window, by the window itself or by an
 * unscoped exhausted window of its own. An eligible account with no fresh evidence is not known to
 * be blocked, so it keeps the pool open, as routing would still try it.
 */
import { CODEX_CAPACITY_MAX_QUOTA_AGE_MS } from "../providers/codex-capacity";
import type { QuotaPoolWindow } from "./contract";

export interface PooledAccountInput {
  /** In automatic routing: not paused, not awaiting reauth, not excluded by routing policy. */
  eligible: boolean;
  /** Configured capacity weight; plan-calibrated for Codex, 1 where no calibration exists. */
  weight: number;
  windows: readonly QuotaPoolWindow[];
}

interface Group {
  first: QuotaPoolWindow;
  totalWeight: number;
  consumedWeight: number;
  oldestObservedMs: number;
  earliestResetMs?: number;
  windowSeconds: Set<number | undefined>;
  units: Set<string | undefined>;
}

const timeMs = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/** A reading inside the capacity freshness bound whose window has not reset yet. */
function current(window: QuotaPoolWindow, now: number): boolean {
  const observed = timeMs(window.observedAt);
  if (observed === undefined || now - observed > CODEX_CAPACITY_MAX_QUOTA_AGE_MS) return false;
  const reset = timeMs(window.resetsAt);
  return reset === undefined || reset > now;
}

function only<T>(values: Set<T>): T | undefined {
  return values.size === 1 ? values.values().next().value : undefined;
}

export function pooledWindows(accounts: readonly PooledAccountInput[], now: number): QuotaPoolWindow[] {
  const live = accounts
    .filter(account => account.eligible && Number.isFinite(account.weight) && account.weight > 0)
    .map(account => ({ weight: account.weight, windows: account.windows.filter(window => current(window, now)) }));
  const groups = new Map<string, Group>();
  for (const account of live) {
    for (const window of account.windows) {
      if (window.usedPercent === undefined) continue;
      const group = groups.get(window.id) ?? {
        first: window, totalWeight: 0, consumedWeight: 0, oldestObservedMs: Number.POSITIVE_INFINITY,
        windowSeconds: new Set(), units: new Set(),
      };
      group.totalWeight += account.weight;
      group.consumedWeight += account.weight * window.usedPercent;
      group.oldestObservedMs = Math.min(group.oldestObservedMs, timeMs(window.observedAt)!);
      const reset = timeMs(window.resetsAt);
      if (reset !== undefined) group.earliestResetMs = Math.min(group.earliestResetMs ?? reset, reset);
      group.windowSeconds.add(window.windowSeconds);
      group.units.add(window.unit);
      groups.set(window.id, group);
    }
  }
  const blockedOverall = live.map(account => account.windows.some(window => window.exhausted === true && window.scopeModel === undefined));
  const out: QuotaPoolWindow[] = [];
  for (const [id, group] of groups) {
    const exhausted = live.every((account, index) => blockedOverall[index]
      || account.windows.some(window => window.id === id && window.exhausted === true));
    const windowSeconds = only(group.windowSeconds);
    const unit = only(group.units);
    const pooled: QuotaPoolWindow = {
      id,
      kind: group.first.kind,
      label: group.first.label,
      usedPercent: Math.min(100, group.consumedWeight / group.totalWeight),
      ...(unit !== undefined ? { unit: unit as QuotaPoolWindow["unit"] } : {}),
      ...(group.earliestResetMs !== undefined ? { resetsAt: new Date(group.earliestResetMs).toISOString() } : {}),
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
      ...(group.first.scopeModel !== undefined ? { scopeModel: group.first.scopeModel } : {}),
      source: "estimated",
      observedAt: new Date(group.oldestObservedMs).toISOString(),
      exhausted,
    };
    out.push(pooled);
  }
  return out;
}
