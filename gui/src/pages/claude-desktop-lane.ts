/**
 * Lane density helpers for the Claude Desktop page.
 *
 * These are deliberately pure and rendered-list-only. The page's `modelsByFamily` and
 * `effectiveDefaults` must keep seeing every model: `effectiveDefaults` picks the first
 * AVAILABLE member as a family's fallback, so filtering the source arrays would let a search
 * box silently change which model Claude Desktop resolves. Narrow the rendered slice, never
 * the data.
 */

/** Cards rendered per lane before the pager appears. */
export const LANE_PAGE = 6;
/** Lanes shorter than this need no filter — showing one would be pure noise. */
export const LANE_SEARCH_MIN = 4;

export interface LaneModel {
  route: string;
  label: string;
  available: boolean;
}

export interface LaneView<T extends LaneModel> {
  /** True total for this family, unaffected by search — what the lane header must report. */
  total: number;
  /** Whether the filter input is worth showing at all. */
  showSearch: boolean;
  /** Cards to render now. */
  shown: T[];
  /** How many matches remain behind the pager. */
  hidden: number;
  /** The lane has models, but none match the current query. */
  noMatch: boolean;
}

export function laneView<T extends LaneModel>(models: T[], search: string, limit: number): LaneView<T> {
  const query = search.trim().toLowerCase();
  const matched = query
    ? models.filter(model => model.label.toLowerCase().includes(query) || model.route.toLowerCase().includes(query))
    : models;
  // Stable partition: available first, server order preserved inside each half.
  const ordered = matched.toSorted((a, b) => Number(!a.available) - Number(!b.available));
  const shown = ordered.slice(0, limit);
  return {
    total: models.length,
    showSearch: models.length > LANE_SEARCH_MIN,
    shown,
    hidden: ordered.length - shown.length,
    noMatch: models.length > 0 && ordered.length === 0,
  };
}

/**
 * Default family fold: every family starts collapsed so model lists open on demand.
 *
 * This supersedes the earlier "fold only the empty families" rule. Keeping Opus open by
 * default made the vertical stack taller than the viewport once a family filled up, so the
 * page now opens compact and every list is one click away.
 */
export function defaultCollapsedFamilies(counts: Readonly<Record<string, number>>): Set<string> {
  return new Set(Object.keys(counts));
}

/**
 * Whether a model row starts expanded.
 *
 * A row is collapsed by default EXCEPT the family's resolved default: that is the row a
 * user opens the page to change, so putting it behind a second click would fail the
 * discoverability test progressive disclosure exists to pass.
 */
export function rowStartsOpen(route: string, familyDefault: string | null): boolean {
  return familyDefault !== null && route === familyDefault;
}
