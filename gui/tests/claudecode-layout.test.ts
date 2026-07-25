import { expect, test } from "bun:test";

test("ClaudeCode renders the single stacked layout (no workspace rail)", async () => {
  const page = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();

  expect(page).not.toContain("claudecode-workspace");
  expect(page).not.toContain("ccw-body");
  expect(page).not.toContain("selectedSection");
  expect(page).not.toContain("claude.workspace.settings");

  expect(app).toContain("<ClaudeCode apiBase={API_BASE} />");
});

test("ClaudeCode stacked layout mounts every section in order", async () => {
  const src = await Bun.file(new URL("../src/pages/ClaudeCode.tsx", import.meta.url)).text();

  const order = [
    "{settingsSection}",
    "{quickstartSection}",
    "{smallFastSection}",
    "{modelMapSection}",
    "{aliasesSection}",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }
});
