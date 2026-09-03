import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOwnedServiceHome } from "./helpers/owned-service-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Regression: `ocx start` + Ctrl-C must NOT orphan the Bun proxy.
 *
 * The bin/ocx.mjs launcher used a blocking spawnSync that did not forward signals,
 * so a signal delivered only to the launcher killed it and left the Bun child
 * serving forever (port bound, ocx.pid/runtime-port.json left behind, Codex config
 * not restored). The launcher now forwards SIGINT/SIGTERM/SIGHUP to the child and
 * waits for its graceful shutdown.
 *
 * POSIX-only (Windows has no real signal forwarding semantics) and requires `node`
 * on PATH to exercise the real launcher.
 */

const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
const nodeAvailable = !spawnSync("node", ["--version"], { stdio: "ignore" }).error;
const runnable = process.platform !== "win32" && nodeAvailable;

const spawned: ChildProcess[] = [];
const tmpHomes: string[] = [];

function claimTempHome(home: string): { homeDir: string; userProfile: string; serviceManagerEnv: Record<string, string> } {
  const homeDir = join(home, "user-home");
  const userProfile = join(home, "user-profile");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(userProfile, { recursive: true });
  return { homeDir, userProfile, serviceManagerEnv: claimOwnedServiceHome(home, home, homeDir).env };
}

afterAll(() => {
  for (const c of spawned) {
    try { c.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of tmpHomes) {
    try { removeTreeWithRetry(dir); } catch { /* best-effort */ }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Startup budget for the proxy, generous on CI and tight locally.
 *
 * The subject of this test is signal forwarding, not startup latency, so the
 * budget only has to be long enough that a slow machine does not read as an
 * orphaned proxy. Locally the spawn is healthy in ~800ms; a shared CI runner
 * building four shards plus a macOS suite in parallel is a different machine
 * entirely, and 20s was not enough for it twice on 2026-09-03.
 *
 * Raising this cannot hide the regression the test guards: an orphaned proxy
 * fails at step 4 (the port never frees), which has its own deadline. What a
 * too-short startup budget DOES hide is that distinction — it fails before the
 * shutdown path runs at all.
 */
const STARTUP_BUDGET_MS = process.env.CI ? 60_000 : 20_000;

async function waitUntil(fn: () => Promise<boolean>, deadlineMs: number): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(250);
  }
  return false;
}

describe.skipIf(!runnable)("ocx launcher graceful shutdown", () => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(
      `${signal} to the launcher tears down the Bun proxy and restores Codex config (no orphan)`,
      async () => {
        const home = mkdtempSync(join(tmpdir(), "ocx-shutdown-"));
        tmpHomes.push(home);
        const port = await freePort();
        const identity = claimTempHome(home);

        // Seed a native Codex config so the proxy actually injects on start (injectCodexConfig
        // no-ops when no config.toml exists) — this lets us prove the config is RESTORED.
        const codexConfig = join(home, "config.toml");
        writeFileSync(codexConfig, 'model = "gpt-5.1"\n');

        // stdout/stderr are CAPTURED, not discarded.
        //
        // This test failed twice on the v2.41.0 promotion at exactly 20s -- the
        // startup deadline below, not the shutdown path this test is named for.
        // With `stdio: "ignore"` the failure said only `expect(up).toBe(true)`:
        // no proxy log, no exit code, no way to tell a slow runner from a real
        // startup regression. Locally the same spawn is healthy in ~800ms, so a
        // 25x margin is already generous and the missing evidence was the actual
        // problem.
        const child = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HOME: identity.homeDir,
            USERPROFILE: identity.userProfile,
            OPENCODEX_HOME: home,
            CODEX_HOME: home,
            ...identity.serviceManagerEnv,
          },
        });
        spawned.push(child);

        let exited = false;
        let exitCode: number | null = null;
        let exitSignal: NodeJS.Signals | null = null;
        child.on("exit", () => { exited = true; });
        child.on("exit", (code, sig) => { exitCode = code; exitSignal = sig; });

        let output = "";
        child.stdout?.on("data", chunk => { output += String(chunk); });
        child.stderr?.on("data", chunk => { output += String(chunk); });

        // 1. Proxy comes up + injected the Codex config (Design B root override on loopback).
        const up = await waitUntil(() => healthy(port), STARTUP_BUDGET_MS);
        if (!up) {
          // Name what actually went wrong instead of asserting a bare boolean.
          const died = exited ? ` The launcher EXITED (code ${exitCode}, signal ${exitSignal}).` : " The launcher was still running.";
          throw new Error(
            `The proxy never answered /healthz on port ${port} within ${STARTUP_BUDGET_MS}ms.${died}`
            + ` Launcher output:\n${output.trim() || "(none)"}`,
          );
        }
        expect(existsSync(join(home, "ocx.pid"))).toBe(true);
        const injected = readFileSync(codexConfig, "utf8");
        expect(injected).toContain("# Auto-injected by opencodex");
        expect(injected).toContain(`openai_base_url = "http://127.0.0.1:${port}/v1"`);
        expect(injected).not.toContain("model_providers.opencodex");

        // 2. Signal ONLY the launcher PID (the exact orphan trigger).
        child.kill(signal);

        // 3. Launcher exits...
        const launcherGone = await waitUntil(async () => exited, 15_000);
        expect(launcherGone).toBe(true);

        // 4. ...and the Bun proxy is gone (port freed) — the regression guard.
        const portFreed = await waitUntil(async () => !(await healthy(port)), 10_000);
        expect(portFreed).toBe(true);

        // 5. Graceful cleanup ran: pid + runtime-port removed, Codex config restored.
        expect(existsSync(join(home, "ocx.pid"))).toBe(false);
        expect(existsSync(join(home, "runtime-port.json"))).toBe(false);
        expect(readFileSync(codexConfig, "utf8")).not.toContain("opencodex");
      },
      STARTUP_BUDGET_MS + 40_000,
    );
  }
});
