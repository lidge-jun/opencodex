import { existsSync } from "node:fs";
import type { Server } from "bun";
import { siblingRuntimeField, withSiblingMarker } from "../codex/sibling-start";
import { loadConfig } from "../config";
import { removePid, removeRuntimePort, writePid, writeRuntimePort, type RuntimePortState } from "../config/process-state";
import { installCrashGuards } from "../lib/crash-guard";
import { createLocalAttestationSecret } from "../lib/local-management-attestation";
import { loadServiceTokenFromFile, serviceApiTokenFingerprint } from "../lib/service-secrets";
import {
  DESKTOP_RESTART_EXIT_CODE,
  DESKTOP_SUPERVISED_ENV,
  DESKTOP_SUPERVISED_PORT_WAIT_MS,
  isDesktopSupervised,
} from "../lib/system-restart-contract";
import { findAvailablePort, isAddrInUse, PortUnavailableError, waitForPortAvailable } from "../server/ports";
import type { ReplacementStartRequest } from "../server/restart-replacement";
import type { OcxClientConnectionConfig } from "../types";
import { createClientLinkSupervisor, type ClientLinkSupervisor } from "./link-tunnel";
import { clientLinkStatePath } from "./link-state";
import { startMachineListener } from "./machine-listener";
import { isLinkConnection, readClientConnectionState } from "./state";

let activeServer: Server<unknown> | null = null;
let activePort: number | null = null;
let activeSupervisor: ClientLinkSupervisor | null = null;
let recycleScheduled = false;

/**
 * How long link mode waits for its configured port: the budget a hard-pinned `ocx start --port`
 * gives `reclaimListenPort` (`src/cli/index.ts`).
 */
export const LINK_PORT_WAIT_MS = 60_000;

/** How long a pinned port is re-probed after the reclaim wait before the start gives up on it. */
export const PINNED_PREFER_RETRY_MS = 5_000;

/**
 * Link mode's port-reclaim budget. Under the desktop app the whole wait (this plus
 * {@link PINNED_PREFER_RETRY_MS}) ends inside the app's 30-second startup deadline, so the app sees
 * this start either serve or exit instead of giving up on it first.
 */
export function linkPortWaitMs(desktopSupervised: boolean = isDesktopSupervised()): number {
  return desktopSupervised ? DESKTOP_SUPERVISED_PORT_WAIT_MS : LINK_PORT_WAIT_MS;
}
/** Bind attempts when the port is taken between the free-port probe and `Bun.serve`. */
const LINK_BIND_ATTEMPTS = 3;

export interface ClientRuntimeIo {
  /** Link-mode port budget; defaults to {@link LINK_PORT_WAIT_MS}. */
  portWaitMs?: number;
  startListener?: typeof startMachineListener;
}

export interface StandaloneRecycleIo {
  spawnReplacement?: (request: ReplacementStartRequest) => Promise<void>;
  exitProcess?: (code: number) => void;
  configuredPort?: () => number | undefined;
  isDesktopSupervised?: () => boolean;
}

function cleanup(): void {
  removePid(process.pid);
  removeRuntimePort(process.pid);
}

/**
 * What this runtime publishes in `runtime-port.json`. The attestation secret is what the desktop app
 * reads to authenticate the runtime it started (`desktop/src-tauri/src/auth.rs`); a record without one
 * reads as unusable there, the same as a standalone start's record would.
 */
export function clientRuntimeRecord(
  pid: number,
  port: number,
  attestationSecret: string = createLocalAttestationSecret(),
): RuntimePortState {
  return { pid, port, hostname: "127.0.0.1", attestationSecret, ...siblingRuntimeField() };
}

