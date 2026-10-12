import { describe, expect, test } from "bun:test";
import { fetchLiveStartupHealth, selectStatusStartupHealth, statusServiceSummary, runtimeSupervisorLine } from "../../src/cli/status";
import type { StartupHealth } from "../../src/codex/autostart-health";
import { startupHealthProbeBudgetMs, startupHealthReadBudgetMs } from "../../src/codex/autostart-health";
import { LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof } from "../../src/lib/local-management-attestation";
import type { fetchBoundLocalManagementRead } from "../../src/server/local-management-read-client";

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

function deps(body: unknown, proof: string | null = createLocalAttestationProof(SECRET, NONCE, LIVE.pid, LIVE.port)) {
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
      headers: { "content-type": "application/json", ...(proof ? { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } : {}) },
    }),
  };
}

describe("ocx status live startup health", () => {
  test("the reader covers the endpoint's bounded probe wait on every supported platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(startupHealthReadBudgetMs(platform)).toBeGreaterThan(startupHealthProbeBudgetMs(platform) + 500);
      expect(startupHealthReadBudgetMs(platform)).toBeLessThanOrEqual(16_500);
    }
  });

  test("the direct transport receives the reader deadline instead of its own 10-second default", async () => {
    const attested = deps(startupPayload());
    let timeoutMs: number | undefined;
    let directFetchCalls = 0;
    const fixture: Parameters<typeof fetchBoundLocalManagementRead>[2] = {
      ...attested,
      directFetch: async (_url, _init, io) => {
        timeoutMs = io?.timeoutMs;
        directFetchCalls += 1;
        return attested.fetchImpl();
      },
    };
    delete fixture.fetchImpl;
    expect((await fetchLiveStartupHealth(LIVE, fixture))?.serviceViable).toBe(true);
    expect(timeoutMs).toBe(startupHealthReadBudgetMs());
    expect(directFetchCalls).toBe(1);

    fixture.fetchImpl = attested.fetchImpl;
    expect((await fetchLiveStartupHealth(LIVE, fixture))?.serviceViable).toBe(true);
    expect(directFetchCalls).toBe(1);
  });

  test("waits for a cold attested service probe beyond the old 1.5-second deadline", async () => {
    const fixture = deps(startupPayload());
    const observed = await fetchLiveStartupHealth(LIVE, {
      ...fixture,
      fetchImpl: async (_url, init) => {
        await new Promise<void>((resolve, reject) => {
          const signal = init!.signal!;
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, 1_650);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return fixture.fetchImpl();
      },
    });
    expect(observed?.serviceViable).toBe(true);
  });

  test("a probe exceeding the reader deadline still falls back", async () => {
    const observed = await fetchLiveStartupHealth(LIVE, {
      ...deps(startupPayload()),
      timeoutMs: 10,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }),
    });
    expect(observed).toBeNull();
  });

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
    expect(selected.startup.status).toBe("protected");
    expect(selected.startup.rebootSafe).toBe(true);
    expect(fallbackCalls).toBe(0);
    expect(selected.startupSource).toBe("live");
    expect(statusServiceSummary(live, { installed: false, summary: "systemd not found" }, true))
      .toContain("running under the live managed service");
  });

  test("selection falls back to local startup diagnostics when the live read is unavailable", () => {
    const local = { ...startupPayload(), status: "at-risk", rebootSafe: false, protection: "none" } as StartupHealth;
    let fallbackCalls = 0;
    const selected = selectStatusStartupHealth(null, () => { fallbackCalls += 1; return local; });
    expect(selected.startup).toBe(local);
    expect(selected.startupSource).toBe("local");
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

  // Whoever holds the port can answer the request; only the server that owns the runtime secret
  // can sign this request's nonce. A substituted listener's verdict must never be trusted.
  test("rejects a live verdict without the server's proof over this request's nonce", async () => {
    expect(await fetchLiveStartupHealth(LIVE, deps(startupPayload(), null))).toBeNull();
    const otherNonce = createLocalAttestationProof(SECRET, "C".repeat(43), LIVE.pid, LIVE.port);
    expect(await fetchLiveStartupHealth(LIVE, deps(startupPayload(), otherNonce))).toBeNull();
    const otherSecret = createLocalAttestationProof("D".repeat(43), NONCE, LIVE.pid, LIVE.port);
    expect(await fetchLiveStartupHealth(LIVE, deps(startupPayload(), otherSecret))).toBeNull();
  });

  test("fails closed when the runtime attestation cannot bind the live PID", async () => {
    const observed = await fetchLiveStartupHealth(LIVE, {
      ...deps(startupPayload()),
      readRuntime: () => null,
    });
    expect(observed).toBeNull();
  });
});


