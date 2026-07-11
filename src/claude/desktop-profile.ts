import { createHash } from "node:crypto";
import type {
  OcxClaudeDesktopAssignment,
  OcxClaudeDesktopFamily,
  OcxClaudeDesktopProfile,
} from "../types";

export const DESKTOP_FAMILIES = ["opus", "fable", "sonnet", "haiku"] as const;
export type DesktopFamily = OcxClaudeDesktopFamily;
export type DesktopProfile = OcxClaudeDesktopProfile;

export interface DesktopProfileModel {
  route: string;
  label: string;
  contextWindow?: number;
}

export interface RenderedDesktopModel extends DesktopProfileModel {
  name: string;
  family: DesktopFamily;
  isFamilyDefault: boolean;
  supports1m: boolean;
}

const DATE_ALIAS = /^claude-opus-4-8-(2026\d{4})$/;
const DAY_COUNT_2026 = 365;

export class DesktopProfileError extends Error {
  constructor(message: string, readonly path = "profile") {
    super(`${path}: ${message}`);
    this.name = "DesktopProfileError";
  }
}

export function emptyDesktopProfile(): DesktopProfile {
  return {
    version: 1,
    assignments: {},
    defaults: { opus: null, fable: null, sonnet: null, haiku: null },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new DesktopProfileError(`unknown field "${key}"`, path);
  }
}

function isFamily(value: unknown): value is DesktopFamily {
  return typeof value === "string" && (DESKTOP_FAMILIES as readonly string[]).includes(value);
}

function routeModelId(route: string): string {
  const slash = route.indexOf("/");
  return slash >= 0 ? route.slice(slash + 1) : route;
}

function isRealAnthropicRoute(route: string): boolean {
  return route.startsWith("anthropic/claude-");
}

