/**
 * Claude Desktop model visibility (#7702), dashboard side. Mirrors
 * src/claude/desktop-model-visibility.ts: `null` lists every model, `exclude` lists all but
 * `routes` (new models appear), `include` lists only `routes` (new models stay hidden).
 * Pure so the selection, the new-model policy switch and the apply preview are testable
 * without mounting the page.
 */

export interface DesktopVisibility {
  mode: "include" | "exclude";
  routes: string[];
}

export interface VisibilityModel {
  route: string;
  label: string;
  available: boolean;
}

/** A row the next apply writes (`listed`/`rendered` on GET /api/claude-desktop). */
export interface ListedDesktopModel {
  route: string;
  name: string;
  label: string;
}

/** An on-disk selected-profile row (`appliedModels` on GET /api/claude-desktop/status). */
export interface AppliedDesktopModel {
  name: string;
  label: string;
}

export function isDesktopVisibility(value: unknown): value is DesktopVisibility {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.mode === "include" || v.mode === "exclude")
    && Array.isArray(v.routes) && v.routes.every(route => typeof route === "string");
}

/** Canonical form: sorted unique routes, and "exclude nothing" is the same as unset. */
export function normalizeVisibility(visibility: DesktopVisibility | null): DesktopVisibility | null {
  if (!visibility) return null;
  const routes = [...new Set(visibility.routes)].sort();
  if (visibility.mode === "exclude" && routes.length === 0) return null;
  return { mode: visibility.mode, routes };
}

export function sameVisibility(left: DesktopVisibility | null, right: DesktopVisibility | null): boolean {
  return JSON.stringify(normalizeVisibility(left)) === JSON.stringify(normalizeVisibility(right));
}

export function routeVisible(visibility: DesktopVisibility | null, route: string): boolean {
  if (!visibility) return true;
  const listed = visibility.routes.includes(route);
  return visibility.mode === "include" ? listed : !listed;
}

/** Show or hide `routes`, keeping the new-model policy the selection already has. */
export function setRoutesVisible(
  visibility: DesktopVisibility | null,
  routes: readonly string[],
  visible: boolean,
): DesktopVisibility | null {
  const current = visibility ?? { mode: "exclude" as const, routes: [] };
  const members = new Set(current.routes);
  // include lists the shown routes; exclude lists the hidden ones.
  const addToList = current.mode === "include" ? visible : !visible;
  for (const route of routes) {
    if (addToList) members.add(route);
    else members.delete(route);
  }
  return normalizeVisibility({ mode: current.mode, routes: [...members] });
}

/**
 * Switch what happens to models discovered later, without changing which known models are
 * shown today: the list is rewritten from the include form to the exclude form or back.
 */
export function setNewModelPolicy(
  visibility: DesktopVisibility | null,
  knownRoutes: readonly string[],
  mode: DesktopVisibility["mode"],
): DesktopVisibility | null {
  if ((visibility?.mode ?? "exclude") === mode) return visibility;
  const routes = knownRoutes.filter(route => routeVisible(visibility, route) === (mode === "include"));
  // An include list must keep its entries even when it names nothing yet; only an empty
  // exclude list collapses to unset.
  return mode === "include" ? { mode, routes: [...new Set(routes)].sort() } : normalizeVisibility({ mode, routes });
}

export function providerOf(route: string): string {
  const slash = route.indexOf("/");
  return slash > 0 ? route.slice(0, slash) : route;
}

export function providersOf(models: readonly VisibilityModel[]): string[] {
  return [...new Set(models.map(model => providerOf(model.route)))].sort();
}

/** Search matches route or label, case-insensitively; an empty provider means every provider. */
export function filterVisibilityModels<T extends VisibilityModel>(models: readonly T[], query: string, provider: string): T[] {
  const needle = query.trim().toLowerCase();
  return models.filter(model => (!provider || providerOf(model.route) === provider)
    && (!needle || model.route.toLowerCase().includes(needle) || model.label.toLowerCase().includes(needle)));
}

export interface VisibilityCounts {
  /** Available models the selection lists. */
  selected: number;
  /** Models currently available from providers. */
  available: number;
  /** Selected models that are not available now; never written, so counted apart. */
  selectedUnavailable: number;
}

export function visibilityCounts(models: readonly VisibilityModel[], visibility: DesktopVisibility | null): VisibilityCounts {
  let selected = 0;
  let available = 0;
  let selectedUnavailable = 0;
  for (const model of models) {
    const visible = routeVisible(visibility, model.route);
    if (model.available) {
      available += 1;
      if (visible) selected += 1;
    } else if (visible && visibility?.mode === "include") {
      // Only an explicit include names an unavailable model; "everything" does not.
      selectedUnavailable += 1;
    }
  }
  return { selected, available, selectedUnavailable };
}

/** The rows the next apply writes under a draft selection, in written order. */
export function desiredDesktopList(rendered: readonly ListedDesktopModel[], visibility: DesktopVisibility | null): ListedDesktopModel[] {
  const kept = rendered.filter(model => routeVisible(visibility, model.route));
  // Mirrors the writer's guard: a selection hiding everything falls back to the full list.
  return kept.length > 0 ? kept : [...rendered];
}

export interface ApplyPreview {
  added: string[];
  removed: string[];
}

/** Labels Desktop gains and loses on the next apply; null when the applied list is unknown. */
export function applyPreview(
  desired: readonly ListedDesktopModel[],
  applied: readonly AppliedDesktopModel[] | null,
): ApplyPreview | null {
  if (!applied) return null;
  const appliedNames = new Set(applied.map(model => model.name));
  const desiredNames = new Set(desired.map(model => model.name));
  return {
    added: desired.filter(model => !appliedNames.has(model.name)).map(model => model.label),
    removed: applied.filter(model => !desiredNames.has(model.name)).map(model => model.label),
  };
}