const SUPERVISION = { kind: "desktop" as const, supervisorPid: 3131, runtimePid: LIVE.pid,
  app: "/fixture/opencodex-desktop", proxy: "/fixture/ocx" };
function supervisedPayload() {
  return { ...startupPayload(), protection: "desktop", desktop: { owned: false, loginEnabled: true,
    running: true, viable: true, supervisor: { supervisorPid: 3131, runtimePid: LIVE.pid, app: SUPERVISION.app } },
    recommendedAction: null };
}

test("live reader accepts desktop protection, supervision and recovery sentences", async () => {
  for (const recommendedAction of [undefined, null, "Reopen OpenCodex and check Start at Login."]) {
    expect(await fetchLiveStartupHealth(LIVE, deps({ ...supervisedPayload(), recommendedAction })))
      .toMatchObject({ protection: "desktop", desktop: { supervisor: { supervisorPid: 3131, runtimePid: LIVE.pid } } });
  }
});

test("live reader rejects malformed desktop evidence and unbounded action text", async () => {
  const payload = supervisedPayload();
  for (const desktop of [null, [], { ...payload.desktop, running: "yes" },
    { ...payload.desktop, supervisor: null }, { ...payload.desktop, supervisor: [] },
    { ...payload.desktop, supervisor: { ...payload.desktop.supervisor, supervisorPid: "3131" } },
    { ...payload.desktop, supervisor: { ...payload.desktop.supervisor, runtimePid: "4242" } },
    { ...payload.desktop, supervisor: { ...payload.desktop.supervisor, app: 7 } }]) {
    expect(await fetchLiveStartupHealth(LIVE, deps({ ...payload, desktop }))).toBeNull();
  }
  for (const recommendedAction of [7, {}, "x".repeat(513)]) {
    expect(await fetchLiveStartupHealth(LIVE, deps({ ...payload, recommendedAction }))).toBeNull();
  }
  // JSON cannot represent infinities; send a number which parses to infinity on the wire.
  const fixture = deps(payload);
  fixture.fetchImpl = async () => new Response(JSON.stringify(payload).replace('"runtimePid":4242', '"runtimePid":1e400'),
    { headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(SECRET, NONCE, LIVE.pid, LIVE.port) } });
  expect(await fetchLiveStartupHealth(LIVE, fixture)).toBeNull();
});

