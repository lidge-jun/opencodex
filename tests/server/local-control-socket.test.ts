/**
 * #8184: `ocx link status` on a hub whose public listener is not loopback.
 *
 * The hub management listener is the target of Tailscale Serve, so a request on it may have come
 * from anywhere on the tailnet and must never count as trusted loopback (#6913). These cases start
 * real servers and prove three things: the admin token stays refused on every TCP listener, the
 * private Unix socket admits it for the one status read and nothing else, and the socket's access
 * boundary is the filesystem, which no TCP relay or forged header can reach.
 *
 * The ownership cases run real second and third processes. A same-process imitation cannot show
 * what a lease is for: two runtimes in one process share a pid, so only a separate process proves
 * that a live incumbent keeps its socket and that a killed one is replaced.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import { runLinkCommand } from "../../src/cli/link";
import { ownEvidence, ownerDefaults } from "../../src/codex/prompt-lock-owner";
import { ownerState } from "../../src/codex/prompt-lock-owner";
import { removeOwnedConfigState } from "../../src/lib/config-ownership";
import {
  LOCAL_CONTROL_SOCKET_PATH_MAX,
  localControlLeasePath,
  localControlPrivateSocketPath,
  localControlSocketDir,
  localControlSocketPath,
  localControlSocketPathFits,
  usableLocalControlSocket,
} from "../../src/lib/local-control-socket";
import {
  createLocalControlListener,
  LocalControlReleaseError,
  localControlRouteAllowed,
  localControlSocketWanted,
} from "../../src/server/index/local-control-listener";
import { createOptionalListenerSet } from "../../src/server/index/optional-listeners";
import { AuxiliaryListenerBindError, findAvailablePort, isAddrInUse } from "../../src/server/ports";
import type { OcxConfig } from "../../src/types";
import { repoPath } from "../helpers/repo-root";
import { SPAWN_BUDGET_MS, SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const previousApiToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
const previousHome = process.env.OPENCODEX_HOME;
const ADMIN = "admin-secret";
const STATUS = "/api/link/status?compatibility=1&diagnostics=1&children=1";
const unixSupported = process.platform !== "win32";
/**
 * sun_path is 103 bytes, and os.tmpdir() on macOS is /var/folders/..., which pushes
 * <home>/run/control-65535.sock past it. The socket cases therefore pin a short root on macOS
 * and use the platform temp directory elsewhere, which on Windows is where C:\tmp does not
 * exist. The long-path case below exercises the default shape on purpose instead of skipping it.
 */
const SOCKET_ROOT = process.platform === "darwin" ? "/tmp" : tmpdir();
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
  return fetch("http://localhost" + path, { ...init, unix: socket } as RequestInit);
}

/**
 * A lease record this host wrote for a pid that is gone. The production helper decides that, not
 * the fixture: a reused pid reads as live, and the test must say so instead of asserting against
 * a state the code never produces.
 */
function writeCrashedLease(path: string): void {
  const deadPid = spawnSync("/bin/sh", ["-c", "exit 0"]).pid!;
  const record = { ...ownEvidence(ownerDefaults), pid: deadPid, token: "0123456789abcdef" };
  expect(ownerState(record, ownerDefaults)).toBe("dead");
  writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
}

/**
 * The child runtime for the ownership cases. It reports that it reached the barrier, waits for the
 * parent to release it, then starts a listener and records what it got. A loser exits; a winner
 * stays alive because its Bun server holds the event loop open.
 */
const CHILD_SCRIPT = [
  "(async () => {",
  "  const fs = await import('node:fs');",
  "  const { createLocalControlListener } = await import(process.env.OCX_CHILD_MODULE);",
  "  fs.writeFileSync(process.env.OCX_CHILD_READY, 'ready');",
  "  while (!fs.existsSync(process.env.OCX_CHILD_BARRIER)) await Bun.sleep(2);",
  "  const listener = createLocalControlListener();",
  "  listener.start({",
  "    config: { hostname: '0.0.0.0' },",
  "    publicPort: Number(process.env.OCX_CHILD_PORT),",
  "    dispatch: async () => Response.json({ owner: process.env.OCX_CHILD_OWNER }),",
  "  });",
  "  fs.writeFileSync(process.env.OCX_CHILD_RESULT, JSON.stringify({",
  "    pid: process.pid, owner: process.env.OCX_CHILD_OWNER, socketPath: listener.socketPath(),",
  "  }));",
  "  if (!listener.socketPath()) process.exit(0);",
  "})().catch(error => { process.stderr.write(String((error && error.stack) || error)); process.exit(1); });",
].join("\n");

