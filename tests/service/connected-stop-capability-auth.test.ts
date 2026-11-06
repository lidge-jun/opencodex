import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertConnectedClientStopSupported } from "../../src/cli/stop-restore";
import { startMachineListener } from "../../src/client/machine-listener";
import { saveConfig } from "../../src/config";
import { writeRuntimePort } from "../../src/config/process-state";
import {
  createLocalAttestationChallenge,
  createLocalAttestationProof,
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  verifyLocalAttestationProof,
} from "../../src/lib/local-management-attestation";
import {
  createLocalManagementReadCapability,
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
} from "../../src/lib/local-management-capability";
import { startServer } from "../../src/server";
import { directLocalHttpFetch } from "../../src/server/direct-local-http";
import { requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { serverAuthConfig } from "../helpers/server-auth-config";
import { currentServerFixtureConfig, settleServerAuthFixture } from "../helpers/server-auth-fixture";

const SECRET = "A".repeat(43);
const ADMIN = "ocx-test-connected-stop-admin";
let home: string;
let oldHome: string | undefined;
let oldAdmin: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let proxy: ReturnType<typeof startServer> | undefined;
let codexHome: IsolatedCodexHome | undefined;

beforeEach(() => {
  oldHome = process.env.OPENCODEX_HOME;
  oldAdmin = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  home = mkdtempSync(join(tmpdir(), "ocx-stop-capability-auth-"));
  process.env.OPENCODEX_HOME = home;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
});

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await proxy?.stop(true);
  proxy = undefined;
  if (codexHome) {
    await settleServerAuthFixture(home, codexHome.path);
    codexHome.restore();
    codexHome = undefined;
  }
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  if (oldAdmin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = oldAdmin;
  removeTreeWithRetry(home);
});

type FixtureOptions = {
  health?: "proxy" | "client" | "foreign";
  healthProof?: boolean;
  readProof?: boolean;
  missingRecord?: boolean;
  record?: Record<string, unknown>;
  replaceAfter?: "health" | "capability";
};

function listener(options: FixtureOptions = {}) {
  const requests: Array<{ path: string; method: string; headers: Headers }> = [];
  const auth: ManagementAuthState = {
    available: true, token: ADMIN, source: "environment", sessions: new Map(), pairingGrants: new Map(),
  };
  const record = () => ({ pid: process.pid, port: server!.port, hostname: "127.0.0.1", attestationSecret: SECRET });
  const writeRecord = (overrides: Record<string, unknown> = {}) => {
    writeFileSync(join(home, "runtime-port.json"), JSON.stringify({ ...record(), ...overrides }), { mode: 0o600 });
  };
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push({ path, method: req.method, headers: new Headers(req.headers) });
    const headers = new Headers();
    const health = path === "/healthz";
    const nonce = req.headers.get(health ? LOCAL_ATTESTATION_CHALLENGE_HEADER : LOCAL_MANAGEMENT_NONCE_HEADER);
    if (nonce && (health ? options.healthProof : options.readProof)) {
      headers.set(LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof(SECRET, nonce, process.pid, server!.port!)!);
    }
    if (options.replaceAfter === (health ? "health" : "capability")) writeRecord({ attestationSecret: "B".repeat(43) });
    if (health) {
      return options.health === "foreign"
        ? Response.json({ service: "other" }, { status: 404 })
        : Response.json({ service: "opencodex", pid: process.pid,
          ...(options.health === "client" ? { role: "client" } : {}) }, { headers });
    }
    const error = requireManagementAuth(req, auth, undefined, record());
    if (error) return error;
    return Response.json({ schema: "ocx-stop-capabilities/1", connectedClientOwnership: true, pid: process.pid }, { headers });
  } });
  if (!options.missingRecord) writeRecord(options.record);
  return { target: { pid: process.pid, port: server.port!, hostname: "127.0.0.1" }, requests };
}

describe("connected stop preflight runtime authority", () => {
  test("a foreign health response never receives a reusable administrator credential", async () => {
    const fixture = listener({ health: "foreign" });
    let refused = false;
    try { await assertConnectedClientStopSupported(fixture.target); } catch { refused = true; }
    expect(fixture.requests.some(req => req.headers.has("x-opencodex-api-key"))).toBe(false);
    expect(refused).toBe(true);
  });

  test("a claimed native client PID without attestation cannot authorize stop", async () => {
    const fixture = listener({ health: "client" });
    await expect(assertConnectedClientStopSupported(fixture.target)).rejects.toThrow("Connected-client stop refused");
    expect(fixture.requests.map(req => req.path)).toEqual(["/healthz"]);
  });

  test("an attested native client keeps its credential-free health-only path", async () => {
    const fixture = listener({ health: "client", healthProof: true });
    await assertConnectedClientStopSupported(fixture.target);
    expect(fixture.requests.map(req => req.path)).toEqual(["/healthz"]);
    expect(fixture.requests[0]!.headers.has(LOCAL_ATTESTATION_CHALLENGE_HEADER)).toBe(true);
    expect(fixture.requests[0]!.headers.has("x-opencodex-api-key")).toBe(false);
  });

  test("an ordinary proxy proves its bound read without receiving the admin token", async () => {
    const fixture = listener({ healthProof: true, readProof: true });
    await assertConnectedClientStopSupported(fixture.target);
    expect(fixture.requests.map(req => `${req.method} ${req.path}`)).toEqual(["GET /healthz", "GET /api/stop"]);
    expect(fixture.requests.every(req => !req.headers.has("x-opencodex-api-key"))).toBe(true);
    expect(fixture.requests[1]!.headers.has(LOCAL_MANAGEMENT_CAPABILITY_HEADER)).toBe(true);
  });

  for (const hostname of ["localhost", "localhost."]) {
    test(`${hostname} preflight uses the same literal IPv4 endpoint as stop`, async () => {
      const fixture = listener({ healthProof: true, readProof: true, record: { hostname } });
      await assertConnectedClientStopSupported({ ...fixture.target, hostname });
      expect(fixture.requests.map(req => req.path)).toEqual(["/healthz", "/api/stop"]);
      expect(fixture.requests.map(req => req.headers.get("host")))
        .toEqual([`127.0.0.1:${fixture.target.port}`, `127.0.0.1:${fixture.target.port}`]);
    });
  }

  test("a stop response without the request's proof is refused", async () => {
    const fixture = listener({ healthProof: true });
    await expect(assertConnectedClientStopSupported(fixture.target)).rejects.toThrow("Connected-client stop refused");
  });

  for (const options of [
    { missingRecord: true },
    { record: { attestationSecret: undefined } },
    { record: { pid: process.pid + 1 } },
    { record: { port: 1 } },
    { record: { hostname: "127.0.0.2" } },
  ]) {
    test(`unbound runtime refuses before network I/O: ${JSON.stringify(options)}`, async () => {
      const fixture = listener({ ...options, healthProof: true, readProof: true });
      await expect(assertConnectedClientStopSupported(fixture.target)).rejects.toThrow("Connected-client stop refused");
      expect(fixture.requests).toHaveLength(0);
    });
  }

  for (const replaceAfter of ["health", "capability"] as const) {
    test(`replacement after ${replaceAfter} discards the preflight`, async () => {
      const fixture = listener({ healthProof: true, readProof: true, replaceAfter });
      await expect(assertConnectedClientStopSupported(fixture.target)).rejects.toThrow("Connected-client stop refused");
      expect(fixture.requests).toHaveLength(replaceAfter === "health" ? 1 : 2);
      expect(fixture.requests.every(req => !req.headers.has("x-opencodex-api-key"))).toBe(true);
    });
  }
});

