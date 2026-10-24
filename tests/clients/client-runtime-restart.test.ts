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
import { clientRestartRollbackAction, createClientRestartController, type ClientRestartAdmission, type ClientRestartIo } from "../../src/client/runtime-restart";
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

describe("rollback after a failed replacement", () => {
  const link = { ...connection, transport: "link" as const, link: { linkId: `lnk_${"b".repeat(16)}`, tunnelPort: 23457 } };
  test("serves the same connection again only while it is still the durable one", () => {
    expect(clientRestartRollbackAction(link, { kind: "connected", value: { ...link, catalogSyncedAt: "2026-10-21T00:00:00.000Z" } })).toBe("resume");
    expect(clientRestartRollbackAction(link, { kind: "disconnected" } as never)).toBe("recycle");
    expect(clientRestartRollbackAction(link, { kind: "connected", value: { ...link, connectedAt: "2026-10-21T00:00:00.000Z" } })).toBe("recycle");
    expect(clientRestartRollbackAction(link, { kind: "connected", value: { ...link, link: { ...link.link, linkId: `lnk_${"c".repeat(16)}` } } })).toBe("recycle");
  });
});
