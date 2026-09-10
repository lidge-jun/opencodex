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

// Managed-namespace date aliases run 2026-2035. The original 2026-only
// (365 slots) design failed with "all 365 encoded date slots are occupied"
// once a catalog exceeded 365 routes (stale assignments are retained by
// design, so the set only grows). Years before 2026 stay rejected: dated
// ids like `claude-opus-4-8-20250201` are real model snapshot ids, not
// managed aliases, and the inbound decoder relies on that distinction.
// Every emitted suffix stays 8 digits so modelMap date-stripping keeps
// working.
const DATE_ALIAS = /^claude-opus-4-8-(202[6-9]\d{4}|203[0-5]\d{4})$/;
const LEGACY_YEAR = 2026;
const LEGACY_DAY_COUNT = 365;
const ALIAS_FIRST_YEAR = 2026;
const ALIAS_LAST_YEAR = 2035;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInAliasYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

export const TOTAL_ALIAS_SLOTS = (() => {
  let total = 0;
  for (let year = ALIAS_FIRST_YEAR; year <= ALIAS_LAST_YEAR; year += 1) total += daysInAliasYear(year);
  return total;
})();
export const ALIAS_YEAR_RANGE = { first: ALIAS_FIRST_YEAR, last: ALIAS_LAST_YEAR } as const;

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

/**
 * Applied-state markers survive every profile rebuild.
 *
 * `parseDesktopProfile`, `reconcileDesktopProfile` and `moveDesktopRoute` each construct a
 * fresh `{ version, assignments, defaults }`, and the management routes persist whatever they
 * return. Without this carry-through, saving an assignment — or merely dragging a model to
 * another family — would erase the fingerprint the apply route wrote, and the GUI would report
 * "not applied" for a config that is applied on disk.
 */
function appliedMarkers(source: { appliedFingerprint?: unknown; appliedAt?: unknown }): {
  appliedFingerprint?: string;
  appliedAt?: string;
} {
  return {
    ...(typeof source.appliedFingerprint === "string" ? { appliedFingerprint: source.appliedFingerprint } : {}),
    ...(typeof source.appliedAt === "string" ? { appliedAt: source.appliedAt } : {}),
  };
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

export function validDateAlias(alias: string): boolean {
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
  // `appliedFingerprint`/`appliedAt` are written back by the apply route once a profile
  // reaches Claude Desktop (see server/management/agent-settings-routes.ts). Rejecting them
  // here made every reload after the first apply fail with `unknown field`.
  assertExactKeys(value, ["version", "assignments", "defaults", "appliedFingerprint", "appliedAt"], "profile");
  if (value.version !== 1) throw new DesktopProfileError("version must be 1", "profile.version");
  if (!isPlainObject(value.assignments)) throw new DesktopProfileError("must be an object", "profile.assignments");
  if (!isPlainObject(value.defaults)) throw new DesktopProfileError("must be an object", "profile.defaults");
  assertExactKeys(value.defaults, DESKTOP_FAMILIES, "profile.defaults");
  if (value.appliedFingerprint !== undefined && typeof value.appliedFingerprint !== "string") {
    throw new DesktopProfileError("must be a string", "profile.appliedFingerprint");
  }
  if (value.appliedAt !== undefined && typeof value.appliedAt !== "string") {
    throw new DesktopProfileError("must be a string", "profile.appliedAt");
  }

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
      throw new DesktopProfileError("must be a valid claude-opus-4-8-YYYYMMDD alias", `profile.assignments.${route}.alias`);
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
  return { version: 1, assignments, defaults, ...appliedMarkers(value) };
}

function formatSlotDate(year: number, dayOfYear: number): string {
  const date = new Date(Date.UTC(year, 0, dayOfYear));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `claude-opus-4-8-${y}${m}${d}`;
}

// Legacy 2026 ring, byte-identical to the original allocator: the same route
// must keep resolving to the same 2026 alias it always had, and a probe over
// a nearly-full 2026 set must land on the same free date as before.
function legacyDayAlias(dayIndex: number): string {
  return formatSlotDate(LEGACY_YEAR, dayIndex + 1);
}

// Overflow ring for catalogs past 365 routes (2027-2035). Probed only after
// every legacy slot is taken, so existing profiles never shift into it.
const OVERFLOW_FIRST_YEAR = LEGACY_YEAR + 1;
const OVERFLOW_SLOT_COUNT = TOTAL_ALIAS_SLOTS - LEGACY_DAY_COUNT;

function overflowSlotAlias(slotIndex: number): string {
  let remaining = ((slotIndex % OVERFLOW_SLOT_COUNT) + OVERFLOW_SLOT_COUNT) % OVERFLOW_SLOT_COUNT;
  for (let year = OVERFLOW_FIRST_YEAR; year <= ALIAS_LAST_YEAR; year += 1) {
    const days = daysInAliasYear(year);
    if (remaining < days) return formatSlotDate(year, remaining + 1);
    remaining -= days;
  }
  throw new DesktopProfileError("slot index out of range", "profile.assignments");
}

function routeStartDay(route: string): number {
  return createHash("sha256").update(route).digest().readUInt32BE(0) % LEGACY_DAY_COUNT;
}

function routeOverflowStart(route: string): number {
  return createHash("sha256").update(route).digest().readUInt32BE(4) % OVERFLOW_SLOT_COUNT;
}

function allocateAlias(route: string, used: Set<string>): string {
  if (isRealAnthropicRoute(route)) return routeModelId(route);
  const start = routeStartDay(route);
  for (let offset = 0; offset < LEGACY_DAY_COUNT; offset += 1) {
    const alias = legacyDayAlias((start + offset) % LEGACY_DAY_COUNT);
    if (!used.has(alias)) return alias;
  }
  const overflowStart = routeOverflowStart(route);
  for (let offset = 0; offset < OVERFLOW_SLOT_COUNT; offset += 1) {
    const alias = overflowSlotAlias((overflowStart + offset) % OVERFLOW_SLOT_COUNT);
    if (!used.has(alias)) return alias;
  }
  throw new DesktopProfileError(`all ${TOTAL_ALIAS_SLOTS} encoded date slots are occupied`, `profile.assignments.${route}.alias`);
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
  return parseDesktopProfile({ version: 1, assignments, defaults, ...appliedMarkers(profile) });
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
  return parseDesktopProfile({ version: 1, assignments, defaults, ...appliedMarkers(parsed) });
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
