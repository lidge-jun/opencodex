import { spawn } from "node:child_process";
import type { Server } from "bun";
import { loadConfig } from "../config";
import { removePid, removeRuntimePort, writePid, writeRuntimePort } from "../config/process-state";
import { installCrashGuards } from "../lib/crash-guard";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { serviceApiTokenFingerprint } from "../lib/service-secrets";
import { findAvailablePort } from "../server/ports";
import { startMachineListener } from "./machine-listener";
import { readClientConnectionState } from "./state";

let activeServer: Server<unknown> | null = null;
let activePort: number | null = null;
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
  if (admissionToken && serviceApiTokenFingerprint(admissionToken) === disconnectedTokenFingerprint) {
    delete childEnv.OPENCODEX_API_AUTH_TOKEN;
    delete childEnv.OCX_API_TOKEN_FILE;
  }
  return childEnv;
}

export function scheduleStandaloneRecycle(disconnectedTokenFingerprint: string): void {
  if (recycleScheduled) return;
  recycleScheduled = true;
  const timer = setTimeout(() => {
    const port = activePort;
    try { activeServer?.stop(true); } catch { /* best effort */ }
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
        env: standaloneRecycleEnv(process.env, disconnectedTokenFingerprint),
      });
      child.unref();
    }
    process.exit(0);
  }, 50);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export async function startClientRuntime(
  options: { port?: number; block?: boolean } = {},
): Promise<void> {
  const state = readClientConnectionState();
  if (state.kind !== "connected") throw new Error(`client runtime refused: client state is ${state.kind}`);
  const config = loadConfig();
  const preferred = options.port ?? config.port ?? 10100;
  const port = await findAvailablePort(preferred, "127.0.0.1", {
    preferRetryMs: options.port === undefined ? 750 : 5_000,
    preferRetryIntervalMs: 50,
    allowEphemeralFallback: options.port === undefined,
  });
  const server = startMachineListener(port, { state: state.value });
  const boundPort = server.port ?? port;
  activeServer = server;
  activePort = boundPort;
  installCrashGuards();
  writePid(process.pid);
  writeRuntimePort({ pid: process.pid, port: boundPort, hostname: "127.0.0.1" });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { server.stop(true); } finally {
      cleanup();
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") process.on("SIGHUP", shutdown);
  process.on("exit", cleanup);

  if (options.block ?? true) await new Promise<void>(() => {});
}
