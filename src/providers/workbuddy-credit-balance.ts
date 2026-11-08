import { compareWorkBuddyDecimals, formatWorkBuddyDecimal, parseWorkBuddyDecimal, roundedWorkBuddyUnavailable, subtractWorkBuddyDecimals, sumWorkBuddyDecimals, type WorkBuddyDecimal } from "./workbuddy-decimal";

export interface WorkBuddyCreditAmount {
  total: number;
  used: number;
  remaining: number;
  frozen: number;
}

export const WORKBUDDY_CREDIT_KINDS = ["plan_base", "plan_bonus", "addon", "benefit", "other"] as const;
export type WorkBuddyCreditKind = typeof WORKBUDDY_CREDIT_KINDS[number];

/** Display-only credits; they are neither USD nor provider-wide model eligibility. */
export interface WorkBuddyCreditBalance extends WorkBuddyCreditAmount {
  groups: Array<WorkBuddyCreditAmount & { kind: WorkBuddyCreditKind }>;
  expiring?: { amount: number; at: number };
  /** Optional exact display inputs; null marks malformed or inconsistent metadata. */
  exact?: { total: string; remaining: string } | null;
}

export function workBuddyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function workBuddyCapacity(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && value.length <= 384 && /^\d+(?:\.\d+)?$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : undefined;
}

/** Sum bounded numeric capacities as decimals before converting the result back to a number. */
function sumCapacities(values: readonly number[]): number {
  const parts = values.map(value => {
    const [coefficient, exponent = "0"] = value.toString().split("e");
    const [whole, fraction = ""] = coefficient!.split(".");
    let digits = BigInt(`${whole}${fraction}`);
    let scale = fraction.length - Number(exponent);
    if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
    return { digits, scale };
  });
  const scale = Math.max(0, ...parts.map(part => part.scale));
  const digits = parts.reduce((sum, part) => sum + part.digits * 10n ** BigInt(scale - part.scale), 0n);
  return Number(`${digits}e-${scale}`);
}

function sumAmounts(rows: readonly WorkBuddyCreditAmount[]): WorkBuddyCreditAmount {
  return {
    total: sumCapacities(rows.map(row => row.total)),
    used: sumCapacities(rows.map(row => row.used)),
    remaining: sumCapacities(rows.map(row => row.remaining)),
    frozen: sumCapacities(rows.map(row => row.frozen)),
  };
}

/** Remaining credits when the provider omits them, bounded below by zero. */
export function remainingWorkBuddyCredits(total: number, used: number, frozen = 0): number {
  return Math.max(0, sumCapacities([total, -used, -frozen]));
}

function amount(value: unknown): WorkBuddyCreditAmount | undefined {
  const row = workBuddyRecord(value);
  const total = workBuddyCapacity(row.total), used = workBuddyCapacity(row.used);
  const remaining = workBuddyCapacity(row.remaining), frozen = workBuddyCapacity(row.frozen);
  if (total === undefined || used === undefined || remaining === undefined || frozen === undefined) return undefined;
  return { total, used, remaining, frozen };
}

/** Narrow wire/cache input before rendering, without admitting account or package identifiers. */
export function normalizeWorkBuddyCredits(value: unknown): WorkBuddyCreditBalance | undefined {
  const row = workBuddyRecord(value), balance = amount(value);
  if (!balance || !Array.isArray(row.groups) || row.groups.length > WORKBUDDY_CREDIT_KINDS.length) return undefined;
  const groups: WorkBuddyCreditBalance["groups"] = [];
  const seen = new Set<string>();
  for (const raw of row.groups) {
    const group = workBuddyRecord(raw), quantities = amount(group);
    const kind = WORKBUDDY_CREDIT_KINDS.find(kind => kind === group.kind);
    if (!quantities || !kind || seen.has(kind)) return undefined;
    seen.add(kind); groups.push({ kind, ...quantities });
  }
  const expiring = workBuddyRecord(row.expiring), quantity = workBuddyCapacity(expiring.amount);
  const at = typeof expiring.at === "number" && expiring.at > 0 && Number.isFinite(new Date(expiring.at).getTime()) ? expiring.at : undefined;
  let exact: WorkBuddyCreditBalance["exact"];
  if (Object.hasOwn(row, "exact")) {
    const raw = workBuddyRecord(row.exact);
    const total = typeof raw.total === "string" ? parseWorkBuddyDecimal(raw.total) : undefined;
    const remaining = typeof raw.remaining === "string" ? parseWorkBuddyDecimal(raw.remaining) : undefined;
    exact = total && remaining && Number(raw.total) === balance.total && Number(raw.remaining) === balance.remaining
      ? { total: formatWorkBuddyDecimal(total), remaining: formatWorkBuddyDecimal(remaining) } : null;
  }
  return { ...balance, groups, ...(exact !== undefined ? { exact } : {}), ...(quantity !== undefined && quantity > 0 && at !== undefined ? { expiring: { amount: quantity, at } } : {}) };
}

