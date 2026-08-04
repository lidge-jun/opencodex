import { expect, test } from "bun:test";

async function styles(): Promise<string> {
  return Bun.file(new URL("../src/styles.css", import.meta.url)).text();
}

/**
 * Declaration block of a rule matching `selector`. `which` picks between the base rule and a
 * later media-query override, both of which exist for `.sidebar` and the beside-placement menu.
 */
function ruleBody(css: string, selector: string, which: "first" | "last" = "last"): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  expect(matches.length).toBeGreaterThan(0);
  return (which === "first" ? matches[0]! : matches.at(-1)!)[1]!;
}

// The locale menu opens beside its trigger, which sits in the sidebar footer. It used to be
// pinned with `top: 0` and no height limit, so growing the locale list to six entries pushed it
// past the bottom of the sidebar. A repositioning fix alone would not hold — the durable
// property is the height bound, which makes the menu independent of how many locales exist.
test("the beside-placement menu is anchored upward and height-bounded", async () => {
  const css = await styles();

  for (const selector of [".select-dropdown-beside", ".lang-toggle .select-dropdown-beside"]) {
    const body = ruleBody(css, selector);
    expect(`${selector}: ${body}`).not.toMatch(/top:\s*0/);
    expect(body).toMatch(/bottom:\s*0/);
    expect(body).toMatch(/max-height:/);
    expect(body).toMatch(/overflow-y:\s*auto/);
  }
});

// `position: fixed` cannot be used here: the sidebar establishes a containing block via
// backdrop-filter on desktop and a transform on the mobile drawer, so fixed coordinates would
// resolve against the sidebar rather than the viewport — and the blur is itself conditional on
// accessibility settings, which would make the bug depend on the user environment.
test("the sidebar still establishes the containing block this fix assumes", async () => {
  const css = await styles();
  // The base desktop rule, not the mobile-drawer override further down the file.
  const sidebar = ruleBody(css, ".sidebar", "first");
  expect(sidebar).toMatch(/backdrop-filter:/);
  // The mobile drawer establishes one too, via transform — which is why a fixed-position fix
  // would have been wrong in BOTH layouts.
  const drawer = ruleBody(css, ".sidebar", "last");
  expect(drawer).toMatch(/transform:\s*translateX/);
});

// The drawer scrolls, so beside-placement would be clipped at its edge; the mobile rule opens
// the menu upward from the foot row instead. It must keep outranking the desktop rule.
test("the mobile drawer keeps its own upward placement", async () => {
  const css = await styles();
  expect(css).toMatch(/\.sidebar \.lang-toggle \.select-dropdown-beside\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\)/);
});