function validDateAlias(alias: string): boolean {
  const match = DATE_ALIAS.exec(alias);
  if (!match) return false;
  const year = Number(match[1]!.slice(0, 4));
  const month = Number(match[1]!.slice(4, 6));
  const day = Number(match[1]!.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function parseDesktopProfile(value: unknown): DesktopProfile {
  if (!isPlainObject(value)) throw new DesktopProfileError("must be an object");
  assertExactKeys(value, ["version", "assignments", "defaults"], "profile");
  if (value.version !== 1) throw new DesktopProfileError("version must be 1", "profile.version");
  if (!isPlainObject(value.assignments)) throw new DesktopProfileError("must be an object", "profile.assignments");
  if (!isPlainObject(value.defaults)) throw new DesktopProfileError("must be an object", "profile.defaults");
  assertExactKeys(value.defaults, DESKTOP_FAMILIES, "profile.defaults");

  const assignments: Record<string, OcxClaudeDesktopAssignment> = {};
  const aliases = new Set<string>();
  for (const [route, raw] of Object.entries(value.assignments)) {
    if (!route.trim() || !route.includes("/")) throw new DesktopProfileError("route must be provider/model", `profile.assignments.${route || "<empty>"}`);
    if (!isPlainObject(raw)) throw new DesktopProfileError("must be an object", `profile.assignments.${route}`);
    assertExactKeys(raw, ["family", "alias"], `profile.assignments.${route}`);
    if (!isFamily(raw.family)) throw new DesktopProfileError("unknown family", `profile.assignments.${route}.family`);
    if (typeof raw.alias !== "string" || !raw.alias) throw new DesktopProfileError("must be a non-empty string", `profile.assignments.${route}.alias`);
    if (isRealAnthropicRoute(route)) {
      if (raw.alias !== routeModelId(route)) throw new DesktopProfileError("real Anthropic routes must keep their exact model id", `profile.assignments.${route}.alias`);
    } else if (!validDateAlias(raw.alias)) {
      throw new DesktopProfileError("must be a valid claude-opus-4-8-2026MMDD alias", `profile.assignments.${route}.alias`);
    }
    if (aliases.has(raw.alias)) throw new DesktopProfileError(`duplicate alias "${raw.alias}"`, `profile.assignments.${route}.alias`);
    aliases.add(raw.alias);
    assignments[route] = { family: raw.family, alias: raw.alias };
  }

  const defaults = {} as DesktopProfile["defaults"];
  for (const family of DESKTOP_FAMILIES) {
    const route = value.defaults[family];
    if (route !== null && typeof route !== "string") throw new DesktopProfileError("must be a route or null", `profile.defaults.${family}`);
    const members = Object.keys(assignments).filter(key => assignments[key]!.family === family).sort();
    if (members.length === 0) {
      if (route !== null) throw new DesktopProfileError("must be null for an empty family", `profile.defaults.${family}`);
      defaults[family] = null;
      continue;
    }
    if (typeof route !== "string" || !assignments[route] || assignments[route]!.family !== family) {
      throw new DesktopProfileError("must reference a member of this family", `profile.defaults.${family}`);
    }
    defaults[family] = route;
  }
  return { version: 1, assignments, defaults };
}

function dayOfYearAlias(dayIndex: number): string {
  const date = new Date(Date.UTC(2026, 0, dayIndex + 1));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `claude-opus-4-8-${y}${m}${d}`;
}

function routeStartDay(route: string): number {
  return createHash("sha256").update(route).digest().readUInt32BE(0) % DAY_COUNT_2026;
}

function allocateAlias(route: string, used: Set<string>): string {
  if (isRealAnthropicRoute(route)) return routeModelId(route);
  const start = routeStartDay(route);
  for (let offset = 0; offset < DAY_COUNT_2026; offset += 1) {
    const alias = dayOfYearAlias((start + offset) % DAY_COUNT_2026);
    if (!used.has(alias)) return alias;
  }
  throw new DesktopProfileError("all 365 encoded date slots are occupied", `profile.assignments.${route}.alias`);
}

export function reconcileDesktopProfile(
  stored: unknown,
  models: readonly DesktopProfileModel[],
): DesktopProfile {
  const profile = stored === undefined || stored === null ? emptyDesktopProfile() : parseDesktopProfile(stored);
  const assignments: DesktopProfile["assignments"] = Object.fromEntries(
    Object.entries(profile.assignments).map(([route, assignment]) => [route, { ...assignment }]),
  );
  const used = new Set(Object.values(assignments).map(value => value.alias));
  for (const model of [...models].sort((a, b) => a.route.localeCompare(b.route))) {
    if (assignments[model.route]) continue;
    const alias = allocateAlias(model.route, used);
    used.add(alias);
    assignments[model.route] = { family: "opus", alias };
  }
  const defaults = { ...profile.defaults };
  for (const family of DESKTOP_FAMILIES) {
    const members = Object.keys(assignments).filter(route => assignments[route]!.family === family).sort();
    const current = defaults[family];
    defaults[family] = current && assignments[current]?.family === family ? current : (members[0] ?? null);
  }
  return parseDesktopProfile({ version: 1, assignments, defaults });
}

export function moveDesktopRoute(
  profile: DesktopProfile,
  route: string,
  family: DesktopFamily,
  makeDefault = false,
): DesktopProfile {
  const parsed = parseDesktopProfile(profile);
  const current = parsed.assignments[route];
  if (!current) throw new DesktopProfileError("route is not assigned", `profile.assignments.${route}`);
  const oldFamily = current.family;
  if (oldFamily === family) {
    return makeDefault ? setDesktopFamilyDefault(parsed, family, route) : parsed;
  }
  const assignments = { ...parsed.assignments, [route]: { ...current, family } };
  const defaults = { ...parsed.defaults };
  if (defaults[oldFamily] === route) {
    defaults[oldFamily] = Object.keys(assignments).filter(key => key !== route && assignments[key]!.family === oldFamily).sort()[0] ?? null;
  }
  const destinationMembers = Object.keys(assignments).filter(key => assignments[key]!.family === family).sort();
  if (makeDefault || !defaults[family] || assignments[defaults[family]!]?.family !== family) defaults[family] = route;
  if (!defaults[family] && destinationMembers.length > 0) defaults[family] = destinationMembers[0]!;
  return parseDesktopProfile({ version: 1, assignments, defaults });
}

export function setDesktopFamilyDefault(
  profile: DesktopProfile,
  family: DesktopFamily,
  route: string | null,
): DesktopProfile {
  const parsed = parseDesktopProfile(profile);
  const members = Object.keys(parsed.assignments).filter(key => parsed.assignments[key]!.family === family);
  if (route === null && members.length > 0) throw new DesktopProfileError("cannot clear a non-empty family default", `profile.defaults.${family}`);
  if (route !== null && parsed.assignments[route]?.family !== family) throw new DesktopProfileError("route is not a member of this family", `profile.defaults.${family}`);
  return parseDesktopProfile({ ...parsed, defaults: { ...parsed.defaults, [family]: route } });
}

export function renderDesktopProfile(
  profile: DesktopProfile,
  models: readonly DesktopProfileModel[],
): RenderedDesktopModel[] {
  const parsed = parseDesktopProfile(profile);
  const modelByRoute = new Map(models.map(model => [model.route, model]));
  const activeByFamily = new Map<DesktopFamily, string[]>();
  for (const family of DESKTOP_FAMILIES) activeByFamily.set(family, []);
  for (const [route, assignment] of Object.entries(parsed.assignments)) {
    if (modelByRoute.has(route)) activeByFamily.get(assignment.family)!.push(route);
  }
  for (const routes of activeByFamily.values()) routes.sort();
  const effectiveDefaults = {} as Record<DesktopFamily, string | null>;
  for (const family of DESKTOP_FAMILIES) {
    const active = activeByFamily.get(family)!;
    const stored = parsed.defaults[family];
    effectiveDefaults[family] = stored && active.includes(stored) ? stored : (active[0] ?? null);
  }
  const defaultOrder = DESKTOP_FAMILIES.map(family => effectiveDefaults[family]).filter((route): route is string => !!route);
  const defaultSet = new Set(defaultOrder);
  const rest = Object.keys(parsed.assignments).filter(route => modelByRoute.has(route) && !defaultSet.has(route)).sort();
  return [...defaultOrder, ...rest].map(route => {
    const model = modelByRoute.get(route)!;
    const assignment = parsed.assignments[route]!;
    return {
      ...model,
      name: assignment.alias,
      family: assignment.family,
      isFamilyDefault: effectiveDefaults[assignment.family] === route,
      supports1m: typeof model.contextWindow === "number" && model.contextWindow >= 1_000_000,
    };
  });
}
