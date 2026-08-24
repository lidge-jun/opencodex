/**
 * The sidebar's row contract.
 *
 * Replaces `sidebar-claude-entry.test.ts`, which asserted the exact Claude shortcut row
 * that has now been removed. Two of its rules outlived it and are kept here: the
 * sidebar carries navigation and nothing else, and no orphaned switch styles are left
 * behind. Phase one intentionally promotes two existing nested routes (API keys and
 * routing) without adding new pages or a parallel router.
 */
import { expect, test } from "bun:test";

const raw = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

/*
 * Comments explain the removed Claude row by name, and matching that prose is not
 * evidence about the code — the predecessor of this file learned that the hard way, and
 * so did this one on its first run.
 */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("grouped rows preserve the phase-one information architecture", () => {
  expect(src).not.toContain('tkey: "nav.claude"');

  const navBlock = src.slice(src.indexOf("const NAV_GROUPS"), src.indexOf("];", src.indexOf("const NAV_GROUPS")));
  const targets = [...navBlock.matchAll(/\{ id: "([^"]+)"(?:, subPath: "([^"]+)")?, tkey:/g)]
    .map(([, id, subPath]) => subPath ? `${id}/${subPath}` : id);

  expect(targets).toEqual([
    "dashboard",
    "providers", "models", "integrations/keys",
    "usage", "logs",
    "models/routing", "subagents",
    "integrations", "startup", "storage",
  ]);
  expect(new Set(targets).size).toBe(targets.length);
  expect(src).toContain("const exactEntry = NAV.find");
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
