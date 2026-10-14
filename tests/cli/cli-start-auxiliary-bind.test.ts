import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAvailablePort } from "../../src/server/ports";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { watchdogMs } from "../helpers/ci-watchdog";
import { assertAuxiliaryListenerPortsAvailable } from "../../src/cli/auxiliary-listener-preflight";

const DEADLINE = watchdogMs(20_000);

for (const listener of ["unauthenticatedLoopbackListener", "hub.managementIngress"] as const) {
  for (const pinned of [false, true]) {
    test(`${listener} failure never retries the public port (${pinned ? "pinned" : "soft"})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "ocx-auxiliary-bind-"));
      const home = join(root, "home");
      const ocxHome = join(root, "ocx");
      const codexHome = join(root, "codex");
      for (const path of [home, ocxHome, codexHome]) mkdirSync(path);
      const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
      const auxiliaryPort = occupied.port!;
      const publicPort = await findAvailablePort(0, "127.0.0.1");
      writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
        port: publicPort, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai",
        codexAutoStart: false, syncResumeHistory: false,
        clientIntegrations: { codex: false, grok: false, "claude-desktop": false },
        claudeCode: { systemEnv: false },
        ...(listener === "hub.managementIngress"
          ? { runtimeRole: "hub", hub: { managementIngress: { enabled: true, port: auxiliaryPort } } }
          : { unauthenticatedLoopbackListener: { enabled: true, port: auxiliaryPort } }),
      }));
      const child = Bun.spawn([process.execPath, repoPath("src/cli/index.ts"), "start", ...(pinned ? ["--port", String(publicPort)] : [])], {
        cwd: root,
        env: { HOME: home, USERPROFILE: home, OPENCODEX_HOME: ocxHome, CODEX_HOME: codexHome,
          PATH: process.env.PATH ?? "", NO_PROXY: "127.0.0.1,localhost" },
        stdout: "pipe", stderr: "pipe",
      });
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; child.kill(); }, DEADLINE);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        const output = stdout + stderr;
        expect(timedOut, "CLI must exit on its own before the watchdog").toBe(false);
        expect(code).not.toBe(0);
        expect(output).toContain(`${listener} at 127.0.0.1:${auxiliaryPort}`);
        expect(output).not.toContain("picking another");
        expect(output).not.toContain("waiting to retry the same port");
        // An impossible auxiliary bind must fail before unrelated private-state
        // publication (and its synchronous Windows icacls subprocesses).
        expect(existsSync(join(ocxHome, "spend-ledger-owner.sqlite"))).toBe(false);
        expect(existsSync(join(ocxHome, "admin-api-token"))).toBe(false);
        const rebound = Bun.serve({ port: publicPort, hostname: "127.0.0.1", fetch: () => new Response("free") });
        await rebound.stop(true);
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) { child.kill(); await child.exited; }
        await occupied.stop(true);
        removeTreeWithRetry(root);
      }
    }, DEADLINE + 10_000);
  }
}

test("auxiliary preflight leaves free sockets available for the actual bind", async () => {
  const loopbackPort = await findAvailablePort(0);
  const managementPort = await findAvailablePort(0, "127.0.0.1", { reservedPort: loopbackPort });
  await assertAuxiliaryListenerPortsAvailable({
    port: 0, providers: {}, defaultProvider: "openai", runtimeRole: "hub",
    unauthenticatedLoopbackListener: { enabled: true, port: loopbackPort },
    hub: { managementIngress: { enabled: true, port: managementPort } },
  });
  // Bind inside try: if another process takes the second port, the first server still stops.
  const listeners: ReturnType<typeof Bun.serve>[] = [];
  try {
    for (const port of [loopbackPort, managementPort]) {
      listeners.push(Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") }));
    }
    expect(listeners.map(server => server.port)).toEqual([loopbackPort, managementPort]);
  } finally { await Promise.all(listeners.map(server => server.stop(true))); }
});

test("auxiliary preflight rejects two listeners configured for one port", async () => {
  const port = await findAvailablePort(0);
  await expect(assertAuxiliaryListenerPortsAvailable({
    port: 0, providers: {}, defaultProvider: "openai", runtimeRole: "hub",
    unauthenticatedLoopbackListener: { enabled: true, port },
    hub: { managementIngress: { enabled: true, port } },
  })).rejects.toThrow(`hub.managementIngress at 127.0.0.1:${port}`);
});

test("auxiliary preflight ignores the companion, disabled listeners, and non-hub ingress", async () => {
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  try {
    const base = { port: 0, providers: {}, defaultProvider: "openai", hub: { managementIngress: { enabled: true, port: occupied.port! } } };
    await assertAuxiliaryListenerPortsAvailable({ ...base, port: occupied.port!, unauthenticatedLoopbackListener: { enabled: true } });
    await assertAuxiliaryListenerPortsAvailable({ ...base, unauthenticatedLoopbackListener: { enabled: false, port: occupied.port! } });
    await assertAuxiliaryListenerPortsAvailable({ ...base, runtimeRole: "hub", hub: { managementIngress: { enabled: false, port: occupied.port! } } });
    expect(occupied.port).toBeGreaterThan(0);
  } finally { await occupied.stop(true); }
});
