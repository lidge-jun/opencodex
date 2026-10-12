import type { OcxConfig } from "../types";
import { routedSlug, slugEquals, slugEquivalenceKey } from "./slug-codec";

/** Discovery evidence only; independent of the parser and the catalog cache. */
export interface AntigravityEffortFamilyRow {
  id: string;
  provider: string;
  custom?: boolean;
  catalogKind?: string;
  antigravityEffortWireModelIds?: Partial<Record<"low" | "medium" | "high", string>>;
}

const FAMILY_EFFORTS = ["low", "medium", "high"] as const;

export function antigravityEffortFamilyIds(row: AntigravityEffortFamilyRow): string[] | undefined {
  if (row.custom || row.catalogKind === "custom-model-v1" || !row.antigravityEffortWireModelIds) return undefined;
  const ids = FAMILY_EFFORTS.map(effort => `${row.id}-${effort}`);
  return FAMILY_EFFORTS.every((effort, index) => row.antigravityEffortWireModelIds![effort] === ids[index])
    ? ids : undefined;
}

/** Retained wire targets stay routable internally; only the public list collapses. */
export function collapseAntigravityPublicModels<T extends AntigravityEffortFamilyRow>(rows: T[]): T[] {
  const hidden = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = antigravityEffortFamilyIds(row);
    if (!ids) continue;
    const providerIds = hidden.get(row.provider) ?? new Set<string>();
    for (const id of ids) providerIds.add(id);
    hidden.set(row.provider, providerIds);
  }
  return rows.filter(row => row.custom || row.catalogKind === "custom-model-v1"
    || antigravityEffortFamilyIds(row) !== undefined || !hidden.get(row.provider)?.has(row.id));
}

/** Project stored native/encoded selections without rewriting the user's allowlist. */
export function projectAntigravitySelectedModels(
  provider: string,
  selected: readonly string[],
  rows: readonly AntigravityEffortFamilyRow[],
): string[] {
  const projected = [...selected];
  const keys = new Set(selected.map(id => slugEquivalenceKey(routedSlug(provider, id))));
  const bases = new Set(rows.filter(row => row.provider === provider && antigravityEffortFamilyIds(row)).map(row => row.id));
  for (const row of rows) {
    if (row.provider !== provider) continue;
    const ids = antigravityEffortFamilyIds(row);
    const baseKey = slugEquivalenceKey(routedSlug(provider, row.id));
    if (!ids || keys.has(baseKey) || projected.includes(row.id)
      || !ids.some(id => !bases.has(id) && keys.has(slugEquivalenceKey(routedSlug(provider, id))))) continue;
    projected.push(row.id);
  }
  return projected;
}

/** Inherit once, before the baseline has ever recorded the public base identity. */
export function antigravityFamilyDisabled(
  config: Pick<OcxConfig, "providers" | "disabledModels" | "modelDiscovery">,
  row: AntigravityEffortFamilyRow,
  rows: readonly AntigravityEffortFamilyRow[] = [],
): boolean {
  const ids = antigravityEffortFamilyIds(row);
  if (!ids) return false;
  const disabled = config.disabledModels ?? [];
  if (disabled.some(slug => slugEquals(slug, row.provider, row.id))) return true;
  const baseline = config.modelDiscovery?.knownModels?.[row.provider];
  if (!baseline) return false;
  const known = new Set([...baseline.ids, ...baseline.removed]);
  if (known.has(row.id)) return false;
  const bases = new Set(rows.filter(candidate => candidate.provider === row.provider
    && antigravityEffortFamilyIds(candidate)).map(candidate => candidate.id));
  const priorTiers = ids.filter(id => known.has(id) && !bases.has(id));
  return priorTiers.length > 0
    && priorTiers.every(id => disabled.some(slug => slugEquals(slug, row.provider, id)));
}
