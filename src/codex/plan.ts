/** Preserve user/provider plan labels only when they are usable strings. */
export function codexPlanValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

/** Case-insensitive key used by quota, capacity, and collision policy. */
export function codexPlanKey(value: unknown): string | undefined {
  return codexPlanValue(value)?.trim().toLowerCase();
}

export function isThirtyDayOnlyCodexPlan(value: unknown): boolean {
  const key = codexPlanKey(value);
  return key === "go" || key === "free";
}
