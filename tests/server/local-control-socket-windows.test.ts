/**
 * #8998: the #8184 local control socket on Windows.
 *
 * Windows has AF_UNIX sockets, but lstat refuses an AF_UNIX file with EACCES, so neither its type
 * nor its owner can be read and the POSIX identity checks in tests/server/local-control-socket.test.ts
 * do not apply. These cases start real hubs on Windows and prove the same contract: the admin
 * token stays refused on TCP, the socket admits it for the one status read, the files go away on
 * stop, a crashed predecessor's names are replaced, and the client sends the token only when the
 * run directory and the whole path to it are trusted.
 *
 * The test root has to have trusted ancestry itself, which a shared temp directory may not have
 * (the test preload also moves tmpdir() and homedir() into a sandbox under it): this file picks the
 * first of OCX_TEST_WINDOWS_SOCKET_ROOT, tmpdir() and homedir() that passes, and skips the hub cases
 * with a printed reason when none does rather than weakening the check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer, waitForFailedStartRollback } from "../../src/server";
import { runLinkCommand } from "../../src/cli/link";
import { ownEvidence, ownerDefaults, ownerState } from "../../src/codex/prompt-lock-owner";
import {
  isLocalControlPrivateSocketName,
  localControlLeasePath,
  localControlPrivateSocketPath,
  localControlSocketDir,
  localControlSocketPath,
  removeWindowsPrivateSocket,
  usableLocalControlSocket,
  windowsSocketEntryState,
  windowsTrustedPath,
  type WindowsSocketEntryState,
} from "../../src/lib/local-control-socket";
import { createLocalControlListener, LocalControlReleaseError } from "../../src/server/index/local-control-listener";
import { AuxiliaryListenerBindError, findAvailablePort, isAddrInUse } from "../../src/server/ports";
import type { OcxConfig } from "../../src/types";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const windows = process.platform === "win32";
const ADMIN = "admin-secret";
const STATUS = "/api/link/status?children=1";
const previous = {
  api: process.env.OPENCODEX_API_AUTH_TOKEN,
  admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
  home: process.env.OPENCODEX_HOME,
};

/** A root whose own path a Windows runtime would trust, or null. */
function trustedRoot(): string | null {
  if (!windows) return null;
  const override = process.env.OCX_TEST_WINDOWS_SOCKET_ROOT?.trim();
  for (const base of [...(override ? [override] : []), tmpdir(), homedir()]) {
    mkdirSync(base, { recursive: true });
    const probe = mkdtempSync(join(base, "ocx-lcw-"));
    try {
      mkdirSync(join(probe, "home", "run"), { recursive: true });
      if (windowsTrustedPath(join(probe, "home", "run"), false)) return base;
    } finally {
      removeTreeWithRetry(probe);
    }
  }
  return null;
}
const ROOT = trustedRoot();
if (windows && ROOT === null) {
  console.warn("[local-control-socket-windows] no candidate root has trusted ancestry; set OCX_TEST_WINDOWS_SOCKET_ROOT to a private directory to run the hub cases");
}
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

async function startHub(publicPort = 0) {
  for (let draw = 1; ; draw += 1) {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    saveConfig(hubConfig(managementPort));
    try {
      const server = startServer(publicPort);
      return { server, managementPort, publicPort: server.port! };
    } catch (error) {
      await waitForFailedStartRollback(error);
      if (!(error instanceof AuxiliaryListenerBindError && isAddrInUse(error.cause)) || draw >= 3) throw error;
    }
  }
}

function overSocket(socket: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch("http://localhost" + path, { ...init, unix: socket } as RequestInit);
}

/** What the run directory lists for this port: the public name, private names and the lease. */
function portEntries(port: number): string[] {
  try {
    return readdirSync(localControlSocketDir()).filter(name => name === "control-" + port + ".sock" || name.startsWith(".c" + port + "."))
      .filter(name => !name.endsWith(".lock") && !name.endsWith(".tmp")).sort();
  } catch {
    return [];
  }
}

/** Give Everyone modify rights on a directory, as a careless installer or a shared parent would. */
function loosen(dir: string): void {
  const result = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [dir, "/grant", "*S-1-1-0:(OI)(CI)M"], { encoding: "utf8" });
  expect(result.status).toBe(0);
}

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

function cliDeps(publicPort: number) {
  return {
    findLiveProxy: async () => ({ pid: process.pid, port: publicPort, hostname: "0.0.0.0", source: "runtime" as const, role: "hub" }),
    readAdminToken: () => ADMIN,
  };
}

