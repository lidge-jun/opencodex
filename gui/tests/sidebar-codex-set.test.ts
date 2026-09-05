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

test("Codex Set is always present in the sidebar, never filtered by view mode", async () => {
  const src = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  // The old conditional filter must not come back.
  expect(src).not.toContain('viewMode === "workspace" && id === "codex-auth"');
  expect(src).not.toContain('viewMode === "workspace" && id === "codex-set"');
  /*
   * The subject here is "the sidebar renders the whole table", not the shape of
   * one line. Pinning the exact destructuring made this fail the moment an
   * entry gained a field — a change it was never written to catch.
   */
  expect(src).toContain("NAV.map(");

  /*
   * It stays in the nav table and remains routable for deep links. The icon
   * component is deliberately not part of the assertion — for the same reason
   * the destructuring above is not. Pinning `Icon: IconKey` made this test fail
   * when the row was given its actual Codex mark, which is a change it was never
   * written to catch. The entry's identity is its id and its label key.
   */
  expect(src).toContain('{ id: "codex-set", tkey: "nav.codexSet", Icon:');
  expect(src).toContain('{page === "codex-set" && <CodexSet apiBase={sharedBase} />}');
});

test("the shipped #codex-auth bookmark still resolves", async () => {
  // The page id changed; a URL a user saved did not. WP3 renames the route and
  // keeps the legacy hash working rather than stranding it on an unknown page.
  const { readPageFromHash, resolveAppHashChange } = await import("../src/app-routing");
  expect(readPageFromHash("codex-auth")).toBe("codex-set");
  const action = resolveAppHashChange("codex-auth");
  expect(action.page).toBe("codex-set");
  expect(action.replaceTo).toBe("codex-set");
});
