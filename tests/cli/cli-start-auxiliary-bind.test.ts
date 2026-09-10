import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAvailablePort } from "../../src/server/ports";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { watchdogMs } from "../helpers/ci-watchdog";

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
