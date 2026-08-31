import { describe, expect, test } from "bun:test";
import { deriveStartupHealth, formatStartupRoutingDetail, startupHealthSummary } from "../src/codex/autostart-health";
import { unusedProxyWarningLines } from "../src/cli/status";
import { classifyCodexRouting, hasInjectedCodexRouting } from "../src/codex/inject";
import { handleManagementAPI } from "../src/server/management-api";
import { getCachedStartupHealth, invalidateStartupHealthCache, markStartupHealthDiagnosticStale } from "../src/server/startup-health-cache";
import type { OcxConfig } from "../src/types";

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
});
import { ManagementRequest as Request } from "./helpers/management-auth";

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
});
