/**
 * #8184: `ocx link status` on a hub whose public listener is not loopback.
 *
 * The hub management listener is the target of Tailscale Serve, so a request on it may have come
 * from anywhere on the tailnet and must never count as trusted loopback (#6913). These cases start
 * real servers and prove three things: the admin token stays refused on every TCP listener, the
 * private Unix socket admits it for the one status read and nothing else, and the socket's access
 * boundary is the filesystem, which no TCP relay or forged header can reach.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import { runLinkCommand } from "../../src/cli/link";
import {
  localControlLeasePath,
  localControlSocketDir,
  localControlSocketPath,
  usableLocalControlSocket,
} from "../../src/lib/local-control-socket";
import {
  createLocalControlListener,
  localControlRouteAllowed,
  localControlSocketWanted,
} from "../../src/server/index/local-control-listener";
import { AuxiliaryListenerBindError, findAvailablePort, isAddrInUse } from "../../src/server/ports";
import type { OcxConfig } from "../../src/types";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousHome = process.env.OPENCODEX_HOME;
const ADMIN = "admin-secret";
const STATUS = "/api/link/status?compatibility=1&diagnostics=1";
const unixSupported = process.platform !== "win32";
let testDir = "";

function hubConfig(managementPort: number, hostname = "0.0.0.0"): OcxConfig {
  return {
    port: 0,
    hostname,
    defaultProvider: "chatgpt",
    providers: { chatgpt: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
    runtimeRole: "hub",
    hub: { managementPublicOrigin: "https://hub.example.test", managementIngress: { enabled: true, port: managementPort } },
    remoteGui: { allowedTailscaleUsers: ["alice@example.test"] },
  } as unknown as OcxConfig;
}

async function startHub(hostname = "0.0.0.0") {
  for (let draw = 1; ; draw += 1) {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    saveConfig(hubConfig(managementPort, hostname));
    try {
      const server = startServer(0);
      return { server, managementPort, publicPort: server.port! };
    } catch (error) {
      await waitForFailedStartRollback(error);
      if (!(error instanceof AuxiliaryListenerBindError && isAddrInUse(error.cause)) || draw >= 3) throw error;
    }
  }
}

/** runCliAction reports a failure as exit code 1 and one stderr line; keep both. */
async function runQuietly(args: string[], deps: Parameters<typeof runLinkCommand>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error] = [console.log, console.error];
  console.log = (...values: unknown[]) => { out.push(values.join(" ")); };
  console.error = (...values: unknown[]) => { err.push(values.join(" ")); };
  try {
    return { code: await runLinkCommand(args, deps), out, err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function overSocket(socket: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://localhost${path}`, { ...init, unix: socket } as RequestInit);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-lc-"));
  process.env.OPENCODEX_HOME = testDir;
  process.env.OPENCODEX_API_AUTH_TOKEN = "public-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
});

afterEach(() => {
  for (const [key, value] of [["OPENCODEX_API_AUTH_TOKEN", previousApiToken], ["OPENCODEX_ADMIN_AUTH_TOKEN", previousAdminToken], ["OPENCODEX_HOME", previousHome]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (testDir && existsSync(testDir)) removeTreeWithRetry(testDir);
  testDir = "";
});

describe("local control socket route table", () => {
  test("admits only GET /api/link/status", () => {
    const allowed = (method: string, path: string, headers: Record<string, string> = {}) =>
      localControlRouteAllowed(new URL(`http://localhost${path}`), new Request(`http://localhost${path}`, { method, headers }));
    expect(allowed("GET", STATUS)).toBe(true);
    expect(allowed("GET", "/api/link/status")).toBe(true);
    expect(allowed("POST", "/api/link/status")).toBe(false);
    expect(allowed("GET", "/api/link/status", { upgrade: "websocket" })).toBe(false);
    for (const path of ["/api/config", "/api/link/candidates", "/api/link/issue", "/healthz", "/v1/responses", "/"]) {
      expect(allowed("GET", path)).toBe(false);
    }
  });

  test("is wanted only when the public listener is not loopback", () => {
    expect(localControlSocketWanted({ hostname: "0.0.0.0" })).toBe(unixSupported);
    expect(localControlSocketWanted({ hostname: "10.0.0.5" })).toBe(unixSupported);
    for (const hostname of ["127.0.0.1", "localhost", "::1", undefined]) {
      expect(localControlSocketWanted({ hostname } as Pick<OcxConfig, "hostname">)).toBe(false);
    }
  });
});

describe.skipIf(!unixSupported)("hub with a non-loopback public listener (#8184)", () => {
  test("refuses the admin token on every TCP listener and admits it on the private socket", async () => {
    const { server, managementPort, publicPort } = await startHub();
    try {
      const socket = localControlSocketPath(publicPort);
      // The boundary from #6913 is unchanged: TCP ingress, including the relayed management
      // listener, never confers trusted loopback, whatever the request claims about itself.
      const forged = {
        "x-opencodex-api-key": ADMIN,
        Host: "localhost",
        "X-Forwarded-For": "127.0.0.1",
        Forwarded: "for=127.0.0.1",
        "x-opencodex-ingress": "local-control",
      };
      for (const port of [managementPort, publicPort]) {
        const response = await fetch(`http://127.0.0.1:${port}${STATUS}`, { headers: forged });
        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden");
      }

      const admitted = await overSocket(socket, STATUS, { headers: { "x-opencodex-api-key": ADMIN } });
      expect(admitted.status).toBe(200);
      expect(Object.keys((await admitted.json()) as Record<string, unknown>)).toEqual(expect.arrayContaining(["role", "listener", "links"]));

      // The socket confers ingress trust, not a credential.
      expect((await overSocket(socket, STATUS)).status).toBe(401);
      expect((await overSocket(socket, STATUS, { headers: { "x-opencodex-api-key": "wrong" } })).status).toBe(401);
      for (const [method, path] of [["GET", "/api/config"], ["GET", "/api/link/candidates"], ["POST", "/api/link/issue"], ["GET", "/healthz"], ["POST", "/v1/responses"], ["GET", "/"]] as const) {
        const refused = await overSocket(socket, path, { method, headers: { "x-opencodex-api-key": ADMIN } });
        expect(refused.status).toBe(404);
      }
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("the socket sits in a private directory and is removed on shutdown", async () => {
    // A pre-existing directory with loose permissions is tightened before the socket binds.
    mkdirSync(localControlSocketDir(), { recursive: true });
    chmodSync(localControlSocketDir(), 0o755);
    const { server, publicPort } = await startHub();
    const socket = localControlSocketPath(publicPort);
    try {
      expect(lstatSync(localControlSocketDir()).mode & 0o777).toBe(0o700);
      const stat = lstatSync(socket);
      expect(stat.isSocket()).toBe(true);
      expect(stat.mode & 0o077).toBe(0);
      expect(usableLocalControlSocket(publicPort)).toBe(socket);
      // A client refuses a socket whose directory another user could reach.
      chmodSync(localControlSocketDir(), 0o755);
      expect(usableLocalControlSocket(publicPort)).toBeNull();
      chmodSync(localControlSocketDir(), 0o700);
    } finally {
      await server.stop(true);
    }
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(localControlLeasePath(publicPort))).toBe(false);
  }, SERVER_BUDGET_MS);

  test("a path that is not a stale socket is left alone and no socket is served", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    mkdirSync(localControlSocketDir(), { recursive: true, mode: 0o700 });
    writeFileSync(localControlSocketPath(publicPort), "not a socket");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const server = startServer(publicPort);
    try {
      expect(lstatSync(localControlSocketPath(publicPort)).isFile()).toBe(true);
      expect(usableLocalControlSocket(publicPort)).toBeNull();
    } finally {
      await server.stop(true);
    }
    expect(lstatSync(localControlSocketPath(publicPort)).isFile()).toBe(true);
    // The refused start must not leave its ownership record behind for the next runtime.
    expect(existsSync(localControlLeasePath(publicPort))).toBe(false);
  }, SERVER_BUDGET_MS);

  test("a loopback public listener serves no socket", async () => {
    const { server, publicPort } = await startHub("127.0.0.1");
    try {
      expect(existsSync(localControlSocketPath(publicPort))).toBe(false);
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("ocx link status reads the hub through the socket", async () => {
    const { server, publicPort } = await startHub();
    try {
      const deps = {
        findLiveProxy: async () => ({ pid: process.pid, port: publicPort, hostname: "0.0.0.0", source: "runtime" as const, role: "hub" }),
        readAdminToken: () => ADMIN,
      };
      const viaSocket = await runQuietly(["status", "--json"], deps);
      expect(viaSocket.err).toBe("");
      expect(viaSocket.code).toBe(0);
      expect(Object.keys(JSON.parse(viaSocket.out.at(-1)!))).toEqual(expect.arrayContaining(["role", "listener", "links"]));
      // Without the socket the same command meets the TCP refusal the issue reported.
      const viaTcp = await runQuietly(["status", "--json"], { ...deps, localControlSocket: () => null });
      expect(viaTcp.code).toBe(1);
      expect(viaTcp.err).toContain("Link management request failed (403)");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);
});

describe.skipIf(!unixSupported)("local control socket ownership (#8184)", () => {
  const dispatchFor = (owner: string) => async () => Response.json({ owner });

  test("a live incumbent keeps its socket when a second runtime starts on the same port", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const first = createLocalControlListener();
    const second = createLocalControlListener();
    first.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("first") });
    try {
      const socket = localControlSocketPath(publicPort);
      expect(first.socketPath()).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "first" });

      second.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("second") });

      // The incumbent is live, so the second runtime must not take the address or the lease.
      expect(second.socketPath()).toBeNull();
      expect(first.socketPath()).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "first" });
    } finally {
      await second.stop();
      await first.stop();
    }
    expect(existsSync(localControlSocketPath(publicPort))).toBe(false);
    expect(existsSync(localControlLeasePath(publicPort))).toBe(false);
  }, SERVER_BUDGET_MS);

  test("an old runtime's shutdown leaves a successor's socket in place", async () => {
    const { server, publicPort } = await startHub();
    const socket = localControlSocketPath(publicPort);
    let successor: ReturnType<typeof Bun.serve> | null = null;
    try {
      // A successor bound the public address while the old runtime still held its own listener.
      unlinkSync(socket);
      successor = Bun.serve({ unix: socket, fetch: () => new Response("successor") });

      await server.stop(true);

      expect(lstatSync(socket).isSocket()).toBe(true);
      const response = await fetch("http://localhost/", { unix: socket } as RequestInit);
      expect(await response.text()).toBe("successor");
    } finally {
      if (successor) await successor.stop(true);
      if (existsSync(socket)) unlinkSync(socket);
    }
  }, SERVER_BUDGET_MS);

  test("a crashed predecessor's lease and dead socket are replaced", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const socket = localControlSocketPath(publicPort);
    const lease = localControlLeasePath(publicPort);
    mkdirSync(localControlSocketDir(), { recursive: true, mode: 0o700 });
    // A dead socket: bind a private address, publish it, then stop the binder. Bun unlinks only
    // the private name, so the public hard link survives as the crash residue a real crash leaves.
    const deadPrivate = join(localControlSocketDir(), `.c${publicPort}.dead`);
    const dead = Bun.serve({ unix: deadPrivate, fetch: () => new Response("dead") });
    linkSync(deadPrivate, socket);
    await dead.stop(true);
    const deadPid = spawnSync("/bin/sh", ["-c", "exit 0"]).pid!;
    writeFileSync(lease, JSON.stringify({ pid: deadPid, start: "ps:gone", token: `.c${publicPort}.dead` }), { mode: 0o600 });
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));

    const server = startServer(publicPort);
    try {
      expect(usableLocalControlSocket(publicPort)).toBe(socket);
      const response = await overSocket(socket, STATUS, { headers: { "x-opencodex-api-key": ADMIN } });
      expect(response.status).toBe(200);
    } finally {
      await server.stop(true);
    }
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(lease)).toBe(false);
  }, SERVER_BUDGET_MS);
});

