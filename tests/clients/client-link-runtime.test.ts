import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { bindClientListener, startClientRuntime } from "../../src/client/runtime";
import type { MachineListenerDeps } from "../../src/client/machine-listener";
import type { OcxClientConnectionConfig } from "../../src/types";
import { clientLinkStatePath, writeClientLinkState } from "../../src/client/link-state";
import { fixturePath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { watchdogMs } from "../helpers/ci-watchdog";

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port!;
  server.stop(true);
  return port;
}

async function waitFor<T>(read: () => T | null, label: string): Promise<T> {
  const deadline = Date.now() + watchdogMs(15_000);
  while (Date.now() < deadline) {
    const result = read();
    if (result !== null) return result;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function linkClientState(): OcxClientConnectionConfig {
  const token = `ocx_data_${"c".repeat(40)}`;
  return {
    serverUrl: "http://127.0.0.1:34567",
    managementUrl: "http://127.0.0.1:34567",
    managementTransport: "direct",
    transport: "link",
    link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" },
    selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "key-1",
    tokenFingerprint: serviceApiTokenFingerprint(token),
    protocolVersion: 1,
    connectedAt: "2026-09-25T00:00:00.000Z",
  };
}

function servePlain(port: number): Server<unknown> {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("bound") });
}

test("link runtime refuses a busy configured port instead of selecting an ephemeral port", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-client-link-runtime-"));
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("held") });
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const token = `ocx_data_${"c".repeat(40)}`;
    const config = getDefaultConfig();
    config.port = holder.port!;
    config.runtimeRole = "client";
    config.client = {
      serverUrl: "http://127.0.0.1:34567",
      managementUrl: "http://127.0.0.1:34567",
      managementTransport: "direct",
      transport: "link",
      link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" },
      selectedClients: ["codex"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "key-1",
      tokenFingerprint: serviceApiTokenFingerprint(token),
      protocolVersion: 1,
      connectedAt: "2026-09-25T00:00:00.000Z",
    };
    saveConfig(config);
    await expect(startClientRuntime({ block: false }, { portWaitMs: 300 }))
      .rejects.toThrow(`link mode needs port ${holder.port}`);
  } finally {
    holder.stop(true);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("an ended link recycles a connected sibling after listener cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-client-sibling-recycle-"));
  const home = join(root, "ocx");
  const codexHome = join(root, "codex");
  const userHome = join(root, "home");
  for (const dir of [home, codexHome, userHome]) mkdirSync(dir, { recursive: true });
  const priorHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  const ownerPort = freePort();
  let clientPort = freePort();
  while (clientPort === ownerPort) clientPort = freePort();
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let drained: Promise<unknown> | null = null;
  let replacementPid: number | null = null;
  try {
    const linkId = "lnk_0123456789abcdef";
    const token = `ocx_data_${"c".repeat(40)}`;
    const config = getDefaultConfig();
    config.port = clientPort;
    config.runtimeRole = "client";
    config.codexAutoStart = false;
    config.clientIntegrations = { codex: false, grok: false, "claude-desktop": false };
    config.client = {
      serverUrl: "http://127.0.0.1:34567",
      managementUrl: "http://127.0.0.1:34567",
      managementTransport: "direct",
      transport: "link",
      link: { tunnelPort: 34567, linkId },
      selectedClients: ["codex"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "key-1",
      tokenFingerprint: serviceApiTokenFingerprint(token),
      protocolVersion: 1,
      connectedAt: "2026-09-25T00:00:00.000Z",
    };
    saveConfig(config);
    writeClientLinkState({ linkId, alias: "fixture", hubHostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      peerListenerPort: 34569, tunnelPort: 34567 });

    const spawned = Bun.spawn([process.execPath, fixturePath("client-sibling-recycle-child.ts")], {
      env: { ...process.env, HOME: userHome, USERPROFILE: userHome, CODEX_HOME: codexHome,
        OPENCODEX_HOME: home, OCX_TEST_OWNER_PORT: String(ownerPort), OCX_TEST_CLIENT_PORT: String(clientPort) },
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    child = spawned;
    const clientPid = spawned.pid;
    // Keep the child's recent output from spawn on, so a child that stalls (#4956) fails with
    // its own state and output instead of a bare timeout. Each buffer keeps the last 4000 chars.
    const output = { stdout: "", stderr: "" };
    const drain = async (stream: ReadableStream<Uint8Array>, key: "stdout" | "stderr") => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stream) output[key] = (output[key] + decoder.decode(chunk, { stream: true })).slice(-4000);
      } catch (error) {
        output[key] += `\npipe read failed: ${String(error)}`;
      }
    };
    drained = Promise.all([drain(spawned.stdout, "stdout"), drain(spawned.stderr, "stderr")]);
    const withChild = <T>(wait: Promise<T>): Promise<T> => wait.catch(error => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; client pid=${clientPid} `
        + `exit=${spawned.exitCode}\nclient stdout: ${output.stdout.slice(-700)}\nclient stderr: ${output.stderr.slice(-700)}`);
    });
    await withChild(waitFor(() => existsSync(join(home, "client-runtime-ready")) ? true : null, "connected client readiness"));
    const initial = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8")) as { pid: number; siblingOfPort?: number };
    expect(initial).toMatchObject({ pid: clientPid, siblingOfPort: ownerPort });

    const standalone = { ...config, runtimeRole: "standalone" as const };
    delete standalone.client;
    saveConfig(standalone);
    unlinkSync(clientLinkStatePath());
    const oldExit = await withChild(waitFor(() => spawned.exitCode ?? null, "connected client recycle exit"));
    expect(oldExit).toBe(0);
    const replacement = await withChild(waitFor(() => {
      try {
        const state = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8")) as { pid: number; port: number; siblingOfPort?: number };
        return state.pid !== clientPid ? state : null;
      } catch { return null; }
    }, "standalone replacement runtime"));
    replacementPid = replacement.pid;
    expect(replacement).toMatchObject({ port: clientPort, siblingOfPort: ownerPort });
    const health = await fetch(`http://127.0.0.1:${clientPort}/healthz`).then(response => response.json()) as { pid?: number };
    expect(health.pid).toBe(replacement.pid);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child) await child.exited;
    // The replacement logs to a file rather than these pipes, so they close with the child.
    if (drained) await Promise.race([drained, Bun.sleep(2000)]);
    if (replacementPid !== null) {
      try { process.kill(replacementPid, "SIGTERM"); } catch { /* already exited */ }
      await waitFor(() => {
        try { return process.kill(replacementPid, 0) ? null : true; }
        catch { return true; }
      }, "replacement process exit");
      // Windows SIGTERM is TerminateProcess, so no signal/exit handler removes the runtime
      // record. The fixture cleanup owns that stale file after proving the process is gone.
      if (process.platform !== "win32") {
        await waitFor(() => existsSync(join(home, "runtime-port.json")) ? null : true, "replacement runtime cleanup");
      }
    }
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    removeTreeWithRetry(root);
  }
}, watchdogMs(60_000));

