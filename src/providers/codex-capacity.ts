import { codexPlanKey, codexPlanValue } from "../codex/plan";

export const CODEX_CONFIGURED_CAPACITY_WEIGHTS = {
  plus: 1,
  team: 1,
  business: 1,
  prolite: 5,
  pro: 20,
} as const;

/**
 * Weight for a plan the map above has not calibrated.
 *
 * `CodexAccount.plan` is an unrestricted upstream string and cannot be enumerated: the
 * bundled model snapshot alone carries 21 distinct plan names (`edu_plus`, `finserv`,
 * `k12`, `quorum`, `self_serve_business_usage_based`, …) against the five listed above.
 * Treating an unlisted plan as unknown dropped the account from the estimate entirely and
 * reported "incomplete coverage" — which is how a Business seat upgraded to Premium
 * disappeared from its own capacity report (#3155), and it was already happening to the
 * other sixteen snapshot plans without anyone noticing.
 *
 * `src/codex/quota.ts` reached the same conclusion about the same field: an allowlist is a
 * list of the plans someone remembered. Counting an unfamiliar plan at the baseline seat
 * weight — the value `plus`, `team`, and `business` already carry — under-states a large
 * seat, which is a visibly conservative estimate. Excluding it silently overstates coverage
 * the operator does not have, which is worse.
 *
 * Uncalibrated plans are still counted in `unknownPlanAccounts` so the estimate's
 * uncertainty stays on screen.
 */
export const CODEX_DEFAULT_CAPACITY_WEIGHT = 1;

/** Match the provider-report last-good freshness bound. */
export const CODEX_CAPACITY_MAX_QUOTA_AGE_MS = 30 * 60_000;

export type CodexCapacityQuota = {
  fiveHourPercent?: number;
  fiveHourResetAt?: number;
  weeklyPercent?: number;
  weeklyResetAt?: number;
  monthlyPercent?: number;
  monthlyResetAt?: number;
  customWindows?: Array<{ label: string; percent: number; resetAt?: number }>;
  updatedAt: number;
};

export interface CodexCapacityAccount {
  isMain: boolean;
  active?: boolean;
  plan?: unknown;
  paused: boolean;
  needsReauth?: boolean;
  quota: CodexCapacityQuota | null;
}

export interface CodexCapacityWindowAggregation {
  usedPercent: number;
  includedAccounts: number;
  excludedAccounts: number;
  incomplete: boolean;
  /** Internal calculation evidence; stripped from the management API response. */
  totalWeight?: number;
  /** Internal calculation evidence; stripped from the management API response. */
  consumedWeight?: number;
  /** Internal calculation evidence; stripped from the management API response. */
  remainingWeight?: number;
  updatedAt: number;
  nextRecoveryAt?: number;
  nextRecoveryPercent?: number;
}

export interface CodexCapacityAggregation {
  kind: "capacity-weighted-v1";
  scope: "routable-known";
  includedAccounts: number;
  excludedAccounts: number;
  unknownPlanAccounts: number;
  missingQuotaAccounts: number;
  pausedAccounts: number;
  reauthAccounts: number;
  staleQuotaAccounts: number;
  partialWindowAccounts: number;
  incomplete: boolean;
  presentation?: "aggregate" | "effective-account-fallback" | "coverage-only";
  fiveHour?: CodexCapacityWindowAggregation;
  weekly?: CodexCapacityWindowAggregation;
  monthly?: CodexCapacityWindowAggregation;
  customWindows?: Array<CodexCapacityWindowAggregation & { label: string }>;
  currentAccount?: {
    isMain: boolean;
    plan?: string | null;
    quota: CodexCapacityQuota | null;
  };
}

export interface CodexCapacityResult {
  quota: CodexCapacityQuota | null;
  aggregation: CodexCapacityAggregation | null;
  currentAccount?: CodexCapacityAggregation["currentAccount"];
}

type MutableWindow = {
  totalWeight: number;
  consumedWeight: number;
  includedAccounts: number;
  recoveries: Map<number, number>;
  oldestUpdatedAt: number;
};

/** True when this plan has a calibrated weight rather than falling back to the default. */
function isCalibratedPlan(plan: unknown): boolean {
  const normalized = codexPlanKey(plan);
  return !!normalized && Object.hasOwn(CODEX_CONFIGURED_CAPACITY_WEIGHTS, normalized);
}

