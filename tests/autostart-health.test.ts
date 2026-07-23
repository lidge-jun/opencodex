import { describe, expect, test } from "bun:test";
import { deriveStartupHealth, startupHealthSummary } from "../src/codex/autostart-health";
import { classifyCodexRouting, hasInjectedCodexRouting } from "../src/codex/inject";
import { handleManagementAPI } from "../src/server/management-api";
import { invalidateStartupHealthCache, markStartupHealthDiagnosticStale } from "../src/server/startup-health-cache";
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
  });

  test("exposes a secret-free startup health DTO to the dashboard", async () => {
    invalidateStartupHealthCache();
    const url = new URL("http://localhost/api/startup-health");
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 25);
    const responsePromise = handleManagementAPI(
      new Request(url),
      url,
      { port: 10100, providers: {}, defaultProvider: "openai", codexAutoStart: true } as OcxConfig,
    );
    await Bun.sleep(75);
    expect(timerFired).toBe(true); // service-manager probes run in a child, not the proxy event loop
    clearTimeout(timer);
    const response = await responsePromise;
    expect(response?.status).toBe(200);

    const body = await response!.json() as Record<string, unknown>;
    expect(["native", "protected", "at-risk"]).toContain(body.status);
    expect(typeof body.rebootSafe).toBe("boolean");
    expect(typeof body.routingInjected).toBe("boolean");
    expect(body.commands).toEqual({
      installService: "ocx service install",
      installShim: "ocx codex-shim install",
      restoreNative: "ocx restore",
    });

    const serialized = JSON.stringify(body).toLowerCase();
    for (const secretName of ["api_key", "apikey", "authorization", "access_token", "refresh_token"]) {
      expect(serialized).not.toContain(secretName);
    }
  });
});
