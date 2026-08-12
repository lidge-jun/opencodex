/**
 * Real subprocess/loopback coverage for ocx ready dispatch boundaries.
 *
 * Keep tests/cli-ready.test.ts injected-only. These focused integration tests
 * prove that the top-level CLI preserves terminal-failed and pre-parse behavior
 * with isolated homes and an actual discovered proxy fixture.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  killAfterMs = 3_000,
): Promise<CliResult> {
  const startedAt = performance.now();
  const child = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      void child.exited.then(resolve);
    }, killAfterMs);
  });
  const exitCode = await Promise.race([child.exited, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { exitCode, stdout, stderr, elapsedMs: performance.now() - startedAt, timedOut };
}

function isolatedHomes(prefix: string): { root: string; opencodexHome: string; codexHome: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const opencodexHome = join(root, "opencodex");
  const codexHome = join(root, "codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  return { root, opencodexHome, codexHome };
}

function writeRuntimePort(opencodexHome: string, port: number, pid: number): void {
  writeFileSync(
    join(opencodexHome, "runtime-port.json"),
    JSON.stringify({ pid, port, hostname: "127.0.0.1" }) + "\n",
    "utf8",
  );
}

describe("ocx ready real subprocess", () => {
  test("ready --wait exits immediately on terminal failed readiness", async () => {
    const homes = isolatedHomes("ocx-ready-subprocess-failed-");
    const fixturePid = process.pid;
    let healthzHits = 0;
    let readyzHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") {
          healthzHits++;
          return Response.json({
            service: "opencodex",
            status: "ok",
            version: "test",
            uptime: 1,
            pid: fixturePid,
          });
        }
        if (path === "/readyz") {
          readyzHits++;
          return Response.json(
            {
              service: "opencodex",
              version: "test",
              uptime: 1,
              status: "failed",
              pid: fixturePid,
              port: server.port,
            },
            { status: 503 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    writeRuntimePort(homes.opencodexHome, server.port, fixturePid);

    try {
      const result = await runCli(
        ["ready", "--wait", "--timeout", "300", "--json"],
        { OPENCODEX_HOME: homes.opencodexHome, CODEX_HOME: homes.codexHome },
        10_000,
      );

      expect(healthzHits).toBe(1);
      expect(readyzHits).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(1);
      // Far below the 300s --timeout, but tolerant of cold Bun startup on CI.
      expect(result.elapsedMs).toBeLessThan(9_000);
      expect(JSON.parse(result.stdout.trim())).toEqual({
        ready: false,
        status: "failed",
        pid: fixturePid,
        port: server.port,
      });
      expect(result.stderr).toBe("");
    } finally {
      server.stop(true);
      rmSync(homes.root, { recursive: true, force: true });
    }
  });

  test("invalid --timeout exits 64 before discovery and auto-restore", async () => {
    const homes = isolatedHomes("ocx-ready-subprocess-invalid-");
    const fixturePid = process.pid;
    let healthzHits = 0;
    let readyzHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") healthzHits++;
        if (path === "/readyz") readyzHits++;
        return Response.json({
          service: "opencodex",
          status: "ok",
          version: "test",
          uptime: 1,
          pid: fixturePid,
        });
      },
    });
    writeRuntimePort(homes.opencodexHome, server.port, fixturePid);
    // If the global auto-restore preflight runs, this non-file state emits an
    // auto-restore warning. Invalid ready args must exit before inspecting it.
    mkdirSync(join(homes.opencodexHome, "codex-shim.json"));

    try {
      const result = await runCli(
        ["ready", "--timeout", "5"],
        {
          OPENCODEX_HOME: homes.opencodexHome,
          CODEX_HOME: homes.codexHome,
          OPENCODEX_CODEX_SHIM_AUTO_RESTORE: "1",
        },
        10_000,
      );

      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(64);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Usage: ocx ready");
      expect(result.stderr).not.toContain("auto-restore");
      expect(healthzHits).toBe(0);
      expect(readyzHits).toBe(0);
    } finally {
      server.stop(true);
      rmSync(homes.root, { recursive: true, force: true });
    }
  });
});
