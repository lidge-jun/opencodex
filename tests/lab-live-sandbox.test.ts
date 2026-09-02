import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertDestinationAddressSet, assertHostSniMatch, assertLeaseScope, buildRouteSubjectV1, classifyTransportError,
  createCredentialLease, createLabDestination, createMockTransport, createSandboxResourceState, enforceSandboxLimits,
  freezeRouteSubject, LabCredentialError, LabDestinationError, LabSandboxError, prepareLiveSandbox, readInstallationSalt,
  rejectProxyEnvironment, TransportError,
} from "../src/lab";
import * as executionAuthority from "../src/lib/lab-live-execution-authority";
import { isTrustedLabRouteExecutor } from "../src/lib/lab-live-execution-authority";
import { createHostIssuedLabRouteExecutor } from "../src/lib/lab-live-host";
import { REQUIRED_LAB_SANDBOX_BOUNDARIES, type LabBehaviorValues, type LabRouteContext, type TrustedLabRouteExecutor } from "../src/lab/live/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const HOMES: string[] = [];
function tempHome(): string { const dir = join(tmpdir(), `ocx-lab-live-${process.pid}-${Math.random().toString(16).slice(2)}`); mkdirSync(dir, { recursive: true, mode: 0o700 }); HOMES.push(dir); return dir; }
afterEach(() => { for (const dir of HOMES.splice(0)) { try { removeTreeWithRetry(dir); } catch { /* ignore */ } } delete process.env.OPENCODEX_HOME; });

function behavior(adapter: string, upstreamProtocol: string): LabBehaviorValues {
  return { "wire.adapter": { source: "lab_forced", value: adapter }, "wire.upstreamProtocol": { source: "lab_forced", value: upstreamProtocol }, "auth.mode": { source: "provider_config", value: "api_key" }, "auth.transport": { source: "provider_config", value: "authorization_bearer" }, "mcp.nativeLocalExec": { source: "lab_forced", value: false }, "runtime.bunVersion": { source: "lab_forced", value: Bun.version }, "runtime.platform": { source: "lab_forced", value: process.platform }, "runtime.arch": { source: "lab_forced", value: process.arch }, "runtime.streamMode": { source: "lab_forced", value: "auto" }, "runtime.fastMode": { source: "lab_forced", value: false }, "runtime.effortCap": { source: "lab_forced", value: null }, "headers.nonCredentialBehaviorDigest": { source: "provider_config", value: "0".repeat(64) } };
}
function baseRoute(overrides: Partial<LabRouteContext> = {}): LabRouteContext {
  const base = { providerId: "fixture-provider", providerInstanceKey: "fixture-instance", clientModelId: "fixture-model", upstreamModelId: "fixture-model", effectiveAdapter: "openai-chat", inboundProtocol: "openai-responses", upstreamProtocol: "openai-chat", surface: "responses-http", baseUrl: "https://api.example.com/v1", opencodexCompatibilityVersion: "a".repeat(64), labRunApproval: true, allowPrivateNetwork: false, requiredClaims: [] as string[], availableHarnessFeatures: ["live_transport"] };
  const merged = { ...base, ...overrides }; return { ...merged, behaviorValues: overrides.behaviorValues ?? behavior(merged.effectiveAdapter, merged.upstreamProtocol) };
}
const limits = { totalTimeoutMs: 120000, connectTimeoutMs: 10000, firstByteTimeoutMs: 30000, inactivityTimeoutMs: 30000, maxRequests: 16, maxInputBytes: 8388608, maxOutputBytes: 16777216, maxOutputTokens: 32768, maxToolCalls: 32, maxMemoryBytes: 536870912, maxChildProcesses: 0, maxArtifacts: 16, perArtifactBytes: 262144, aggregateArtifactBytes: 1048576 };

function runSaltInitializer(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`salt initializer exited ${code}: ${stderr.trim()}`));
    });
  });
}

