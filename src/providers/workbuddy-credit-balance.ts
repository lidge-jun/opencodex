export interface WorkBuddyCreditAmount {
  total: number;
  used: number;
  remaining: number;
  frozen: number;
}

export const WORKBUDDY_CREDIT_KINDS = ["plan_base", "plan_bonus", "addon", "benefit", "other"] as const;
export type WorkBuddyCreditKind = typeof WORKBUDDY_CREDIT_KINDS[number];

/** Plain decimal text (no sign or exponent) of a validated, bounded credit amount. */
export interface WorkBuddyExactCredits {
  total: string;
  remaining: string;
}

/** Display-only credits; they are neither USD nor provider-wide model eligibility. */
export interface WorkBuddyCreditBalance extends WorkBuddyCreditAmount {
  groups: Array<WorkBuddyCreditAmount & { kind: WorkBuddyCreditKind }>;
  expiring?: { amount: number; at: number };
  /** Optional exact companions of `total` and `remaining`; the numeric fields stay the contract. */
  exact?: WorkBuddyExactCredits;
}

export function workBuddyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function workBuddyCapacity(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER ? number : undefined;
}

interface Decimal { digits: bigint; scale: number }

const ZERO: Decimal = { digits: 0n, scale: 0 };
// Exact metadata bounds: balances above MAX_SAFE_INTEGER (16 digits) are already rejected.
const EXACT_TEXT = /^(\d{1,16})(?:\.(\d{1,32}))?$/;
const EXACT_SCALE = 32;

/** Decimal value of a number's shortest round-trip text, as the summed capacities always used. */
function numberDecimal(value: number): Decimal {
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const [whole, fraction = ""] = coefficient!.split(".");
  let digits = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) { digits *= 10n ** BigInt(-scale); scale = 0; }
  return { digits, scale };
}

function textDecimal(text: string): Decimal | undefined {
  const match = EXACT_TEXT.exec(text);
  return match ? { digits: BigInt(`${match[1]}${match[2] ?? ""}`), scale: match[2]?.length ?? 0 } : undefined;
}

/**
 * Exact value of a validated capacity: quoted decimals keep their text, and numbers (already
 * rounded by JSON.parse) use their shortest decimal. Values outside the bounds, such as subnormal
 * numbers or long quoted fractions, have no exact form and leave only the numeric projection.
 */
function exactCapacity(value: unknown): Decimal | undefined {
  if (workBuddyCapacity(value) === undefined) return undefined;
  const decimal = typeof value === "string" ? textDecimal(value) : numberDecimal(value as number);
  return decimal && decimal.scale <= EXACT_SCALE ? decimal : undefined;
}

function addDecimals(values: readonly Decimal[]): Decimal {
  const scale = Math.max(0, ...values.map(value => value.scale));
  return { digits: values.reduce((sum, value) => sum + value.digits * 10n ** BigInt(scale - value.scale), 0n), scale };
}

function decimalNumber(value: Decimal): number {
  return Number(`${value.digits}e-${value.scale}`);
}

/** Canonical plain text without trailing fractional zeros; undefined outside the exact bounds. */
function decimalText(value: Decimal): string | undefined {
  if (value.digits < 0n) return undefined;
  let { digits, scale } = value;
  while (scale > 0 && digits % 10n === 0n) { digits /= 10n; scale--; }
  const raw = digits.toString().padStart(scale + 1, "0");
  const text = scale ? `${raw.slice(0, -scale)}.${raw.slice(-scale)}` : raw;
  return textDecimal(text) ? text : undefined;
}

/** Exact `[numerator, denominator]` of bounded exact text, for display rounding. */
export function workBuddyExactRatio(text: string): [bigint, bigint] | undefined {
  const value = textDecimal(text);
  return value && [value.digits, 10n ** BigInt(value.scale)];
}