function configuredWeight(plan: unknown): number {
  const normalized = codexPlanKey(plan);
  return normalized && Object.hasOwn(CODEX_CONFIGURED_CAPACITY_WEIGHTS, normalized)
    ? CODEX_CONFIGURED_CAPACITY_WEIGHTS[normalized as keyof typeof CODEX_CONFIGURED_CAPACITY_WEIGHTS]
    : CODEX_DEFAULT_CAPACITY_WEIGHT;
}

function normalizedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined;
}

function futureResetMs(value: unknown, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value > 10_000_000_000 ? value : value * 1000;
  return milliseconds > now ? milliseconds : undefined;
}

function hasKnownQuotaWindow(quota: CodexCapacityQuota | null): quota is CodexCapacityQuota {
  if (!quota) return false;
  return normalizedPercent(quota.fiveHourPercent) !== undefined
    || normalizedPercent(quota.weeklyPercent) !== undefined
    || normalizedPercent(quota.monthlyPercent) !== undefined
    || !!quota.customWindows?.some(window => normalizedPercent(window.percent) !== undefined);
}

function currentQuotaForDisplay(account: CodexCapacityAccount, now: number): CodexCapacityQuota | null {
  const quota = account.quota;
  const fresh = !!quota
    && Number.isFinite(quota.updatedAt)
    && now - quota.updatedAt <= CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
  return !account.paused && !account.needsReauth && fresh && hasKnownQuotaWindow(quota) ? quota : null;
}

function addWindow(
  windows: Map<string, MutableWindow>,
  key: string,
  weight: number,
  percent: number,
  resetAt: number | undefined,
  updatedAt: number,
): void {
  const window = windows.get(key) ?? {
    totalWeight: 0,
    consumedWeight: 0,
    includedAccounts: 0,
    recoveries: new Map<number, number>(),
    oldestUpdatedAt: updatedAt,
  };
  const consumed = weight * percent / 100;
  window.totalWeight += weight;
  window.consumedWeight += consumed;
  window.includedAccounts += 1;
  window.oldestUpdatedAt = Math.min(window.oldestUpdatedAt, updatedAt);
  if (resetAt !== undefined && consumed > 0) {
    window.recoveries.set(resetAt, (window.recoveries.get(resetAt) ?? 0) + consumed);
  }
  windows.set(key, window);
}

function finalizeWindow(window: MutableWindow, totalAccounts: number): CodexCapacityWindowAggregation {
  const nextRecoveryAt = [...window.recoveries.keys()].sort((a, b) => a - b)[0];
  const recovered = nextRecoveryAt === undefined ? undefined : window.recoveries.get(nextRecoveryAt);
  return {
    usedPercent: window.consumedWeight / window.totalWeight * 100,
    includedAccounts: window.includedAccounts,
    excludedAccounts: totalAccounts - window.includedAccounts,
    incomplete: window.includedAccounts < totalAccounts,
    totalWeight: window.totalWeight,
    consumedWeight: window.consumedWeight,
    remainingWeight: window.totalWeight - window.consumedWeight,
    updatedAt: window.oldestUpdatedAt,
    ...(nextRecoveryAt !== undefined ? { nextRecoveryAt } : {}),
    ...(recovered !== undefined ? { nextRecoveryPercent: recovered / window.totalWeight * 100 } : {}),
  };
}