export function standaloneRecycleEnv(
  env: NodeJS.ProcessEnv,
  disconnectedTokenFingerprint: string,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  // A detached replacement is not the desktop app's child.
  delete childEnv[DESKTOP_SUPERVISED_ENV];
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

function configuredTcpPort(): number | undefined {
  try {
    const port = loadConfig().port;
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "failed";
}

export async function recycleStandalone(
  disconnectedTokenFingerprint: string,
  io: StandaloneRecycleIo = {},
): Promise<void> {
  // The configured port when the listener never recorded one: the recycle still owes a proxy.
  const port = activePort ?? (io.configuredPort ?? configuredTcpPort)();
  const exit = io.exitProcess ?? ((code: number) => { process.exit(code); });
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
  // proxy back, under every launch shape.
  //
  // Under the desktop app that spawned us: exit 75 and let the app start the standalone
  // runtime, so it keeps owning it (tray Stop, Quit) instead of losing it to a detached child.
  if ((io.isDesktopSupervised ?? isDesktopSupervised)()) {
    exit(DESKTOP_RESTART_EXIT_CODE);
    return;
  }
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
    exit(1);
    return;
  }
  if (port === undefined) {
    console.warn("[client] no valid port to restart the standalone proxy on; run 'ocx start'");
    exit(1);
    return;
  }
  // Wait until the replacement answers (it retries an early exit) instead of exiting the moment
  // it spawned: a replacement that died unseen left no proxy and nothing to report it.
  try {
    const spawnReplacement = io.spawnReplacement
      ?? (async (request: ReplacementStartRequest) => (await import("../server/restart-replacement")).spawnReplacementStart(request));
    await spawnReplacement({
      port,
      waitForHealth: true,
      // A sibling's replacement stays a sibling even if the owner is down while it probes.
      env: withSiblingMarker(standaloneRecycleEnv(process.env, disconnectedTokenFingerprint)),
    });
  } catch (error) {
    console.warn(`[client] the standalone replacement did not start (${errorCode(error)}); run 'ocx start'`);
    exit(1);
    return;
  }
  exit(0);
}

/**
 * Bind the client listener. Link mode is pinned to the configured port because Codex routes to it:
 * like a hard-pinned `ocx start --port`, it waits for a port that a restarting parent is still
 * releasing, never kills the holder and never hops. The waits run only while the port is busy; a
 * free port binds on the first probe.
 */
export async function bindClientListener(
  request: {
    state: OcxClientConnectionConfig;
    linkMode: boolean;
    preferred: number;
    explicitPort: boolean;
    configuredPort: number;
  },
  io: ClientRuntimeIo = {},
): Promise<{ server: Server<unknown>; port: number }> {
  const { linkMode } = request;
  const portWaitMs = io.portWaitMs ?? (linkMode ? linkPortWaitMs() : LINK_PORT_WAIT_MS);
  const deadline = Date.now() + portWaitMs;
  const busy = (cause: unknown) => new Error(
    `link mode needs port ${request.configuredPort}; free it or change port`,
    { cause },
  );
  let port: number;
  try {
    if (linkMode) {
      const { reclaimListenPort } = await import("../server/port-reclaim");
      await reclaimListenPort(request.configuredPort, "127.0.0.1", {
        timeoutMs: portWaitMs,
        intervalMs: 100,
        scanIntervalMs: 500,
        killOcxHolders: false,
        dropTcpRows: true,
      });
    }
    port = await findAvailablePort(request.preferred, "127.0.0.1", {
      preferRetryMs: request.explicitPort ? PINNED_PREFER_RETRY_MS : 750,
      preferRetryIntervalMs: 50,
      allowEphemeralFallback: linkMode ? false : !request.explicitPort,
    });
  } catch (error) {
    if (linkMode && error instanceof PortUnavailableError) throw busy(error);
    throw error;
  }
  const startListener = io.startListener ?? startMachineListener;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const server = startListener(port, { state: request.state });
      return { server, port: server.port ?? port };
    } catch (error) {
      // Check-then-bind: the port can be taken between the probe and Bun.serve.
      if (!linkMode || !isAddrInUse(error)) throw error;
      const waitMs = Math.max(1_000, deadline - Date.now());
      if (attempt >= LINK_BIND_ATTEMPTS
        || !(await waitForPortAvailable(port, "127.0.0.1", { timeoutMs: waitMs, intervalMs: 100 }))) {
        throw busy(error);
      }
    }
  }
}

export async function startClientRuntime(
  options: { port?: number; block?: boolean } = {},
  io: ClientRuntimeIo = {},
): Promise<void> {
  const state = readClientConnectionState();
  if (state.kind !== "connected") throw new Error(`client runtime refused: client state is ${state.kind}`);
  const config = loadConfig();
  const linkMode = isLinkConnection(state.value);
  if (linkMode && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) {
    throw new Error("link mode requires a valid local config port");
  }
  const preferred = linkMode ? config.port : options.port ?? config.port ?? 10100;
  const { server, port: boundPort } = await bindClientListener({
    state: state.value,
    linkMode,
    preferred,
    explicitPort: options.port !== undefined,
    configuredPort: config.port,
  }, io);
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
  writeRuntimePort(clientRuntimeRecord(process.pid, boundPort));

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