describe("CL-03 live sandbox security seams", () => {
  test("rejects proxy environment variables", () => { expect(() => rejectProxyEnvironment({ HTTP_PROXY: "http://evil" })).toThrow(LabSandboxError); expect(() => rejectProxyEnvironment({ no_proxy: "localhost" })).toThrow(LabSandboxError); });
  test("prepareLiveSandbox allows only TZ=UTC and NO_COLOR=1", () => { expect(prepareLiveSandbox({})).toEqual({ TZ: "UTC", NO_COLOR: "1" }); });

  test("DNS/address mismatch and lease scope mismatch fail closed", async () => {
    const home = tempHome(); process.env.OPENCODEX_HOME = home;
    const destination = await createLabDestination({ baseUrl: "https://api.example.com/v1", labRunApproval: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], configDir: home });
    expect(() => assertDestinationAddressSet(destination, [{ address: "1.2.3.4", family: 4 }])).toThrow(LabDestinationError);
    const other = await createLabDestination({ baseUrl: "https://api.example.com/v2", labRunApproval: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], configDir: home });
    const lease = createCredentialLease({ destination, budget: 1 }); expect(() => assertLeaseScope(lease, other)).toThrow(LabCredentialError);
  });

  test("address-set equality uses the same canonical representation on both sides", async () => {
    const home = tempHome(); const destination = await createLabDestination({ baseUrl: "https://api.example.com/v1", labRunApproval: true, resolve: async () => [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }, { address: "93.184.216.34", family: 4 }, { address: "93.184.216.34", family: 4 }], configDir: home });
    expect(() => assertDestinationAddressSet(destination, [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }])).not.toThrow();
  });

  test("destination resolution obeys the connect timeout", async () => {
    const home = tempHome();
    const pending = createLabDestination({ baseUrl: "https://api.example.com/v1", labRunApproval: true, connectTimeoutMs: 5, resolve: async () => await new Promise<Array<{ address: string; family: 4 | 6 }>>(() => {}), configDir: home });
    await expect(pending).rejects.toMatchObject({ code: "connect_timeout" });
  });

  test("host/SNI mismatch fails closed", async () => { const home = tempHome(); process.env.OPENCODEX_HOME = home; const destination = await createLabDestination({ baseUrl: "https://api.example.com/v1", labRunApproval: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], configDir: home }); expect(() => assertHostSniMatch(destination, "evil.example.com")).toThrow(LabDestinationError); });
  test("metadata and link-local destinations are blocked", async () => { const home = tempHome(); process.env.OPENCODEX_HOME = home; await expect(createLabDestination({ baseUrl: "http://169.254.169.254/latest/meta-data", labRunApproval: true, configDir: home })).rejects.toThrow(LabDestinationError); });
  test("private network requires permission and lab approval", async () => { const home = tempHome(); process.env.OPENCODEX_HOME = home; await expect(createLabDestination({ baseUrl: "http://127.0.0.1:11434/v1", configDir: home })).rejects.toThrow(LabDestinationError); const ok = await createLabDestination({ baseUrl: "http://127.0.0.1:11434/v1", allowPrivateNetwork: true, labRunApproval: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }], configDir: home }); expect(ok.privateNetwork).toBe(true); });
  test("redirects fail closed in mock transport", async () => { const transport = createMockTransport({ entries: [{ status: 302, body: "", headers: { location: "https://evil.example.com" } }] }); await expect(transport.request({ method: "GET", path: "/" })).rejects.toThrow(TransportError); });

  test("credential lease is destination-bound, bounded, and non-serializable", async () => { const home = tempHome(); process.env.OPENCODEX_HOME = home; const destination = await createLabDestination({ baseUrl: "https://api.example.com/v1", labRunApproval: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], configDir: home }); const lease = createCredentialLease({ destination, budget: 1 }); assertLeaseScope(lease, destination); expect(() => JSON.stringify(lease)).toThrow(LabCredentialError); lease.consume(); expect(() => lease.consume()).toThrow(LabCredentialError); });
  test("auth/quota/network/transient classify as blockers", () => { expect(classifyTransportError(new TransportError("auth_blocked", "auth")).classification).toBe("authentication_blocked"); expect(classifyTransportError(new TransportError("quota_blocked", "quota")).classification).toBe("quota_blocked"); expect(classifyTransportError(new TransportError("network_blocked", "net")).classification).toBe("network_failure"); expect(classifyTransportError(new TransportError("provider_transient", "transient")).classification).toBe("provider_transient"); expect(classifyTransportError(new TransportError("connect_timeout", "connect")).classification).toBe("timeout"); expect(classifyTransportError(new TransportError("total_timeout", "timeout")).classification).toBe("timeout"); });

  test("observable resource counters enforce child-process limit", () => { const state = createSandboxResourceState(); expect(() => enforceSandboxLimits(state, limits, { childProcesses: 1 })).toThrow(LabSandboxError); });
  test("untrusted runtime code cannot self-attest a trusted executor", async () => {
    expect("createTrustedLabRouteExecutor" in executionAuthority).toBe(false);
    const fake = { execute: async () => { throw new Error("never"); }, enforcedBoundaries: [...REQUIRED_LAB_SANDBOX_BOUNDARIES] } as TrustedLabRouteExecutor;
    expect(isTrustedLabRouteExecutor(fake)).toBe(false);
    const hostIssued = createHostIssuedLabRouteExecutor(async () => { throw new Error("never"); });
    expect(isTrustedLabRouteExecutor(hostIssued)).toBe(true);
    expect(hostIssued.enforcedBoundaries).toEqual(REQUIRED_LAB_SANDBOX_BOUNDARIES);
  });

  test("installation salt is stable across repeated reads", () => {
    const home = tempHome(); const first = readInstallationSalt(home); const second = readInstallationSalt(home);
    expect(first).toEqual(second); expect(first.byteLength).toBe(32);
  });

  test("concurrent first-run salt initialization converges on one completed salt", async () => {
    const home = tempHome();
    const saltModule = new URL("../src/lab/subject/installation-salt.ts", import.meta.url).href;
    const script = `import { readInstallationSalt } from ${JSON.stringify(saltModule)};\nconst salt = readInstallationSalt(${JSON.stringify(home)});\nprocess.stdout.write(Buffer.from(salt).toString("hex"));`;
    const [first, second] = await Promise.all([runSaltInitializer(script), runSaltInitializer(script)]);
    expect(first).toHaveLength(64); expect(second).toBe(first);
    expect(Buffer.from(readInstallationSalt(home)).toString("hex")).toBe(first);
  });

  test("endpoint fingerprint comes from immutable destination snapshot only", async () => { const home = tempHome(); process.env.OPENCODEX_HOME = home; const destination = await createLabDestination({ baseUrl: "https://api.example.com/v1/custom", labRunApproval: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], configDir: home }); const subject = buildRouteSubjectV1(baseRoute({ baseUrl: "https://api.example.com/v1/custom" }), destination, home); expect(subject.endpointFingerprint).toHaveLength(64); expect(JSON.stringify(subject)).not.toContain("api.example.com"); expect(JSON.stringify(subject)).not.toContain("https://"); });
  test("route subject stability across credential rotation", async () => { const home = tempHome(); process.env.OPENCODEX_HOME = home; const destination = await createLabDestination({ baseUrl: "https://api.example.com/v1", labRunApproval: true, resolve: async () => [{ address: "93.184.216.34", family: 4 }], configDir: home }); const subjectA = freezeRouteSubject(buildRouteSubjectV1(baseRoute(), destination, home)); createCredentialLease({ destination, budget: 1 }).consume(); const subjectB = freezeRouteSubject(buildRouteSubjectV1(baseRoute(), destination, home)); expect(subjectA).toEqual(subjectB); });
});