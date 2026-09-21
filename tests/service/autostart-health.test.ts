import { describe, expect, test } from "bun:test";
import { collectStartupHealth, deriveStartupHealth, formatStartupRoutingDetail, injectedRoutingRestartWarningLines, startupHealthSummary } from "../../src/codex/autostart-health";
import { unusedProxyWarningLines } from "../../src/cli/status";
import { classifyCodexRouting, hasInjectedCodexRouting } from "../../src/codex/inject";
import { isCodexClientProcess, listCodexClientProcesses } from "../../src/codex/native-profile-processes";
import { collectRoutingAdoption, deriveRoutingAdoption } from "../../src/codex/routing-adoption";
import { handleManagementAPI } from "../../src/server/management-api";
import { getCachedStartupHealth, getStartupHealthSnapshot, invalidateStartupHealthCache, markStartupHealthDiagnosticStale } from "../../src/server/startup-health-cache";
import type { OcxConfig } from "../../src/types";

const base = {
  routingKind: "opencodex-local" as const,
  autostartEnabled: true,
  serviceInstalled: false,
  serviceViable: false,
  serviceEnabled: false,
  serviceRunning: false,
  serviceStale: false,
  serviceConflict: false,
  serviceSupported: true,
  shimInstalled: false,
  shimHealthy: false,
  platform: "win32" as const,
};

