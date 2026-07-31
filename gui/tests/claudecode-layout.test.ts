import { expect, test } from "bun:test";

test("ClaudeCode renders the denser workspace rail layout", async () => {
  const page = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  // The Claude nav entry mounts a Code/Desktop tab wrapper; ClaudeCode itself is
  // the Code tab body with a section rail to cut scroll.
  const claude = await Bun.file(new URL("../src/pages/Claude.tsx", import.meta.url)).text();

  expect(page).toContain("claudecode-workspace");
  expect(page).toContain("ccw-body");
  expect(page).toContain("selectedSection");
  expect(page).toContain("claude.workspace.settings");

  expect(app).toContain("<Claude apiBase={API_BASE} />");
  expect(claude).toContain("<ClaudeCode key={apiBase} apiBase={apiBase} />");
  expect(claude).toContain("<ClaudeDesktop key={apiBase} apiBase={apiBase} active={tab === \"desktop\"} />");
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