/** Display-only configured-weight estimate. It never participates in account selection or routing. */
export function aggregateCodexPoolCapacity(
  accounts: readonly CodexCapacityAccount[],
  now = Date.now(),
): CodexCapacityResult {
  const current = accounts.find(account => account.active)
    ?? accounts.find(account => account.isMain)
    ?? accounts[0];
  const currentPlan = codexPlanValue(current?.plan);
  const currentAccount = current ? {
    isMain: current.isMain,
    ...(currentPlan !== undefined ? { plan: currentPlan } : {}),
    quota: currentQuotaForDisplay(current, now),
  } : undefined;
  const windows = new Map<string, MutableWindow>();
  const included = new Set<CodexCapacityAccount>();
  const contributions = new Map<CodexCapacityAccount, Set<string>>();
  let unknownPlanAccounts = 0;
  let missingQuotaAccounts = 0;
  let pausedAccounts = 0;
  let reauthAccounts = 0;
  let staleQuotaAccounts = 0;

  for (const account of accounts) {
    const weight = configuredWeight(account.plan);
    // Still reported, so the operator can see the estimate is conservative for this seat —
    // but no longer a reason to drop the account from the aggregate (#3155).
    if (!isCalibratedPlan(account.plan)) unknownPlanAccounts += 1;
    if (account.paused) pausedAccounts += 1;
    if (account.needsReauth) reauthAccounts += 1;
    const quota = account.quota;
    const quotaFresh = !!quota
      && Number.isFinite(quota.updatedAt)
      && now - quota.updatedAt <= CODEX_CAPACITY_MAX_QUOTA_AGE_MS;
    if (quota && !quotaFresh) staleQuotaAccounts += 1;
    const standard = quota ? [
      ["fiveHour", quota.fiveHourPercent, quota.fiveHourResetAt],
      ["weekly", quota.weeklyPercent, quota.weeklyResetAt],
      ["monthly", quota.monthlyPercent, quota.monthlyResetAt],
    ] as const : [];
    const custom = quota?.customWindows ?? [];
    const hasQuota = hasKnownQuotaWindow(quota);
    if (!hasQuota) missingQuotaAccounts += 1;
    if (account.paused || account.needsReauth || !quota || !hasQuota || !quotaFresh) continue;

    let contributed = false;
    const contributionKeys = new Set<string>();
    for (const [key, rawPercent, rawReset] of standard) {
      const percent = normalizedPercent(rawPercent);
      if (percent === undefined) continue;
      addWindow(windows, key, weight, percent, futureResetMs(rawReset, now), quota.updatedAt);
      contributionKeys.add(key);
      contributed = true;
    }
    for (const customWindow of custom) {
      const percent = normalizedPercent(customWindow.percent);
      if (percent === undefined) continue;
      addWindow(windows, `custom:${customWindow.label}`, weight, percent, futureResetMs(customWindow.resetAt, now), quota.updatedAt);
      contributionKeys.add(`custom:${customWindow.label}`);
      contributed = true;
    }
    if (contributed) {
      included.add(account);
      contributions.set(account, contributionKeys);
    }
  }

  if (windows.size === 0) {
    if (accounts.length === 0) return { quota: null, aggregation: null, ...(currentAccount ? { currentAccount } : {}) };
    const aggregation: CodexCapacityAggregation = {
      kind: "capacity-weighted-v1",
      scope: "routable-known",
      includedAccounts: 0,
      excludedAccounts: accounts.length,
      unknownPlanAccounts,
      missingQuotaAccounts,
      pausedAccounts,
      reauthAccounts,
      staleQuotaAccounts,
      partialWindowAccounts: 0,
      incomplete: true,
      ...(currentAccount ? { currentAccount } : {}),
    };
    return { quota: null, aggregation, ...(currentAccount ? { currentAccount } : {}) };
  }
  const fiveHour = windows.get("fiveHour") ? finalizeWindow(windows.get("fiveHour")!, accounts.length) : undefined;
  const weekly = windows.get("weekly") ? finalizeWindow(windows.get("weekly")!, accounts.length) : undefined;
  const monthly = windows.get("monthly") ? finalizeWindow(windows.get("monthly")!, accounts.length) : undefined;
  const customWindows = [...windows.entries()].flatMap(([key, window]) => key.startsWith("custom:")
    ? [{ label: key.slice("custom:".length), ...finalizeWindow(window, accounts.length) }]
    : []);
  const quota: CodexCapacityQuota = {
    ...(fiveHour ? { fiveHourPercent: fiveHour.usedPercent } : {}),
    ...(weekly ? { weeklyPercent: weekly.usedPercent } : {}),
    ...(monthly ? { monthlyPercent: monthly.usedPercent } : {}),
    ...(customWindows.length > 0 ? {
      customWindows: customWindows.map(window => ({ label: window.label, percent: window.usedPercent })),
    } : {}),
    updatedAt: Math.min(
      ...[fiveHour, weekly, monthly, ...customWindows]
        .flatMap(window => window ? [window.updatedAt] : []),
    ),
  };
  const visibleWindowKeys = [...windows.keys()];
  const partialWindowAccounts = accounts.filter(account => {
    const keys = contributions.get(account);
    return !!keys && visibleWindowKeys.some(key => !keys.has(key));
  }).length;
  const excludedAccounts = accounts.length - included.size;
  const aggregation: CodexCapacityAggregation = {
    kind: "capacity-weighted-v1",
    scope: "routable-known",
    includedAccounts: included.size,
    excludedAccounts,
    unknownPlanAccounts,
    missingQuotaAccounts,
    pausedAccounts,
    reauthAccounts,
    staleQuotaAccounts,
    partialWindowAccounts,
    incomplete: excludedAccounts > 0 || partialWindowAccounts > 0,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(monthly ? { monthly } : {}),
    ...(customWindows.length > 0 ? { customWindows } : {}),
    ...(currentAccount ? { currentAccount } : {}),
  };
  return { quota, aggregation, ...(currentAccount ? { currentAccount } : {}) };
}
