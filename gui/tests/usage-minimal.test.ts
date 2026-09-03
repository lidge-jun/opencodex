import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../src/pages/Usage.tsx"), "utf8");
const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/**
 * devlog/_plan/260904_dashboard_minimal/060_usage.md: five summary cards (the "active days"
 * card said nothing a 7/30-day range with a heatmap did not), the counting caveat on the
 * coverage card as a focusable info button (not a paragraph, not a title attribute), the
 * cost figure at body weight beside its caveat, and the year heatmap behind a closed
 * disclosure for 30d while the seven-day bars stay inline.
 */
describe("Usage page minimal shape", () => {
  test("five cards, no active-days card, no subtitle paragraph", () => {
    expect(src).toContain('className="usage-cards usage-cards-5"');
    expect(src).not.toContain("usage.card.activeDays");
    expect(src).not.toContain("activeDays");
    expect(src).not.toContain('<p className="page-sub">{t("usage.subtitle")}</p>');
  });

  test("the counting caveat is a focusable tooltip on the coverage card with an accessible name", () => {
    expect(src).toContain('<Tooltip content={t("usage.subtitle")}');
    expect(src).toContain('{t("usage.subtitleAria")}');
    expect(src).not.toMatch(/title=\{t\("usage\.subtitle"\)\}/);
  });

  test("the cost figure is body weight, not a stat value", () => {
    expect(src).toContain('className="mono text-control usage-cost-value"');
    expect(src).not.toContain('className="stat-value mono usage-cost-value"');
  });

  test("30d heatmap sits in a closed details whose toggle re-pins the scroll; 7d bars stay inline", () => {
    expect(src).toContain('<details className="panel usage-heatmap-details" style={{ marginTop: 16 }} onToggle={pinRight}>');
    expect(src).toContain("const pinRight = useCallback(");
    expect(src).not.toMatch(/<details className="panel usage-heatmap-details"[^>]*\bopen\b/);
    // Seven-day bars are returned before the details branch.
    expect(src.indexOf('if (range === "7d") {')).toBeLessThan(src.indexOf('<details className="panel usage-heatmap-details"'));
    expect(css).toContain(".usage-heatmap-details > summary::-webkit-details-marker { display: none; }");
    expect(css).toContain(".usage-cards-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }");
  });
});
