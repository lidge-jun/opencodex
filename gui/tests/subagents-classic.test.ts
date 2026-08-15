import { expect, test } from "bun:test";

/**
 * Subagents ships a single denser workspace layout (rail + featured main pane).
 * Classic stacked cards and the view-mode toggle are gone.
 */

test("Subagents mounts the denser workspace as the only layout", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();

  expect(page).toContain("SubagentsWorkspace");
  expect(page).toContain("subagents-workspace");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("workspaceView");
  expect(page).not.toContain("ocx-subagents-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  // Exactly one workspace render path remains after the shared cold-state guard.
  expect(page).toContain('state.showSkeleton && !snapshot');
  expect(page).toContain("DataSurfaceSkeleton");
  expect(page.match(/^ {2}return \(/gm)?.length).toBe(1);
});

test("Subagents keeps the featured-slot contract: 5 slots, reorder, remove, save", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();
  const workspace = await Bun.file(
    new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url),
  ).text();

  // Five-slot cap is a single exported FEATURED_MAX shared by page and workspace.
  expect(page).toContain("prev.length >= FEATURED_MAX");
  expect(page).toContain("FEATURED_MAX");
  expect(workspace).toContain("export const FEATURED_MAX");
  expect(workspace).toContain("{chosen.length}/{FEATURED_MAX}");

  // Reorder / remove / save controls survive in the workspace main pane.
  expect(workspace).toContain('t("sub.moveUp", { m })');
  expect(workspace).toContain('t("sub.moveDown", { m })');
  expect(workspace).toContain('t("sub.removeAria", { m })');
  expect(workspace).toContain('t("common.save")');

  // Persistence still targets the subagent-models endpoint.
  expect(page).toContain("/api/subagent-models");
});

test("Subagents workspace assets and i18n keys are present", async () => {
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();
  expect(css).toContain("styles-subagents-workspace.css");

  const workspaceComponent = Bun.file(
    new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url),
  );
  expect(await workspaceComponent.exists()).toBe(true);

  const workspaceCss = Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url));
  expect(await workspaceCss.exists()).toBe(true);

  for (const locale of ["en", "fr", "ko", "ja", "de", "ru", "zh", "zh-TW"]) {
    const src = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(src).toContain("sub.workspace.");
  }
});
