import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { startClientRuntime } from "../../src/client/runtime";
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
    await expect(startClientRuntime({ block: false })).rejects.toThrow(`link mode needs port ${holder.port}`);
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

    child = Bun.spawn([process.execPath, fixturePath("client-sibling-recycle-child.ts")], {
      env: { ...process.env, HOME: userHome, USERPROFILE: userHome, CODEX_HOME: codexHome,
        OPENCODEX_HOME: home, OCX_TEST_OWNER_PORT: String(ownerPort), OCX_TEST_CLIENT_PORT: String(clientPort) },
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    const clientPid = child.pid;
    await waitFor(() => existsSync(join(home, "client-runtime-ready")) ? true : null, "connected client readiness");
    const initial = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8")) as { pid: number; siblingOfPort?: number };
    expect(initial).toMatchObject({ pid: clientPid, siblingOfPort: ownerPort });

    const standalone = { ...config, runtimeRole: "standalone" as const };
    delete standalone.client;
    saveConfig(standalone);
    unlinkSync(clientLinkStatePath());
    const oldExit = await waitFor(() => child?.exitCode ?? null, "connected client recycle exit");
    expect(oldExit).toBe(0);
    const replacement = await waitFor(() => {
      try {
        const state = JSON.parse(readFileSync(join(home, "runtime-port.json"), "utf8")) as { pid: number; port: number; siblingOfPort?: number };
        return state.pid !== clientPid ? state : null;
      } catch { return null; }
    }, "standalone replacement runtime").catch(async error => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; client stderr: ${(await new Response(child.stderr).text()).slice(-700)}`);
    });
    replacementPid = replacement.pid;
    expect(replacement).toMatchObject({ port: clientPort, siblingOfPort: ownerPort });
    const health = await fetch(`http://127.0.0.1:${clientPort}/healthz`).then(response => response.json()) as { pid?: number };
    expect(health.pid).toBe(replacement.pid);
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (child) await child.exited;
    if (replacementPid !== null) {
      try { process.kill(replacementPid, "SIGTERM"); } catch { /* already exited */ }
      await waitFor(() => existsSync(join(home, "runtime-port.json")) ? null : true, "replacement shutdown");
    }
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    removeTreeWithRetry(root);
  }
}, watchdogMs(60_000));
