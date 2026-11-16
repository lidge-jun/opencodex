import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

/*
 * The professional pass (design-system/foundations.md, "Professional pass"): a flat canvas,
 * hairline cards, tight radii, a short type scale, tabular figures, no decorative motion or
 * gradients, and a quiet sidebar. Each check below names the rule it holds.
 */
const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("flat canvas: no ambient gradient wash and no glass rail", async () => {
  const styles = await read("../src/styles.css");
  expect(styles).not.toContain("radial-gradient(");
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toMatch(/\.sidebar \{\s*background: var\(--rail\);\s*backdrop-filter: none;/);
});

test("tight radii and hairline cards", async () => {
  const theme = await read("../src/design/theme.css");
  expect(theme).toContain("--radius-control: 0.5rem;");
  expect(theme).toContain("--radius-card: 0.625rem;");
  expect(theme).toContain("--radius-panel: 0.75rem;");
  // rounded-full must stay finite: Tailwind's calc(infinity * 1px) default builds to
  // 2147483647px, which macOS WKWebView can paint as square corners (#8281).
  expect(theme).toMatch(/@theme inline \{[^}]*--radius-full: 9999px;/);
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toMatch(/\.card,\s*\.panel \{\s*border: 1px solid var\(--ocx-line\);/);
});

test("a short type scale with tabular figures", async () => {
  const theme = await read("../src/design/theme.css");
  expect(theme).toContain("--text-title: 1.25rem;");
  expect(theme).toContain("--text-stat: 1.375rem;");
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toContain(":is(.stat .value, .stat .value.mono, .stat-value) {");
  expect(bridge).toContain(".page-head > :is(h1, h2) {\n  font-size: 20px;");
});

test("no decorative motion, gradient fills or oversized titles in v2 code", async () => {
  // Status dots do not pulse and buttons are flat fills. Page titles use text-title, so a
  // hand-sized 24px/26px heading cannot creep back in.
  const roots = ["src/components/ui-v2", "src/pages", "src/components/v2-accounts", "src/components/v2-connect",
    "src/components/v2-logs", "src/components/v2-models", "src/components/v2-proxy", "src/components/v2-startup",
    "src/components/v2-subagents", "src/components/v2-usage"];
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of roots) {
    if (!existsSync(new URL(`../${root}`, import.meta.url))) continue;
    for await (const file of new Bun.Glob("**/*.tsx").scan(new URL(`../${root}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
      scanned++;
      const src = await Bun.file(new URL(`../${root}/${file.split(String.fromCharCode(92)).join("/")}`, import.meta.url)).text();
      for (const [rule, rx] of [
        ["pulse", /\banimate-(ping|pulse)\b/],
        ["gradient", /\bbg-(linear|radial|conic)-|\bbg-gradient-to-|\bbg-\[(linear|radial)-gradient/],
        ["title size", /<h[12][^>]*className="[^"]*\btext-\[(2[3-9]|3\d)px\]/],
      ] as const) {
        if (rx.test(src)) offenders.push(`${root}/${file}: ${rule}`);
      }
    }
  }
  expect(scanned).toBeGreaterThan(50);
  expect(offenders).toEqual([]);
});

test("the sidebar is quiet: flat rows, no raised plate on the current page", async () => {
  const bridge = await read("../src/design/bridge.css");
  expect(bridge).toMatch(/\.nav-item \{\s*min-height: 32px;/);
  expect(bridge).toMatch(/\.nav-item\.active \{[^}]*box-shadow: none;/);
  expect(bridge).toMatch(/\.nav-tier-label \{[^}]*text-transform: none;/);
  const proxy = await read("../src/components/ui-v2/proxy-controls.tsx");
  expect(proxy).not.toContain("ocx-beam");
  expect(proxy).not.toContain("animate-ping");
});
