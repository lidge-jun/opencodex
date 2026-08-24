import { expect, test } from "bun:test";

/**
 * Superseded by WP2a (devlog/_plan/260725_gui_view_consolidation/020_nav_and_dashboard_tabs.md).
 *
 * The phase-one information architecture moves account authentication into the
 * Providers workflow. The legacy route remains valid for bookmarks and recovery,
 * but it is no longer a duplicate top-level destination.
 */

test("Codex Auth remains routable without duplicating the Providers navigation", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  // The old conditional filter must not come back.
  expect(src).not.toContain('viewMode === "workspace" && id === "codex-auth"');
  /*
   * The subject here is "the sidebar renders the whole table", not the shape of
   * one line. Pinning the exact destructuring made this fail the moment an
   * entry gained a field — a change it was never written to catch.
   */
  expect(src).toContain("NAV_GROUPS.map(");

  const nav = src.slice(src.indexOf("const NAV_GROUPS"), src.indexOf("const NAV ="));
  expect(nav).not.toContain('id: "codex-auth"');
  // The page itself stays mounted for existing bookmarks and provider recovery flows.
  expect(src).toContain('{page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}');
});