describe("Codex startup health", () => {
  test("flags injected routing without a persistent starter as restart-unsafe", () => {
    const health = deriveStartupHealth(base);
    expect(health).toMatchObject({
      status: "at-risk",
      rebootSafe: false,
      protection: "none",
      recommendedCommand: "ocx service install",
    });
    expect(startupHealthSummary(health)).toContain("AT RISK");
    expect(startupHealthSummary(health)).toContain("ocx service install");
  });

  // 260804 #970 follow-up: an already-REGISTERED service is refreshed in place. `install`
  // re-registers, which needs elevation on Windows and can switch a WinSW backend to Task
  // Scheduler, so recommending it to someone who already has a service costs them a UAC
  // prompt they do not need. Ablate by restoring the unconditional installService and the
  // stale/unhealthy cases below go red.
  test("an installed but unhealthy service is repaired, not re-registered", () => {
    for (const broken of [
      { serviceInstalled: true, serviceStale: true },
      { serviceInstalled: true, serviceEnabled: false },
      { serviceInstalled: true, serviceRunning: false },
    ]) {
      const health = deriveStartupHealth({ ...base, ...broken });
      expect(health.status).toBe("at-risk");
      expect(health.recommendedCommand).toBe("ocx service repair");
      expect(startupHealthSummary(health)).toContain("ocx service repair");
    }
  });

  test("a genuinely absent service still gets the registering command", () => {
    const health = deriveStartupHealth({ ...base, serviceInstalled: false });
    expect(health.recommendedCommand).toBe("ocx service install");
  });

  test("a conflicting service needs uninstall-then-install, not repair", () => {
    // repairService() refuses a conflict outright — two managers must be torn down first.
    const health = deriveStartupHealth({ ...base, serviceInstalled: true, serviceConflict: true });
    expect(health.recommendedCommand).toBe("ocx service install");
  });

  test("treats a background service as restart protection", () => {
    const health = deriveStartupHealth({ ...base, serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    expect(health).toMatchObject({
      status: "protected",
      rebootSafe: true,
      protection: "service",
      recommendedCommand: null,
    });
  });

  test("never preserves a green local-routing claim when diagnostics are stale", () => {
    const protectedHealth = deriveStartupHealth({ ...base, serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    expect(markStartupHealthDiagnosticStale(protectedHealth)).toMatchObject({
      status: "at-risk",
      rebootSafe: false,
      protection: "none",
      diagnosticStale: true,
    });
  });

  // The stale-cache path re-derives recommendedCommand itself, so it can silently undo
  // the repair choice deriveStartupHealth made — and the dashboard reads exactly this
  // value while a probe is revalidating. Asserting status/protection alone missed it.
  test("the stale-cache path keeps repair for an installed service", () => {
    const installed = deriveStartupHealth({ ...base, serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    expect(markStartupHealthDiagnosticStale(installed).recommendedCommand).toBe("ocx service repair");

    const absent = deriveStartupHealth({ ...base, serviceInstalled: false, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    expect(markStartupHealthDiagnosticStale(absent).recommendedCommand).toBe("ocx service install");

    const conflict = deriveStartupHealth({ ...base, serviceInstalled: true, serviceConflict: true, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    expect(markStartupHealthDiagnosticStale(conflict).recommendedCommand).toBe("ocx service install");
  });

  test("classifies a healthy Windows shim as CLI-only rather than Desktop-safe", () => {
    const windowsShim = deriveStartupHealth({ ...base, shimInstalled: true, shimHealthy: true });
    expect(windowsShim).toMatchObject({ protection: "shim", shimCoverage: "cli-only", status: "at-risk" });
    const unixShim = deriveStartupHealth({ ...base, platform: "linux", shimInstalled: true, shimHealthy: true });
    expect(unixShim).toMatchObject({ protection: "shim", shimCoverage: "cli-only", status: "at-risk" });
    expect(deriveStartupHealth({ ...base, shimInstalled: true, shimHealthy: false }).status).toBe("at-risk");
    expect(deriveStartupHealth({ ...base, autostartEnabled: false, shimInstalled: true, shimHealthy: true }).status).toBe("at-risk");
  });

  test("native routing has no opencodex restart dependency", () => {
    const health = deriveStartupHealth({ ...base, routingKind: "native" });
    expect(health).toMatchObject({ status: "native", rebootSafe: true, protection: "none" });
  });

  test("recognizes marker-owned and legacy routing without claiming user overrides", () => {
    expect(hasInjectedCodexRouting([
      '# Auto-injected by opencodex',
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "[features]",
    ].join("\n"))).toBe(true);
    expect(hasInjectedCodexRouting([
      'model_provider = "opencodex"',
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
    ].join("\n"))).toBe(true);
    expect(hasInjectedCodexRouting('openai_base_url = "http://127.0.0.1:10100/v1"')).toBe(false);
    expect(classifyCodexRouting('openai_base_url = "http://127.0.0.1:10100/v1"')).toBe("custom-local");
    expect(classifyCodexRouting('"openai_base_url" = "http://127.0.0.2:10100/v1"')).toBe("custom-local");
    expect(classifyCodexRouting('openai_base_url = "http://0.0.0.0:10100/v1"')).toBe("custom-local");
    expect(classifyCodexRouting('openai_base_url = "http://[::]:10100/v1"')).toBe("custom-local");
    expect(classifyCodexRouting('openai_base_url = "http://[::ffff:127.0.0.1]:10100/v1"')).toBe("custom-local");
    expect(classifyCodexRouting('openai_base_url = "http://[::ffff:127.1.2.3]:10100/v1"')).toBe("custom-local");
    expect(classifyCodexRouting('openai_base_url = "not-a-url"')).toBe("unknown");
    expect(classifyCodexRouting('openai_base_url = "https://gateway.example/v1"')).toBe("custom-remote");
    expect(classifyCodexRouting([
      '"model_provider" = "gateway"',
      '[model_providers."gateway"]',
      '"base_url" = "http://127.0.0.2:10100/v1"',
    ].join("\n"))).toBe("custom-local");
    expect(classifyCodexRouting([
      'model_provider = "gateway"',
      '[model_providers.gateway]',
    ].join("\n"))).toBe("unknown");
    expect(classifyCodexRouting('model_provider = "missing-custom"')).toBe("unknown");
    expect(classifyCodexRouting('model_provider = "openai"')).toBe("native");
    expect(classifyCodexRouting([
      "[features]",
      'model_provider = "opencodex"',
      "[model_providers.opencodex]",
      'base_url = "http://127.0.0.1:10100/v1"',
    ].join("\n"))).toBe("native");
    expect(classifyCodexRouting([
      'model_provider = "opencodex"',
      "[model_providers.opencodex]",
      'base_url = "https://gateway.example/v1"',
    ].join("\n"))).toBe("opencodex-local");
    expect(classifyCodexRouting([
      "# Auto-injected by opencodex",
      'openai_base_url = "http://192.168.1.10:10100/v1"',
    ].join("\n"))).toBe("opencodex-local");
  });

  test("fails closed for installed-but-broken services and custom local gateways", () => {
    expect(deriveStartupHealth({ ...base, serviceInstalled: true, serviceStale: true })).toMatchObject({
      status: "at-risk",
      rebootSafe: false,
      serviceViable: false,
    });
    expect(deriveStartupHealth({ ...base, routingKind: "custom-local" })).toMatchObject({
      status: "at-risk",
      routingInjected: false,
      localRoutingDependency: true,
      protection: "none",
      recommendedCommand: "ocx restore",
    });
    expect(deriveStartupHealth({ ...base, routingKind: "custom-local", serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true })).toMatchObject({
      status: "at-risk",
      rebootSafe: false,
      protection: "none",
      recommendedCommand: "ocx restore",
    });
    expect(deriveStartupHealth({ ...base, routingKind: "custom-remote" })).toMatchObject({
      status: "native",
      localRoutingDependency: false,
    });
    expect(deriveStartupHealth({ ...base, routingKind: "unknown", serviceInstalled: true, serviceViable: true })).toMatchObject({
      status: "at-risk",
      rebootSafe: false,
      protection: "none",
      recommendedCommand: "ocx restore",
    });
    const custom = deriveStartupHealth({ ...base, routingKind: "custom-local" });
    expect(startupHealthSummary(custom)).toContain("run 'ocx restore'");
    expect(startupHealthSummary(custom)).not.toContain("ocx service install");
  });

  test("exposes fresh secret-free startup health across cache expiry", async () => {
    invalidateStartupHealthCache();
    let now = 1_000;
    let probeCalls = 0;
    const cacheDeps = {
      now: () => now,
      probe: async () => {
        probeCalls += 1;
        return deriveStartupHealth({
          ...base,
          routingKind: probeCalls === 1 ? "native" : "custom-remote",
        });
      },
    };
    const readStartupHealth = (config: Pick<OcxConfig, "codexAutoStart">) =>
      getCachedStartupHealth(config, cacheDeps);
    const url = new URL("http://localhost/api/startup-health");
    const responsePromise = handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig,
      { getCachedStartupHealth: readStartupHealth },
    );
    const response = await responsePromise;
    expect(response?.status).toBe(200);

    const body = await response!.json() as Record<string, unknown>;
    expect(["native", "protected", "at-risk"]).toContain(body.status);
    expect(typeof body.rebootSafe).toBe("boolean");
    expect(typeof body.routingInjected).toBe("boolean");
    expect(body.diagnosticStale).toBe(false);
    expect(body.routingKind).toBe("native");
    expect(probeCalls).toBe(1);
    expect(body.commands).toEqual({
      installService: "ocx service install",
      repairService: "ocx service repair",
      installShim: "ocx codex-shim install",
      restoreNative: "ocx restore",
    });

    const serialized = JSON.stringify(body).toLowerCase();
    for (const secretName of ["api_key", "apikey", "authorization", "access_token", "refresh_token"]) {
      expect(serialized).not.toContain(secretName);
    }

    now += 30_001;
    const refreshed = await handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig,
      { getCachedStartupHealth: readStartupHealth },
    );
    const refreshedBody = await refreshed!.json() as Record<string, unknown>;
    expect(refreshedBody.diagnosticStale).toBe(false);
    expect(refreshedBody.routingKind).toBe("custom-remote");
    expect(probeCalls).toBe(2);
  });

  test("a platform probe that misses its bounded wait returns stale health", async () => {
    invalidateStartupHealthCache();
    let releaseProbe!: (value: ReturnType<typeof deriveStartupHealth>) => void;
    const pendingProbe = new Promise<ReturnType<typeof deriveStartupHealth>>(resolve => {
      releaseProbe = resolve;
    });
    let observedWaitMs = 0;

    const health = await getCachedStartupHealth(
      { codexAutoStart: true },
      {
        probe: async () => pendingProbe,
        waitForProbe: async (_probe, timeoutMs) => {
          observedWaitMs = timeoutMs;
          return null;
        },
      },
    );

    expect(health.diagnosticStale).toBe(true);
    expect(observedWaitMs).toBeGreaterThan(0);

    releaseProbe(deriveStartupHealth({ ...base, routingKind: "native" }));
    await pendingProbe;
    invalidateStartupHealthCache();
  });

  test("settings snapshot starts a probe without waiting for it", async () => {
    invalidateStartupHealthCache();
    let releaseProbe!: (value: ReturnType<typeof deriveStartupHealth>) => void;
    const pendingProbe = new Promise<ReturnType<typeof deriveStartupHealth>>(resolve => {
      releaseProbe = resolve;
    });

    const health = getStartupHealthSnapshot(
      { codexAutoStart: true },
      { probe: async () => pendingProbe },
    );

    expect(health.diagnosticStale).toBe(true);
    releaseProbe(deriveStartupHealth({ ...base, routingKind: "native" }));
    await pendingProbe;
    invalidateStartupHealthCache();
  });

  test("snapshot preserves fresh protection and returns expired protection before a controlled probe settles", async () => {
    invalidateStartupHealthCache();
    let now = 1_000;
    const config = { codexAutoStart: true };
    const protectedHealth = deriveStartupHealth({ ...base, serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    await getCachedStartupHealth(config, { now: () => now, probe: async () => protectedHealth, waitForProbe: probe => probe });
    let calls = 0;
    let release!: (value: typeof protectedHealth) => void;
    const pending = new Promise<typeof protectedHealth>(resolve => { release = resolve; });
    const deps = { now: () => now, probe: () => { calls += 1; return pending; }, waitForProbe: (probe: Promise<typeof protectedHealth>) => probe };
    expect(getStartupHealthSnapshot(config, deps)).toBe(protectedHealth);
    expect(calls).toBe(0);
    now += 30_000;
    const snapshot = getStartupHealthSnapshot(config, deps);
    expect(snapshot).toMatchObject({ diagnosticStale: true, status: "at-risk", rebootSafe: false });
    // Snapshot has returned while the manually controlled probe remains unresolved.
    expect(getStartupHealthSnapshot(config, deps)).toEqual(snapshot);
    const fresh = getCachedStartupHealth(config, deps);
    const replacement = deriveStartupHealth({ ...base, routingKind: "custom-remote" });
    release(replacement);
    expect(await fresh).toBe(replacement);
    expect(calls).toBe(1);
    invalidateStartupHealthCache();
  });

  test.each(["reject", "throw"])("detached snapshot probe handles %s and permits a later retry", async (failure) => {
    invalidateStartupHealthCache();
    const config = { codexAutoStart: true };
    const failed = getStartupHealthSnapshot(config, { probe: () => {
      if (failure === "throw") throw new Error("controlled probe failure");
      return Promise.reject(new Error("controlled probe failure"));
    } });
    expect(failed.diagnosticStale).toBe(true);
    const settled = await getCachedStartupHealth(config, { waitForProbe: probe => probe });
    expect(settled.diagnosticStale).toBe(true);
    const replacement = deriveStartupHealth({ ...base, routingKind: "native" });
    expect(await getCachedStartupHealth(config, { probe: async () => replacement, waitForProbe: probe => probe })).toBe(replacement);
    invalidateStartupHealthCache();
  });

  test("invalidated probe cannot replace or clear a newer flight", async () => {
    invalidateStartupHealthCache();
    const config = { codexAutoStart: true };
    type Health = ReturnType<typeof deriveStartupHealth>;
    let oldRelease!: (value: Health) => void;
    let newRelease!: (value: Health) => void;
    const oldProbe = new Promise<Health>(resolve => { oldRelease = resolve; });
    const newProbe = new Promise<Health>(resolve => { newRelease = resolve; });
    getStartupHealthSnapshot(config, { probe: () => oldProbe });
    const oldWait = getCachedStartupHealth(config, { waitForProbe: probe => probe });
    invalidateStartupHealthCache();
    getStartupHealthSnapshot(config, { probe: () => newProbe });
    const newer = getCachedStartupHealth(config, { waitForProbe: probe => probe });
    oldRelease(deriveStartupHealth(base));
    await oldWait;
    let spuriousCalls = 0;
    getStartupHealthSnapshot(config, { probe: async () => { spuriousCalls += 1; return deriveStartupHealth(base); } });
    const expected = deriveStartupHealth({ ...base, routingKind: "native" });
    newRelease(expected);
    expect(await newer).toBe(expected);
    expect(getStartupHealthSnapshot(config)).toBe(expected);
    expect(spuriousCalls).toBe(0);
    invalidateStartupHealthCache();
  });
});
import { ManagementRequest as Request } from "../helpers/management-auth";

describe("routing visibility (#2411)", () => {
  test("formatStartupRoutingDetail renders the token doctor already prints", () => {
    expect(formatStartupRoutingDetail(deriveStartupHealth({ ...base, routingKind: "native" })))
      .toBe("routing=native, service=absent, shim=absent");
    expect(formatStartupRoutingDetail(deriveStartupHealth({
      ...base,
      serviceInstalled: true,
      serviceViable: true,
      shimInstalled: true,
      shimHealthy: true,
    }))).toBe("routing=opencodex-local, service=viable, shim=healthy");
    expect(formatStartupRoutingDetail(deriveStartupHealth({ ...base, serviceInstalled: true })))
      .toBe("routing=opencodex-local, service=installed-but-unhealthy, shim=absent");
    expect(formatStartupRoutingDetail(deriveStartupHealth({ ...base, shimInstalled: true })))
      .toBe("routing=opencodex-local, service=absent, shim=stale");
  });

  // A healthy proxy paired with native routing is the state #2411 reports: the
  // process answers /healthz truthfully while no Codex request reaches it.
  // custom-local and unknown stay silent on purpose — startupHealthSummary
  // already renders both as AT RISK with a remedy, so a second warning would
  // train operators to ignore this one.
  test("unusedProxyWarningLines fires only for a live proxy on native routing", () => {
    expect(unusedProxyWarningLines({ proxyUp: true, routingKind: "native" }).length).toBeGreaterThan(0);
    expect(unusedProxyWarningLines({ proxyUp: true, routingKind: "native" }).join(" ")).toContain("unused");
    expect(unusedProxyWarningLines({ proxyUp: false, routingKind: "native" })).toEqual([]);
    expect(unusedProxyWarningLines({ proxyUp: true, routingKind: "opencodex-local" })).toEqual([]);
    expect(unusedProxyWarningLines({ proxyUp: true, routingKind: "custom-remote" })).toEqual([]);
    expect(unusedProxyWarningLines({ proxyUp: true, routingKind: "custom-local" })).toEqual([]);
    expect(unusedProxyWarningLines({ proxyUp: true, routingKind: "unknown" })).toEqual([]);
  });

  // #5261: setup writes routing that outlives the session and then ends on a success line.
  // The warning reuses the health model rather than re-deriving the condition, so it cannot
  // disagree with what status and doctor say about the same install.
  test("injectedRoutingRestartWarningLines speaks exactly when the install is restart-unsafe", () => {
    const atRisk = deriveStartupHealth(base);
    expect(atRisk.status).toBe("at-risk");
    const lines = injectedRoutingRestartWarningLines(atRisk);
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join(" ");
    expect(joined).toContain("survives a restart");
    expect(joined).toContain(startupHealthSummary(atRisk));
    // The way out that does not require the proxy to come back first.
    expect(joined).toContain("ocx restore");

    // A CLI-only shim still leaves Codex Desktop uncovered, which is the reported shape.
    const shimmed = deriveStartupHealth({ ...base, shimInstalled: true, shimHealthy: true });
    expect(shimmed.status).toBe("at-risk");
    expect(injectedRoutingRestartWarningLines(shimmed).length).toBeGreaterThan(0);
    // ...and the warning must stay true in that case: a healthy shim DOES restart the proxy, for
    // CLI launches. Claiming nothing will would contradict the summary line printed beneath it.
    expect(injectedRoutingRestartWarningLines(shimmed).join(" ")).not.toContain("nothing here will restart");
    expect(injectedRoutingRestartWarningLines(shimmed).join(" ")).toContain(startupHealthSummary(shimmed));

    // Native routing has no opencodex restart dependency, so there is nothing to warn about.
    expect(injectedRoutingRestartWarningLines(deriveStartupHealth({ ...base, routingKind: "native" }))).toEqual([]);
    // Neither does a viable service, which is the state the warning is steering toward.
    const served = deriveStartupHealth({ ...base, serviceInstalled: true, serviceViable: true, serviceEnabled: true, serviceRunning: true });
    expect(served.status).toBe("protected");
    expect(injectedRoutingRestartWarningLines(served)).toEqual([]);
  });
});

// #4550: configured routing is not adopted routing. A Codex client that started
// before the route was injected cannot have read it, so status must name the
// stale pid instead of presenting config on disk as live traffic. Everything
// here runs through the pure derivation and the injected lister/start-time
// seams — no real process table or journal is touched.
describe("routing adoption (#4550)", () => {
  const injectedAtMs = 1_700_000_000_000;

  const staleClientEvidence = (
    clients: ReadonlyArray<{ pid: number; startedAtMs: number | null }> = [
      { pid: 4242, startedAtMs: injectedAtMs - 60_000 },
    ],
  ) => deriveRoutingAdoption({ routingKind: "opencodex-local", injectedAtMs, clients });

  test("a client started before the injection is pending-client-restart with its pid named", () => {
    const evidence = staleClientEvidence();
    expect(evidence.adoption).toBe("pending-client-restart");
    expect(evidence.staleClients).toEqual([{ pid: 4242, startedAtMs: injectedAtMs - 60_000 }]);
    expect(evidence.observedClients).toBe(1);
  });

  test("a client started after the injection is adopted", () => {
    const evidence = deriveRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      clients: [{ pid: 4242, startedAtMs: injectedAtMs + 60_000 }],
    });
    expect(evidence).toMatchObject({ adoption: "adopted", staleClients: [], observedClients: 1 });
  });

  test("a start in the same wall-clock second as the injection is not stale", () => {
    // ps -o lstart is second-granularity, so a millisecond lead inside the same
    // second is a rounding artifact, not proof the client predates the route.
    // Both values sit inside second 1700000000; the comparison must truncate.
    const evidence = deriveRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs: injectedAtMs + 900,
      clients: [{ pid: 4242, startedAtMs: injectedAtMs + 100 }],
    });
    expect(evidence.adoption).toBe("adopted");
    expect(evidence.staleClients).toEqual([]);
  });

  test("enumeration failure, a missing injection time, and an unreadable start all resolve to unknown", () => {
    // "Could not tell" must never collapse into a clean bill of health.
    expect(deriveRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      clients: [{ pid: 4242, startedAtMs: injectedAtMs + 60_000 }],
      enumerationFailed: true,
    }).adoption).toBe("unknown");
    expect(deriveRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs: null,
      clients: [{ pid: 4242, startedAtMs: injectedAtMs - 60_000 }],
    }).adoption).toBe("unknown");
    expect(deriveRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      clients: [{ pid: 4242, startedAtMs: null }],
    }).adoption).toBe("unknown");
  });

  test("a stale client outranks an unreadable one", () => {
    const evidence = staleClientEvidence([
      { pid: 4242, startedAtMs: injectedAtMs - 60_000 },
      { pid: 4343, startedAtMs: null },
    ]);
    expect(evidence.adoption).toBe("pending-client-restart");
    expect(evidence.staleClients).toEqual([{ pid: 4242, startedAtMs: injectedAtMs - 60_000 }]);
  });

  test.each(["native", "custom-local"] as const)("routing kind %s is not-applicable without enumerating clients", (routingKind) => {
    // We do not speak for routing we do not own — the collector must not even
    // walk the process table for a kind that is not opencodex-local.
    let listCalls = 0;
    const evidence = collectRoutingAdoption({
      routingKind,
      listClients: () => {
        listCalls += 1;
        return { status: "enumerated", processes: [] };
      },
      readStartMsBatch: () => new Map(),
    });
    expect(evidence.adoption).toBe("not-applicable");
    expect(listCalls).toBe(0);
  });

  test("collectRoutingAdoption reads start times through its seams and names the stale pid", () => {
    const evidence = collectRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      platform: "linux",
      listClients: () => ({
        status: "enumerated" as const,
        processes: [{ pid: 4242, commandLine: "codex chat" }],
      }),
      readStartMsBatch: pids => new Map(pids.map(pid => [pid, injectedAtMs - 60_000])),
    });
    expect(evidence.adoption).toBe("pending-client-restart");
    expect(evidence.staleClients).toEqual([{ pid: 4242, startedAtMs: injectedAtMs - 60_000 }]);
  });

  test("collectRoutingAdoption maps an unavailable walk and a start-time failure to unknown", () => {
    expect(collectRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      listClients: () => ({ status: "unavailable" as const }),
    }).adoption).toBe("unknown");
    expect(collectRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      listClients: () => ({
        status: "enumerated" as const,
        processes: [{ pid: 4242, commandLine: "codex chat" }],
      }),
      readStartMsBatch: () => { throw new Error("start times unavailable"); },
    }).adoption).toBe("unknown");
  });

  test("formatStartupRoutingDetail keeps the routing/service/shim prefix and appends stale clients", () => {
    const plain = formatStartupRoutingDetail(deriveStartupHealth(base));
    expect(plain).toBe("routing=opencodex-local, service=absent, shim=absent");

    // adopted evidence adds nothing — the string stays byte-identical, which is
    // what keeps the pre-#4550 assertions above valid.
    const adopted = deriveRoutingAdoption({
      routingKind: "opencodex-local",
      injectedAtMs,
      clients: [{ pid: 4242, startedAtMs: injectedAtMs + 60_000 }],
    });
    expect(formatStartupRoutingDetail(deriveStartupHealth({ ...base, routingAdoption: adopted }))).toBe(plain);

    const stale = staleClientEvidence();
    expect(formatStartupRoutingDetail(deriveStartupHealth({ ...base, routingAdoption: stale })))
      .toBe(`${plain}, clients=pending-restart(pid 4242)`);
  });

  test("a stale client adds a restart action to the summary without changing restart-safety classification", () => {
    const without = deriveStartupHealth(base);
    const withStale = deriveStartupHealth({ ...base, routingAdoption: staleClientEvidence() });
    // Adoption evidence describes client opportunity, not restart safety —
    // conflating them would silently change unrelated behaviour.
    expect(withStale).toMatchObject({
      status: without.status,
      protection: without.protection,
      rebootSafe: without.rebootSafe,
      recommendedCommand: without.recommendedCommand,
    });
    expect(startupHealthSummary(withStale)).toBe(
      `${startupHealthSummary(without)}; restart Codex client pid 4242 so it adopts the injected proxy route`,
    );
  });

  test("the summary names every stale client when more than one predates the injection", () => {
    const stale = staleClientEvidence([
      { pid: 4242, startedAtMs: injectedAtMs - 60_000 },
      { pid: 4000, startedAtMs: injectedAtMs - 120_000 },
    ]);
    expect(startupHealthSummary(deriveStartupHealth({ ...base, routingAdoption: stale })))
      .toContain("restart Codex clients pid 4000, 4242 so they adopt the injected proxy route");
  });

  test("collectStartupHealth carries injected routingAdoption evidence into the health summary", () => {
    const health = collectStartupHealth({ codexAutoStart: true }, {
      routingKind: "opencodex-local",
      service: {
        supported: true,
        installed: false,
        enabled: false,
        running: false,
        viable: false,
        startable: false,
        stale: false,
        conflict: false,
        backend: null,
        summary: "test service diagnostic",
      },
      shim: { installed: false, healthy: false, summary: "test shim diagnostic" },
      routingAdoption: staleClientEvidence(),
    });
    expect(health.routingAdoption?.adoption).toBe("pending-client-restart");
    expect(startupHealthSummary(health)).toContain("restart Codex client pid 4242");
  });

  test("isCodexClientProcess matches direct and interpreter-wrapped Codex clients only", () => {
    expect(isCodexClientProcess("codex", "codex chat")).toBe(true);
    expect(isCodexClientProcess("/usr/local/bin/codex", "/usr/local/bin/codex --profile work")).toBe(true);
    expect(isCodexClientProcess("node", "node /home/user/.codex/codex.js chat")).toBe(true);
    expect(isCodexClientProcess("vim", "vim note.txt")).toBe(false);
    expect(isCodexClientProcess("codex-helper", "codex-helper run")).toBe(false);
    expect(isCodexClientProcess("node", "node server.js")).toBe(false);
  });

  test("listCodexClientProcesses keeps a failed walk distinct from an empty match set", () => {
    // A throw means "could not tell"; an empty array means "none running".
    // Collapsing them would turn a failed enumeration into a false adopted.
    expect(listCodexClientProcesses({
      listSnapshots: () => { throw new Error("walk failed"); },
    })).toEqual({ status: "unavailable" });
    expect(listCodexClientProcesses({
      pid: -1,
      listSnapshots: () => [{ pid: 4321, commandLine: "vim note.txt", executable: "vim" }],
    })).toEqual({ status: "enumerated", processes: [] });
    expect(listCodexClientProcesses({
      pid: -1,
      listSnapshots: () => [
        { pid: 4242, commandLine: "codex chat", executable: "/usr/local/bin/codex" },
        { pid: 4321, commandLine: "vim note.txt", executable: "vim" },
      ],
    })).toEqual({ status: "enumerated", processes: [{ pid: 4242, commandLine: "codex chat" }] });
  });
});
