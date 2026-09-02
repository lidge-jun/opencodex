import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CL03_LIVE_SUITES, createMockTransport, discoverLiveScenarios, evaluateAllApplicableRequiredPassV1,
  executeInertTool, expandLiveScenario, invokeMcpStub, listInertToolDefinitions, listLiveScenarioIds,
  loadLiveCaseAuthority, observationFromLiveResult, persistLiveResult, rebuildLabProjection,
  registerMcpStubTool, routeSubjectApplicableToRequirements, runLiveScenario, runLiveSuite,
  scenarioManifestDigest, subjectIdForSubject,
} from "../src/lab";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import { replayLabLedger } from "../src/lab/ledger/store";
import { clearMcpStub } from "../src/lab/live/mcp-loopback";
import { TransportError } from "../src/lab/live/transport";
import { expandLiveSuiteManifest } from "../src/lab/live/suite-manifest";
import type { LabBehaviorValues, LabRouteContext, LiveScenarioRunResult } from "../src/lab/live/types";
import type { ProtocolSubjectV1, RouteSubjectV1 } from "../src/lab/events/types";
import type { NormalizedObservation } from "../src/lab/conformance/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const HOMES: string[] = [];
function tempHome(): string { const dir = join(tmpdir(), `ocx-lab-probe-${process.pid}-${Math.random().toString(16).slice(2)}`); mkdirSync(dir, { recursive: true, mode: 0o700 }); HOMES.push(dir); return dir; }
afterEach(() => { for (const dir of HOMES.splice(0)) { try { removeTreeWithRetry(dir); } catch { /* ignore */ } } delete process.env.OPENCODEX_HOME; clearMcpStub(); });

function behavior(adapter: string, upstreamProtocol: string): LabBehaviorValues {
  return {
    "wire.adapter": { source: "lab_forced", value: adapter }, "wire.upstreamProtocol": { source: "lab_forced", value: upstreamProtocol },
    "auth.mode": { source: "provider_config", value: "api_key" }, "auth.transport": { source: "provider_config", value: "authorization_bearer" },
    "mcp.nativeLocalExec": { source: "lab_forced", value: false }, "runtime.bunVersion": { source: "lab_forced", value: Bun.version },
    "runtime.platform": { source: "lab_forced", value: process.platform }, "runtime.arch": { source: "lab_forced", value: process.arch },
    "runtime.streamMode": { source: "lab_forced", value: "auto" }, "runtime.fastMode": { source: "lab_forced", value: false },
    "runtime.effortCap": { source: "lab_forced", value: null }, "headers.nonCredentialBehaviorDigest": { source: "provider_config", value: "0".repeat(64) },
  };
}

function mockRoute(overrides: Partial<LabRouteContext> = {}): LabRouteContext {
  const base = {
    providerId: "fixture-provider", providerInstanceKey: "fixture-provider-instance", clientModelId: "fixture-model", upstreamModelId: "fixture-model",
    effectiveAdapter: "openai-responses", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses", surface: "responses-http",
    baseUrl: "https://api.example.com/v1", opencodexCompatibilityVersion: "a".repeat(64), labRunApproval: true, allowPrivateNetwork: false,
    requiredClaims: ["tools", "image", "reasoning"],
    availableHarnessFeatures: ["live_transport", "inert_tools", "adapter_vector", "reasoning_replay", "synthetic_image", "in_memory_mcp_stub", "mcp_call_result_v1", "mcp_lab_stub"],
  };
  const merged = { ...base, ...overrides };
  return { ...merged, behaviorValues: overrides.behaviorValues ?? behavior(merged.effectiveAdapter, merged.upstreamProtocol) };
}

function transportForCase(caseRecord: ReturnType<typeof discoverLiveScenarios>[number]) {
  return createMockTransport({ entries: caseRecord.initiatingRequest ? [{ status: 200, headers: { "content-type": caseRecord.fixture.mediaType }, body: caseRecord.fixture.bytesUtf8 }] : [] });
}

function passObservation(): NormalizedObservation {
  return {
    client: { request: { status: 200, headers: {}, json: {}, rawBytes: 0 }, response: { status: 200, headers: {}, json: {}, events: [], toolCalls: [], mcpCalls: [], terminal: "completed", normalizedText: "OK" } },
    upstream: { requests: [], responses: [] }, process: { exitCode: null }, verifiers: {},
  };
}
function reasoningObservation(): NormalizedObservation {
  const observation = passObservation();
  observation.upstream.requests = [
    { status: 200, headers: {}, json: {}, rawBytes: 0 },
    { status: 200, headers: {}, json: { input: [{ signature: "sig_fixture" }] }, rawBytes: 0 },
  ];
  observation.client.response.normalizedText = "";
  return observation;
}
function trustedObservation(observation: NormalizedObservation) {
  return createHostIssuedLabRouteExecutor(async () => observation);
}

