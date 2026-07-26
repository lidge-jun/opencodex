import { expect, test } from "bun:test";
import { en } from "../src/i18n/en";
import { normalizeInjectionSelection } from "../src/pages/dashboard-core-poll";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS } from "../src/startup-health-ui";

test("project-config diagnostics poll cadence is owned by the shared constant", () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
});

test("Dashboard wires a single project-config diagnostics owner outside the settings poll", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  // Diagnostics live in their own fetcher + client-resource poll, not inside core health.
  expect(core.match(/diagnostics\/project-config/g)?.length ?? 0).toBe(1);
  expect(hook).toContain("fetchProjectConfigDiagnostics");
  expect(hook).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  // Core poll must not own the diagnostics endpoint.
  const coreFnStart = core.indexOf("export async function fetchDashboardCore");
  expect(coreFnStart).toBeGreaterThan(-1);
  const coreBody = core.slice(coreFnStart);
  expect(coreBody).not.toContain("diagnostics/project-config");
});

test("Dashboard usage polling cannot delay core health and settings", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const coreFnStart = core.indexOf("export async function fetchDashboardCore");
  const usageFnStart = core.indexOf("export async function fetchDashboardUsage");
  expect(coreFnStart).toBeGreaterThan(-1);
  expect(usageFnStart).toBeGreaterThan(-1);
  expect(core.slice(coreFnStart)).not.toContain("/api/usage?range=30d");
  expect(hook).toContain("dashboard-usage:${apiBase}");
  expect(hook).toContain("fetchDashboardUsage(apiBase, signal)");
  expect(hook).toMatch(/dashboard-usage:\$\{apiBase\}[\s\S]*pollMs: 60_000/);
});

test("Dashboard workspace pane is a labelled section, not a nested main landmark", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("dashboard-workspace-main");
  expect(src).toContain("dash.workspace.sections");
  expect(src).not.toMatch(/<main\b[^>]*dashboard-workspace-main/);
  expect(src).toMatch(/<(section)\b[^>]*dashboard-workspace-main/);
});

test("native Codex subagent defaults stay separate from OpenCodex guidance", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const sections = await Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text();
  const head = await Bun.file(new URL("../src/pages/dashboard-overview-head.tsx", import.meta.url)).text();
  expect(core).toContain("syncCodexSubagentDefaults: data.syncCodexSubagentDefaults === true");
  expect(sections).toContain("saveInjection({ syncCodexSubagentDefaults: !syncCodexSubagentDefaults })");
  expect(sections).toContain("disabled={injectionSaving || !injectionModel}");
  expect(sections).not.toContain("injectionSaving || !multiAgentGuidanceEnabled");
  expect(sections).not.toContain("dash.injectionActive");
  expect(en["dash.syncCodexSubagentDefaults"]).toBe("Use as native Codex subagent defaults");
  expect(en["dash.syncCodexSubagentDefaultsHint"]).toContain("Off by default");
  expect(en["dash.syncCodexSubagentDefaultsHint"]).toContain("existing user-owned [agents] defaults are preserved rather than overwritten");
  expect(en["dash.multiAgentGuidanceHint"]).not.toContain("proactive");
  expect(head).toContain("models.v2Mode_");
});

test("injection writes consume the server's model-clear normalization", () => {
  expect(normalizeInjectionSelection({
    multiAgentGuidanceEnabled: true,
    syncCodexSubagentDefaults: false,
    model: null,
    effort: null,
  })).toEqual({
    multiAgentGuidanceEnabled: true,
    syncCodexSubagentDefaults: false,
    injectionModel: "",
    injectionEffort: "",
  });
});

test("Dashboard sync surfaces native subagent default warnings", async () => {
  const sections = await Bun.file(new URL("../src/pages/dashboard-overview-sections.tsx", import.meta.url)).text();
  expect(sections).toContain("syncResult.nativeSubagentDefaultsWarning");
  expect(sections).toContain('"notice-warn"');
  expect(sections).toContain("<IconAlert />");
});
