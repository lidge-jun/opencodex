import { expect, test } from "bun:test";

/**
 * Superseded by WP2a (devlog/_plan/260725_gui_view_consolidation/020_nav_and_dashboard_tabs.md).
 *
 * Codex Auth used to be filtered out of the sidebar in Workspace mode, on the
 * reasoning that the Providers workspace embeds the same account pool. The
 * maintainer instead promoted it to the second slot so it is always reachable.
 * That old filter was also a latent WP5 hazard: once Classic is removed there is
 * no non-workspace mode left, so a viewMode-keyed filter would have hidden the
 * page permanently.
 */

test("Codex Auth is always present in the sidebar, never filtered by view mode", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  // The old conditional filter must not come back.
  expect(src).not.toContain('viewMode === "workspace" && id === "codex-auth"');
  /*
   * The subject here is "the sidebar renders the whole table", not the shape of
   * one line. Pinning the exact destructuring made this fail the moment an
   * entry gained a field — a change it was never written to catch.
   */
  expect(src).toContain("NAV.map(");

  // It stays in the nav table and remains routable for deep links.
  expect(src).toContain('{ id: "codex-auth", tkey: "nav.codexAuth", Icon: IconKey }');
  expect(src).toContain('{page === "codex-auth" && <CodexAuth apiBase={API_BASE} />}');
});
