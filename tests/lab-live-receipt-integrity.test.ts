import { expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLiveCaseAuthority, observationFromLiveResult, runLiveScenario } from "../src/lab";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import type { NormalizedObservation } from "../src/lab/conformance/types";
import type { LabBehaviorValues, LabRouteContext } from "../src/lab/live/types";

function behavior(): LabBehaviorValues {
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
  };
}

function route(): LabRouteContext {
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
    labRunApproval: true,
    allowPrivateNetwork: false,
    requiredClaims: [],
    availableHarnessFeatures: ["live_transport"],
    behaviorValues: behavior(),
  };
}

function passingObservation(): NormalizedObservation {
  return {
    client: {
      request: { status: 200, headers: {}, json: {}, rawBytes: 0 },
      response: { status: 200, headers: {}, json: {}, events: [], toolCalls: [], mcpCalls: [], terminal: "completed", normalizedText: "OK" },
    },
    upstream: { requests: [], responses: [] },
    process: { exitCode: null },
    verifiers: {},
  };
}

test("trusted live receipt rejects post-seal outcome mutation", async () => {
  const home = join(tmpdir(), `ocx-lab-receipt-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    const authority = loadLiveCaseAuthority();
    const scenario = authority.cases.find((row) => row.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(scenario, route(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      routeExecutor: createHostIssuedLabRouteExecutor(async () => passingObservation()),
    });
    expect(result.passed).toBe(true);
    result.passed = false;
    expect(() => observationFromLiveResult(result, scenario, authority, { configDir: home }))
      .toThrow("trusted execution receipt mismatch");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});