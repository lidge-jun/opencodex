import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerIdFromMountinfo, runtimeOwnerScope, sameRuntimeOwnerScope } from "../../src/config/process-state";
import { observeProxyLiveness, type LivenessIo } from "../../src/server/proxy-liveness";
import { watchdogMs } from "../helpers/ci-watchdog";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

// #8552: a container runs the proxy as PID 1 on every start, so the record the previous container
// left names PID 1 too -- the starting process itself. Signalling it succeeds and its command line
// is ocx, which used to read as a live owner and refused startup on every restart.

const OCX_COMMAND_LINE = "bun /app/src/cli/index.ts start";
const refused = (async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }) as unknown as typeof fetch;

function ioFor(extra: Partial<LivenessIo>): LivenessIo {
  return {
    readPidFn: () => null,
    readRuntimeFn: () => null,
    verifyPidFn: pid => pid,
    configFn: () => ({ port: 10100, hostname: "127.0.0.1" }),
    loopbackAvailabilityFn: () => "available",
    readCommandLineFn: () => OCX_COMMAND_LINE,
    attempts: 1,
    timeoutMs: 50,
    fetchFn: refused,
    ...extra,
  };
}

const OWN = { host: "0123456789abcdef0123456789abcdef", network: "11111111111111111111111111111111" };
const unpublished = () => ({ pid: process.pid, publishedOwnership: false, scope: OWN });
const selfRecord = (ownerScope: unknown = OWN) => ({ pid: process.pid, port: 10100, hostname: "127.0.0.1", ...(ownerScope === null ? {} : { ownerScope }) });