/** Sum bounded numeric capacities as decimals before converting the result back to a number. */
function sumCapacities(values: readonly number[]): number {
  return decimalNumber(addDecimals(values.map(numberDecimal)));
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

/** Exact remaining credits when the provider omits them, bounded below by zero. */
function exactRemaining(total: Decimal, used: Decimal, frozen: Decimal): Decimal {
  const remaining = addDecimals([total, { ...used, digits: -used.digits }, { ...frozen, digits: -frozen.digits }]);
  return remaining.digits < 0n ? ZERO : remaining;
}

/** Exact total/remaining for raw amounts, or undefined when any lacks a bounded exact form. */
export function workBuddyExactCredits(total: unknown, used: unknown): WorkBuddyExactCredits | undefined {
  const exactTotal = exactCapacity(total), exactUsed = exactCapacity(used);
  if (!exactTotal || !exactUsed) return undefined;
  const totalText = decimalText(exactTotal), remainingText = decimalText(exactRemaining(exactTotal, exactUsed, ZERO));
  return totalText !== undefined && remainingText !== undefined ? { total: totalText, remaining: remainingText } : undefined;
}

/** Exact text must be bounded plain decimal text encoding the same numeric fields; null rejects. */
function exactCredits(value: unknown, balance: WorkBuddyCreditAmount): WorkBuddyExactCredits | undefined | null {
  if (value === undefined) return undefined;
  const row = workBuddyRecord(value), { total, remaining } = row;
  if (Object.keys(row).length !== 2 || typeof total !== "string" || typeof remaining !== "string") return null;
  if (!textDecimal(total) || !textDecimal(remaining)) return null;
  return Number(total) === balance.total && Number(remaining) === balance.remaining ? { total, remaining } : null;
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
  const exact = exactCredits(row.exact, balance);
  if (exact === null) return undefined;
  const expiring = workBuddyRecord(row.expiring), quantity = workBuddyCapacity(expiring.amount);
  const at = typeof expiring.at === "number" && expiring.at > 0 && Number.isFinite(new Date(expiring.at).getTime()) ? expiring.at : undefined;
  return { ...balance, groups, ...(exact ? { exact } : {}),
    ...(quantity !== undefined && quantity > 0 && at !== undefined ? { expiring: { amount: quantity, at } } : {}) };
}

interface PackageAmount extends WorkBuddyCreditAmount { exact?: { total: Decimal; remaining: Decimal } }

function packageAmount(row: Record<string, unknown>): PackageAmount | undefined {
  const total = workBuddyCapacity(row.CycleTotalCapacity), used = workBuddyCapacity(row.CycleUsedCapacity);
  const frozen = row.CycleFrozenCapacity === undefined ? 0 : workBuddyCapacity(row.CycleFrozenCapacity);
  if (total === undefined || used === undefined || frozen === undefined) return undefined;
  const estimated = row.CycleRemainCapacity === undefined;
  const remaining = estimated ? remainingWorkBuddyCredits(total, used, frozen) : workBuddyCapacity(row.CycleRemainCapacity);
  if (remaining === undefined) return undefined;
  const exactTotal = exactCapacity(row.CycleTotalCapacity);
  let exactLeft: Decimal | undefined;
  if (!estimated) exactLeft = exactCapacity(row.CycleRemainCapacity);
  else {
    const exactUsed = exactCapacity(row.CycleUsedCapacity);
    const exactFrozen = row.CycleFrozenCapacity === undefined ? ZERO : exactCapacity(row.CycleFrozenCapacity);
    if (exactTotal && exactUsed && exactFrozen) exactLeft = exactRemaining(exactTotal, exactUsed, exactFrozen);
  }
  return { total, used, remaining, frozen, ...(exactTotal && exactLeft ? { exact: { total: exactTotal, remaining: exactLeft } } : {}) };
}

/** Exact package sums, present only when every package has bounded exact amounts. */
function sumExact(rows: readonly PackageAmount[]): WorkBuddyExactCredits | undefined {
  if (rows.some(row => !row.exact)) return undefined;
  const total = decimalText(addDecimals(rows.map(row => row.exact!.total)));
  const remaining = decimalText(addDecimals(rows.map(row => row.exact!.remaining)));
  return total !== undefined && remaining !== undefined ? { total, remaining } : undefined;
}

export function parseWorkBuddyCredits(value: unknown): WorkBuddyCreditBalance | undefined {
  const summary = workBuddyRecord(value);
  if (!Array.isArray(summary.Packages) || summary.Packages.length > 512) return undefined;
  const packages: PackageAmount[] = [];
  for (const raw of summary.Packages) {
    const quantities = packageAmount(workBuddyRecord(raw));
    if (!quantities) return undefined;
    packages.push(quantities);
  }
  const balance: WorkBuddyCreditBalance = { ...sumAmounts(packages), groups: [] };
  const exact = sumExact(packages);
  // The numeric fields are the nearest numbers to the exact sums, which normalization re-checks.
  if (exact) Object.assign(balance, { total: Number(exact.total), remaining: Number(exact.remaining), exact });
  // CreditGroups is a breakdown of Packages, not another balance to add to it.
  if (Array.isArray(summary.CreditGroups) && summary.CreditGroups.length <= 16) {
    const grouped = new Map<WorkBuddyCreditKind, WorkBuddyCreditAmount[]>();
    for (const raw of summary.CreditGroups) {
      const row = workBuddyRecord(raw), quantities = packageAmount(row);
      if (!quantities) continue;
      const kind = WORKBUDDY_CREDIT_KINDS.find(kind => kind === row.Kind) ?? "other";
      const rows = grouped.get(kind) ?? [];
      rows.push(quantities);
      grouped.set(kind, rows);
    }
    balance.groups = [...grouped].map(([kind, rows]) => ({ kind, ...sumAmounts(rows) }));
  }
  return normalizeWorkBuddyCredits(balance);
}
