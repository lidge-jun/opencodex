import { expect, test } from "bun:test";

test("Subagents exposes and persists the global fallback chain", async () => {
  const page = await Bun.file(new URL("../src/pages/Subagents.tsx", import.meta.url)).text();
  const workspace = await Bun.file(
    new URL("../src/components/subagents-workspace/SubagentDelegationSection.tsx", import.meta.url),
  ).text();

  expect(page).toContain("/api/subagent-model-fallback");
  expect(page).toContain("pollMs: fallbackPollMs");
  expect(page).toContain("useSubagentModels");
  expect(page).toContain("onFallbackSave");
  expect(workspace).toContain('t("sub.fallbackLabel")');
  expect(workspace).toContain('t("sub.fallbackAdd")');
  expect(workspace).toContain("onFallbackChange");
  expect(workspace).toContain("onFallbackPollMsChange");
  expect(workspace).toContain('t("sub.fallbackUseRoster")');
  expect(page).toContain('setUseSubagentModels(next.useSubagentModels)');
});
