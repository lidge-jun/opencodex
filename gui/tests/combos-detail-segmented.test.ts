/**
 * The Combos detail panel's Config/About switch.
 *
 * Combos is a tab of the Models page now, so an underline row here would sit directly
 * beneath the page tab strip — two rows of the same visual language stacked, which
 * reads as two levels of navigation rather than one page's facets. Primer names this
 * directly in its UnderlineNav guidance.
 *
 * The roles stay tab semantics because they control a real tabpanel; only the styling
 * changed. That distinction is what these assertions protect: a future "cleanup" that
 * converts them to a radiogroup would misdescribe the widget.
 */
import { expect, test } from "bun:test";

const panel = await Bun.file(
  new URL("../src/components/combo-workspace-detail-panel.tsx", import.meta.url),
).text();
const css = await Bun.file(
  new URL("../src/styles-combos-workspace.css", import.meta.url),
).text();

test("the detail switch renders as a segmented pill, not an underline row", () => {
  expect(panel).toContain('className="segmented combos-workspace-segmented"');
  // The old underline classes are gone from both the markup and the stylesheet.
  expect(panel).not.toContain("combos-workspace-tab--active");
  expect(css).not.toContain(".combos-workspace-tab {");
  expect(css).not.toContain(".combos-workspace-tabs {");
});

test("it keeps tab semantics because it controls a real tabpanel", () => {
  expect(panel).toContain('role="tablist"');
  expect(panel).toContain('role="tab"');
  expect(panel).toContain("aria-selected={tab ===");
  expect(panel).toContain('role="tabpanel"');
  // A filter shape would be wrong here: these switch a panel, they do not filter rows.
  expect(panel).not.toContain('role="radiogroup"');
});

test("the pill group has its own concrete styling, since .segmented alone has none", () => {
  expect(css).toContain(".combos-workspace-segmented {");
  expect(css).toContain(".combos-workspace-segmented .btn {");
  expect(css).toContain("border-radius: var(--radius-pill)");
});
