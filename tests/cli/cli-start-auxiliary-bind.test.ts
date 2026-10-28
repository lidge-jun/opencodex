import { expect, spyOn, test } from "bun:test";
import * as net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { watchdogMs } from "../helpers/ci-watchdog";
import { assertAuxiliaryListenerPortsAvailable } from "../../src/cli/auxiliary-listener-preflight";
import { directLocalHttpFetch } from "../../src/server/direct-local-http";

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
      // Also hold the public endpoint: auxiliary failure must win before even a
      // pinned start attempts public-port reclamation. Nobody can steal this port.
      const publicListener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request =>
        // Prove this listener is foreign so recovery can reach the auxiliary preflight.
        new URL(request.url).pathname === "/healthz"
          ? Response.json({ service: "public-canary" }) : new Response("public canary") });
      const publicPort = publicListener.port;
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
        // Probe the held listener directly; an ambient HTTP(S)_PROXY must not answer for it.
        expect(await (await directLocalHttpFetch(`http://127.0.0.1:${publicPort}/`)).text()).toBe("public canary");
      } finally {
        clearTimeout(deadline);
        if (child.exitCode === null) { child.kill(); await child.exited; }
        await occupied.stop(true);
        await publicListener.stop(true);
        removeTreeWithRetry(root);
      }
    }, DEADLINE + 10_000);
  }
}

test("auxiliary preflight closes its sockets before returning", async () => {
  // Observe the actual handles instead of rebinding a released number.
  const probes: net.Server[] = [];
  const create = net.createServer;
  const spy = spyOn(net, "createServer").mockImplementation((...args) => {
    const probe = create(...args); probes.push(probe); return probe;
  });
  const base = { port: 0, providers: {}, defaultProvider: "openai", runtimeRole: "hub" as const };
  try {
    await assertAuxiliaryListenerPortsAvailable({ ...base, unauthenticatedLoopbackListener: { enabled: true, port: 0 } });
    await assertAuxiliaryListenerPortsAvailable({ ...base, hub: { managementIngress: { enabled: true, port: 0 } } });
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe.listening).toBe(false);
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
      expect(probe.listening).toBe(true);
      await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    spy.mockRestore();
    for (const probe of probes) if (probe.listening) probe.close();
  }
});

test("auxiliary preflight rejects two listeners configured for one port", async () => {
  // Collision is rejected before binding, so no allocation is required.
  const port = 12345;
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
