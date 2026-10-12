import type { RawEntry } from "./parsing";

/** Match the opt-in tier spelling without coercing malformed catalog values to strings. */
function isUltraFast(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "ultrafast";
}

/** Recognize an explicitly supplied Ultra Fast descriptor by its string-valued id. */
function isUltraFastDescriptor(value: unknown): boolean {
  return value !== null && typeof value === "object" && "id" in value && isUltraFast(value.id);
}

/** Restore only exact-row operator metadata, after fresh provider capabilities are applied. */
export function preserveOperatorUltraFastTiers(entry: RawEntry, previous: RawEntry | undefined, enabled: boolean): void {
  // A native template or stale row is not authority for this opt-in. Keep all other fresh
  // tier policy, including Fast, while replacing only Ultra Fast from the exact persisted row.
  for (const [field, matches] of [
    ["service_tiers", isUltraFastDescriptor],
    ["additional_speed_tiers", isUltraFast],
  ] as const) {
    const current = entry[field];
    const fresh = Array.isArray(current) ? current.filter(value => !matches(value)) : [];
    const old = previous?.[field];
    const supplied = enabled && Array.isArray(old) ? old.find(matches) : undefined;
    if (supplied !== undefined) {
      entry[field] = [...fresh, structuredClone(supplied)];
    } else if (Array.isArray(current) && fresh.length !== current.length) {
      if (fresh.length > 0) entry[field] = fresh;
      else delete entry[field];
    }
  }
  const hasDeclaration = (Array.isArray(entry.service_tiers) && entry.service_tiers.some(isUltraFastDescriptor))
    || (Array.isArray(entry.additional_speed_tiers) && entry.additional_speed_tiers.some(isUltraFast));
  for (const field of ["service_tier", "default_service_tier"] as const) {
    if (enabled && hasDeclaration && previous && isUltraFast(previous[field])) entry[field] = previous[field];
    else if (isUltraFast(entry[field])) delete entry[field];
  }
}