describe("private socket names", () => {
  test.each([
    [".c10100.abcdef12", true], [".c10100.0123abcd", true],
    [".c10100.lease", false], [".c10100.lease.lock", false], [".c10100.abcdef1", false], [".c10100.abcdef123", false],
    [".c10100.ABCDEF12", false], [".c101000.abcdef12", false], [".c1010.abcdef12", false], ["control-10100.sock", false],
    [".c010100.abcdef12", false], ["x.c10100.abcdef12", false],
  ] as const)("%s for port 10100 is %p", (name, expected) => {
    expect(isLocalControlPrivateSocketName(10100, name)).toBe(expected);
  });
});

describe("removing a published socket name keeps the lease unless the name is proven gone", () => {
  function remove(states: WindowsSocketEntryState[], unlinkFails = false) {
    const unlinked: string[] = [];
    const observe = () => states.shift() ?? "unknown";
    const unlink = (path: string) => { if (unlinkFails) throw new Error("EBUSY"); unlinked.push(path); };
    let error: unknown = null;
    try { removeWindowsPrivateSocket("C:\\run\\.c10100.abcdef12", observe, unlink); } catch (caught) { error = caught; }
    return { unlinked, error };
  }

  test("an absent name or a readable non-socket is left alone and does not block the release", () => {
    for (const state of ["absent", "other"] as const) expect(remove([state])).toEqual({ unlinked: [], error: null });
  });

  test("a socket is unlinked and must then read absent", () => {
    expect(remove(["socket", "absent"])).toEqual({ unlinked: ["C:\\run\\.c10100.abcdef12"], error: null });
    expect(remove(["socket", "socket"]).error).toBeInstanceOf(Error);
    expect(remove(["socket", "unknown"]).error).toBeInstanceOf(Error);
  });

  test("an unverifiable entry or a failed unlink throws, so the caller keeps its lease", () => {
    const unknown = remove(["unknown"]);
    expect(unknown.unlinked).toEqual([]);
    expect(unknown.error).toBeInstanceOf(Error);
    expect(remove(["socket"], true).error).toBeInstanceOf(Error);
  });
});

