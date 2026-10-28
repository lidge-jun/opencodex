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
 * looks fresher than the evidence under it. Its `exhausted` speaks for that window alone: true when
 * every eligible account has that window exhausted.
 *
 * An average can show headroom while no account can run (one account blocked on its 5-hour window,
 * another on its weekly), and a block can come from a window with no percentage at all (a parsed
 * CLI refusal). That routing verdict is a separate `availability` window, emitted only while the
 * pool is blocked, so its timing comes from the evidence that proves the block rather than from
 * whichever percentage window it would otherwise be attached to:
 *
 * - `availability`: every eligible account holds an unscoped exhausted window;
 * - `availability:<scope>`: every eligible account is blocked for that model scope, by the scoped
 *   window or an unscoped one, and neither the unscoped verdict nor the scoped window itself already
 *   says so.
 *
 * Its `resetsAt` is the earliest moment some account recovers (an account recovers when the last of
 * its blocking windows resets; omitted when that is unknown for every account) and its `observedAt`
 * the oldest blocking observation. An eligible account with no fresh evidence is not known to be
 * blocked, so it keeps the pool open, as routing would still try it.
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

type LiveAccount = { weight: number; windows: QuotaPoolWindow[] };

const timeMs = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

const iso = (ms: number) => new Date(ms).toISOString();

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

function averaged(live: readonly LiveAccount[]): QuotaPoolWindow[] {
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
  return [...groups].map(([id, group]) => {
    const windowSeconds = only(group.windowSeconds);
    const unit = only(group.units);
    return {
      id,
      kind: group.first.kind,
      label: group.first.label,
      usedPercent: Math.min(100, group.consumedWeight / group.totalWeight),
      ...(unit !== undefined ? { unit: unit as QuotaPoolWindow["unit"] } : {}),
      ...(group.earliestResetMs !== undefined ? { resetsAt: iso(group.earliestResetMs) } : {}),
      ...(windowSeconds !== undefined ? { windowSeconds } : {}),
      ...(group.first.scopeModel !== undefined ? { scopeModel: group.first.scopeModel } : {}),
      source: "estimated",
      observedAt: iso(group.oldestObservedMs),
      exhausted: live.every(account => account.windows.some(window => window.id === id && window.exhausted === true)),
    };
  });
}

/** The pool-wide block for one scope (undefined: every model), or null while some account can run. */
function availability(live: readonly LiveAccount[], scope: string | undefined, label: string): QuotaPoolWindow | null {
  let oldestObservedMs = Number.POSITIVE_INFINITY;
  let recoveryMs = Number.POSITIVE_INFINITY;
  for (const account of live) {
    const blocks = account.windows.filter(window => window.exhausted === true
      && (window.scopeModel === undefined || window.scopeModel === scope));
    if (blocks.length === 0) return null;
    let accountRecovery = 0;
    for (const block of blocks) {
      oldestObservedMs = Math.min(oldestObservedMs, timeMs(block.observedAt)!);
      accountRecovery = Math.max(accountRecovery, timeMs(block.resetsAt) ?? Number.POSITIVE_INFINITY);
    }
    recoveryMs = Math.min(recoveryMs, accountRecovery);
  }
  return {
    id: scope === undefined ? "availability" : `availability:${scope}`,
    kind: "custom",
    label,
    ...(Number.isFinite(recoveryMs) ? { resetsAt: iso(recoveryMs) } : {}),
    ...(scope !== undefined ? { scopeModel: scope } : {}),
    source: "estimated",
    observedAt: iso(oldestObservedMs),
    exhausted: true,
  };
}

export function pooledWindows(accounts: readonly PooledAccountInput[], now: number): QuotaPoolWindow[] {
  const live: LiveAccount[] = accounts
    .filter(account => account.eligible && Number.isFinite(account.weight) && account.weight > 0)
    .map(account => ({ weight: account.weight, windows: account.windows.filter(window => current(window, now)) }));
  if (live.length === 0) return [];
  const out = averaged(live);
  const overall = availability(live, undefined, "Pool availability");
  if (overall) return [...out, overall];
  const scopes = new Map<string, string>();
  for (const window of live.flatMap(account => account.windows)) {
    if (window.scopeModel !== undefined && !scopes.has(window.scopeModel)) scopes.set(window.scopeModel, window.label);
  }
  for (const [scope, label] of scopes) {
    const scopedOwn = live.every(account => account.windows.some(window => window.scopeModel === scope && window.exhausted === true));
    if (scopedOwn) continue;
    const blocked = availability(live, scope, `Pool availability (${label})`);
    if (blocked) out.push(blocked);
  }
  return out;
}
