import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const unpublished = () => ({ pid: process.pid, publishedOwnership: false });

describe("a record naming this process's own PID", () => {
  test("a runtime record left by an earlier lifetime of this PID is absent", async () => {
    const io = ioFor({ readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "127.0.0.1" }), ownProcessFn: unpublished });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
  });

  test("a pid file left by an earlier lifetime of this PID is absent", async () => {
    const io = ioFor({ readPidFn: () => process.pid, ownProcessFn: unpublished });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "absent", live: null });
  });

  test("once this process has published ownership, its own PID still reads as a live owner", async () => {
    const io = ioFor({
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "127.0.0.1" }),
      ownProcessFn: () => ({ pid: process.pid, publishedOwnership: true }),
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  test("another alive ocx PID beside the self record still refuses", async () => {
    const io = ioFor({
      readPidFn: () => process.ppid,
      readRuntimeFn: pid => pid === undefined ? { pid: process.pid, port: 10100, hostname: "127.0.0.1" } : null,
      ownProcessFn: unpublished,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
  });

  test("an endpoint that did not answer definitively still refuses", async () => {
    const io = ioFor({
      readRuntimeFn: () => ({ pid: process.pid, port: 10100, hostname: "127.0.0.1" }),
      ownProcessFn: unpublished,
      fetchFn: (async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }) as unknown as typeof fetch,
    });
    expect(await observeProxyLiveness(io)).toEqual({ kind: "unknown", live: null });
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
test.skipIf(process.platform === "win32")("ocx start recovers records its own PID left in an earlier lifetime", async () => {
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
    'printf \'{"pid":%s,"port":%s,"hostname":"127.0.0.1"}\' "$$" "$SELF_PID_PORT" > "$OPENCODEX_HOME/runtime-port.json"',
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const stderr = new Response(child.stderr).text();
  const deadline = Date.now() + START_WAIT_MS;
  let served: { pid?: number } | null = null;
  while (Date.now() < deadline && child.exitCode === null && !served) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { pid?: number };
      if (response.ok && body.pid === child.pid) served = body;
    } catch { /* not listening yet */ }
    if (!served) await Bun.sleep(50);
  }
  if (!served) {
    if (child.exitCode === null) child.kill();
    await child.exited;
    const reason = (await stderr).split("\n").find(line => line.startsWith("error:")) ?? (await stderr).trim().slice(0, 400);
    throw new Error(`start did not serve as PID ${child.pid}: exit ${child.exitCode}: ${reason}`);
  }
  expect(served.pid).toBe(child.pid);
  const runtimePath = join(ocxHome, "runtime-port.json");
  expect(existsSync(runtimePath)).toBe(true);
  const record = JSON.parse(readFileSync(runtimePath, "utf8")) as { pid: number; port: number; attestationSecret?: string };
  expect(record.pid).toBe(child.pid);
  expect(record.port).toBe(port);
  // A fresh publication: the stale record had no attestation secret.
  expect(typeof record.attestationSecret).toBe("string");
}, Math.max(30_000, START_WAIT_MS * 2));
