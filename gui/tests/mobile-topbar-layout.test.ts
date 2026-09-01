import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error("selector not found: " + selector);
  return css.slice(start, css.indexOf("}", start));
}

// Measured on a real 320px viewport through CDP before this test existed:
// .brand .ver ended at x=245 while .mobile-topbar-actions began at x=206 - a
// 39px overlap that put the power orb on top of the version badge.
//
// A flex item only shrinks below its content size when it carries min-width: 0
// itself. ".mobile-topbar .brand" had it; its children did not, so .name held
// its intrinsic width and pushed .ver under the actions.
test("the mobile brand can shrink, so the version badge cannot reach the action orbs", () => {
  const brand = block(".mobile-topbar .brand");
  expect(brand).toContain("min-width: 0");

  const name = block(".mobile-topbar .brand .name");
  expect(name).toContain("min-width: 0");
  expect(name).toContain("overflow: hidden");
  expect(name).toContain("text-overflow: ellipsis");

  const ver = block(".mobile-topbar .brand .ver");
  expect(ver).toContain("flex-shrink: 0");
});

test("the topbar action orbs keep their touch target", () => {
  const actions = block(".mobile-topbar-actions {");
  expect(actions).toContain("flex: 0 0 auto");
  const orb = block(".mobile-topbar-actions .sidebar-orb {");
  expect(orb).toContain("min-width: 44px");
  expect(orb).toContain("min-height: 44px");
});

// Shrinking .name is necessary but not sufficient: the row budget at the
// narrowest width leaves it about 38px, which rendered as "op...". The badge is
// dropped instead - the same brand node is mounted again in the drawer head, so
// the version is one tap away, and the live value is also on the dashboard.
//
// It belongs in the tiny-phone breakpoint this stylesheet already uses. A review
// pass caught the first attempt inventing @media (max-width: 400px), which was
// the only 400px rule in the file and covered an unmeasured 375-399 band.
test("the badge is dropped at the existing tiny-phone breakpoint, not a new one", () => {
  expect(css).not.toContain("max-width: 400px");

  const tiny = css.indexOf("@media (max-width: 360px)");
  expect(tiny).toBeGreaterThan(-1);
  const scope = css.slice(tiny, tiny + 700);
  expect(scope).toContain(".mobile-topbar .brand .ver { display: none; }");
});