test("old live verdict is overridden only by positive supervision, and summaries use the selection", () => {
  const live = { ...startupPayload(), status: "at-risk", rebootSafe: false,
    protection: "none", recommendedCommand: "ocx service install" } as StartupHealth;
  const local = { ...supervisedPayload(), status: "at-risk", rebootSafe: false,
    recommendedCommand: null, recommendedAction: "Turn on Start at Login." } as StartupHealth;
  let fallbackCalls = 0;
  const selected = selectStatusStartupHealth(live, () => { fallbackCalls++; return local; }, () => SUPERVISION, LIVE.pid);
  expect(selected.startup).toBe(local);
  expect(selected.startupSource).toBe("local-supervision-override");
  expect(fallbackCalls).toBe(1);
  const summary = statusServiceSummary(selected.startup, { installed: false, summary: "local service absent" }, true);
  expect(summary).toContain("OpenCodex Desktop supervises the running proxy");
  expect(summary).not.toContain("run '");
  // The proxy is live, but the verdict is the local reading; the label must say so.
  expect(statusServiceSummary(selected.startup, { installed: false, summary: "" }, true, selected.startupSource))
    .toContain("local startup reports");
  const serviceProtected = statusServiceSummary({ ...local, protection: "service", serviceViable: true },
    { installed: true, summary: "managed" }, true);
  expect(serviceProtected).toStartWith("OpenCodex Desktop supervises the running proxy; ");
  expect(serviceProtected).not.toContain("run '");
  expect(statusServiceSummary(selected.startup, { installed: false, summary: "absent" }, false)).toBe("absent");
  expect(runtimeSupervisorLine(selected.startup)).toBe(`Runtime supervisor: OpenCodex Desktop (pid 3131, ${SUPERVISION.app}); durable owner: none`);
  expect(runtimeSupervisorLine({ ...local, desktop: { ...local.desktop!, owned: true } })).toContain("durable owner: desktop");
  expect(runtimeSupervisorLine(live)).toBeNull();
  for (const probe of [() => ({ kind: "none" as const }),
    () => ({ kind: "unknown" as const, reason: "pid-mismatch", desktopSeen: true }),
    () => ({ kind: "unsupported" as const }), () => { throw new Error("ps unavailable"); }]) {
    const unchanged = selectStatusStartupHealth(live, () => { throw new Error("must not fall back"); }, probe);
    expect(unchanged).toEqual({ startup: live, startupSource: "live" });
  }
  const modern = supervisedPayload() as StartupHealth;
  expect(selectStatusStartupHealth(modern, () => { throw new Error("must not fall back"); },
    () => { throw new Error("must not inspect modern runtime"); })).toEqual({ startup: modern, startupSource: "live" });
});


test.each(["runtime changed", "supervisor changed", "missing desktop", "missing supervisor", "owned"] as const)(
  "supervision override keeps the live service verdict when local evidence is %s", scenario => {
    const live = startupPayload() as StartupHealth;
    const local = supervisedPayload() as StartupHealth;
    const supervisor = local.desktop!.supervisor!;
    const cases = {
      "runtime changed": { ...local.desktop!, supervisor: { ...supervisor, runtimePid: LIVE.pid + 1 } },
      "supervisor changed": { ...local.desktop!, supervisor: { ...supervisor, supervisorPid: 3132 } },
      "missing desktop": undefined,
      "missing supervisor": { ...local.desktop!, supervisor: undefined },
      "owned": { ...local.desktop!, owned: true },
    };
    const desktop = cases[scenario];
    const fallback = { ...local, desktop, recommendedCommand: desktop ? null : "ocx service install" };
    const selected = selectStatusStartupHealth(live, () => fallback, () => SUPERVISION, LIVE.pid);
    expect(selected).toEqual({ startup: live, startupSource: "live" });
    expect(selected.startup.protection).toBe("service");
    expect(selected.startup.recommendedCommand).toBeNull();
  },
);

test("matching supervision overrides the old live verdict", () => {
  const live = startupPayload() as StartupHealth;
  const local = supervisedPayload() as StartupHealth;
  expect(selectStatusStartupHealth(live, () => local, () => SUPERVISION, LIVE.pid))
    .toEqual({ startup: local, startupSource: "local-supervision-override" });
});

test("supervision evidence must match the identity-checked live PID before evaluating fallback", () => {
  const live = startupPayload() as StartupHealth;
  let fallbackCalls = 0;
  const selected = selectStatusStartupHealth(live, () => { fallbackCalls++; return supervisedPayload() as StartupHealth; },
    () => SUPERVISION, LIVE.pid + 1);
  expect(selected).toEqual({ startup: live, startupSource: "live" });
  expect(fallbackCalls).toBe(0);
});
