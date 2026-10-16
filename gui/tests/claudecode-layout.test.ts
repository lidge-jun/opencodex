import { expect, test } from "bun:test";

test("ClaudeCode renders every section on one page without an inner rail", async () => {
  const page = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  // The Claude nav entry mounts a Code/Desktop tab wrapper; ClaudeCode itself is
  // the Code tab body, laid out as one vertical page.
  const claude = await Bun.file(new URL("../src/pages/Claude.tsx", import.meta.url)).text();

  expect(page).toContain("claudecode-workspace-shell claudecode-doc");
  // The inner section rail made a second sidebar beside the app's own; it must not return.
  expect(page).not.toContain("claudecode-workspace-rail");
  expect(page).not.toContain("selectedSection");
  // One Save bar for the page, with its own polite status line.
  expect(page).toContain('className="ccw-savebar" role="region"');
  expect(page).toContain('aria-live="polite" aria-atomic="true"');

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

test("ClaudeCode sections follow the page order, master switch and Save bar last", async () => {
  const src = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const render = src.slice(src.indexOf('<div className="claudecode-workspace-shell claudecode-doc">'));

  const order = [
    "claude.firstParty.label",
    "<ClaudeCodeQuickstartSection",
    "<ClaudeCodeSettingsCard",
    "<SmallFastModelSetting",
    "<ClaudeCodeModelMapSection",
    "<ClaudeCodeAliasesSection",
    "{connectionRow}",
    'className="ccw-savebar"',
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = render.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
});