describe.skipIf(!windows || ROOT === null)("Windows hub with a non-loopback public listener (#8998)", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(ROOT!, "ocx-lcw-"));
    process.env.OPENCODEX_HOME = join(testDir, "home");
    mkdirSync(process.env.OPENCODEX_HOME, { recursive: true });
    process.env.OPENCODEX_API_AUTH_TOKEN = "public-secret";
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
  });

  afterEach(() => {
    for (const [key, value] of [["OPENCODEX_API_AUTH_TOKEN", previous.api], ["OPENCODEX_ADMIN_AUTH_TOKEN", previous.admin], ["OPENCODEX_HOME", previous.home]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (testDir) removeTreeWithRetry(testDir);
    testDir = "";
  });

  test("refuses the admin token on TCP, admits it on the socket, and removes every file on stop", async () => {
    const { server, managementPort, publicPort } = await startHub();
    const socket = localControlSocketPath(publicPort);
    try {
      for (const port of [managementPort, publicPort]) {
        const response = await fetch("http://127.0.0.1:" + port + STATUS, { headers: { "x-opencodex-api-key": ADMIN } });
        expect(response.status).toBe(403);
      }
      const admitted = await overSocket(socket, STATUS, { headers: { "x-opencodex-api-key": ADMIN } });
      expect(admitted.status).toBe(200);
      expect(Object.keys((await admitted.json()) as Record<string, unknown>)).toEqual(expect.arrayContaining(["role", "listener", "links"]));
      expect((await overSocket(socket, STATUS)).status).toBe(401);
      for (const [method, path] of [["GET", "/api/config"], ["POST", "/api/link/issue"], ["GET", "/healthz"]] as const) {
        expect((await overSocket(socket, path, { method, headers: { "x-opencodex-api-key": ADMIN } })).status).toBe(404);
      }
      expect(usableLocalControlSocket(publicPort)).toBe(socket);
      expect(portEntries(publicPort).filter(name => isLocalControlPrivateSocketName(publicPort, name))).toHaveLength(1);
    } finally {
      await server.stop(true);
    }
    expect(portEntries(publicPort)).toEqual([]);
    expect(usableLocalControlSocket(publicPort)).toBeNull();
  }, SERVER_BUDGET_MS);

  test("ocx link status reads the hub through the socket instead of meeting the 403", async () => {
    const { server, publicPort } = await startHub();
    try {
      const viaSocket = await runQuietly(["status", "--json"], cliDeps(publicPort));
      expect(viaSocket.err).toBe("");
      expect(viaSocket.code).toBe(0);
      expect(Object.keys(JSON.parse(viaSocket.out.at(-1)!))).toEqual(expect.arrayContaining(["role", "listener", "links"]));
      const viaTcp = await runQuietly(["status", "--json"], { ...cliDeps(publicPort), localControlSocket: () => null });
      expect(viaTcp.code).toBe(1);
      expect(viaTcp.err).toContain("Link management request failed (403)");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a crashed predecessor's socket names are replaced; the lease shape and other files are kept", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const dir = localControlSocketDir();
    mkdirSync(dir, { recursive: true });
    // A real AF_UNIX file left by a runtime that was killed: only a completed stop unlinks it.
    const stale = localControlPrivateSocketPath(publicPort, "0123456789abcdef");
    const crashed = Bun.spawn([process.execPath, "-e",
      "Bun.serve({ unix: process.argv[1], fetch: () => new Response('stale') }); require('fs').writeFileSync(process.argv[1] + '-ready', '1'); setInterval(() => {}, 1000);",
      stale], { stdout: "ignore", stderr: "ignore" });
    while (!readdirSync(dir).includes(".c" + publicPort + ".01234567-ready")) await Bun.sleep(10);
    crashed.kill("SIGKILL");
    await crashed.exited;
    unlinkSync(stale + "-ready");
    expect(readdirSync(dir)).toContain(".c" + publicPort + ".01234567");
    linkSync(stale, localControlSocketPath(publicPort));
    const deadPid = spawnSync(process.execPath, ["-e", "0"]).pid!;
    const record = { ...ownEvidence(ownerDefaults), pid: deadPid, token: "0123456789abcdef" };
    expect(ownerState(record, ownerDefaults)).toBe("dead");
    writeFileSync(localControlLeasePath(publicPort), JSON.stringify(record));
    writeFileSync(join(dir, ".c" + publicPort + ".notes"), "keep me");
    const { server } = await startHub(publicPort);
    try {
      const entries = portEntries(publicPort);
      expect(entries).not.toContain(".c" + publicPort + ".01234567");
      expect(entries).toContain(".c" + publicPort + ".notes");
      const lease = JSON.parse(readFileSync(localControlLeasePath(publicPort), "utf8")) as { token: string };
      expect(lease.token).not.toBe("0123456789abcdef");
      expect((await overSocket(localControlSocketPath(publicPort), STATUS, { headers: { "x-opencodex-api-key": ADMIN } })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
    expect(portEntries(publicPort)).toEqual([".c" + publicPort + ".notes"]);
  }, SERVER_BUDGET_MS);

  test("a readable file at the public path is left alone, and the failed attempt leaves no socket and no lease", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    mkdirSync(localControlSocketDir(), { recursive: true });
    writeFileSync(localControlSocketPath(publicPort), "not a socket");
    const { server } = await startHub(publicPort);
    try {
      expect(portEntries(publicPort)).toEqual(["control-" + publicPort + ".sock"]);
      expect(readFileSync(localControlSocketPath(publicPort), "utf8")).toBe("not a socket");
      expect(usableLocalControlSocket(publicPort)).toBeNull();
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a loose pre-existing run directory is refused and left loose, so no client trusts what it holds", async () => {
    mkdirSync(localControlSocketDir(), { recursive: true });
    loosen(localControlSocketDir());
    expect(windowsTrustedPath(localControlSocketDir())).toBe(false);
    const { server, publicPort } = await startHub();
    try {
      expect(windowsTrustedPath(localControlSocketDir())).toBe(false);
      expect(portEntries(publicPort)).toEqual([]);
      expect(usableLocalControlSocket(publicPort)).toBeNull();
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("the client refuses a run directory another account can write, and the CLI keeps TCP", async () => {
    const { server, publicPort } = await startHub();
    try {
      expect(usableLocalControlSocket(publicPort)).toBe(localControlSocketPath(publicPort));
      loosen(localControlSocketDir());
      expect(usableLocalControlSocket(publicPort)).toBeNull();
      const result = await runQuietly(["status", "--json"], cliDeps(publicPort));
      expect(result.code).toBe(1);
      expect(result.err).toContain("Link management request failed (403)");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a config home under a parent other accounts can write gets no socket, from server or client", async () => {
    const shared = join(testDir, "shared");
    mkdirSync(shared);
    loosen(shared);
    process.env.OPENCODEX_HOME = join(shared, "home");
    mkdirSync(process.env.OPENCODEX_HOME);
    const { server, publicPort } = await startHub();
    try {
      expect(portEntries(publicPort)).toEqual([]);
      expect(usableLocalControlSocket(publicPort)).toBeNull();
      const result = await runQuietly(["status", "--json"], cliDeps(publicPort));
      expect(result.code).toBe(1);
      expect(result.err).toContain("Link management request failed (403)");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a loopback public listener serves no socket and spawns no ACL check in the client", async () => {
    const managementPort = await findAvailablePort(0, "127.0.0.1");
    saveConfig(hubConfig(managementPort, "127.0.0.1"));
    const server = startServer(0);
    try {
      expect(portEntries(server.port!)).toEqual([]);
      expect(usableLocalControlSocket(server.port!)).toBeNull();
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("a pre-existing junction at the run directory is refused before any ACL operation follows it", async () => {
    const target = join(testDir, "elsewhere");
    mkdirSync(target);
    loosen(target);
    const made = spawnSync("cmd.exe", ["/c", "mklink", "/J", localControlSocketDir(), target], { encoding: "utf8" });
    expect(made.status).toBe(0);
    const before = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [target], { encoding: "utf8" }).stdout;
    const { server, publicPort } = await startHub();
    try {
      expect(readdirSync(target)).toEqual([]);
      expect(usableLocalControlSocket(publicPort)).toBeNull();
      // Hardening never ran on the junction's target: its loose ACL is exactly as it was.
      expect(spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), [target], { encoding: "utf8" }).stdout).toBe(before);
    } finally {
      await server.stop(true);
      spawnSync("cmd.exe", ["/c", "rmdir", localControlSocketDir()]);
    }
  }, SERVER_BUDGET_MS);

  test("the socket entry observation tells a socket, a readable file, absence and a missing directory apart", async () => {
    const { server, publicPort } = await startHub();
    try {
      expect(windowsSocketEntryState(localControlSocketPath(publicPort))).toBe("socket");
      writeFileSync(join(localControlSocketDir(), "plain"), "x");
      expect(windowsSocketEntryState(join(localControlSocketDir(), "plain"))).toBe("other");
      expect(windowsSocketEntryState(join(localControlSocketDir(), "missing"))).toBe("absent");
      expect(windowsSocketEntryState(join(testDir, "no-such-dir", "x"))).toBe("absent");
    } finally {
      await server.stop(true);
    }
  }, SERVER_BUDGET_MS);

  test("an unreadable ownership record fails the release and keeps it for the next stop", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const listener = createLocalControlListener();
    listener.start({ config: { hostname: "0.0.0.0" } as OcxConfig, publicPort, dispatch: async () => Response.json({ ok: true }) });
    expect(listener.socketPath()).toBe(localControlSocketPath(publicPort));
    const lease = localControlLeasePath(publicPort);
    const record = readFileSync(lease, "utf8");
    writeFileSync(lease, "{not json");
    const failed = await listener.stop().then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(LocalControlReleaseError);
    // Nothing was handed over: the public name is still there for the retained release.
    expect(portEntries(publicPort)).toContain("control-" + publicPort + ".sock");
    writeFileSync(lease, record);
    await listener.stop();
    expect(portEntries(publicPort)).toEqual([]);
  }, SERVER_BUDGET_MS);

  test("a lease that cannot be deleted fails the stop, and the next start retries it before serving again", async () => {
    const publicPort = await findAvailablePort(0, "0.0.0.0");
    const ctx = { config: { hostname: "0.0.0.0" } as OcxConfig, publicPort, dispatch: async () => Response.json({ ok: true }) };
    const listener = createLocalControlListener();
    listener.start(ctx);
    expect(listener.socketPath()).toBe(localControlSocketPath(publicPort));
    const lease = localControlLeasePath(publicPort);
    // Another process holds the record open without FILE_SHARE_DELETE: it stays readable, but no
    // unlink can remove it until that handle closes. The path travels as a quoted literal: copying
    // process.env into the child can carry both SYSTEMROOT and SystemRoot, which breaks the spawn.
    const quoted = "'" + lease.replaceAll("'", "''") + "'";
    const holder = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open(" + quoted + ", 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()"],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    try {
      const reader = holder.stdout.getReader();
      let seen = "";
      while (!seen.includes("held")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("the lease holder exited before opening the record");
        seen += new TextDecoder().decode(chunk.value);
      }
      const failed = await listener.stop().then(() => null, (error: unknown) => error);
      expect(failed).toBeInstanceOf(LocalControlReleaseError);
      expect(readFileSync(lease, "utf8")).toContain("token");
    } finally {
      holder.stdin.write("\n");
      await holder.stdin.end();
      await holder.exited;
    }
    // The retained release runs first, so this runtime's own stale record does not read as a live owner.
    listener.start(ctx);
    expect(listener.socketPath()).toBe(localControlSocketPath(publicPort));
    await listener.stop();
    expect(portEntries(publicPort)).toEqual([]);
  }, SERVER_BUDGET_MS);
});

