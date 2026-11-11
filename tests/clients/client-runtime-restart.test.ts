/**
 * OCX-6: `ocx restart` on a connected client runtime (a Remote Link Child).
 *
 * The listener proves its identity on `/healthz` and accepts `POST /api/system/restart` only with
 * the capability bound to its pid and port. The controller restarts by starting its own
 * replacement, and a replacement that does not come up leaves the old runtime serving.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { startMachineListener } from "../../src/client/machine-listener";
import { classifyClientRestartSupervisor, clientConnectionEnded, clientRestartRollbackAction, createClientRestartController, type ClientRestartAdmission, type ClientRestartIo } from "../../src/client/runtime-restart";
import { readClientConnectionStateWithEvidence } from "../../src/client/state";
import * as configModule from "../../src/config";
import { claudeProxyStartEnv } from "../../src/cli/claude";
import { opencodeProxyStartEnv } from "../../src/cli/opencode";
import { spyOn } from "bun:test";
import { deriveLaunchdServiceDiagnostic, deriveSystemdServiceDiagnostic, deriveWindowsServiceDiagnostic } from "../../src/service/diagnostics";
import {
  createLocalAttestationChallenge,
  createLocalAttestationSecret,
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  verifyLocalAttestationProof,
} from "../../src/lib/local-management-attestation";
import {
  CLIENT_RESTART_DRAIN_MS,
  CLIENT_RESTART_READY_BY_MS,
  createSystemRestartCapability,
  SYSTEM_RESTART_CAPABILITY_HEADER,
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_NONCE_HEADER,
  SYSTEM_RESTART_PATH,
} from "../../src/lib/system-restart-contract";
import type { ManagementAuthState } from "../../src/server/management-auth";
import type { OcxClientConnectionConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const STARTED_AT = "2026-10-21T00:00:00.000Z";
const ADMIN = `ocx_admin_${"a".repeat(43)}`;
const connection: OcxClientConnectionConfig = {
  serverUrl: "https://hub.example.test",
  managementUrl: "https://hub.example.test",
  managementTransport: "direct",
  selectedClients: ["codex"],
  tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
  apiKeyId: "client-key-a",
  tokenFingerprint: "a".repeat(64),
  protocolVersion: 1,
  connectedAt: "2026-08-28T00:00:00.000Z",
  catalogSyncedAt: "2026-08-28T00:01:00.000Z",
};

function authState(): ManagementAuthState {
  return { available: true, token: ADMIN, source: "environment", sessions: new Map(), pairingGrants: new Map() };
}

let root = "";
let previousHome: string | undefined;
const servers: Server<unknown>[] = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  root = mkdtempSync(join(tmpdir(), "ocx-client-restart-"));
  process.env.OPENCODEX_HOME = root;
  writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, defaultProvider: "openai" }));
});

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(root);
});

function listen(request: () => Promise<ClientRestartAdmission>, secret = createLocalAttestationSecret()) {
  const server = startMachineListener(0, {
    state: connection,
    managementAuthState: authState(),
    restart: { attestationSecret: secret, startedAt: STARTED_AT, request },
  });
  servers.push(server);
  return { server, secret, port: server.port! };
}

function restartHeaders(secret: string, port: number, pid = process.pid): Record<string, string> {
  const nonce = createLocalAttestationChallenge();
  return {
    [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(pid),
    [SYSTEM_RESTART_NONCE_HEADER]: nonce,
    [SYSTEM_RESTART_CAPABILITY_HEADER]: createSystemRestartCapability(secret, nonce, "POST", SYSTEM_RESTART_PATH, process.pid, port)!,
  };
}

describe("client listener: bound restart", () => {
  test("/healthz proves this process to a challenge and advertises the restart and its start time", async () => {
    const { server, secret, port } = listen(async () => ({ kind: "accepted", alreadyRestarting: false }));
    const challenge = createLocalAttestationChallenge();
    const response = await fetch(new URL("/healthz", server.url), { headers: { [LOCAL_ATTESTATION_CHALLENGE_HEADER]: challenge } });
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ role: "client", pid: process.pid, port, startedAt: STARTED_AT, restartCapability: "v1" });
    expect(verifyLocalAttestationProof(secret, challenge, process.pid, port, response.headers.get(LOCAL_ATTESTATION_PROOF_HEADER))).toBe(true);
  });

  test("accepts only the capability bound to this pid and port", async () => {
    let requests = 0;
    const { server, secret, port } = listen(async () => { requests += 1; return { kind: "accepted", alreadyRestarting: requests > 1 }; });
    const url = new URL(SYSTEM_RESTART_PATH, server.url);
    const refusals: Array<[Record<string, string>, number]> = [
      [{}, 409],
      [{ [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid) }, 401],
      [{ authorization: `Bearer ${ADMIN}`, "x-opencodex-api-key": ADMIN, [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid) }, 401],
      [restartHeaders(createLocalAttestationSecret(), port), 401],
      [restartHeaders(secret, port + 1 > 65535 ? port - 1 : port + 1), 401],
      [restartHeaders(secret, port, process.pid + 1), 409],
    ];
    for (const [headers, status] of refusals) {
      const response = await fetch(url, { method: "POST", headers });
      expect(response.status).toBe(status);
    }
    expect(requests).toBe(0);

    const accepted = await fetch(url, { method: "POST", headers: restartHeaders(secret, port) });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ success: true, alreadyDraining: false });
    const again = await fetch(url, { method: "POST", headers: restartHeaders(secret, port) });
    expect(await again.json()).toMatchObject({ success: true, alreadyDraining: true });
    expect(requests).toBe(2);
  });

  test("a supervised runtime refuses with the supervisor named and keeps serving", async () => {
    const { server, secret, port } = listen(async () => ({ kind: "supervised", supervisor: "service" }));
    const response = await fetch(new URL(SYSTEM_RESTART_PATH, server.url), { method: "POST", headers: restartHeaders(secret, port) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: { code: "restart_supervised", supervisor: "service" } });
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
  });

  test("without the restart wiring the route stays unavailable and /healthz advertises nothing", async () => {
    const server = startMachineListener(0, { state: connection, managementAuthState: authState() });
    servers.push(server);
    const body = await (await fetch(new URL("/healthz", server.url))).json() as Record<string, unknown>;
    expect(body.restartCapability).toBeUndefined();
    expect((await fetch(new URL(SYSTEM_RESTART_PATH, server.url), { method: "POST" })).status).toBe(404);
  });

  test("a signal-stopping runtime refuses bound restart without a success receipt", async () => {
    const { server, secret, port } = listen(async () => ({ kind: "stopping" }));
    const response = await fetch(new URL(SYSTEM_RESTART_PATH, server.url), { method: "POST", headers: restartHeaders(secret, port) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, error: { code: "runtime_stopping" } });
  });
});

function fakeIo(overrides: Partial<ClientRestartIo> = {}) {
  const calls: string[] = [];
  const io: ClientRestartIo = {
    supervisor: async () => null,
    stop: async drainMs => { calls.push(`stop:${drainMs}`); },
    spawnReplacement: async deadlineAt => { calls.push(`spawn:${deadlineAt}`); },
    resume: async () => { calls.push("resume"); },
    exitProcess: code => { calls.push(`exit:${code}`); },
    now: () => 1_000,
    sleep: async () => {},
    warn: message => { calls.push(`warn:${message}`); },
    ...overrides,
  };
  return { io, calls };
}

describe("client restart controller", () => {
  test("signal shutdown refuses new and pending restart admissions without spawning", async () => {
    let stopping = false;
    let admit!: (value: null) => void;
    const { io, calls } = fakeIo({ stopping: () => stopping, supervisor: () => new Promise(resolve => { admit = resolve; }) });
    const controller = createClientRestartController(io);
    const pending = controller.request();
    expect(controller.hasHandoff()).toBe(false);
    stopping = true;
    expect(await controller.request()).toEqual({ kind: "stopping" });
    admit(null);
    expect(await pending).toEqual({ kind: "stopping" });
    expect(controller.hasHandoff()).toBe(false);
    expect(calls).toEqual([]);
  });

  test("pending admission never owns routing and refusal or failure leaves no handoff", async () => {
    let settle!: (value: "service" | null) => void;
    const { io } = fakeIo({ supervisor: () => new Promise(resolve => { settle = resolve; }) });
    const controller = createClientRestartController(io);
    expect(controller.hasHandoff()).toBe(false);
    const pending = controller.request();
    expect(controller.hasHandoff()).toBe(false);
    settle("service");
    expect(await pending).toEqual({ kind: "supervised", supervisor: "service" });
    expect(controller.hasHandoff()).toBe(false);
    const failed = createClientRestartController(fakeIo({ supervisor: async () => { throw new Error("unavailable"); } }).io);
    await expect(failed.request()).rejects.toThrow("unavailable");
    expect(failed.hasHandoff()).toBe(false);
  });

  test("accepted handoff remains owned until its asynchronous exit settles", async () => {
    let entered!: () => void;
    let release!: () => void;
    const atExit = new Promise<void>(resolve => { entered = resolve; });
    const exitGate = new Promise<void>(resolve => { release = resolve; });
    const controller = createClientRestartController(fakeIo({ exitProcess: async () => { entered(); await exitGate; } }).io);
    await controller.request();
    await atExit;
    expect(controller.hasHandoff()).toBe(true);
    release();
    await controller.settled();
    expect(controller.hasHandoff()).toBe(false);
  });

  test("a replacement that answers ends this process", async () => {
    const { io, calls } = fakeIo();
    const controller = createClientRestartController(io);
    expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: false });
    await controller.settled();
    expect(calls).toEqual([`stop:${CLIENT_RESTART_DRAIN_MS}`, `spawn:${1_000 + CLIENT_RESTART_READY_BY_MS}`, "exit:0"]);
  });

  test("a failed replacement keeps the old runtime: it serves again and does not exit", async () => {
    const { io, calls } = fakeIo({
      spawnReplacement: async () => { throw Object.assign(new Error("x"), { code: "not_ready" }); },
    });
    const controller = createClientRestartController(io);
    await controller.request();
    await controller.settled();
    expect(calls).toEqual([
      `stop:${CLIENT_RESTART_DRAIN_MS}`,
      "warn:[client] restart: the replacement did not start (not_ready); this runtime keeps serving",
      "resume",
    ]);
    // The latch is released: a later restart is accepted afresh.
    expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: false });
  });

  test("only a rollback that cannot serve again exits, and it says so", async () => {
    const { io, calls } = fakeIo({
      spawnReplacement: async () => { throw Object.assign(new Error("x"), { code: "child_exit" }); },
      resume: async () => { throw Object.assign(new Error("x"), { code: "EADDRINUSE" }); },
    });
    const controller = createClientRestartController(io);
    await controller.request();
    await controller.settled();
    expect(calls.at(-2)).toBe("warn:[client] restart: this runtime could not serve again (EADDRINUSE); run 'ocx start'");
    expect(calls.at(-1)).toBe("exit:1");
  });

  test("a supervised runtime is refused before anything stops", async () => {
    const { io, calls } = fakeIo({ supervisor: async () => "desktop" });
    const controller = createClientRestartController(io);
    expect(await controller.request()).toEqual({ kind: "supervised", supervisor: "desktop" });
    await controller.settled();
    expect(calls).toEqual([]);
  });

  // After `ocx disconnect` (or a newer connect) the served connection is gone, so there is no
  // old runtime worth keeping: the restart hands off to the recycle, which every owner relaunches.
  for (const supervisor of ["desktop", "service", null] as const) {
    test(`a runtime whose connection changed recycles under ${supervisor ?? "no"} supervisor`, async () => {
      const { io, calls } = fakeIo({
        supervisor: async () => supervisor,
        connectionChanged: () => true,
        recycle: async () => { calls.push("recycle"); },
      });
      const controller = createClientRestartController(io);
      expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: false });
      expect(controller.hasHandoff()).toBe(true);
      expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: true });
      await controller.settled();
      expect(calls).toEqual(["recycle"]);
    });
  }

  // Final review: the recycle hands off to the supervisor only when supervision is viable, so it
  // receives the same verdict (isServiceViable included) the refusal path uses.
  // Coordinator review round 2: the connection recheck must be the last step before the recycle,
  // after the asynchronous supervisor lookup. The hook holds that lookup open while the connection
  // becomes current again; the recycle must not run.
  test("a connection current again during the supervisor lookup keeps this runtime", async () => {
    let ended = true;
    let releaseLookup!: (value: "desktop") => void;
    let lookupEntered!: () => void;
    let lookups = 0;
    const entered = new Promise<void>(resolve => { lookupEntered = resolve; });
    const recycled: unknown[] = [];
    const { io } = fakeIo({
      connectionChanged: () => ended,
      supervisor: () => { lookups += 1; if (lookups === 1) return Promise.resolve("desktop" as const); lookupEntered(); return new Promise(resolve => { releaseLookup = resolve; }); },
      recycle: async verdict => { recycled.push(verdict); },
    });
    const controller = createClientRestartController(io);
    expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: false });
    await entered;
    ended = false;
    releaseLookup("desktop");
    await controller.settled();
    expect(recycled).toEqual([]);
  });

  // Final review: a manager that owns this process but cannot be proven to relaunch it must keep
  // the runtime; refused at admission, nothing recycled or detached.
  // The restart decision table (PR body): every supervisor verdict, with the connection ended
  // (saved, valid, disconnected or another connection) or not (served connection current, or
  // the saved state is invalid, missing or unreadable).
  test.each([
    ["desktop", true, "accepted", ["recycle:desktop"]],
    ["desktop", false, "supervised", []],
    ["service", true, "accepted", ["recycle:service"]],
    ["service", false, "supervised", []],
    ["service-unproven", true, "supervised", []],
    ["service-unproven", false, "supervised", []],
    ["owner-unproven", true, "supervised", []],
    ["owner-unproven", false, "supervised", []],
    [null, true, "accepted", ["recycle:none"]],
    [null, false, "accepted", ["stop:20000", "spawn:71000", "exit:0"]],
  ] as const)("decision table: supervisor %s, connection ended %s", async (supervisor, ended, kind, expectedCalls) => {
    const calls: string[] = [];
    const { io, calls: ioCalls } = fakeIo({ supervisor: async () => supervisor, connectionChanged: () => ended, recycle: async verdict => { calls.push(`recycle:${verdict ?? "none"}`); } });
    const controller = createClientRestartController(io);
    const admission = await controller.request();
    expect(admission.kind).toBe(kind);
    if (kind === "supervised") expect(admission).toEqual({ kind: "supervised", supervisor });
    await controller.settled();
    expect([...calls, ...ioCalls]).toEqual([...expectedCalls]);
  });

  test("an owned but unproven service refuses even an ended connection, and recycles nothing", async () => {
    const recycled: unknown[] = [];
    const { io } = fakeIo({ supervisor: async () => "service-unproven", connectionChanged: () => true, recycle: async verdict => { recycled.push(verdict); } });
    const controller = createClientRestartController(io);
    expect(await controller.request()).toEqual({ kind: "supervised", supervisor: "service-unproven" });
    await controller.settled();
    expect(recycled).toEqual([]);
  });

  test("the recycle receives the supervisor verdict", async () => {
    for (const supervisor of ["desktop", "service", null] as const) {
      const seen: unknown[] = [];
      const { io } = fakeIo({ supervisor: async () => supervisor, connectionChanged: () => true, recycle: async verdict => { seen.push(verdict); } });
      const controller = createClientRestartController(io);
      await controller.request();
      await controller.settled();
      expect(seen).toEqual([supervisor]);
    }
  });

  test("an unchanged connection under a supervisor is still refused", async () => {
    const { io, calls } = fakeIo({ supervisor: async () => "service", connectionChanged: () => false, recycle: async () => { calls.push("recycle"); } });
    expect(await createClientRestartController(io).request()).toEqual({ kind: "supervised", supervisor: "service" });
    expect(calls).toEqual([]);
  });

  test("a connection that is current again by the time the recycle would run keeps this runtime", async () => {
    const verdicts = [true, false];
    const { io, calls } = fakeIo({ supervisor: async () => "desktop", connectionChanged: () => verdicts.shift() ?? false, recycle: async () => { calls.push("recycle"); } });
    const controller = createClientRestartController(io);
    expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: false });
    await controller.settled();
    expect(calls).toEqual([]);
    expect(controller.hasHandoff()).toBe(false);
  });

  test("a second request while one is in flight joins it", async () => {
    let finish!: () => void;
    let spawns = 0;
    const { io } = fakeIo({ spawnReplacement: () => { spawns += 1; return new Promise<void>(resolve => { finish = resolve; }); } });
    const controller = createClientRestartController(io);
    expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: false });
    expect(await controller.request()).toEqual({ kind: "accepted", alreadyRestarting: true });
    while (!finish) await Bun.sleep(1);
    finish();
    await controller.settled();
    expect(spawns).toBe(1);
  });
});

describe("who supervises a client restart (real service diagnostics)", () => {
  const owned = { OCX_SERVICE: "1", OCX_SERVICE_MANAGED: "1" } as NodeJS.ProcessEnv;
  const systemd = (enabled: boolean, running: boolean) => deriveSystemdServiceDiagnostic({ installed: true, enabled, running, stale: false, diagnostics: "test" });
  test.each([
    ["systemd running but disabled (started by hand)", systemd(false, true), "service-unproven"],
    ["systemd enabled and running", systemd(true, true), "service"],
    ["launchd job installed but not loaded", deriveLaunchdServiceDiagnostic({ installed: true, stale: false, load: { state: "not-loaded" } as never, diagnostics: "test" }), "service-unproven"],
    ["launchd job loaded from the current plist", deriveLaunchdServiceDiagnostic({ installed: true, stale: false, load: { state: "loaded-current" }, diagnostics: "test" }), "service"],
    ["Windows native service stopped", deriveWindowsServiceDiagnostic({ schedulerXml: "", schedulerExpectedUserId: null, schedulerAssetsPresent: false, nativeStatus: "stopped", recordedBackend: "native", staleBakedPaths: false, nativeRepairAssetsOnly: false, diagnostics: "test" }), "service-unproven"],
  ] as const)("%s", (_name, diagnostic, expected) => {
    expect(classifyClientRestartSupervisor({ desktop: false, env: owned, diagnose: () => diagnostic })).toBe(expected);
  });

  // Final review round 2: launchd's unknown load state stays viable for the diagnostic's other
  // callers, but a restart needs positive evidence that the job is loaded.
  test("launchd job whose load state is unknown is not proof of relaunch", () => {
    const unknown = deriveLaunchdServiceDiagnostic({ installed: true, stale: false, load: { state: "unknown", detail: "launchctl could not be asked" }, diagnostics: "test" });
    expect(unknown.viable).toBe(true);
    expect(classifyClientRestartSupervisor({ desktop: false, env: { OCX_SERVICE_MANAGED: "1" }, diagnose: () => unknown })).toBe("service-unproven");
  });

  // Final review round 2: ocx claude and ocx opencode start their own proxies with OCX_SERVICE=1;
  // through their real launch environments, with no service installed, nothing supervises them.
  const notInstalled = deriveSystemdServiceDiagnostic({ installed: false, enabled: false, running: false, stale: false, diagnostics: "test" });
  const installedDisabled = systemd(false, false);
  test.each([
    ["ocx claude", () => claudeProxyStartEnv({ PATH: "/usr/bin" })],
    ["ocx opencode", () => opencodeProxyStartEnv({ PATH: "/usr/bin" })],
  ] as const)("a %s companion with no service installed is not supervised", (_name, env) => {
    expect(env().OCX_SERVICE).toBe("1");
    expect(classifyClientRestartSupervisor({ desktop: false, env: env(), diagnose: () => notInstalled })).toBeNull();
  });

  test.each([
    ["ocx claude", () => claudeProxyStartEnv({ PATH: "/usr/bin" })],
    ["ocx opencode", () => opencodeProxyStartEnv({ PATH: "/usr/bin" })],
  ] as const)("a bare OCX_SERVICE=1 (%s environment) while a service is installed is owner-unproven", (_name, env) => {
    expect(classifyClientRestartSupervisor({ desktop: false, env: env(), diagnose: () => installedDisabled })).toBe("owner-unproven");
  });

  test("the Windows wrapper's marker counts as manager-launched", () => {
    expect(classifyClientRestartSupervisor({ desktop: false, env: { OCX_SERVICE: "1", OCX_WINDOWS_WRAPPER_PROTOCOL: "1" }, diagnose: () => systemd(true, true) })).toBe("service");
  });

  test("OCX_SERVICE_MANAGED alone marks the process as manager-owned", () => {
    expect(classifyClientRestartSupervisor({ desktop: false, env: { OCX_SERVICE_MANAGED: "1" }, diagnose: () => systemd(false, true) })).toBe("service-unproven");
  });

  test("no manager marker means no supervisor, whatever the service diagnostic says", () => {
    expect(classifyClientRestartSupervisor({ desktop: false, env: {}, diagnose: () => systemd(true, true) })).toBeNull();
  });

  test("the desktop app wins", () => {
    expect(classifyClientRestartSupervisor({ desktop: true, env: owned, diagnose: () => systemd(false, true) })).toBe("desktop");
  });
});

// Final review: a missing config.json reads as the default configuration, which is not evidence that
// the served connection ended. The real reader is used here, with no injected state.
describe("connection-ended evidence from the real state reader", () => {
  const link = { ...connection, transport: "link" as const, link: { linkId: `lnk_${"b".repeat(16)}`, tunnelPort: 23457 } };
  test("a missing config.json is not proof the connection ended", () => {
    const empty = mkdtempSync(join(tmpdir(), "ocx-client-restart-missing-config-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = empty;
    try {
      const state = readClientConnectionStateWithEvidence();
      expect(state).toEqual({ kind: "invalid", reason: "config.json is missing" });
      expect(clientConnectionEnded(link, state)).toBe(false);
    } finally {
      process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(empty);
    }
  });

  // Final review round 2: a saved file that fails validation is not evidence either.
  test("a saved config that fails validation is not proof", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ port: "bad" }));
    const state = readClientConnectionStateWithEvidence();
    expect(state.kind).toBe("invalid");
    expect(clientConnectionEnded(link, state)).toBe(false);
  });

  // ...and the verdict comes from one snapshot: a connect committed after the file was read cannot
  // pair the old bytes with a validation of the new ones. The hook commits at the second read.
  test("a connection committed between reads never yields disconnected from a stale read", () => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, defaultProvider: "openai" }));
    const realDiagnostics = configModule.readConfigDiagnostics;
    let committed = false;
    const hook = spyOn(configModule, "readConfigDiagnostics").mockImplementation((options?: Parameters<typeof realDiagnostics>[0]) => {
      if (!committed) {
        committed = true;
        writeFileSync(join(root, "config.json"), JSON.stringify({ port: 0, providers: {}, defaultProvider: "openai", runtimeRole: "client", client: link }));
      }
      return realDiagnostics(options);
    });
    try {
      const state = readClientConnectionStateWithEvidence();
      expect(committed && state.kind === "disconnected").toBe(false);
    } finally {
      hook.mockRestore();
    }
  });

  test("a saved config with no client is proof", () => {
    // beforeEach wrote a standalone config.json into this test's home.
    const state = readClientConnectionStateWithEvidence();
    expect(state).toEqual({ kind: "disconnected" });
    expect(clientConnectionEnded(link, state)).toBe(true);
  });
});

describe("rollback after a failed replacement", () => {
  const link = { ...connection, transport: "link" as const, link: { linkId: `lnk_${"b".repeat(16)}`, tunnelPort: 23457 } };
  // Only a proven end of the served connection may recycle a supervised runtime; an unreadable or
  // mismatched config is not one, and recycling on it could take down a link that still works.
  test("a supervised restart treats only a disconnect or a different connection as ended", () => {
    expect(clientConnectionEnded(link, { kind: "disconnected" } as never)).toBe(true);
    expect(clientConnectionEnded(link, { kind: "connected", value: { ...link, connectedAt: "2026-10-21T00:00:00.000Z" } })).toBe(true);
    expect(clientConnectionEnded(link, { kind: "connected", value: { ...link, link: { ...link.link, linkId: `lnk_${"c".repeat(16)}` } } })).toBe(true);
    expect(clientConnectionEnded(link, { kind: "connected", value: { ...link, catalogSyncedAt: "2026-10-21T00:00:00.000Z" } })).toBe(false);
    expect(clientConnectionEnded(link, { kind: "invalid", reason: "config.json is missing or unreadable" } as never)).toBe(false);
    expect(clientConnectionEnded(link, { kind: "mismatched", reason: "x" } as never)).toBe(false);
  });
  test("serves the same connection again only while it is still the durable one", () => {
    expect(clientRestartRollbackAction(link, { kind: "connected", value: { ...link, catalogSyncedAt: "2026-10-21T00:00:00.000Z" } })).toBe("resume");
    expect(clientRestartRollbackAction(link, { kind: "disconnected" } as never)).toBe("recycle");
    expect(clientRestartRollbackAction(link, { kind: "connected", value: { ...link, connectedAt: "2026-10-21T00:00:00.000Z" } })).toBe("recycle");
    expect(clientRestartRollbackAction(link, { kind: "connected", value: { ...link, link: { ...link.link, linkId: `lnk_${"c".repeat(16)}` } } })).toBe("recycle");
  });
});
