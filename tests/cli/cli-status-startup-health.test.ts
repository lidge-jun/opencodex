import { describe, expect, test } from "bun:test";
import { fetchLiveStartupHealth, selectStatusStartupHealth, statusServiceSummary } from "../../src/cli/status";
import type { StartupHealth } from "../../src/codex/autostart-health";

const LIVE = {
  pid: 4242,
  port: 10101,
  hostname: "127.0.0.1",
  source: "runtime" as const,
};

const SECRET = "A".repeat(43);
const NONCE = "B".repeat(43);

function startupPayload() {
  return {
    status: "protected",
    routingKind: "opencodex-local",
    routingInjected: true,
    localRoutingDependency: true,
    autostartEnabled: true,
    rebootSafe: true,
    protection: "service",
    serviceInstalled: true,
    serviceViable: true,
    serviceEnabled: true,
    serviceRunning: true,
    serviceStale: false,
    serviceConflict: false,
    shimInstalled: true,
    shimHealthy: true,
    shimCoverage: "cli-only",
    serviceSupported: true,
    platform: "linux",
    diagnosticStale: false,
    recommendedCommand: null,
    commands: {
      installService: "ocx service install",
      repairService: "ocx service repair",
      installShim: "ocx codex-shim install",
      restoreNative: "ocx restore",
    },
  };
}

function deps(body: unknown) {
  return {
    readRuntime: () => ({
      pid: LIVE.pid,
      port: LIVE.port,
      hostname: LIVE.hostname,
      attestationSecret: SECRET,
    }),
    createNonce: () => NONCE,
    now: () => 1_000,
    fetchImpl: async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  };
}

describe("ocx status live startup health", () => {
  test("uses an attested live startup verdict when the shell-local service probe would disagree", async () => {
    const observed = await fetchLiveStartupHealth(LIVE, deps(startupPayload()));
    expect(observed?.status).toBe("protected");
    expect(observed?.rebootSafe).toBe(true);
    expect(observed?.serviceViable).toBe(true);
    expect(observed?.protection).toBe("service");
  });

  test("rejects malformed live startup payloads", async () => {
    for (const malformed of [
      { ...startupPayload(), serviceRunning: "yes" },
      (() => { const row = { ...startupPayload() } as Record<string, unknown>; delete row.platform; return row; })(),
      { ...startupPayload(), recommendedCommand: 7 },
      { ...startupPayload(), commands: { installService: "ok" } },
      { ...startupPayload(), routingAdoption: { adoption: "adopted", injectedAtMs: 1, staleClients: "bad", observedClients: 1 } },
      { ...startupPayload(), routingAdoption: { adoption: "adopted", injectedAtMs: 1, staleClients: [{ pid: "bad", startedAtMs: 1 }], observedClients: 1 } },
    ]) {
      expect(await fetchLiveStartupHealth(LIVE, deps(malformed))).toBeNull();
    }
  });

  test("selection prefers the attested live verdict and does not evaluate the conflicting fallback", () => {
    const live = startupPayload() as StartupHealth;
    let fallbackCalls = 0;
    const selected = selectStatusStartupHealth(live, () => {
      fallbackCalls += 1;
      return { ...live, status: "at-risk", rebootSafe: false, protection: "none" } as StartupHealth;
    });
    expect(selected.status).toBe("protected");
    expect(selected.rebootSafe).toBe(true);
    expect(fallbackCalls).toBe(0);
    expect(statusServiceSummary(live, { installed: false, summary: "systemd not found" }, true))
      .toContain("running under the live managed service");
  });

  test("selection falls back to local startup diagnostics when the live read is unavailable", () => {
    const local = { ...startupPayload(), status: "at-risk", rebootSafe: false, protection: "none" } as StartupHealth;
    let fallbackCalls = 0;
    const selected = selectStatusStartupHealth(null, () => { fallbackCalls += 1; return local; });
    expect(selected).toBe(local);
    expect(fallbackCalls).toBe(1);
    expect(statusServiceSummary(null, { installed: true, summary: "registered" }, false))
      .toContain("registered but NOT serving");
  });

  test("service summary never contradicts a present negative live startup verdict", () => {
    const live = {
      ...startupPayload(),
      status: "at-risk",
      rebootSafe: false,
      protection: "none",
      serviceInstalled: false,
      serviceRunning: false,
      serviceViable: false,
      recommendedCommand: "ocx service repair",
    } as StartupHealth;
    const summary = statusServiceSummary(live, { installed: true, summary: "healthy local service" }, true);
    expect(summary).toContain("live startup reports service absent, not running, not viable");
    expect(summary).toContain("ocx service repair");
    expect(summary).not.toContain("healthy local service");
  });

  test("fails closed when the runtime attestation cannot bind the live PID", async () => {
    const observed = await fetchLiveStartupHealth(LIVE, {
      ...deps(startupPayload()),
      readRuntime: () => null,
    });
    expect(observed).toBeNull();
  });
});