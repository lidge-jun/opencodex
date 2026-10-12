/**
 * Desktop model roles over the existing family profile (design D1).
 *
 * Claude Desktop reads one family tier per model. Most users only care about two of them:
 * the Opus default, which the gateway lists first, and the Haiku default. These helpers let
 * the Models card set those two without exposing the tier taxonomy, and keep the exact
 * move rules the Advanced lanes use, so both surfaces produce the same profile.
 */

export const FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
export type Family = typeof FAMILIES[number];

export interface Assignment {
  family: Family;
  alias: string;
}

export interface DesktopProfile {
  version: 1;
  assignments: Record<string, Assignment>;
  defaults: Record<Family, string | null>;
  appliedFingerprint?: string;
  appliedAt?: string;
}

export interface RoleModel {
  route: string;
  label: string;
  available: boolean;
}

/**
 * Move `route` into `family`. The old family's default falls to its first remaining member
 * (sorted) when the moved route held it; the new family's default becomes `route` when it is
 * empty, or always when `makeDefault` is set — even if the route already lived there.
 * Aliases and applied markers are carried over untouched.
 */
export function assignFamily(profile: DesktopProfile, route: string, family: Family, makeDefault: boolean): DesktopProfile {
  const previous = profile.assignments[route];
  if (!previous) return profile;
  if (previous.family === family) {
    if (!makeDefault || profile.defaults[family] === route) return profile;
    return { ...profile, defaults: { ...profile.defaults, [family]: route } };
  }
  const assignments = { ...profile.assignments, [route]: { ...previous, family } };
  const defaults = { ...profile.defaults };
  if (defaults[previous.family] === route) {
    defaults[previous.family] = Object.keys(assignments)
      .filter(key => key !== route && assignments[key]!.family === previous.family)
      .sort()[0] ?? null;
  }
  if (makeDefault || defaults[family] === null) defaults[family] = route;
  return { ...profile, assignments, defaults };
}

/** Stored default when it is an available member, else the first available member (sorted). */
export function effectiveFamilyDefaults(models: readonly RoleModel[], profile: DesktopProfile): Record<Family, string | null> {
  const activeByFamily = Object.fromEntries(FAMILIES.map(family => [family, [] as string[]])) as Record<Family, string[]>;
  for (const model of models) {
    if (model.available) activeByFamily[profile.assignments[model.route]?.family ?? "opus"].push(model.route);
  }
  const result = {} as Record<Family, string | null>;
  for (const family of FAMILIES) {
    const active = activeByFamily[family].toSorted();
    const stored = profile.defaults[family];
    result[family] = stored && active.includes(stored) ? stored : (active[0] ?? null);
  }
  return result;
}

/** How many assignments a family holds, available or not. */
export function familySize(models: readonly RoleModel[], profile: DesktopProfile, family: Family): number {
  return models.filter(model => (profile.assignments[model.route]?.family ?? "opus") === family).length;
}

/**
 * The value a role select shows: the stored default, so an unavailable stored choice stays
 * visible; the effective default only when nothing is stored.
 */
export function roleValue(profile: DesktopProfile, effective: Record<Family, string | null>, family: Family): string {
  return profile.defaults[family] ?? effective[family] ?? "";
}

/** Available routes sorted by label, minus the route the other role holds. */
export function roleOptions(models: readonly RoleModel[], exclude: string | null): RoleModel[] {
  return models
    .filter(model => model.available && model.route !== exclude)
    .sort((a, b) => a.label.localeCompare(b.label) || a.route.localeCompare(b.route));
}

/** The compact list: default first, quick second, the rest by label. A GUI overview only. */
export function roleListOrder<T extends RoleModel>(models: readonly T[], defaultRoute: string | null, quickRoute: string | null): T[] {
  const rank = (route: string) => (route === defaultRoute ? 0 : route === quickRoute ? 1 : 2);
  return models.toSorted((a, b) => rank(a.route) - rank(b.route) || a.label.localeCompare(b.label) || a.route.localeCompare(b.route));
}
