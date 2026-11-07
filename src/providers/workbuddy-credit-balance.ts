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
}

export function workBuddyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function workBuddyCapacity(value: unknown): number | undefined {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return undefined;
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
  return { ...balance, groups, ...(quantity !== undefined && quantity > 0 && at !== undefined ? { expiring: { amount: quantity, at } } : {}) };
}

function packageAmount(row: Record<string, unknown>): WorkBuddyCreditAmount | undefined {
  const total = workBuddyCapacity(row.CycleTotalCapacity), used = workBuddyCapacity(row.CycleUsedCapacity);
  const frozen = row.CycleFrozenCapacity === undefined ? 0 : workBuddyCapacity(row.CycleFrozenCapacity);
  if (total === undefined || used === undefined || frozen === undefined) return undefined;
  const remaining = row.CycleRemainCapacity === undefined ? remainingWorkBuddyCredits(total, used, frozen) : workBuddyCapacity(row.CycleRemainCapacity);
  return remaining === undefined ? undefined : { total, used, remaining, frozen };
}

export function parseWorkBuddyCredits(value: unknown): WorkBuddyCreditBalance | undefined {
  const summary = workBuddyRecord(value);
  if (!Array.isArray(summary.Packages) || summary.Packages.length > 512) return undefined;
  const packages: WorkBuddyCreditAmount[] = [];
  for (const raw of summary.Packages) {
    const quantities = packageAmount(workBuddyRecord(raw));
    if (!quantities) return undefined;
    packages.push(quantities);
  }
  const balance: WorkBuddyCreditBalance = { ...sumAmounts(packages), groups: [] };
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