describe("link runtime waits for its configured port like a hard-pinned start", () => {
  test("the bind helper forwards link status, cached key, and tunnel gate", async () => {
    const port = freePort();
    const linkStatus = () => ({ kind: "stopped" as const });
    const linkKeySource = () => "link-key";
    const linkTunnel = { connected: () => false, pending: () => true, waitForConnected: async () => true };
    const request = {
      state: linkClientState(), linkMode: true, preferred: port,
      explicitPort: true, configuredPort: port,
      linkStatus, linkKeySource, linkTunnel,
    };
    let received: MachineListenerDeps | undefined;
    let bound: Server<unknown> | undefined;
    try {
      await bindClientListener(request, {
        startListener: (listenPort, deps) => {
          received = deps;
          return (bound = servePlain(listenPort!));
        },
      });
      expect(received?.linkStatus).toBe(linkStatus);
      expect(received?.linkKeySource).toBe(linkKeySource);
      expect(received?.linkTunnel).toBe(linkTunnel);
    } finally {
      bound?.stop(true);
    }
  });

  test("a port its restarting parent releases after the short prefer-retry still binds", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("parent") });
    const port = holder.port!;
    // Longer than the 750ms prefer-retry that used to be the whole budget.
    const release = setTimeout(() => holder.stop(true), 1_500);
    let bound: Server<unknown> | undefined;
    const started = Date.now();
    try {
      const result = await bindClientListener({
        state: linkClientState(),
        linkMode: true,
        preferred: port,
        explicitPort: false,
        configuredPort: port,
      }, {
        portWaitMs: 10_000,
        startListener: p => (bound = servePlain(p!)),
      });
      expect(result.port).toBe(port);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    } finally {
      clearTimeout(release);
      holder.stop(true);
      bound?.stop(true);
    }
  });

  test("a bind that loses the port after the probe is retried", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    probe.stop(true);
    let calls = 0;
    let bound: Server<unknown> | undefined;
    try {
      const result = await bindClientListener({
        state: linkClientState(),
        linkMode: true,
        preferred: port,
        explicitPort: true,
        configuredPort: port,
      }, {
        portWaitMs: 5_000,
        startListener: p => {
          calls += 1;
          if (calls === 1) throw Object.assign(new Error(`Failed to start server. Is port ${p} in use?`), { code: "EADDRINUSE" });
          return (bound = servePlain(p!));
        },
      });
      expect(calls).toBe(2);
      expect(result.port).toBe(port);
    } finally {
      bound?.stop(true);
    }
  });

  test("a hub-transport client keeps its single bind attempt", async () => {
    let calls = 0;
    const attempt = bindClientListener({
      state: { ...linkClientState(), transport: undefined, link: undefined },
      linkMode: false,
      preferred: 0,
      explicitPort: false,
      configuredPort: 0,
    }, {
      startListener: () => {
        calls += 1;
        throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      },
    });
    await expect(attempt).rejects.toThrow("in use");
    expect(calls).toBe(1);
  });
});
