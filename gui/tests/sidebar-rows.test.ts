/**
 * The sidebar's row contract.
 *
 * Replaces `sidebar-claude-entry.test.ts`, which asserted the exact Claude shortcut row
 * that has now been removed. Two of its rules outlived it and are kept here: the
 * sidebar carries navigation and nothing else, and no orphaned switch styles are left
 * behind. The third — that exactly one of two rows resolving to the same page lights up
 * — cannot be violated any more, because every row maps one-to-one onto a page again.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

/*
 * Comments explain the removed Claude row by name, and matching that prose is not
 * evidence about the code — the predecessor of this file learned that the hard way, and
 * so did this one on its first run.
 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the sidebar is eight group rows, in order, owning every sidebar page once", async () => {
  const { NAV_GROUPS, groupForPage } = await import("../src/nav-groups");
  const { VALID_PAGES } = await import("../src/app-routing");

  // The exact rows, in order. A count alone would pass if a row were swapped for
  // another, and Routing folding into Models is precisely that kind of change.
  expect(NAV_GROUPS.map(group => group.id)).toEqual([
    "dashboard", "connect", "codex-set", "providers", "models", "subagents", "usage-logs", "remote",
  ]);
  expect(Object.fromEntries(NAV_GROUPS.map(group => [group.id, [...group.pages]]))).toEqual({
    dashboard: ["dashboard"],
    // Claude is a tab inside the Connect page, owned through `embedded`.
    connect: ["integrations"],
    "codex-set": ["codex-set"],
    providers: ["providers"],
    models: ["models"],
    subagents: ["subagents"],
    // Usage leads, so the row opens Usage first.
    "usage-logs": ["usage", "logs", "storage"],
    // Last row, by request.
    remote: ["remote", "remote-workspace"],
  });
  expect(NAV_GROUPS.find(group => group.id === "connect")?.embedded).toEqual(["claude"]);

  // Every routable page except Startup belongs to exactly one row; a page in two rows
  // would light both up.
  const owned = NAV_GROUPS.flatMap(group => [...group.pages, ...(group.embedded ?? [])]);
  expect(new Set(owned).size).toBe(owned.length);
  expect(new Set(owned)).toEqual(new Set([...VALID_PAGES].filter(page => page !== "startup")));
  expect(groupForPage("startup")).toBeNull();
  expect(groupForPage("storage")?.id).toBe("usage-logs");
  expect(groupForPage("claude")?.id).toBe("connect");
  expect(groupForPage("remote-workspace")?.id).toBe("remote");

  // App renders the table rather than a copy of it.
  expect(src).toContain("NAV_GROUPS.map(");
  expect(src).not.toContain("const NAV: NavEntry[]");
});

test("the section switcher lives outside the page-keyed error boundary", () => {
  /*
   * The boundary is keyed by the shell page and remounts on every navigation between
   * shells. Inside it, the switcher would be destroyed by its own click and keyboard
   * focus would fall to <body>; the component test cannot see that, because it is App's
   * placement. Claude and Integrations share one shell key, so Connect's tabs survive.
   */
  const mainInnerAt = src.indexOf('className={`main-inner');
  const switcherAt = src.indexOf("<SectionSwitcher");
  // The page boundary is the first one inside .main-inner; App has others elsewhere.
  const boundaryAt = src.indexOf("<ErrorBoundary", mainInnerAt);
  expect(mainInnerAt).toBeGreaterThan(-1);
  expect(src.slice(boundaryAt, boundaryAt + 80)).toContain("key={shellPage}");
  expect(src).toContain('const shellPage: Page = page === "claude" ? "integrations" : page;');
  expect(switcherAt).toBeGreaterThan(mainInnerAt);
  expect(switcherAt).toBeLessThan(boundaryAt);
  // Hiding the switcher under a focused button must not drop focus to <body>.
  expect(src).toContain("onFocusOrphaned={focusAfterSwitcher}");
});

test("the sidebar is navigation only", () => {
  // A nav row owning a mutation is the exact regression that removed the Claude
  // connection switch.
  const navCode = src.slice(src.indexOf("<nav>"), src.indexOf("</nav>"));
  expect(navCode).not.toContain("Switch");
  expect(navCode).not.toContain("/api/claude");
});

test("the orphaned sidebar switch styles are gone", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(css).not.toContain(".nav-entry-claude .switch");
});

test("the foot's four rows share one text column and one trailing inset", async () => {
  /*
   * The foot stacks lang, theme, proxy and GitHub two pixels apart, so any row that
   * measures itself differently is visible as a step in the stack. All four shipped
   * out of line at once: the proxy label sat 25px left of its neighbours because it
   * has no icon to clear, its row was 8.5px taller because it padded around 28px orbs
   * the others do not have, and the GitHub orbs hung 10px further out because that row
   * was the only one with no trailing inset.
   */
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  // The column every label sits in, owned by the rows that carry an icon.
  for (const selector of [".lang-toggle", ".sidebar-link"]) {
    expect(rule(selector)).toContain("padding: 8px 10px");
    expect(rule(selector)).toContain("gap: 9px");
  }

  // The proxy label has no icon, so it clears that gutter itself. Holding the block
  // padding on the label rather than the row is what keeps the row's height tied to
  // its text, like its neighbours, instead of to the taller orbs beside it.
  expect(rule(".sidebar-action-label")).toContain("padding: 8px 10px 8px calc(10px + 16px + 9px)");

  /*
   * Reject block padding on the row in every spelling, not just the shorthand it
   * shipped with: `padding: 8px 0`, or a lone `padding-top`, would hand the 28px orbs
   * back control of the row height and still slip past a check for the exact original
   * string. `padding-right` survives both patterns — "padding" is followed by "-",
   * never by a colon.
   */
  const proxyRow = rule(".sidebar-action-row");
  expect(proxyRow).not.toMatch(/padding\s*:/);
  expect(proxyRow).not.toMatch(/padding-(top|bottom|block)/);

  // Trailing controls stop on the same inset as the lang chevron above them.
  expect(proxyRow).toContain("padding-right: 10px");
  expect(rule(".sidebar-github-row")).toContain("padding-right: 10px");
});

test("Claude Code is still reachable, just not as a duplicate row", async () => {
  // Removing the shortcut must not remove the destination.
  const routing = await Bun.file(new URL("../src/app-routing.ts", import.meta.url)).text();
  expect(routing).toContain('"integrations/claude"');
  expect(routing).toContain('"integrations/claude/desktop"');
});
