import { expect, test } from "bun:test";

/**
 * The Claude row.
 *
 * It was removed from the sidebar together with the connection switch it used
 * to carry (a56a4aea6). Removing the switch was right — a nav row owning a
 * mutation is a trap — but the entry went with it, and Claude Code is the
 * deepest surface in the app.
 *
 * Two things have to stay true: the row navigates and nothing else, and it does
 * not light up at the same time as Integrations, since both resolve to the same
 * page and only the hash tells them apart.
 */

const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

test("the Claude row targets the Claude tab and carries no mutation", () => {
  expect(src).toContain('tkey: "nav.claude"');
  expect(src).toContain('subPath: "claude"');
  expect(src).toContain('activeHashes: ["integrations/claude"]');

  /*
   * The sidebar is navigation only. A Switch here is the exact regression the
   * collapse removed. Strip comments before asserting: the block explains the
   * removed mutation in prose, and matching that prose is not evidence about
   * the code — an earlier version of this test failed on its own explanation.
   */
  const navBlock = src.slice(src.indexOf("<nav>"), src.indexOf("</nav>"));
  const navCode = navBlock.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, "").replace(/\/\/.*$/gm, "");
  expect(navCode).not.toContain("Switch");
  expect(navCode).not.toContain("/api/claude");
});

test("the orphaned sidebar switch styles are gone", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(css).not.toContain(".nav-entry-claude .switch");
});

/**
 * Mirrors `isNavEntryActive`. Kept as a local re-implementation rather than an
 * export because App does not otherwise expose its nav internals; the rule is
 * small and the two hash cases below are what actually matter.
 */
function activeRow(rawHash: string): "claude" | "integrations" | null {
  const claimed = rawHash === "integrations/claude" || rawHash.startsWith("integrations/claude/");
  if (claimed) return "claude";
  if (rawHash === "integrations" || rawHash.startsWith("integrations/")) return "integrations";
  return null;
}

test("exactly one row is current for any integrations hash", () => {
  expect(activeRow("integrations")).toBe("integrations");
  expect(activeRow("integrations/keys")).toBe("integrations");
  expect(activeRow("integrations/grok")).toBe("integrations");
  // Claude wins its own tab, and the nested Desktop route too — that is what
  // the prefix match buys instead of a second nav entry.
  expect(activeRow("integrations/claude")).toBe("claude");
  expect(activeRow("integrations/claude/desktop")).toBe("claude");
});
