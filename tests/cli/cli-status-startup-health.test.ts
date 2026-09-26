import { describe, expect, test } from "bun:test";
import { fetchLiveStartupHealth } from "../../src/cli/status";

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
    const observed = await fetchLiveStartupHealth(LIVE, deps({
      ...startupPayload(),
      serviceRunning: "yes",
    }));
    expect(observed).toBeNull();
  });

  test("fails closed when the runtime attestation cannot bind the live PID", async () => {
    const observed = await fetchLiveStartupHealth(LIVE, {
      ...deps(startupPayload()),
      readRuntime: () => null,
    });
    expect(observed).toBeNull();
  });
});