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

test("every row maps one-to-one onto a page", () => {
  // The duplicate-row machinery is gone with the row that needed it.
  expect(src).not.toContain("activeHashes");
  expect(src).not.toContain("isNavEntryActive");
  expect(src).not.toContain('tkey: "nav.claude"');

  const navBlock = src.slice(src.indexOf("const NAV: NavEntry[] = ["), src.indexOf("];", src.indexOf("const NAV: NavEntry[] = [")));
  const ids = [...navBlock.matchAll(/\{ id: "([^"]+)"/g)].map(m => m[1]);

  // The exact rows, in order. A count alone would pass if a row were swapped for
  // another, and Routing folding into Models is precisely that kind of change.
  expect(ids).toEqual([
    "dashboard", "codex-set", "providers", "models", "subagents",
    "logs", "usage", "storage", "remote", "integrations",
  ]);
  // No two rows share a page id, which is what made the correction helper necessary.
  expect(new Set(ids).size).toBe(ids.length);
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
  for (const selector of [".lang-toggle", ".theme-toggle", ".sidebar-link"]) {
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
