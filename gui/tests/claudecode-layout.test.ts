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

  // Claude is now a panel of the Integrations tab strip rather than its own
  // top-level page, so App renders the shell and the shell renders Claude.
  expect(app).toContain("<Integrations apiBase={API_BASE} />");
  const integrations = await Bun.file(new URL("../src/pages/Integrations.tsx", import.meta.url)).text();
  expect(integrations).toContain("<Claude apiBase={apiBase} active={active} />");
  // Title/subtitle sit above the Code/Desktop strip (not inside each panel).
  expect(claude).toContain("claude-page-intro");
  expect(claude).toContain("claude.pageTitle");
  expect(claude.indexOf("claude-page-intro")).toBeLessThan(claude.indexOf("claude-tabs"));
  // Both children stay mounted so drafts survive a tab switch; `active` is what keeps the hidden
  // one from fetching, so the two panels must be wired symmetrically.
  // The inner gate is now ANDed with the outer panel's own `active`: a hidden
  // Integrations tab must not leave its selected inner panel polling.
  expect(claude).toContain("<ClaudeCode key={apiBase} apiBase={apiBase} active={active && tab === \"code\"} />");
  expect(claude).toContain("active={active && tab === \"desktop\"}");
  expect(claude).toContain("onPortChange={setDesktopPort}");
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
