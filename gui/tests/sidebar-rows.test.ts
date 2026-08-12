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
    "dashboard", "codex-auth", "providers", "models", "subagents",
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

test("Claude Code is still reachable, just not as a duplicate row", async () => {
  // Removing the shortcut must not remove the destination.
  const routing = await Bun.file(new URL("../src/app-routing.ts", import.meta.url)).text();
  expect(routing).toContain('"integrations/claude"');
  expect(routing).toContain('"integrations/claude/desktop"');
});
