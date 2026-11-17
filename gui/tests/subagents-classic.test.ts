import { expect, test } from "bun:test";

/**
 * The pinned roster lives in the Models page client picker section; the Subagents page keeps
 * a single denser workspace layout for delegation settings and a pointer to the roster.
 */

const read = (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test("Subagents mounts the denser workspace as the only layout", async () => {
  const page = await read("../src/pages/Subagents.tsx");

  expect(page).toContain("SubagentsWorkspace");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("workspaceView");
  expect(page).not.toContain("ocx-subagents-view");
  expect(page).not.toContain("pws.workspaceToggle");
  expect(page).not.toContain("pws.classicToggle");

  // Exactly one workspace render path remains after the shared cold-state guard.
  expect(page).toContain("state.showSkeleton && !snapshot");
  expect(page).toContain("DataSurfaceSkeleton");
  expect(page.match(/^ {2}return \(/gm)?.length).toBe(1);
});

test("Subagents only reads the pinned roster; the editor moved to the Models page", async () => {
  const page = await read("../src/pages/Subagents.tsx");
  const workspace = await read("../src/components/subagents-workspace/SubagentsWorkspace.tsx");
  const models = await read("../src/pages/Models.tsx");
  const section = await read("../src/components/ClientModelPickerSection.tsx");

  expect(page).toContain("useSubagentRoster(apiBase)");
  expect(page).not.toContain("/api/subagent-models");
  expect(workspace).not.toContain("FEATURED_MAX");
  expect(workspace).not.toContain("swi-featured");

  expect(models).toContain("ClientModelPickerSection");
  expect(section).toContain("PickerPinnedRoster");
});

test("Pinned roster keeps the slot contract: 5 slots, reorder, remove, autosave", async () => {
  const hook = await read("../src/pages/use-subagent-roster.ts");
  const roster = await read("../src/components/PickerPinnedRoster.tsx");

  // The five-slot cap is one exported FEATURED_MAX shared by the hook and the editor.
  expect(hook).toContain("export const FEATURED_MAX = 5");
  expect(hook).toContain("prev.length >= FEATURED_MAX");
  expect(roster).toContain("{chosen.length}/{FEATURED_MAX}");

  // Reorder / remove controls survive; every edit saves itself.
  expect(roster).toContain('t("sub.moveUp", { m })');
  expect(roster).toContain('t("sub.moveDown", { m })');
  expect(roster).toContain('t("sub.removeAria", { m })');
  expect(roster).not.toContain("swi-save-row");
  expect(hook).toContain("void persistRoster(next)");

  // Persistence still targets the subagent-models endpoint.
  expect(hook).toContain("/api/subagent-models");
});

test("Subagents workspace assets and i18n keys are present", async () => {
  const css = await read("../src/styles.css");
  expect(css).toContain("styles-subagents-workspace.css");

  expect(await Bun.file(new URL("../src/components/subagents-workspace/SubagentsWorkspace.tsx", import.meta.url)).exists()).toBe(true);
  expect(await Bun.file(new URL("../src/styles-subagents-workspace.css", import.meta.url)).exists()).toBe(true);

  for (const locale of ["en", "fr", "ko", "ja", "de", "ru", "zh", "zh-TW"]) {
    const src = await read(`../src/i18n/${locale}.ts`);
    expect(src).toContain("sub.workspace.");
  }
});