interface ChildReport { pid: number; owner: string; socketPath: string | null }

async function waitForFile(path: string, label: string, timeoutMs = SPAWN_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for " + label);
}

function childEnv(tag: string, publicPort: number, owner: string, barrier: string) {
  return {
    ...process.env,
    OCX_CHILD_MODULE: repoPath("src/server/index/local-control-listener.ts"),
    OCX_CHILD_PORT: String(publicPort),
    OCX_CHILD_OWNER: owner,
    OCX_CHILD_READY: join(testDir, tag + ".ready"),
    OCX_CHILD_BARRIER: barrier,
    OCX_CHILD_RESULT: join(testDir, tag + ".json"),
  };
}

function spawnChild(tag: string, publicPort: number, owner: string, barrier: string) {
  return Bun.spawn([process.execPath, "-e", CHILD_SCRIPT], {
    env: childEnv(tag, publicPort, owner, barrier),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
}

interface Child { tag: string; owner: string; process: ReturnType<typeof Bun.spawn> }

/**
 * A real second process sitting inside the per-port claim mutex. A same-process holder would
 * prove nothing here: the release retries synchronously, so only a separate process can keep the
 * mutex occupied while that budget runs out.
 */
const CLAIM_HOLDER_SCRIPT = [
  "(async () => {",
  "  const fs = await import('node:fs');",
  "  const { withLockClaim } = await import(process.env.OCX_CHILD_CLAIM_MODULE);",
  "  const { ownerDefaults } = await import(process.env.OCX_CHILD_OWNER_MODULE);",
  "  withLockClaim(process.env.OCX_CHILD_LEASE, 'deadbeefdeadbeef', ownerDefaults, () => {",
  "    fs.writeFileSync(process.env.OCX_CHILD_HELD, 'held');",
  "    while (!fs.existsSync(process.env.OCX_CHILD_RELEASE)) Bun.sleepSync(2);",
  "  });",
  "  process.exit(0);",
  "})().catch(error => { process.stderr.write(String((error && error.stack) || error)); process.exit(1); });",
].join("\n");

function holdClaim(leasePath: string) {
  const tag = "claim-" + randomBytes(4).toString("hex");
  const held = join(testDir, tag + ".held");
  const release = join(testDir, tag + ".release");
  const child = Bun.spawn([process.execPath, "-e", CLAIM_HOLDER_SCRIPT], {
    env: {
      ...process.env,
      OCX_CHILD_CLAIM_MODULE: repoPath("src/codex/prompt-lock-claim.ts"),
      OCX_CHILD_OWNER_MODULE: repoPath("src/codex/prompt-lock-owner.ts"),
      OCX_CHILD_LEASE: leasePath,
      OCX_CHILD_HELD: held,
      OCX_CHILD_RELEASE: release,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  return {
    held,
    stop: async () => { writeFileSync(release, "go"); await child.exited; },
  };
}

async function stopChildren(children: Child[]): Promise<void> {
  for (const child of children) child.process.kill("SIGKILL");
  await Promise.all(children.map(child => child.process.exited));
}

/**
 * Release every child at the same instant, then read what each one decided. The winner stays alive
 * to serve the socket, so the caller owns the teardown and must stop the children after asserting.
 */
async function raceListeners(publicPort: number, owners: string[], barrierTag: string): Promise<{ reports: ChildReport[]; children: Child[] }> {
  const barrier = join(testDir, barrierTag);
  const children = owners.map((owner, index) => {
    const tag = barrierTag + "-" + index;
    return { owner, tag, process: spawnChild(tag, publicPort, owner, barrier) };
  });
  try {
    for (const child of children) await waitForFile(join(testDir, child.tag + ".ready"), "child " + child.owner + " at the barrier");
    writeFileSync(barrier, "go");
    for (const child of children) await waitForFile(join(testDir, child.tag + ".json"), "child " + child.owner + " result");
    return { reports: children.map(child => JSON.parse(readFileSync(join(testDir, child.tag + ".json"), "utf8")) as ChildReport), children };
  } catch (error) {
    await stopChildren(children);
    throw error;
  }
}

beforeEach(() => {
  testDir = mkdtempSync(join(SOCKET_ROOT, "ocx-lc-"));
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
      localControlRouteAllowed(new URL("http://localhost" + path), new Request("http://localhost" + path, { method, headers }));
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

describe("local control socket path bound", () => {
  test("counts bytes, not UTF-16 code units", () => {
    const ascii = "/" + "a".repeat(LOCAL_CONTROL_SOCKET_PATH_MAX - 1);
    expect(localControlSocketPathFits(ascii)).toBe(true);
    expect(localControlSocketPathFits(ascii + "a")).toBe(false);
    // 60 Hangul syllables are 60 code units and 180 bytes: a length check would admit them.
    const wide = "/" + "\uAC00".repeat(60);
    expect(wide.length).toBe(61);
    expect(localControlSocketPathFits(wide)).toBe(false);
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
        const response = await fetch("http://127.0.0.1:" + port + STATUS, { headers: forged });
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

  test("a home whose socket path exceeds sun_path is refused without leaving a lease", async () => {
    // The default TMPDIR on macOS is long enough to exceed the bound; this is that shape.
    const longHome = join(testDir, "h".repeat(90));
    mkdirSync(longHome, { recursive: true, mode: 0o700 });
    process.env.OPENCODEX_HOME = longHome;
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const socket = localControlSocketPath(publicPort);
    expect(localControlSocketPathFits(socket)).toBe(false);
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const server = startServer(publicPort);
    try {
      expect(existsSync(socket)).toBe(false);
      expect(existsSync(localControlLeasePath(publicPort))).toBe(false);
      expect(usableLocalControlSocket(publicPort)).toBeNull();
    } finally {
      await server.stop(true);
    }
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

  test("the run directory is registered so uninstall removes it", async () => {
    const { server } = await startHub();
    const runDir = localControlSocketDir();
    try {
      expect(lstatSync(runDir).isDirectory()).toBe(true);
      const manifest = JSON.parse(readFileSync(join(testDir, ".opencodex-uninstall.json"), "utf8")) as { paths: string[] };
      expect(manifest.paths).toContain("run");
    } finally {
      await server.stop(true);
    }
    const result = removeOwnedConfigState(testDir);
    // Other recorded state can be left behind by this fixture; the socket directory must not be.
    expect(result.residualPaths).not.toContain(runDir);
    expect(existsSync(runDir)).toBe(false);
  }, SERVER_BUDGET_MS);
});

describe.skipIf(!unixSupported)("local control socket ownership (#8184)", () => {
  const dispatchFor = (owner: string) => async () => Response.json({ owner });

  test("a live incumbent keeps its socket when a second runtime starts on the same port", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
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

  test("each instance gets its own private socket name and lease token", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    // Sockets only: the lease and its claim directory share the prefix.
    const privateNames = () => readdirSync(localControlSocketDir())
      .filter(name => name.startsWith(".c" + publicPort + "."))
      .filter(name => lstatSync(join(localControlSocketDir(), name)).isSocket())
      .sort();
    const first = createLocalControlListener();
    first.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("first") });
    const firstToken = (JSON.parse(readFileSync(localControlLeasePath(publicPort), "utf8")) as { token: string }).token;
    expect(privateNames()).toEqual([basename(localControlPrivateSocketPath(publicPort, firstToken))]);
    first.abort();

    const second = createLocalControlListener();
    second.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("second") });
    try {
      const secondToken = (JSON.parse(readFileSync(localControlLeasePath(publicPort), "utf8")) as { token: string }).token;
      // A same-pid restart must not reuse the name or the record it is replacing.
      expect(secondToken).not.toBe(firstToken);
      expect(privateNames()).toEqual([basename(localControlPrivateSocketPath(publicPort, secondToken))]);
      expect(await (await overSocket(localControlSocketPath(publicPort), STATUS)).json()).toEqual({ owner: "second" });
    } finally {
      await second.stop();
    }
  }, SERVER_BUDGET_MS);

  test("a successor that starts during a stop takes the socket over", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const first = createLocalControlListener();
    first.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("first") });
    const socket = localControlSocketPath(publicPort);
    expect(first.socketPath()).toBe(socket);

    // The departing runtime has to give the record up before it suspends on its own teardown.
    // Otherwise the successor reads a live lease, refuses, and the port is served by nobody.
    const stopping = first.stop();
    const second = createLocalControlListener();
    second.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("second") });
    try {
      expect(second.socketPath()).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "second" });
    } finally {
      await stopping;
      await second.stop();
    }
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(localControlLeasePath(publicPort))).toBe(false);
  }, SERVER_BUDGET_MS);

  test("a successor that starts while the optional listeners shut down keeps the socket", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const listeners = createOptionalListenerSet();
    listeners.start({ config: hubConfig(0), publicPort, maxRequestBodySize: 0, dispatch: dispatchFor("first") });
    const socket = localControlSocketPath(publicPort);
    expect(existsSync(socket)).toBe(true);
    // A supervisor stop over SSH is the slow one in production. The record must already be gone
    // by the time it runs, or the successor sees a live owner on a port nobody will serve.
    listeners.registerSupervisorStop(() => Bun.sleep(700));

    const stopping = listeners.stop();
    const barrier = join(testDir, "barrier-handoff");
    writeFileSync(barrier, "go");
    let child: ReturnType<typeof spawnChild> | null = null;
    try {
      // The public listener is already closed by now and the runtime record is gone, which is
      // exactly the window an independent `ocx start` occupies.
      await Bun.sleep(100);
      child = spawnChild("handoff", publicPort, "successor", barrier);
      await waitForFile(join(testDir, "handoff.json"), "the successor runtime");
      const report = JSON.parse(readFileSync(join(testDir, "handoff.json"), "utf8")) as ChildReport;
      expect(report.socketPath).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "successor" });

      await stopping;

      // The predecessor finishing must not take the successor's socket with it.
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "successor" });
      expect(existsSync(localControlLeasePath(publicPort))).toBe(true);
    } finally {
      if (child) { child.kill("SIGKILL"); await child.exited; }
      await stopping.catch(() => {});
    }
  }, SPAWN_BUDGET_MS);

  test("a release the claim mutex blocks is reported and retried, not discarded", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const listener = createLocalControlListener();
    listener.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("owner") });
    const socket = localControlSocketPath(publicPort);
    const lease = localControlLeasePath(publicPort);
    const peer = holdClaim(lease);
    try {
      await waitForFile(peer.held, "the peer claim");
      // The peer holds the mutex, so the release cannot run. stop() must say so and keep the
      // record: clearing the fields first is what used to strand a live lease with no retry.
      await expect(listener.stop()).rejects.toBeInstanceOf(LocalControlReleaseError);
      expect(existsSync(lease)).toBe(true);
      expect(existsSync(socket)).toBe(true);
    } finally {
      await peer.stop();
    }
    // The retained record makes the next stop finish the job.
    await listener.stop();
    expect(existsSync(lease)).toBe(false);
    expect(existsSync(socket)).toBe(false);
  }, SPAWN_BUDGET_MS);

  test("an exhausted release keeps the port owned and refuses a second start until it recovers", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const listener = createLocalControlListener();
    listener.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("owner") });
    const socket = localControlSocketPath(publicPort);
    const lease = localControlLeasePath(publicPort);
    const peer = holdClaim(lease);
    try {
      await waitForFile(peer.held, "the peer claim");
      await expect(listener.stop()).rejects.toBeInstanceOf(LocalControlReleaseError);
      // The record still names this live pid, so a second listener in this process refuses
      // rather than publishing over it. That refusal is the observable half of retained state.
      const second = createLocalControlListener();
      second.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("second") });
      expect(second.socketPath()).toBeNull();
      await second.stop();
      expect(existsSync(lease)).toBe(true);
    } finally {
      await peer.stop();
    }
    // With the peer gone the owner's retry releases the record and the port is usable again.
    await listener.stop();
    expect(existsSync(lease)).toBe(false);
    const third = createLocalControlListener();
    third.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("third") });
    try {
      expect(third.socketPath()).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "third" });
    } finally {
      await third.stop();
    }
  }, SPAWN_BUDGET_MS);

  test("an abort that cannot take the claim keeps the record for the next stop", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const listener = createLocalControlListener();
    listener.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("owner") });
    const socket = localControlSocketPath(publicPort);
    const lease = localControlLeasePath(publicPort);
    const peer = holdClaim(lease);
    try {
      await waitForFile(peer.held, "the peer claim");
      // abort() runs inside startServer's catch: it must not throw over the startup error, and
      // it must not pretend the record is gone either.
      expect(() => listener.abort()).not.toThrow();
      expect(existsSync(lease)).toBe(true);
    } finally {
      await peer.stop();
    }
    await listener.stop();
    expect(existsSync(lease)).toBe(false);
    expect(existsSync(socket)).toBe(false);
  }, SPAWN_BUDGET_MS);

  test("a startup that fails after the socket started releases its lease", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const listeners = createOptionalListenerSet();
    const socket = localControlSocketPath(publicPort);
    try {
      listeners.start({ config: hubConfig(0), publicPort, maxRequestBodySize: 0, dispatch: dispatchFor("failed") });
      expect(existsSync(socket)).toBe(true);
      expect(existsSync(localControlLeasePath(publicPort))).toBe(true);
      // What startServer's catch does when a later optional listener throws.
      listeners.abortStart();
      expect(existsSync(socket)).toBe(false);
      expect(existsSync(localControlLeasePath(publicPort))).toBe(false);
    } finally {
      await listeners.stop();
    }
    // A lease nobody serves would keep the next runtime off the port; it must be gone.
    const successor = createLocalControlListener();
    successor.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("successor") });
    try {
      expect(successor.socketPath()).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "successor" });
    } finally {
      await successor.stop();
    }
  }, SERVER_BUDGET_MS);

  test("a crashed predecessor's lease and dead socket are replaced", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const socket = localControlSocketPath(publicPort);
    const lease = localControlLeasePath(publicPort);
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    mkdirSync(localControlSocketDir(), { recursive: true, mode: 0o700 });
    // A dead socket: bind a private address, publish it, then stop the binder. Bun unlinks only
    // the private name, so the public hard link survives as the crash residue a real crash leaves.
    const deadPrivate = join(localControlSocketDir(), ".c" + publicPort + ".dead");
    const dead = Bun.serve({ unix: deadPrivate, fetch: () => new Response("dead") });
    linkSync(deadPrivate, socket);
    await dead.stop(true);
    // The record this host would have written, for a pid that is gone.
    writeCrashedLease(lease);

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

  test("concurrent runtimes racing for a free port produce exactly one owner", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const race = await raceListeners(publicPort, ["a", "b", "c", "d"], "barrier-live");
    try {
      const winners = race.reports.filter(report => report.socketPath !== null);
      expect(winners).toHaveLength(1);
      const socket = localControlSocketPath(publicPort);
      expect(winners[0]!.socketPath).toBe(socket);
      // The public socket is the winner's: it names that runtime, not a loser that also published.
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: winners[0]!.owner });
      const lease = JSON.parse(readFileSync(localControlLeasePath(publicPort), "utf8")) as { pid: number };
      expect(lease.pid).toBe(winners[0]!.pid);
    } finally {
      await stopChildren(race.children);
    }
  }, SPAWN_BUDGET_MS);

  test("concurrent runtimes recovering one crashed lease still produce one owner", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    mkdirSync(localControlSocketDir(), { recursive: true, mode: 0o700 });
    const deadPrivate = join(localControlSocketDir(), ".c" + publicPort + ".dead");
    const dead = Bun.serve({ unix: deadPrivate, fetch: () => new Response("dead") });
    linkSync(deadPrivate, localControlSocketPath(publicPort));
    await dead.stop(true);
    writeCrashedLease(localControlLeasePath(publicPort));

    const race = await raceListeners(publicPort, ["a", "b", "c", "d"], "barrier-stale");
    try {
      const winners = race.reports.filter(report => report.socketPath !== null);
      expect(winners).toHaveLength(1);
      const socket = localControlSocketPath(publicPort);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: winners[0]!.owner });
      // The record names the winner now: the dead predecessor is gone and no loser overwrote it.
      const lease = JSON.parse(readFileSync(localControlLeasePath(publicPort), "utf8")) as { pid: number };
      expect(lease.pid).toBe(winners[0]!.pid);
    } finally {
      await stopChildren(race.children);
    }
  }, SPAWN_BUDGET_MS);

  test("a runtime takes over a socket whose owner was SIGKILLed and reaped", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    saveConfig(hubConfig(await findAvailablePort(0, "127.0.0.1")));
    const barrier = join(testDir, "barrier-sigkill");
    writeFileSync(barrier, "go");
    const child = spawnChild("sigkill", publicPort, "killed", barrier);
    try {
      await waitForFile(join(testDir, "sigkill.json"), "the child runtime");
      const report = JSON.parse(readFileSync(join(testDir, "sigkill.json"), "utf8")) as ChildReport;
      const socket = localControlSocketPath(publicPort);
      expect(report.socketPath).toBe(socket);
      expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "killed" });

      child.kill("SIGKILL");
      await child.exited;

      const successor = createLocalControlListener();
      successor.start({ config: hubConfig(0), publicPort, dispatch: dispatchFor("successor") });
      try {
        expect(successor.socketPath()).toBe(socket);
        expect(await (await overSocket(socket, STATUS)).json()).toEqual({ owner: "successor" });
      } finally {
        await successor.stop();
      }
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  }, SPAWN_BUDGET_MS);
});