describe("a record naming this process's own PID", () => {
  test("a runtime record an earlier run of this container left is absent", async () => {
    const io = ioFor({ readRuntimeFn: () => selfRecord(), ownProcessFn: unpublished });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
  });

  test("a restarted Docker container matches on its container id when the network namespace is new", async () => {
    const own = { host: OWN.host, network: "22222222222222222222222222222222", container: "33333333333333333333333333333333" };
    const io = ioFor({
      readRuntimeFn: () => selfRecord({ host: OWN.host, network: OWN.network, container: own.container }),
      ownProcessFn: () => ({ pid: process.pid, publishedOwnership: false, scope: own }),
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
  });

  test("a pid file beside that runtime record is absent too", async () => {
    const io = ioFor({ readPidFn: () => process.pid, readRuntimeFn: () => selfRecord(), ownProcessFn: unpublished });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
  });

  test("a pid file alone carries no owner scope and still refuses", async () => {
    const io = ioFor({ readPidFn: () => process.pid, ownProcessFn: unpublished });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  // Every container is PID 1. During a RollingUpdate, or with a fixed hostname and start-first, the
  // old container still serves this volume from another network namespace the probe cannot see.
  test("a same-host record from another network namespace and container still refuses", async () => {
    const io = ioFor({
      readRuntimeFn: () => selfRecord({ host: OWN.host, network: "44444444444444444444444444444444", container: "55555555555555555555555555555555" }),
      ownProcessFn: unpublished,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  test("a record from another host or boot still refuses", async () => {
    const io = ioFor({ readRuntimeFn: () => selfRecord({ ...OWN, host: "fedcba9876543210fedcba9876543210" }), ownProcessFn: unpublished });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  for (const [label, scope] of [["no owner scope (an older version, maybe still serving)", null], ["a malformed owner scope", OWN.host], ["a host-only scope on Linux", { host: OWN.host }]] as const) {
    test(`a record with ${label} still refuses`, async () => {
      const io = ioFor({ readRuntimeFn: () => selfRecord(scope), ownProcessFn: unpublished });
      expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
    });
  }

  test("once this process has published ownership, its own PID still reads as a live owner", async () => {
    const io = ioFor({
      readRuntimeFn: () => selfRecord(),
      ownProcessFn: () => ({ ...unpublished(), publishedOwnership: true }),
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  test("another alive ocx PID beside the self record still refuses", async () => {
    const io = ioFor({
      readPidFn: () => process.ppid,
      readRuntimeFn: pid => pid === undefined ? selfRecord() : null,
      ownProcessFn: unpublished,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  test("an endpoint that did not answer definitively still refuses", async () => {
    const io = ioFor({
      readRuntimeFn: () => selfRecord(),
      ownProcessFn: unpublished,
      fetchFn: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as unknown as typeof fetch,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });
});

describe("owner scope comparison", () => {
  test("Linux needs the host plus the network namespace or the container", () => {
    const own = { host: "h", network: "n", container: "c" };
    expect(sameRuntimeOwnerScope({ host: "h", network: "n" }, own)).toBe(true);
    expect(sameRuntimeOwnerScope({ host: "h", network: "x", container: "c" }, own)).toBe(true);
    expect(sameRuntimeOwnerScope({ host: "h", network: "x", container: "y" }, own)).toBe(false);
    expect(sameRuntimeOwnerScope({ host: "h" }, own)).toBe(false);
    expect(sameRuntimeOwnerScope({ host: "other", network: "n", container: "c" }, own)).toBe(false);
    for (const malformed of [undefined, null, "h", ["h"], { host: 1, network: "n" }]) expect(sameRuntimeOwnerScope(malformed, own)).toBe(false);
  });

  test("a machine-wide PID space compares the host alone, and never against a Linux record", () => {
    const own = { host: "h" };
    expect(sameRuntimeOwnerScope({ host: "h" }, own)).toBe(true);
    expect(sameRuntimeOwnerScope({ host: "h", network: "n" }, own)).toBe(false);
    expect(sameRuntimeOwnerScope({ host: "other" }, own)).toBe(false);
  });

  test("container ids come from the files Docker and Podman bind-mount, not from pod sandboxes", () => {
    const id = "a".repeat(64);
    expect(containerIdFromMountinfo(`1234 1200 0:52 /var/lib/docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw\n`)).toBe(id);
    expect(containerIdFromMountinfo(`1234 1200 0:52 /containers/storage/overlay-containers/${id}/userdata/resolv.conf /etc/resolv.conf rw - tmpfs tmpfs rw\n`)).toBe(id);
    expect(containerIdFromMountinfo(`1234 1200 0:52 /var/lib/containerd/io.containerd.grpc.v1.cri/sandboxes/${id}/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n`)).toBeUndefined();
    expect(containerIdFromMountinfo("25 1 8:1 / / rw,relatime - ext4 /dev/sda1 rw\n")).toBeUndefined();
  });
});

const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  while (roots.length) removeTreeWithRetry(roots.pop()!);
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

const START_WAIT_MS = watchdogMs(15_000);

// `exec` keeps the shell's PID, so the shell plays the previous container and `ocx start` the next
// one: same PID, new lifetime, records naming it already on disk. Windows has no exec handoff.
async function startAfterOwnLifetime(ownerScope: unknown): Promise<{ child: ReturnType<typeof Bun.spawn>; port: number; ocxHome: string; served: boolean; stderr: Promise<string> }> {
  const root = mkdtempSync(join(tmpdir(), "ocx-self-pid-"));
  roots.push(root);
  const ocxHome = join(root, "ocx"), codexHome = join(root, "codex"), home = join(root, "home"), runtime = join(root, "runtime");
  for (const path of [ocxHome, codexHome, home, runtime]) mkdirSync(path, { recursive: true });
  const port = await freePort();
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port,
    hostname: "127.0.0.1",
    codexAutoStart: false,
    syncResumeHistory: false,
    clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
    claudeCode: { systemEnv: false },
    providers: {},
    defaultProvider: "openai",
  }));
  const script = [
    'printf %s "$$" > "$OPENCODEX_HOME/ocx.pid"',
    'printf \'{"pid":%s,"port":%s,"hostname":"127.0.0.1","ownerScope":%s}\' "$$" "$SELF_PID_PORT" "$SELF_PID_SCOPE" > "$OPENCODEX_HOME/runtime-port.json"',
    'exec "$SELF_PID_BUN" "$SELF_PID_CLI" start --port "$SELF_PID_PORT"',
  ].join(" && ");
  const child = Bun.spawn(["/bin/sh", "-c", script], {
    cwd: root,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: ocxHome,
      XDG_RUNTIME_DIR: runtime,
      NO_PROXY: "127.0.0.1,localhost",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      SELF_PID_BUN: process.execPath,
      SELF_PID_CLI: repoPath("src/cli/index.ts"),
      SELF_PID_PORT: String(port),
      SELF_PID_SCOPE: JSON.stringify(ownerScope),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stderr = new Response(child.stderr).text();
  const deadline = Date.now() + START_WAIT_MS;
  let served = false;
  while (Date.now() < deadline && child.exitCode === null && !served) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { pid?: number };
      served = response.ok && body.pid === child.pid;
    } catch { /* not listening yet */ }
    if (!served) await Bun.sleep(50);
  }
  return { child, port, ocxHome, served, stderr };
}

const posix = process.platform !== "win32";

test.skipIf(!posix)("ocx start recovers records an earlier run of its PID left in the same place", async () => {
  const { child, port, ocxHome, served, stderr } = await startAfterOwnLifetime(runtimeOwnerScope());
  if (!served) {
    if (child.exitCode === null) child.kill();
    await child.exited;
    const text = await stderr;
    const reason = text.split("\n").find(line => line.startsWith("error:")) ?? text.trim().slice(0, 400);
    throw new Error(`start did not serve as PID ${child.pid}: exit ${child.exitCode}: ${reason}`);
  }
  const record = JSON.parse(readFileSync(join(ocxHome, "runtime-port.json"), "utf8")) as { pid: number; port: number; attestationSecret?: string; ownerScope?: unknown };
  expect(record.pid).toBe(child.pid);
  expect(record.port).toBe(port);
  // A fresh publication: the stale record had no attestation secret.
  expect(typeof record.attestationSecret).toBe("string");
  expect(record.ownerScope).toEqual(runtimeOwnerScope());
}, Math.max(30_000, START_WAIT_MS * 2));

test.skipIf(!posix)("ocx start still refuses a same-PID record written somewhere else", async () => {
  const { child, served, stderr, ocxHome } = await startAfterOwnLifetime({ ...runtimeOwnerScope(), host: "fedcba9876543210fedcba9876543210" });
  expect(served).toBe(false);
  expect(await child.exited).toBe(1);
  expect(await stderr).toContain("Proxy ownership is unverified");
  expect(existsSync(join(ocxHome, "ocx.pid"))).toBe(true);
}, Math.max(30_000, START_WAIT_MS * 2));
