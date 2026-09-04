/**
 * The product brand is the "go home" affordance.
 *
 * It was an inert <div> for the app's whole life, which is how a user ended up on
 * #providers with no obvious way back to the first screen: the sidebar row exists and
 * works, but the logo is what people click first, and clicking it did nothing.
 *
 * These are source-shape assertions rather than a DOM render because the brand node is
 * defined once and mounted twice (mobile topbar + drawer head); asserting the single
 * definition covers both surfaces, and the two live App mounts elsewhere in this suite
 * already prove the JSX renders.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
// Comments describe the control by name; matching prose is not evidence about code.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
const en = await Bun.file(new URL("../src/i18n/en.ts", import.meta.url)).text();

const brand = src.slice(src.indexOf("const brand = ("), src.indexOf("</button>", src.indexOf("const brand = (")));

test("the brand is an interactive control, not an inert div", () => {
  // Bound to the brand NODE itself, not to "a button exists somewhere inside": a
  // regression that wrapped a button in <div className="brand brand-home"> would pass
  // a looser check while the brand stayed an inert div.
  expect(brand).toMatch(/^const brand = \(\s*<button\b[^>]*\bclassName="brand brand-home"/);
  expect(brand).toContain('type="button"');
});

test("activating the brand navigates to the dashboard", () => {
  // navigateToPage is the deliberate-navigation helper the nav rows use: it pushes a
  // history entry, so Back returns to the page the user came from.
  expect(brand).toContain('navigateToPage("dashboard")');
});

test("using the brand inside the drawer closes the drawer", () => {
  // The same node is mounted in the off-canvas drawer. Navigating without closing
  // leaves the drawer sitting over the destination.
  expect(brand).toContain("setNavOpen(false)");
});

test("the brand carries an accessible name and marks the current page", () => {
  // The visible text is the product name, which does not say what the control does.
  expect(brand).toContain('aria-label={t("nav.goHome")}');
  expect(brand).toContain('page === "dashboard"');
  expect(brand).toContain('"aria-current"');
});

test("the button reset exists, because this stylesheet has no global one", () => {
  // Every control here resets itself locally the way .nav-item does. Without this the
  // UA buttonface plate, border, font and centered text land on the brand.
  const start = css.indexOf(".brand-home {");
  expect(start).toBeGreaterThan(-1);
  const rule = css.slice(start, css.indexOf("}", start));
  expect(rule).toContain("appearance: none");
  expect(rule).toContain("background: none");
  expect(rule).toContain("border: none");
  expect(rule).toContain("font: inherit");
  expect(rule).toContain("color: inherit");
  expect(rule).toContain("text-align: left");
  expect(rule).toContain("cursor: pointer");
});

test("the class list still starts with .brand so every layout rule keeps applying", () => {
  // .drawer-head .brand and .mobile-topbar .brand own the flex/min-width contract that
  // mobile-topbar-layout.test.ts asserts; dropping the base class would silently
  // detach the brand from all of it.
  expect(brand).toContain('className="brand brand-home"');
});

test("the home label exists in the English source", () => {
  expect(en).toContain('"nav.goHome"');
});