function routeSubject(): RouteSubjectV1 {
  return { subjectSchemaVersion: 1, subjectKind: "route", providerId: "p", providerInstanceFingerprint: "a".repeat(64), clientModelId: "m", upstreamModelId: "m", effectiveAdapter: "openai-responses", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses", surface: "responses-http", opencodexCompatibilityVersion: "a".repeat(64), behaviorFingerprint: "b".repeat(64), endpointFingerprint: "c".repeat(64), dependencies: [] };
}

describe("CL-03 live probe harness", () => {
  test("loads frozen 10-case live authority with reproducible digests", () => {
    const authority = loadLiveCaseAuthority(); expect(authority.cases.length).toBe(10);
    expect(authority.cases.map((c) => c.id)).toContain("responses-core.live.basic-turn");
    expect(authority.cases.map((c) => c.id)).toContain("mcp-core.live.synthetic-tool");
    expect(scenarioManifestDigest(expandLiveScenario(authority.cases[0]!, authority))).toBe(scenarioManifestDigest(expandLiveScenario(authority.cases[0]!, authority)));
  });

  test("discovers all CL-03 live suites", () => { const authority = loadLiveCaseAuthority(); expect(discoverLiveScenarios(authority, CL03_LIVE_SUITES)).toHaveLength(10); expect(listLiveScenarioIds()).toHaveLength(10); });

  test("runs only applicable live suite scenarios with an injected test transport", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const authority = loadLiveCaseAuthority();
    const summary = await runLiveSuite(mockRoute(), ["responses-core", "chat-core"], { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport: createMockTransport({ entries: [{ status: 200, body: authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!.fixture.bytesUtf8 }] }) });
    expect(summary.total).toBe(1); expect(summary.results[0]?.routeSubject?.subjectKind).toBe("route"); expect(summary.results[0]?.executionAuthority).toBe("test_transport");
  });

  test("inert tool round-trips validate args and return static results", () => { expect(listInertToolDefinitions().map((t) => t.name)).toContain("lookup"); expect(executeInertTool("lookup", { q: "x" }).output).toBe("RESULT"); expect(() => executeInertTool("lookup", { q: 1 })).toThrow(); });
  test("MCP lab stub only", () => { registerMcpStubTool({ namespace: "lab", name: "echo" }); expect(invokeMcpStub("lab", "echo", { x: 1 }, { content: [{ type: "text", text: "ECHO" }] }).content[0]?.text).toBe("ECHO"); });

  test("test transports can exercise normalization but cannot create live evidence", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const authority = loadLiveCaseAuthority(); const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute(), { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport: transportForCase(caseRecord) });
    expect(result.executionAuthority).toBe("test_transport");
    expect(() => observationFromLiveResult(result, caseRecord, authority, { configDir: home })).toThrow("trusted execution receipt");
  });

  test("fabricated trusted-route result cannot create live evidence", () => {
    const home = tempHome(); const authority = loadLiveCaseAuthority(); const caseRecord = authority.cases[0]!;
    const fake: LiveScenarioRunResult = { scenarioId: caseRecord.id, suite: caseRecord.suite, startedAt: 1, completedAt: 2, passed: true, classification: "inconclusive", assertionResults: [], diagnostics: [], routeSubject: routeSubject(), executionAuthority: "trusted_route" };
    expect(() => observationFromLiveResult(fake, caseRecord, authority, { configDir: home })).toThrow("trusted execution receipt");
  });

  test("trusted receipt is bound to the executed scenario and authority", async () => {
    const home = tempHome(); const authority = loadLiveCaseAuthority(); const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute(), { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], routeExecutor: trustedObservation(passObservation()) });
    const differentCase = authority.cases.find((c) => c.id === "tools-core.live.function-round-trip")!;
    expect(() => observationFromLiveResult(result, differentCase, authority, { configDir: home })).toThrow("receipt mismatch");
  });

  test("unapproved routes do not resolve destinations", async () => {
    const scenario = loadLiveCaseAuthority().cases[0]!; let resolves = 0;
    const result = await runLiveScenario(scenario, mockRoute({ labRunApproval: false }), { resolve: async () => { resolves += 1; return [{ address: "93.184.216.34", family: 4 }]; }, transport: transportForCase(scenario) });
    expect(resolves).toBe(0); expect(result.secondaryCode).toBe("route_precondition_unmet:lab_run_approval"); expect(result.routeSubject).toBeUndefined();
  });

  test("executor diagnostics expose only bounded codes", async () => {
    const scenario = loadLiveCaseAuthority().cases[0]!; const secret = "Bearer super-secret-value";
    const result = await runLiveScenario(scenario, mockRoute(), { resolve: async () => [{ address: "93.184.216.34", family: 4 }], routeExecutor: createHostIssuedLabRouteExecutor(async () => { throw new Error(secret); }) });
    expect(result.diagnostics).toEqual(["execution_error"]); expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("raw URLs and secrets never appear in persisted trusted live evidence", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const authority = loadLiveCaseAuthority(); const caseRecord = authority.cases.find((c) => c.id === "responses-core.live.basic-turn")!;
    const result = await runLiveScenario(caseRecord, mockRoute(), { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], routeExecutor: trustedObservation(passObservation()) });
    expect(result.executionAuthority).toBe("trusted_route");
    const { event } = observationFromLiveResult(result, caseRecord, authority, { configDir: home }); const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("api.example.com"); expect(serialized).not.toContain("https://"); expect(serialized).not.toContain("apiKey"); expect(event.evidenceLayer).toBe("live_route_compatibility"); expect(event.executionMode).toBe("live");
  });

  test("JSONL persistence and SQLite rebuild for trusted live evidence", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const authority = loadLiveCaseAuthority(); const caseRecord = authority.cases.find((c) => c.id === "chat-core.live.basic-turn")!;
    const route = mockRoute({ effectiveAdapter: "openai-chat", upstreamProtocol: "openai-chat", surface: "responses-sse" });
    const result = await runLiveScenario(caseRecord, route, { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], routeExecutor: trustedObservation(passObservation()) });
    persistLiveResult(result, caseRecord, authority, { configDir: home }); const projection = rebuildLabProjection(home); expect(projection.events).toBeGreaterThan(0); expect(projection.corruptions).toHaveLength(0); expect(replayLabLedger(join(home, "lab", "compatibility.jsonl")).events.length).toBeGreaterThan(0);
  });

  test("route subject applicability and cross-route evidence reuse prevention", () => {
    const subjectA: RouteSubjectV1 = { subjectSchemaVersion: 1, subjectKind: "route", providerId: "provider-a", providerInstanceFingerprint: "a".repeat(64), clientModelId: "model-a", upstreamModelId: "model-a", effectiveAdapter: "openai-responses", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses", surface: "responses-http", opencodexCompatibilityVersion: "a".repeat(64), behaviorFingerprint: "b".repeat(64), endpointFingerprint: "c".repeat(64), dependencies: [] };
    const subjectB = { ...subjectA, providerId: "provider-b", endpointFingerprint: "d".repeat(64) } as RouteSubjectV1; expect(subjectIdForSubject(subjectA)).not.toBe(subjectIdForSubject(subjectB));
    const requirements = loadLiveCaseAuthority().cases[0]!.requirements; expect(routeSubjectApplicableToRequirements(requirements, subjectA, [])).toBe(true); expect(routeSubjectApplicableToRequirements({ ...requirements, inboundProtocols: ["anthropic-messages"] }, subjectA, [])).toBe(false);
  });

  test("freshness semantics for live suites", () => {
    const authority = loadLiveCaseAuthority(); const suite = expandLiveSuiteManifest("responses-core", authority); expect(suite.freshness.maxAgeMs).toBe(604800000);
    const subject = routeSubject();
    const result = evaluateAllApplicableRequiredPassV1(suite, [], "live", { subject, routeSupportedClaims: [], loadScenarioRequirements: () => ({ inboundProtocols: ["openai-responses"], upstreamProtocols: ["openai-responses"], surfaces: ["responses-http"], requiredClaims: [], freshness: { maxAgeMs: 604800000 } }) });
    expect(result.canVerify).toBe(false); expect(result.missingRequiredScenarioIds.length).toBeGreaterThan(0);
  });

  test("live verification fails closed without route identity or validated claims", () => {
    const authority = loadLiveCaseAuthority(); const suite = expandLiveSuiteManifest("responses-core", authority);
    const protocolSubject: ProtocolSubjectV1 = { subjectSchemaVersion: 1, subjectKind: "protocol", opencodexCompatibilityVersion: "a".repeat(64), effectiveAdapter: "openai-responses", inboundProtocol: "openai-responses", upstreamProtocol: "openai-responses", surface: "responses-http", behaviorFingerprint: "b".repeat(64) };
    const noSubject = evaluateAllApplicableRequiredPassV1(suite, [], "live", { routeSupportedClaims: [], loadScenarioRequirements: () => ({ inboundProtocols: ["openai-responses"], upstreamProtocols: ["openai-responses"], surfaces: ["responses-http"], requiredClaims: [], freshness: { maxAgeMs: 604800000 } }) });
    const wrongSubject = evaluateAllApplicableRequiredPassV1(suite, [], "live", { subject: protocolSubject, routeSupportedClaims: [], loadScenarioRequirements: () => ({ inboundProtocols: ["openai-responses"], upstreamProtocols: ["openai-responses"], surfaces: ["responses-http"], requiredClaims: [], freshness: { maxAgeMs: 604800000 } }) });
    const noClaims = evaluateAllApplicableRequiredPassV1(suite, [], "live", { subject: routeSubject(), loadScenarioRequirements: () => ({ inboundProtocols: ["openai-responses"], upstreamProtocols: ["openai-responses"], surfaces: ["responses-http"], requiredClaims: [], freshness: { maxAgeMs: 604800000 } }) });
    expect(noSubject.notes).toContain("route_subject_required"); expect(wrongSubject.notes).toContain("route_subject_required"); expect(noClaims.notes).toContain("route_claim_state_required");
  });

  test("malformed requiredClaims in a live manifest is rejected", () => {
    const authority = loadLiveCaseAuthority(); const suite = expandLiveSuiteManifest("responses-core", authority);
    const result = evaluateAllApplicableRequiredPassV1(suite, [], "live", { subject: routeSubject(), routeSupportedClaims: [], loadScenarioManifest: () => ({ requirements: { inboundProtocols: ["openai-responses"], upstreamProtocols: ["openai-responses"], surfaces: ["responses-http"], requiredClaims: "tools" }, freshness: { maxAgeMs: 604800000 } }) });
    expect(result.canVerify).toBe(false); expect(result.notes.some((note) => note.startsWith("scenario_manifest_unavailable:"))).toBe(true);
  });

  test("timeouts classify as blockers", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const scenario = loadLiveCaseAuthority().cases[0]!;
    const result = await runLiveScenario(scenario, mockRoute(), { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport: createMockTransport({ entries: [{ status: 200, body: "{}", error: "total_timeout" }] }) });
    expect(result.classification).toBe("timeout");
  });

  test("HTTP auth failure is an exact-route blocker", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const scenario = loadLiveCaseAuthority().cases[0]!;
    const result = await runLiveScenario(scenario, mockRoute(), { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], transport: createMockTransport({ entries: [{ status: 401, body: "" }] }) });
    expect(result.classification).toBe("authentication_blocked"); expect(result.routeSubject?.endpointFingerprint).toHaveLength(64);
  });

  test("reasoning replay persists no private reasoning material", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home; const authority = loadLiveCaseAuthority(); const scenario = authority.cases.find((c) => c.id === "reasoning-core.live.replay")!;
    const result = await runLiveScenario(scenario, mockRoute({ requiredClaims: ["reasoning"] }), { configDir: home, resolve: async () => [{ address: "93.184.216.34", family: 4 }], routeExecutor: trustedObservation(reasoningObservation()) });
    expect(result.passed).toBe(true); const { event } = observationFromLiveResult(result, scenario, authority, { configDir: home }); expect(JSON.stringify(event)).not.toContain("PLAN");
  });

  test("inactivity_timeout failures attribute environment on observation", async () => {
    const home = tempHome();
    process.env.OPENCODEX_HOME = home;
    const authority = loadLiveCaseAuthority();
    const caseRecord = authority.cases[0]!;
    const result = await runLiveScenario(caseRecord, mockRoute(), {
      configDir: home,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      routeExecutor: createHostIssuedLabRouteExecutor(async () => {
        throw new TransportError("inactivity_timeout", "inactivity timeout exceeded");
      }),
    });
    expect(result.classification).toBe("inactivity_timeout");
    const { event } = observationFromLiveResult(result, caseRecord, authority, { configDir: home });
    expect(event.failure?.class).toBe("inactivity_timeout");
    expect(event.failure?.attribution).toBe("environment");
  });
});
