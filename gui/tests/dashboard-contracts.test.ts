import { expect, test } from "bun:test";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS } from "../src/startup-health-ui";

test("project-config diagnostics poll cadence is owned by the shared constant", () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
});

test("Dashboard wires a single project-config diagnostics owner outside the settings poll", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src.match(/diagnostics\/project-config/g)?.length ?? 0).toBe(1);
  expect(src).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  const fetchDataStart = src.indexOf("const fetchData = async () => {");
  const fetchDataEnd = src.indexOf("const interval = setInterval(fetchData, 5000);", fetchDataStart);
  expect(fetchDataStart).toBeGreaterThan(-1);
  expect(fetchDataEnd).toBeGreaterThan(fetchDataStart);
  expect(src.slice(fetchDataStart, fetchDataEnd)).not.toContain("diagnostics/project-config");
});

test("Dashboard workspace pane is a labelled section, not a nested main landmark", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("dashboard-workspace-main");
  expect(src).toContain("dash.workspace.sections");
  expect(src).not.toMatch(/<main\b[^>]*dashboard-workspace-main/);
  expect(src).toMatch(/<(section)\b[^>]*dashboard-workspace-main/);
});

test("multi-agent guidance gates injection controls and Active badge on the enabled flag", async () => {
  const src = await Bun.file(new URL("../src/pages/Dashboard.tsx", import.meta.url)).text();
  expect(src).toContain("!multiAgentGuidanceEnabled");
  expect(src).toContain("multiAgentGuidanceEnabled &&");
  expect(src).toContain("models.v2Mode_");
});
