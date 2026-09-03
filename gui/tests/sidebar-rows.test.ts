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

  // The exact nine, in order. A count alone would pass if a row were swapped for
  // another, and Routing folding into Models is precisely that kind of change.
  expect(ids).toEqual([
    "dashboard", "codex-set", "providers", "models", "subagents",
    "logs", "usage", "storage", "integrations",
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

test("the foot is two orb rows: preferences/links, then runtime actions", async () => {
  /*
   * The foot used to stack five labelled rows (lang, theme, proxy label, GitHub link,
   * star/update) that together outweighed the nine navigation entries above them. It is
   * now two rows of 28px orbs with no text; each orb keeps aria-label + title.
   */
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  expect(rule(".sidebar-foot-row")).toContain("gap: 4px");
  expect(rule(".sidebar-foot-row")).toContain("padding: 4px 10px");
  // The language Select is orb-sized and its own value/chevron are hidden.
  expect(rule(".lang-toggle .select-trigger")).toContain("width: 28px");
  expect(css).toContain(".lang-toggle .select-trigger > span, .lang-toggle .select-trigger > svg { display: none; }");

  // The old labelled rows and the sidebar star orb are gone from CSS and JSX alike.
  for (const gone of [".theme-toggle {", ".sidebar-action-label {", ".sidebar-action-row {", ".sidebar-github-row {", ".sidebar-orb--starred {"]) {
    expect(css).not.toContain(gone);
  }
  expect(src).not.toContain("sidebar-action-label");
  expect(src).not.toContain('className="theme-toggle"');
  expect(src.match(/className="sidebar-foot-row"/g)?.length).toBe(2);

  // Star moved into the update dialog; the sidebar row only links and updates.
  const row = await Bun.file(new URL("../src/components/sidebar-github-row.tsx", import.meta.url)).text();
  expect(row).not.toContain("IconStar");
  expect(row).not.toContain("/api/github/star");
  const dialogs = await Bun.file(new URL("../src/pages/dashboard-dialogs.tsx", import.meta.url)).text();
  expect(dialogs).toContain("{updateOpen && <GithubStarButton apiBase={d.apiBase} />}");
});

test("Claude Code is still reachable, just not as a duplicate row", async () => {
  // Removing the shortcut must not remove the destination.
  const routing = await Bun.file(new URL("../src/app-routing.ts", import.meta.url)).text();
  expect(routing).toContain('"integrations/claude"');
  expect(routing).toContain('"integrations/claude/desktop"');
});
