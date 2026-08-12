import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildBehaviorFingerprintV1,
  buildRouteSubjectV1,
  createCredentialLease,
  createLabDestination,
  createMockTransport,
  createPinnedTransport,
  expandLiveSuiteManifest,
  loadLiveCaseAuthority,
  runLiveScenario,
  runLiveSuite,
} from "../src/lab";
import type {
  LabBehaviorValues,
  LabRouteContext,
  LabTransportResponse,
  LiveRunConfig,
} from "../src/lab/live/types";

const HOMES: string[] = [];
function tempHome(): string {
  const dir = join(tmpdir(), `ocx-lab-live-review-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  HOMES.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  delete process.env.OPENCODEX_HOME;
});

function behavior(overrides: Partial<LabBehaviorValues> = {}): LabBehaviorValues {
  return {
    "wire.adapter": { source: "lab_forced", value: "openai-responses" },
    "wire.upstreamProtocol": { source: "lab_forced", value: "openai-responses" },
    "auth.mode": { source: "provider_config", value: "api_key" },
    "auth.transport": { source: "provider_config", value: "authorization_bearer" },
    "mcp.nativeLocalExec": { source: "lab_forced", value: false },
    "runtime.bunVersion": { source: "lab_forced", value: Bun.version },
    "runtime.platform": { source: "lab_forced", value: process.platform },
    "runtime.arch": { source: "lab_forced", value: process.arch },
    "runtime.streamMode": { source: "lab_forced", value: "auto" },
    "runtime.fastMode": { source: "lab_forced", value: false },
    "runtime.effortCap": { source: "lab_forced", value: null },
    "headers.nonCredentialBehaviorDigest": { source: "provider_config", value: "0".repeat(64) },
    ...overrides,
  };
}

function route(overrides: Partial<LabRouteContext> = {}): LabRouteContext {
  return {
    providerId: "fixture-provider",
    providerInstanceKey: "fixture-provider-instance",
    clientModelId: "fixture-model",
    upstreamModelId: "fixture-model",
    effectiveAdapter: "openai-responses",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-responses",
    surface: "responses-http",
    baseUrl: "https://api.example.com/v1",
    opencodexCompatibilityVersion: "a".repeat(64),
    behaviorValues: behavior(),
    labRunApproval: true,
    allowPrivateNetwork: false,
    requiredClaims: ["tools", "image", "reasoning"],
    availableHarnessFeatures: ["live_transport", "inert_tools", "mcp_loopback", "synthetic_image", "reasoning_replay"],
    ...overrides,
  };
}

const LIMITS: LiveRunConfig = {
  totalTimeoutMs: 120_000,
  connectTimeoutMs: 10_000,
  firstByteTimeoutMs: 30_000,
  inactivityTimeoutMs: 30_000,
  maxRequests: 16,
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxOutputTokens: 32_768,
  maxToolCalls: 32,
  maxMemoryBytes: 512 * 1024 * 1024,
  maxChildProcesses: 0,
  maxArtifacts: 16,
  perArtifactBytes: 256 * 1024,
  aggregateArtifactBytes: 1024 * 1024,
};

describe("CL-03 independent-review regressions", () => {
  test("live assertions are driven by observed route bytes, not frozen fixture bytes", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const scenario = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(scenario, route(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: createMockTransport({ entries: [{ status: 200, body: JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "WRONG" }] }] }) }] }),
    });
    expect(result.passed).toBe(false);
    expect(result.classification).toBe("protocol_failure");
  });

  test("live execution fails closed when no real route transport is supplied", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const scenario = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(scenario, route(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(result.passed).toBe(false);
    expect(result.classification).toBe("harness_failure");
    expect(result.secondaryCode).toBe("live_transport_required");
  });

  test("resolved metadata/private addresses are policy-checked, not merely recorded", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    await expect(createLabDestination({
      baseUrl: "https://safe-looking.example/v1",
      labRunApproval: true,
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      configDir: home,
    })).rejects.toThrow();
    await expect(createLabDestination({
      baseUrl: "https://safe-looking.example/v1",
      labRunApproval: true,
      resolve: async () => [{ address: "10.0.0.8", family: 4 }],
      configDir: home,
    })).rejects.toThrow();
  });

  test("pinned transport uses the approved address and never hostname fetch", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const destination = await createLabDestination({
      baseUrl: "https://api.example.com/v1",
      labRunApproval: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      configDir: home,
    });
    const lease = createCredentialLease({ destination, transportId: "test", budget: 1 });
    const seen: Array<{ address: string; host: string }> = [];
    const transport = createPinnedTransport({
      destination,
      lease,
      transportId: "test",
      limits: LIMITS,
      sender: async (_lease, dest, pinned): Promise<LabTransportResponse> => {
        seen.push({ address: pinned.address, host: dest.host });
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      },
    });
    await transport.request({ method: "POST", path: "/responses", body: "{}" });
    expect(seen).toEqual([{ address: "93.184.216.34", host: "api.example.com" }]);
  });

  test("behavior fingerprint rejects unknown inputs and changes for effective behavior", () => {
    const base = behavior();
    const first = buildBehaviorFingerprintV1(base);
    const second = buildBehaviorFingerprintV1({ ...base, "runtime.fastMode": { source: "lab_forced", value: true } });
    expect(first).not.toBe(second);
    expect(() => buildBehaviorFingerprintV1({ ...base, "secret.apiKey": { source: "provider_config", value: "nope" } } as LabBehaviorValues)).toThrow();
  });

  test("transport blockers retain the exact already-built route subject", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const scenario = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(scenario, route(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: createMockTransport({ entries: [{ status: 401, body: "" }] }),
    });
    expect(result.classification).toBe("authentication_blocked");
    expect(result.routeSubject?.endpointFingerprint).not.toBe("0".repeat(64));
  });

  test("runLiveSuite does not execute inapplicable route scenarios", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    let requests = 0;
    const summary = await runLiveSuite(route(), ["responses-core", "chat-core"], {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: createMockTransport({
        onRequest: () => { requests += 1; },
        entries: [{ status: 200, body: JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }] }) }],
      }),
    });
    expect(summary.total).toBe(1);
    expect(requests).toBe(1);
  });

  test("codex live verification manifest includes the responses basic-turn prerequisite", () => {
    const authority = loadLiveCaseAuthority();
    const suite = expandLiveSuiteManifest("codex-core", authority);
    expect(suite.scenarios.map((s) => s.id)).toContain("responses-core.live.basic-turn");
  });

  test("route subject uses configured instance identity and supplied compatibility version", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const destination = await createLabDestination({
      baseUrl: "https://api.example.com/v1",
      labRunApproval: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      configDir: home,
    });
    const a = buildRouteSubjectV1(route({ providerInstanceKey: "instance-a" }), destination, home);
    const b = buildRouteSubjectV1(route({ providerInstanceKey: "instance-b" }), destination, home);
    expect(a.providerInstanceFingerprint).not.toBe(b.providerInstanceFingerprint);
    expect(a.opencodexCompatibilityVersion).toBe("a".repeat(64));
  });
});