describe("production connected-stop listeners", () => {
  function signed(port: number) {
    const nonce = createLocalAttestationChallenge();
    const expiresAt = Date.now() + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;
    const proof = createLocalManagementReadCapability(SECRET, nonce, "GET", "/api/stop", process.pid, port, expiresAt);
    expect(proof).not.toBeNull();
    return new Headers({
      [LOCAL_MANAGEMENT_NONCE_HEADER]: nonce,
      [LOCAL_MANAGEMENT_EXPECTED_PID_HEADER]: String(process.pid),
      [LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER]: String(expiresAt),
      [LOCAL_MANAGEMENT_CAPABILITY_HEADER]: proof!,
    });
  }

  test("the proxy admits and proves one stop read, refusing replay and altered scope", async () => {
    codexHome = installIsolatedCodexHome("ocx-stop-capability-codex-");
    saveConfig(currentServerFixtureConfig({
      ...serverAuthConfig("127.0.0.1"), clientIntegrations: { codex: false }, asideProfileSync: { allProfiles: false },
    }));
    proxy = startServer(0, {
      localAttestationSecret: SECRET,
      inspectNativeCodexOwnership: ownedServiceHomeInspection("Connected stop capability fixture"),
    });
    const target = { pid: process.pid, port: proxy.port!, hostname: "127.0.0.1" };
    writeRuntimePort({ ...target, attestationSecret: SECRET });
    const configBefore = readFileSync(join(home, "config.json"), "utf8");
    await assertConnectedClientStopSupported(target);
    const send = (path: string, headers: Headers, method = "GET") => directLocalHttpFetch(
      `http://127.0.0.1:${target.port}${path}`, { method, headers, redirect: "error" },
    );
    const headers = signed(target.port);
    const accepted = await send("/api/stop", headers);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(verifyLocalAttestationProof(SECRET, headers.get(LOCAL_MANAGEMENT_NONCE_HEADER)!, process.pid, target.port,
      accepted.headers.get(LOCAL_ATTESTATION_PROOF_HEADER))).toBe(true);
    expect(await accepted.json()).toEqual({ schema: "ocx-stop-capabilities/1", connectedClientOwnership: true, pid: process.pid });
    const replay = await send("/api/stop", headers);
    expect(replay.status).toBe(401);
    await replay.arrayBuffer();
    for (const [method, path] of [["POST", "/api/stop"], ["GET", "/api/config"], ["GET", "/api/stop?deferSharedTeardown=1"]] as const) {
      const refused = await send(path, signed(target.port), method);
      expect(refused.status).toBe(401);
      await refused.arrayBuffer();
    }
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(configBefore);
  });

  test("the native machine listener's attested health supports the preflight", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 0, providers: {}, defaultProvider: "openai" }));
    server = startMachineListener(0, {
      state: { serverUrl: "https://hub.example.test", managementUrl: "https://hub.example.test", managementTransport: "direct",
        selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "client-stop-fixture",
        tokenFingerprint: "a".repeat(64), protocolVersion: 1, connectedAt: "2026-10-01T00:00:00.000Z", catalogSyncedAt: "2026-10-01T00:00:00.000Z" },
      managementAuthState: { available: true, token: ADMIN, source: "environment", sessions: new Map(), pairingGrants: new Map() },
      restart: { attestationSecret: SECRET, startedAt: "2026-10-01T00:00:00.000Z",
        request: async () => { throw new Error("stop preflight must not request a restart"); } },
    });
    const target = { pid: process.pid, port: server.port!, hostname: "127.0.0.1" };
    writeRuntimePort({ ...target, attestationSecret: SECRET });
    await assertConnectedClientStopSupported(target);
    const unsupported = await directLocalHttpFetch(`http://127.0.0.1:${target.port}/api/stop`);
    expect(unsupported.status).toBe(404);
    await unsupported.arrayBuffer();
  });
});