describe("ocx link status socket selection", () => {
  test("falls back to TCP only when the socket cannot be reached", async () => {
    const calls: Array<{ url: string; unix?: string }> = [];
    const body = JSON.stringify({ error: { code: "forbidden" } });
    const deps = (socketAnswers: "transport" | "forbidden") => ({
      findLiveProxy: async () => ({ pid: 1, port: 4100, hostname: "0.0.0.0", source: "runtime" as const }),
      readAdminToken: () => ADMIN,
      localControlSocket: () => "/tmp/ocx-test.sock",
      fetchImpl: (async (url: string, init?: RequestInit & { unix?: string }) => {
        calls.push({ url: String(url), ...(init?.unix ? { unix: init.unix } : {}) });
        if (init?.unix && socketAnswers === "transport") throw new Error("ECONNREFUSED");
        return new Response(body, { status: 403, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });
    expect((await runQuietly(["status"], deps("transport"))).err).toContain("(403)");
    expect(calls.map(call => call.unix ?? call.url)).toEqual(["/tmp/ocx-test.sock", `http://127.0.0.1:4100${STATUS}`]);
    calls.length = 0;
    // An answer from the socket is final: a refusal there is not retried over TCP.
    expect((await runQuietly(["status"], deps("forbidden"))).err).toContain("(403)");
    expect(calls).toEqual([{ url: `http://localhost${STATUS}`, unix: "/tmp/ocx-test.sock" }]);
    calls.length = 0;
    // An explicit base URL is honoured as given.
    expect((await runQuietly(["status"], { ...deps("transport"), baseUrl: "http://127.0.0.1:4200" })).err).toContain("(403)");
    expect(calls).toEqual([{ url: `http://127.0.0.1:4200${STATUS}` }]);
  });
});
