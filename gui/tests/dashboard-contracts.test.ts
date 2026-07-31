import { expect, test } from "bun:test";
import { en } from "../src/i18n/en";
import { normalizeInjectionSelection } from "../src/pages/dashboard-core-poll";
import { PROJECT_CONFIG_DIAGNOSTICS_POLL_MS, beginPollEpoch, beginPollEpochs } from "../src/startup-health-ui";

test("project-config diagnostics poll cadence is owned by the shared constant", () => {
  expect(PROJECT_CONFIG_DIAGNOSTICS_POLL_MS).toBe(30_000);
});

test("dashboard poll epochs share beginPollEpoch", () => {
  const refs = {
    settingsRequest: { current: 0 },
    settingsMutation: { current: 2 },
    shadowRequest: { current: 0 },
    shadowMutation: { current: 4 },
  };
  const paired = beginPollEpochs(refs);
  expect(paired.settings).toEqual({ request: 1, mutation: 2 });
  expect(paired.shadow).toEqual({ request: 1, mutation: 4 });
  expect(beginPollEpoch(refs.settingsRequest, refs.settingsMutation)).toEqual({ request: 2, mutation: 2 });
});

test("Dashboard wires a single project-config diagnostics owner outside the settings poll", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  // Diagnostics live in their own fetcher + client-resource poll, not inside core health.
  expect(core.match(/diagnostics\/project-config/g)?.length ?? 0).toBe(1);
  expect(hook).toContain("fetchProjectConfigDiagnostics");
  expect(hook).toContain("PROJECT_CONFIG_DIAGNOSTICS_POLL_MS");
  // Overview poll must not own the diagnostics endpoint.
  const overviewFnStart = core.indexOf("export async function fetchDashboardOverview");
  expect(overviewFnStart).toBeGreaterThan(-1);
  const overviewBody = core.slice(overviewFnStart, core.indexOf("export async function fetchDashboardMultiAgent"));
  expect(overviewBody).not.toContain("diagnostics/project-config");
});

test("Dashboard usage polling cannot delay core health and settings", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const overviewFnStart = core.indexOf("export async function fetchDashboardOverview");
  const usageFnStart = core.indexOf("export async function fetchDashboardUsage");
  const sidecarsFnStart = core.indexOf("export async function fetchDashboardSidecars");
  expect(overviewFnStart).toBeGreaterThan(-1);
  expect(usageFnStart).toBeGreaterThan(-1);
  expect(sidecarsFnStart).toBeGreaterThan(-1);
  expect(core.slice(overviewFnStart, core.indexOf("export async function fetchDashboardMultiAgent"))).not.toContain("/api/usage?range=30d");
  expect(core.slice(overviewFnStart, core.indexOf("export async function fetchDashboardMultiAgent"))).not.toContain("/api/sidecar-settings");
  expect(core.slice(overviewFnStart, core.indexOf("export async function fetchDashboardMultiAgent"))).not.toContain("/api/shadow-call-settings");
  expect(core.slice(sidecarsFnStart)).toContain("/api/sidecar-settings");
  expect(hook).toContain("dashboard-usage:${apiBase}");
  expect(hook).toContain("dashboard-sidecars:${apiBase}");
  expect(hook).toContain("dashboard-overview:${apiBase}");
  expect(hook).toContain("fetchDashboardUsage(apiBase, signal)");
  expect(hook).toContain("fetchDashboardSidecars");
  expect(hook).toContain("fetchDashboardOverview");
  expect(hook).toMatch(/dashboard-usage:\$\{apiBase\}[\s\S]*pollMs: 60_000/);
});

test("Dashboard interactive controls load independently of health/providers", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const sidecarsFnStart = core.indexOf("export async function fetchDashboardSidecars");
  const settingsFnStart = core.indexOf("export async function fetchDashboardSettings");
  expect(sidecarsFnStart).toBeGreaterThan(-1);
  expect(settingsFnStart).toBeGreaterThan(-1);
  const sidecarsBody = core.slice(sidecarsFnStart, settingsFnStart > sidecarsFnStart ? settingsFnStart : undefined);
  expect(sidecarsBody).toContain("/api/sidecar-settings");
  expect(sidecarsBody).toContain("/api/shadow-call-settings");
  expect(sidecarsBody).not.toContain("/api/settings");
  expect(sidecarsBody).not.toContain("/healthz");
  expect(sidecarsBody).not.toContain("/api/providers");
  expect(sidecarsBody).not.toContain("/api/usage");
});

test("Dashboard overview status widgets do not wait on injection-model", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const overviewStart = core.indexOf("export async function fetchDashboardOverview");
  const multiStart = core.indexOf("export async function fetchDashboardMultiAgent");
  expect(overviewStart).toBeGreaterThan(-1);
  expect(multiStart).toBeGreaterThan(overviewStart);
  const overviewBody = core.slice(overviewStart, multiStart);
  expect(overviewBody).toContain("/healthz");
  expect(overviewBody).toContain("/api/providers");
  expect(overviewBody).not.toContain("/api/injection-model");
  expect(overviewBody).not.toContain("/api/v2");
  expect(overviewBody).not.toContain("/api/effort-caps");
  expect(core.slice(multiStart)).toContain("/api/injection-model");
  expect(hook).toContain("dashboard-overview:${apiBase}");
  expect(hook).toContain("dashboard-multi-agent:${apiBase}");
  expect(hook).toContain("enabled: overviewReady");
});

test("Dashboard MA mode and sidecars do not wait on settings or injection", async () => {
  const core = await Bun.file(new URL("../src/pages/dashboard-core-poll.ts", import.meta.url)).text();
  const hook = await Bun.file(new URL("../src/pages/use-dashboard-data.ts", import.meta.url)).text();
  const maStart = core.indexOf("export async function fetchDashboardMaMode");
  const sidecarsStart = core.indexOf("export async function fetchDashboardSidecars");
  const settingsStart = core.indexOf("export async function fetchDashboardSettings");
  const overviewStart = core.indexOf("export async function fetchDashboardOverview");
  expect(maStart).toBeGreaterThan(-1);
  expect(sidecarsStart).toBeGreaterThan(-1);
  expect(settingsStart).toBeGreaterThan(-1);
  const maBody = core.slice(maStart, overviewStart > maStart ? overviewStart : undefined);
  const sidecarsBody = core.slice(sidecarsStart, settingsStart > sidecarsStart ? settingsStart : undefined);
  expect(maBody).toContain("/api/v2");
  expect(maBody).not.toContain("/api/injection-model");
  expect(maBody).not.toContain("/api/settings");
  expect(sidecarsBody).toContain("/api/sidecar-settings");
  expect(sidecarsBody).not.toContain("/api/settings");
  expect(hook).toContain("dashboard-ma-mode:${apiBase}");
  expect(hook).toContain("dashboard-sidecars:${apiBase}");
  expect(hook).toContain("dashboard-settings:${apiBase}");
  expect(hook).not.toContain("dashboard-controls:${apiBase}");
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

test("fetchStartupHealth does not map abort into a sticky error status", async () => {
  const { fetchStartupHealth } = await import("../src/pages/dashboard-core-poll");
  const controller = new AbortController();
  controller.abort();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    return Response.json({ status: "protected", diagnosticStale: false });
  }) as typeof fetch;
  try {
    await expect(fetchStartupHealth("http://test", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
