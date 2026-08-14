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
  expect(hook).toContain("usageSummary30dResourceKey(apiBase)");
  expect(hook).toContain("dashboard-sidecars:${apiBase}");
  expect(hook).toContain("dashboard-overview:${apiBase}");
  expect(hook).toContain("fetchDashboardUsage(apiBase, signal)");
  expect(hook).toContain("fetchDashboardSidecars");
  expect(hook).toContain("fetchDashboardOverview");
  expect(hook).not.toMatch(/usageSummary30dResourceKey\(apiBase\)[\s\S]*pollMs: 60_000/);
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
  // The controls live on the Subagents tab now; the Dashboard keeps only a link to them.
  const sections = await Bun.file(new URL("../src/components/subagents-workspace/SubagentDelegationSection.tsx", import.meta.url)).text();
  const head = await Bun.file(new URL("../src/pages/dashboard-overview-head.tsx", import.meta.url)).text();
  expect(core).toContain("syncCodexSubagentDefaults: data.syncCodexSubagentDefaults === true");
  expect(sections).toContain("onSave({ syncCodexSubagentDefaults: !syncCodexDefaults })");
  expect(sections).toContain("disabled={saving || !model}");
  expect(sections).not.toContain("saving || !guidanceEnabled");
  expect(sections).not.toContain("dash.injectionActive");
  // Two promises this copy must keep, asserted by meaning rather than by an exact
  // sentence so the wording can be made plainer without breaking the contract:
  // the off state is explained, and it does not clobber hand-written [agents] settings.
  expect(en["dash.syncCodexSubagentDefaultsHint"]).toMatch(/\boff\b/i);
  expect(en["dash.syncCodexSubagentDefaultsHint"]).toMatch(/\[agents\][^.]*\b(left alone|preserved|not overwritten|untouched)\b/i);
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

// The chip used to sit on the server's conservative placeholder until the next 30s tick, which is
// why an unrelated action (refresh quota, tab hop) looked like the thing that fixed it. The probe
// has to carry `stale` through so the caller can re-ask in seconds.
test("fetchStartupHealth reports whether the server answer is still being resolved", async () => {
  const { fetchStartupHealth } = await import("../src/pages/dashboard-core-poll");
  const { probeNeedsFastRetry } = await import("../src/startup-health-ui");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ status: "at-risk", diagnosticStale: true })) as typeof fetch;
    const stale = await fetchStartupHealth("http://test", new AbortController().signal);
    expect(stale).toEqual({ status: "at-risk", stale: true });
    expect(probeNeedsFastRetry(stale)).toBe(true);

    globalThis.fetch = (async () => Response.json({ status: "protected", diagnosticStale: false })) as typeof fetch;
    const settled = await fetchStartupHealth("http://test", new AbortController().signal);
    expect(settled).toEqual({ status: "protected", stale: false });
    expect(probeNeedsFastRetry(settled)).toBe(false);

    // A hard failure is the normal poll's job; re-asking every 2s would just hammer it.
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const failed = await fetchStartupHealth("http://test", new AbortController().signal);
    expect(failed).toEqual({ status: "error", stale: false });
    expect(probeNeedsFastRetry(failed)).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