function packageAmount(row: Record<string, unknown>): { amount: WorkBuddyCreditAmount; total: WorkBuddyDecimal; remaining: WorkBuddyDecimal } | undefined {
  const total = workBuddyCapacity(row.CycleTotalCapacity), used = workBuddyCapacity(row.CycleUsedCapacity);
  const frozen = row.CycleFrozenCapacity === undefined ? 0 : workBuddyCapacity(row.CycleFrozenCapacity);
  const totalDecimal = parseWorkBuddyDecimal(row.CycleTotalCapacity), usedDecimal = parseWorkBuddyDecimal(row.CycleUsedCapacity);
  const frozenDecimal = parseWorkBuddyDecimal(row.CycleFrozenCapacity ?? 0);
  if (total === undefined || used === undefined || frozen === undefined || !totalDecimal || !usedDecimal || !frozenDecimal) return undefined;
  const remainingDecimal = row.CycleRemainCapacity === undefined
    ? subtractWorkBuddyDecimals(totalDecimal, usedDecimal, frozenDecimal) : parseWorkBuddyDecimal(row.CycleRemainCapacity);
  if (!remainingDecimal || (row.CycleRemainCapacity !== undefined && workBuddyCapacity(row.CycleRemainCapacity) === undefined)) return undefined;
  return { amount: { total, used, remaining: Number(formatWorkBuddyDecimal(remainingDecimal)), frozen }, total: totalDecimal, remaining: remainingDecimal };
}

export function parseWorkBuddyCredits(value: unknown): WorkBuddyCreditBalance | undefined {
  const summary = workBuddyRecord(value);
  if (!Array.isArray(summary.Packages) || summary.Packages.length > 512) return undefined;
  const packages: WorkBuddyCreditAmount[] = [];
  const totals: WorkBuddyDecimal[] = [], remaining: WorkBuddyDecimal[] = [];
  for (const raw of summary.Packages) {
    const quantities = packageAmount(workBuddyRecord(raw));
    if (!quantities) return undefined;
    packages.push(quantities.amount); totals.push(quantities.total); remaining.push(quantities.remaining);
  }
  const totalExact = formatWorkBuddyDecimal(sumWorkBuddyDecimals(totals));
  const remainingExact = formatWorkBuddyDecimal(sumWorkBuddyDecimals(remaining));
  const balance: WorkBuddyCreditBalance = { ...sumAmounts(packages), total: Number(totalExact), remaining: Number(remainingExact),
    exact: { total: totalExact, remaining: remainingExact }, groups: [] };
  // CreditGroups is a breakdown of Packages, not another balance to add to it.
  if (Array.isArray(summary.CreditGroups) && summary.CreditGroups.length <= 16) {
    const grouped = new Map<WorkBuddyCreditKind, WorkBuddyCreditAmount[]>();
    for (const raw of summary.CreditGroups) {
      const row = workBuddyRecord(raw), quantities = packageAmount(row);
      if (!quantities) continue;
      const kind = WORKBUDDY_CREDIT_KINDS.find(kind => kind === row.Kind) ?? "other";
      const rows = grouped.get(kind) ?? [];
      rows.push(quantities.amount);
      grouped.set(kind, rows);
    }
    balance.groups = [...grouped].map(([kind, rows]) => ({ kind, ...sumAmounts(rows) }));
  }
  return normalizeWorkBuddyCredits(balance);
}

/** Construct an enterprise balance without rounding subtraction before display. */
export function enterpriseWorkBuddyCredits(totalValue: unknown, usedValue: unknown): WorkBuddyCreditBalance | undefined {
  const total = workBuddyCapacity(totalValue), used = workBuddyCapacity(usedValue);
  const totalDecimal = parseWorkBuddyDecimal(totalValue), usedDecimal = parseWorkBuddyDecimal(usedValue);
  if (total === undefined || used === undefined || !totalDecimal || !usedDecimal) return undefined;
  const remaining = formatWorkBuddyDecimal(subtractWorkBuddyDecimals(totalDecimal, usedDecimal));
  return { total, used, remaining: Number(remaining), frozen: 0, groups: [], exact: { total: formatWorkBuddyDecimal(totalDecimal), remaining } };
}

/** Percent is informational; malformed exact metadata must not masquerade as an exact result. */
export function workBuddyUnavailablePercent(balance: WorkBuddyCreditBalance): number | undefined {
  if (balance.exact === null) return undefined;
  const total = parseWorkBuddyDecimal(balance.exact?.total ?? balance.total);
  const remaining = parseWorkBuddyDecimal(balance.exact?.remaining ?? balance.remaining);
  if (!total || !remaining || total.digits === 0n) return undefined;
  if (balance.exact ? compareWorkBuddyDecimals(remaining, total) > 0
    : balance.remaining / balance.total > 1 + Number.EPSILON * 1024) return undefined;
  return roundedWorkBuddyUnavailable(total, remaining);
}
