import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { watchdogMs } from "./helpers/ci-watchdog";

// Regression: `ocx start` skipped live-proxy discovery entirely when both state
// files were absent, then hopped to an ephemeral port and re-pointed Codex at
// the ephemeral copy. A fallback-port sibling produces exactly that precondition
// on its own shutdown: it overwrites the pid/runtime records on start and
// removes them when it exits, while the configured-port proxy keeps serving.
const RUN_BUDGET_MS = watchdogMs(15_000);

const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
const roots: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("no ephemeral port"))));
    });
    server.listen(0, "127.0.0.1");
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-start-shadow-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  for (const path of [codexHome, ocxHome, home, runtime]) mkdirSync(path, { recursive: true });
  const port = await reserveLoopbackPort();
  // A FIXED configured port: the shadow bug is specifically that start never
  // probes this port when the pid/runtime records are missing.
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
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    OPENCODEX_HOME: ocxHome,
    XDG_RUNTIME_DIR: runtime,
    NO_PROXY: "127.0.0.1,localhost",
  };
  return { root, codexHome, ocxHome, port, pidPath: join(ocxHome, "ocx.pid"), runtimePath: join(ocxHome, "runtime-port.json"), env };
}

async function runCli(fx: Awaited<ReturnType<typeof fixture>>, argv: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cliPath, ...argv], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const completed = await Promise.race([
    Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`CLI watchdog: ocx ${argv.join(" ")}`)), RUN_BUDGET_MS)),
  ]);
  return { exitCode: completed[0], stdout: completed[1], stderr: completed[2] };
}

async function startOwner(fx: Awaited<ReturnType<typeof fixture>>): Promise<ReturnType<typeof Bun.spawn>> {
  const child = Bun.spawn([process.execPath, cliPath, "start", "--port", String(fx.port)], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  const deadline = Date.now() + RUN_BUDGET_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error("timed out waiting for owner health");
    try {
      const response = await fetch(`http://127.0.0.1:${fx.port}/healthz`, { signal: AbortSignal.timeout(500) });
      const body = await response.json() as { pid?: number };
      if (response.ok && body.pid === child.pid) return child;
    } catch { /* not listening yet */ }
    await Bun.sleep(25);
  }
}

/** Simulate a fallback-port sibling that already cleaned up its state files. */
function removeStateFiles(fx: Awaited<ReturnType<typeof fixture>>): void {
  for (const path of [fx.pidPath, fx.runtimePath]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  while (children.length) {
    const child = children.pop()!;
    if (child.exitCode === null) await child.exited;
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("start vs a healthy configured-port proxy with no state files", () => {
  test("start refuses to shadow the live proxy and leaves no fallback instance", async () => {
    const fx = await fixture();
    const owner = await startOwner(fx);
    try {
      removeStateFiles(fx);

      const start = await runCli(fx, ["start"]);
      expect(start.exitCode).toBe(1);
      expect(start.stderr).toContain("Proxy already running");
      expect(start.stderr).toContain(`port ${fx.port}`);
      // The pre-fix failure mode: an ephemeral-port hop plus a fresh instance.
      expect(start.stderr).not.toContain("is busy; starting opencodex on");
      expect(existsSync(fx.runtimePath)).toBe(false);
      expect(existsSync(fx.pidPath)).toBe(false);

      // The untouched owner is still the one serving.
      const health = await fetch(`http://127.0.0.1:${fx.port}/healthz`, { signal: AbortSignal.timeout(500) });
      const body = await health.json() as { pid?: number };
      expect(body.pid).toBe(owner.pid);
    } finally {
      owner.kill("SIGTERM");
      await owner.exited;
    }
  }, RUN_BUDGET_MS);
});
