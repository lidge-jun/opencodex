import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Server } from "bun";
import { siblingRuntimeField, withSiblingMarker } from "../codex/sibling-start";
import { issueSiblingHandoff } from "../codex/sibling-handoff";
import { loadConfig } from "../config";
import { removePid, removeRuntimePort, writePid, writeRuntimePort } from "../config/process-state";
import { installCrashGuards } from "../lib/crash-guard";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { loadServiceTokenFromFile, serviceApiTokenFingerprint } from "../lib/service-secrets";
import { findAvailablePort, PortUnavailableError } from "../server/ports";
import { createClientLinkSupervisor, type ClientLinkSupervisor } from "./link-tunnel";
import { clientLinkStatePath } from "./link-state";
import { startMachineListener } from "./machine-listener";
import { isLinkConnection, readClientConnectionState } from "./state";

let activeServer: Server<unknown> | null = null;
let activePort: number | null = null;
let activeSupervisor: ClientLinkSupervisor | null = null;
let recycleScheduled = false;

function cleanup(): void {
  removePid(process.pid);
  removeRuntimePort(process.pid);
}

export function standaloneRecycleEnv(
  env: NodeJS.ProcessEnv,
  disconnectedTokenFingerprint: string,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  const admissionToken = childEnv.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (admissionToken && serviceApiTokenFingerprint(admissionToken) !== disconnectedTokenFingerprint) {
    // A surviving env token shadows OCX_API_TOKEN_FILE entirely, so nothing below can
    // reintroduce the disconnected token.
    return childEnv;
  }
  if (admissionToken) delete childEnv.OPENCODEX_API_AUTH_TOKEN;
  // The respawned `ocx start` loads OCX_API_TOKEN_FILE into OPENCODEX_API_AUTH_TOKEN when the
  // env token is absent, so vet the file by content: drop the pointer when it is unreadable or
  // holds the disconnected token, keep it when it holds a different operator credential.
  if (!childEnv.OCX_API_TOKEN_FILE?.trim()) return childEnv;
  const fileToken = loadServiceTokenFromFile(childEnv);
  if (fileToken === null || serviceApiTokenFingerprint(fileToken) === disconnectedTokenFingerprint) {
    delete childEnv.OCX_API_TOKEN_FILE;
  }
  return childEnv;
}

export function scheduleStandaloneRecycle(disconnectedTokenFingerprint: string): void {
  if (recycleScheduled) return;
  recycleScheduled = true;
  const timer = setTimeout(() => {
    void recycleStandalone(disconnectedTokenFingerprint);
  }, 50);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

async function recycleStandalone(disconnectedTokenFingerprint: string): Promise<void> {
  const port = activePort;
  try {
    await activeSupervisor?.stop();
  } catch (error) {
    console.warn(`[client] link supervisor stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  activeSupervisor = null;
  try {
    activeServer?.stop(true);
  } catch (error) {
    console.warn(`[client] listener stop failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  cleanup();
  // Recycling back to standalone after `ocx disconnect` must actually bring a standalone
  // proxy back, under either launch shape.
  //
  // Unsupervised: spawn the replacement ourselves and exit 0.
  //
  // Supervised (`OCX_SERVICE=1`): do NOT spawn — the supervisor owns the process, and a
  // second copy would fight it for the port. But exit 0 does not work either: the real
  // supervisor configs are failure-only (systemd `Restart=on-failure`, WinSW
  // `<onfailure action="restart"/>`, the Task Scheduler ERRORLEVEL loop), so a clean exit
  // reads as "the service finished" and nothing restarts. The client stayed down until the
  // operator noticed. Exit 1 is what those configs are watching for, and it is the same
  // policy the dashboard recycle already uses (src/server/management/system-restart.ts).
  //
  // launchd's KeepAlive restarts on any exit, so it is correct under both branches.
  if (process.env.OCX_SERVICE === "1") {
    process.exit(1);
  }
  if (port) {
    const child = spawn(process.execPath, selfLaunchArgv(["start", "--port", String(port)]), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      // A sibling's replacement stays a sibling even if the owner is down while it probes.
      env: withSiblingMarker(standaloneRecycleEnv(process.env, disconnectedTokenFingerprint), issueSiblingHandoff),
    });
    child.unref();
  }
  process.exit(0);
}

export async function startClientRuntime(
  options: { port?: number; block?: boolean } = {},
): Promise<void> {
  const state = readClientConnectionState();
  if (state.kind !== "connected") throw new Error(`client runtime refused: client state is ${state.kind}`);
  const config = loadConfig();
  const linkMode = isLinkConnection(state.value);
  if (linkMode && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) {
    throw new Error("link mode requires a valid local config port");
  }
  const preferred = linkMode ? config.port : options.port ?? config.port ?? 10100;
  let port: number;
  try {
    port = await findAvailablePort(preferred, "127.0.0.1", {
      preferRetryMs: options.port === undefined ? 750 : 5_000,
      preferRetryIntervalMs: 50,
      allowEphemeralFallback: linkMode ? false : options.port === undefined,
    });
  } catch (error) {
    if (linkMode && error instanceof PortUnavailableError) {
      throw new Error(`link mode needs port ${config.port}; free it or change port`, { cause: error });
    }
    throw error;
  }
  const server = startMachineListener(port, { state: state.value });
  const boundPort = server.port ?? port;
  activeServer = server;
  activePort = boundPort;
  const supervisor = linkMode && existsSync(clientLinkStatePath())
    ? createClientLinkSupervisor({
      onLinkEnded: () => scheduleStandaloneRecycle(state.value.tokenFingerprint),
    })
    : null;
  activeSupervisor = supervisor;
  supervisor?.start();
  installCrashGuards();
  writePid(process.pid);
  writeRuntimePort({ pid: process.pid, port: boundPort, hostname: "127.0.0.1", ...siblingRuntimeField() });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        await supervisor?.stop();
      } catch (error) {
        console.warn(`[client] link supervisor stop failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      activeSupervisor = null;
      try {
        server.stop(true);
      } catch (error) {
        console.warn(`[client] listener stop failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        cleanup();
        process.exit(0);
      }
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") process.on("SIGHUP", shutdown);
  process.on("exit", cleanup);

  if (options.block ?? true) await new Promise<void>(() => {});
}
