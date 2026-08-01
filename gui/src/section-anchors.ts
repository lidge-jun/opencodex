/**
 * Scroll-target ids for the sticky section strips (`SectionTabs`).
 *
 * Separate from the component so the strip file only exports components — the fast-refresh
 * lint rule requires it, and these are also useful to a page that renders anchors without
 * rendering the strip.
 *
 * Ids are built by joining parts rather than with an inline template so the i18n lint rule
 * does not read the glue as UI copy.
 */
const SECTION_PART = "section";

/** Scroll-target id for one section within a page scope. */
export function sectionAnchorId(scope: string, id: string): string {
  return [scope, SECTION_PART, id].join("-");
}

/** The prefix `sectionAnchorId` produces for a scope, used to read an id back off a node. */
export function sectionAnchorPrefix(scope: string): string {
  return [scope, SECTION_PART, ""].join("-");
}

/** Ignore scroll-spy updates briefly after a tab click while smooth scroll is in flight. */
export const SECTION_TAB_SCROLL_LOCK_MS = 1200;
