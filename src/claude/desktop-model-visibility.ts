/**
 * Claude Desktop model visibility (#7702): which rows the Desktop 3P `inferenceModels`
 * list carries, persisted as `claudeCode.desktopModelVisibility`.
 *
 * Deliberately separate from the Desktop profile (tier/family mapping and defaults) and
 * from provider-wide `disabledModels`: hiding a row here changes only what Claude Desktop
 * lists. The alias decode registry keeps every route, so a running Desktop session that
 * still sends a just-hidden alias keeps routing instead of failing mid-conversation.
 *
 * - unset: every available model is listed (the pre-#7702 behaviour).
 * - `exclude`: every model except `routes`; newly discovered models are listed.
 * - `include`: only `routes`; newly discovered models stay hidden until selected.
 *
 * Discovery-only mode emits no static list, so visibility does not apply there.
 */
import type { OcxClaudeDesktopModelVisibility } from "../types";
import { readDesktopLibraryText } from "./desktop-3p-library";

export type DesktopModelVisibility = OcxClaudeDesktopModelVisibility;

export const DESKTOP_VISIBILITY_MODES = ["include", "exclude"] as const;
/** Bounded so a hand-edited config cannot grow the per-write set without limit. */
export const MAX_DESKTOP_VISIBILITY_ROUTES = 5000;

export class DesktopModelVisibilityError extends Error {
  constructor(message: string, readonly path = "desktopModelVisibility") {
    super(`${path}: ${message}`);
    this.name = "DesktopModelVisibilityError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseDesktopModelVisibility(value: unknown): DesktopModelVisibility {
  if (!isPlainObject(value)) throw new DesktopModelVisibilityError("must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "mode" && key !== "routes") throw new DesktopModelVisibilityError(`unknown field "${key}"`);
  }
  if (value.mode !== "include" && value.mode !== "exclude") {
    throw new DesktopModelVisibilityError("must be \"include\" or \"exclude\"", "desktopModelVisibility.mode");
  }
  if (!Array.isArray(value.routes)) throw new DesktopModelVisibilityError("must be an array", "desktopModelVisibility.routes");
  if (value.routes.length > MAX_DESKTOP_VISIBILITY_ROUTES) {
    throw new DesktopModelVisibilityError(`must list at most ${MAX_DESKTOP_VISIBILITY_ROUTES} routes`, "desktopModelVisibility.routes");
  }
  const routes = new Set<string>();
  for (const route of value.routes) {
    if (typeof route !== "string" || !route.includes("/") || /\s/.test(route) || route.startsWith("/") || route.endsWith("/")) {
      throw new DesktopModelVisibilityError("routes must be provider/model strings", "desktopModelVisibility.routes");
    }
    routes.add(route);
  }
  return { mode: value.mode, routes: [...routes].sort() };
}

/** Whether Desktop lists this route under the given visibility (unset lists everything). */
export function desktopRouteVisible(visibility: DesktopModelVisibility | undefined, route: string): boolean {
  if (!visibility) return true;
  const listed = visibility.routes.includes(route);
  return visibility.mode === "include" ? listed : !listed;
}

/** Same desired list, compared order-insensitively (routes are stored sorted). */
export function sameDesktopModelVisibility(
  left: DesktopModelVisibility | undefined,
  right: DesktopModelVisibility | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return left.mode === right.mode && left.routes.join("\n") === right.routes.join("\n");
}

interface FamilyRow {
  anthropicFamilyTier: string;
  isFamilyDefault?: boolean;
}

/**
 * Drop hidden rows from a generated Desktop list (`routes[i]` is the route of `models[i]`).
 *
 * A hidden family default hands its role to the first remaining member of that family, and
 * the defaults are moved to the front so the written list keeps the shape
 * `renderDesktopProfile` produces: defaults first, in family order, then everything else.
 */
export function filterDesktopModelsByVisibility<T extends FamilyRow>(
  models: readonly T[],
  routes: readonly string[],
  visibility: DesktopModelVisibility | undefined,
): T[] {
  if (!visibility) return [...models];
  const kept = models.filter((_, index) => desktopRouteVisible(visibility, routes[index] ?? ""));
  if (kept.length === models.length) return kept;
  const families: string[] = [];
  for (const model of models) if (!families.includes(model.anthropicFamilyTier)) families.push(model.anthropicFamilyTier);
  const defaults: T[] = [];
  for (const family of families) {
    const members = kept.filter(model => model.anthropicFamilyTier === family);
    const chosen = members.find(model => model.isFamilyDefault) ?? members[0];
    if (chosen) defaults.push(chosen);
  }
  const defaultSet = new Set(defaults);
  return [
    ...defaults.map(model => ({ ...model, isFamilyDefault: true })),
    ...kept.filter(model => !defaultSet.has(model)).map(({ isFamilyDefault: _drop, ...model }) => model as T),
  ];
}

/** The persisted selection, or undefined when unset or unreadable (unreadable lists everything). */
export function readDesktopModelVisibility(claudeCode: { desktopModelVisibility?: unknown } | undefined): DesktopModelVisibility | undefined {
  if (claudeCode?.desktopModelVisibility === undefined) return undefined;
  try {
    return parseDesktopModelVisibility(claudeCode.desktopModelVisibility);
  } catch {
    return undefined;
  }
}

export interface AppliedDesktopModel {
  name: string;
  label: string;
}

/**
 * The `inferenceModels` rows of the profile Desktop has selected, for the dashboard's
 * applied count and added/removed preview. `null` when there is no static list to read
 * (no profile, discovery-only, or unreadable): unknown, not empty. Names and labels only.
 */
export function readAppliedDesktopModels(selectedProfilePath: string | null): AppliedDesktopModel[] | null {
  if (!selectedProfilePath) return null;
  try {
    const parsed = JSON.parse(readDesktopLibraryText(selectedProfilePath)) as { inferenceModels?: unknown };
    if (!Array.isArray(parsed.inferenceModels)) return null;
    return parsed.inferenceModels.flatMap(row => {
      if (!isPlainObject(row) || typeof row.name !== "string") return [];
      return [{ name: row.name, label: typeof row.labelOverride === "string" ? row.labelOverride : row.name }];
    });
  } catch {
    return null;
  }
}
