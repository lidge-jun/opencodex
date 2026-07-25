import { expect, test } from "bun:test";

/**
 * WP1 (devlog/_plan/260725_gui_view_consolidation/010_subagents_single.md):
 * Subagents has exactly ONE implementation — the former Classic render. The
 * Workspace component, its stylesheet, and its i18n keys were withdrawn after
 * the maintainer compared both implementations and kept Classic.
 */

test("Subagents renders a single implementation with no Workspace branch", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();

  // The Workspace implementation and its branch are gone.
  expect(page).not.toContain("SubagentsWorkspace");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("workspaceView");
  expect(page).not.toContain("subagents-workspace");

  // Exactly one render path remains after the loading guard.
  expect(page).toContain("if (loading) return");
  expect(page.match(/^ {2}return \(/gm)?.length).toBe(1);

  // The page never owned a local toggle; that stays true.
  expect(page).not.toContain("ocx-subagents-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");
});

test("Subagents keeps the featured-slot contract: 5 slots, reorder, remove, save", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();

  // Five-slot cap and its visible counter.
  expect(page).toContain("prev.length >= 5");
  expect(page).toContain("{chosen.length}/5");

  // Reorder / remove / save controls survive the consolidation.
  expect(page).toContain('t("sub.moveUp", { m })');
  expect(page).toContain('t("sub.moveDown", { m })');
  expect(page).toContain('t("sub.removeAria", { m })');
  expect(page).toContain('t("common.save")');

  // Persistence still targets the subagent-models endpoint.
  expect(page).toContain("/api/subagent-models");
});

test("Workspace-only assets and i18n keys are fully withdrawn", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(css).not.toContain("styles-subagents-workspace.css");

  const workspaceComponent = Bun.file(
    new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url),
  );
  expect(await workspaceComponent.exists()).toBe(false);

  const workspaceCss = Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url));
  expect(await workspaceCss.exists()).toBe(false);

  // All six locales drop the Workspace-only strings together.
  for (const locale of ["en", "ko", "ja", "de", "ru", "zh"]) {
    const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(src).not.toContain("sub.workspace.");
  }
});
