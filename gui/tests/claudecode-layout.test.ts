import { expect, test } from "bun:test";

test("ClaudeCode renders the denser workspace rail layout", async () => {
  const page = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  // The Claude nav entry mounts a Code/Desktop tab wrapper; ClaudeCode itself is
  // the Code tab body with a section rail to cut scroll.
  const claude = await Bun.file(new URL("../src/pages/Claude.tsx", import.meta.url)).text();

  expect(page).toContain("claudecode-workspace");
  expect(page).toContain("ccw-body");
  expect(page).toContain("ccw-main-head");
  expect(page).toContain("selectedSection");
  expect(page).toContain("claude.workspace.settings");
  // Save stays in the pane head (visibility-toggled) so the Code/Desktop chrome does not jump.
  expect(page).toContain('data-visible={sectionEditable ? "true" : "false"}');

  // Claude lives as a tab inside Connect (Integrations), not as its own App slot.
  expect(app).not.toContain("<Claude ");
  const integrations = await Bun.file(new URL("../src/pages/Integrations.tsx", import.meta.url)).text();
  expect(integrations).toContain("<Claude apiBase={apiBase} active={active} embedded />");
  // Standalone, one page head; embedded in Connect, the Connect strip names the page instead.
  expect(claude).toContain('<h2>{t("nav.claude")}</h2>');
  expect(claude).toContain("claude.pageSub");
  // No sub-tab strip: Claude renders the Code content directly.
  expect(claude).not.toContain('role="tablist"');
  expect(claude).toContain("<ClaudeCode key={apiBase} apiBase={apiBase} active={active} />");
  // Claude Desktop is its own Connect tab, rendered by Integrations rather than by Claude.
  expect(claude).not.toContain("<ClaudeDesktop");
  expect(integrations).toContain("<ClaudeDesktop key={apiBase} apiBase={apiBase} active={active} />");
});

test("ClaudeCode workspace sections remain available in source order", async () => {
  const src = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();

  const order = [
    "<ClaudeCodeSettingsCard",
    "<ClaudeCodeQuickstartSection",
    "<SmallFastModelSetting",
    "<ClaudeCodeModelMapSection",
    "<ClaudeCodeAliasesSection",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
});