describe("ocx link status socket selection", () => {
  const unavailable = () => new Response(JSON.stringify({ error: "management API unavailable" }), { status: 503, headers: { "content-type": "application/json" } });

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
    expect(calls.map(call => call.unix ?? call.url)).toEqual(["/tmp/ocx-test.sock", "http://127.0.0.1:4100" + STATUS]);
    calls.length = 0;
    // An answer from the socket is final: a refusal there is not retried over TCP.
    expect((await runQuietly(["status"], deps("forbidden"))).err).toContain("(403)");
    expect(calls).toEqual([{ url: "http://localhost" + STATUS, unix: "/tmp/ocx-test.sock" }]);
    calls.length = 0;
    // An explicit base URL is honoured as given.
    expect((await runQuietly(["status"], { ...deps("transport"), baseUrl: "http://127.0.0.1:4200" })).err).toContain("(403)");
    expect(calls).toEqual([{ url: "http://127.0.0.1:4200" + STATUS }]);
  });

  test("a 503 from the socket is not replaced by the TCP listener's 403", async () => {
    // The runtime answered, and its answer is authoritative. A body that carries no error code
    // (a string error, an empty body, or a non-JSON body) used to read as a transport failure and
    // silently downgrade the real 503 into the TCP listener's 403.
    const answers = [
      unavailable(),
      new Response("", { status: 503 }),
      new Response("gateway down", { status: 503, headers: { "content-type": "text/plain" } }),
    ];
    for (const answer of answers) {
      const calls: Array<{ url: string; unix?: string }> = [];
      const deps = {
        findLiveProxy: async () => ({ pid: 1, port: 4100, hostname: "0.0.0.0", source: "runtime" as const }),
        readAdminToken: () => ADMIN,
        localControlSocket: () => "/tmp/ocx-test.sock",
        fetchImpl: (async (url: string, init?: RequestInit & { unix?: string }) => {
          calls.push({ url: String(url), ...(init?.unix ? { unix: init.unix } : {}) });
          if (!init?.unix) return new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403, headers: { "content-type": "application/json" } });
          return answer.clone();
        }) as unknown as typeof fetch,
      };
      const run = await runQuietly(["status"], deps);
      expect(run.code).toBe(1);
      expect(run.err).toContain("(503)");
      expect(run.err).not.toContain("(403)");
      // No second request: the socket answered, so TCP was never tried.
      expect(calls).toEqual([{ url: "http://localhost" + STATUS, unix: "/tmp/ocx-test.sock" }]);
      // The sanitized error carries no body, so a one-time key or a runtime message is not echoed.
      expect(run.err).not.toContain("management API unavailable");
      expect(run.err).not.toContain("gateway down");
    }
  });
});
