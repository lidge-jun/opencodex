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
  const remaining = row.CycleRemainCapacity === undefined ? Math.max(0, total - used - frozen) : workBuddyCapacity(row.CycleRemainCapacity);
  return remaining === undefined ? undefined : { total, used, remaining, frozen };
}

export function parseWorkBuddyCredits(value: unknown): WorkBuddyCreditBalance | undefined {
  const summary = workBuddyRecord(value);
  if (!Array.isArray(summary.Packages) || summary.Packages.length > 512) return undefined;
  const balance: WorkBuddyCreditBalance = { total: 0, used: 0, remaining: 0, frozen: 0, groups: [] };
  for (const raw of summary.Packages) {
    const quantities = packageAmount(workBuddyRecord(raw));
    if (!quantities) return undefined;
    for (const key of ["total", "used", "remaining", "frozen"] as const) balance[key] += quantities[key];
  }
  // CreditGroups is a breakdown of Packages, not another balance to add to it.
  if (Array.isArray(summary.CreditGroups) && summary.CreditGroups.length <= 16) {
    for (const raw of summary.CreditGroups) {
      const row = workBuddyRecord(raw), quantities = packageAmount(row);
      if (!quantities) continue;
      const kind = WORKBUDDY_CREDIT_KINDS.find(kind => kind === row.Kind) ?? "other";
      const existing = balance.groups.find(group => group.kind === kind);
      if (existing) for (const key of ["total", "used", "remaining", "frozen"] as const) existing[key] += quantities[key];
      else balance.groups.push({ kind, ...quantities });
    }
  }
  return normalizeWorkBuddyCredits(balance);
}
