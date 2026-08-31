import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { watchdogMs } from "./helpers/ci-watchdog";

// Regression: `ocx health` probed once (750ms ceiling). A proxy that has only
// just bound can leave that single probe timing out while startup work settles
// the event loop, so the command reported ok:false seconds before the very same
// proxy answered other commands. The health command now retries a bounded
// number of times, matching the stop-path liveness posture (#764).
const RUN_BUDGET_MS = watchdogMs(15_000);

const cliPath = resolve(import.meta.dir, "../src/cli/index.ts");
const roots: string[] = [];
const servers: Server[] = [];

/** Identity body after a deliberately slow first response: single-probe setups miss it. */
function startLateFirstResponseProxy(port: number, firstResponseDelayMs: number): void {
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    const respond = () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        status: "ok",
        service: "opencodex",
        version: "0.0.0-test",
        uptime: 1,
        pid: process.pid,
        port,
      }));
    };
    if (requests === 1) setTimeout(respond, firstResponseDelayMs);
    else respond();
  });
  servers.push(server);
  server.listen(port, "127.0.0.1");
}

async function fixture(port: number) {
  const root = mkdtempSync(join(tmpdir(), "ocx-health-retry-"));
  roots.push(root);
  const ocxHome = join(root, "ocx");
  const home = join(root, "home");
  const codexHome = join(root, "codex");
  const runtime = join(root, "runtime");
  for (const path of [ocxHome, home, codexHome, runtime]) mkdirSync(path, { recursive: true });
  // No pid/runtime records: discovery must fall through to the configured port.
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port,
    hostname: "127.0.0.1",
    codexAutoStart: false,
    providers: {},
    defaultProvider: "openai",
  }));
  return {
    root,
    env: {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: ocxHome,
      XDG_RUNTIME_DIR: runtime,
      NO_PROXY: "127.0.0.1,localhost",
    } as Record<string, string>,
  };
}

async function runHealth(fx: { root: string; env: Record<string, string> }): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn([process.execPath, cliPath, "health", "--json"], {
    cwd: fx.root,
    env: fx.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const completed = await Promise.race([
    Promise.all([child.exited, new Response(child.stdout).text()]),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("CLI watchdog: ocx health --json")), RUN_BUDGET_MS)),
  ]);
  return { exitCode: completed[0], stdout: completed[1] };
}

afterEach(async () => {
  while (servers.length) servers.pop()!.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("ocx health against a proxy whose first probe response is slow", () => {
  test("retries past a slow first response instead of reporting ok:false", async () => {
    const port = await new Promise<number>((resolvePort, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.once("listening", () => {
        const address = server.address();
        const picked = typeof address === "object" && address ? address.port : 0;
        server.close(() => (picked > 0 ? resolvePort(picked) : reject(new Error("no ephemeral port"))));
      });
      server.listen(0, "127.0.0.1");
    });
    // 1500ms first response: beyond the 750ms probe ceiling, so attempt 1 must
    // time out and attempt 2 carry the answer.
    startLateFirstResponseProxy(port, 1500);
    const fx = await fixture(port);

    const result = await runHealth(fx);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { ok: boolean; port: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.port).toBe(port);
  }, RUN_BUDGET_MS);
});
