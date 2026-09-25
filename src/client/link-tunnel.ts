import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { linkDir, linkKnownHostsPath } from "../link/paths";
import { buildTunnelArgv } from "../link/ssh-argv";
import { createSshRunner, type SshChild, type SshRunner } from "../link/ssh-runner";
import {
  classifySshStderr,
  dueForSpawn,
  IDLE,
  reduceTunnel,
  type TunnelState,
} from "../link/tunnel-state";
import { isLinkPort } from "../link/ports";
import { isLinkConnection, readClientConnectionState } from "./state";
import { clientLinkStatePath, readClientLinkState, type ClientLinkState } from "./link-state";

/**
 * The client-owned `ssh -N -L 127.0.0.1:<tunnelPort>:127.0.0.1:<peerListenerPort> <alias>`
 * of a client-initiated link. Two owners use it: the dashboard join (a short-lived tunnel that
 * lives only until the in-process connect finishes) and the client runtime supervisor.
 */
export interface ClientLinkTunnelSpec {
  linkId: string;
  alias: string;
  tunnelPort: number;
  peerListenerPort: number;
}

export interface ClientLinkTunnelHandle {
  readonly pid: number;
  readonly exited: Promise<number>;
  /** TERM, wait up to 5 s, then KILL; removes the pidfile this handle wrote. Idempotent. */
  stop(): Promise<void>;
}

export interface ClientLinkTunnelDeps {
  runner?: SshRunner;
  configDir?: string;
  knownHostsFile?: string;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export type OrphanTunnelResult =
  | { tunnel: "reaped" }
  | { tunnel: "absent" }
  | { tunnel: "owned" }
  | { tunnel: "unresolved"; pid: number };

export interface OrphanReapDeps {
  configDir?: string;
  platform?: NodeJS.Platform;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export type ClientLinkSupervisorStatus =
  | { kind: "stopped" }
  | { kind: "tunnel"; linkId: string; state: TunnelState; pid: number | null }
  | { kind: "failed"; reason: "sidecar_invalid" };

export interface ClientLinkTunnelStatusProjection {
  alias: string;
  state: "failed";
  since: string;
  reason: "sidecar_invalid";
}

export interface ClientLinkSupervisor {
  start(): void;
  /** Stops the tunnel (TERM, up to 5 s, KILL). The runtime calls this before stopping its listener. */
  stop(): Promise<void>;
  status(): ClientLinkSupervisorStatus;
}

/** Read-only status bridge for a client whose persisted sidecar cannot be trusted. */
export function clientLinkTunnelStatus(
  path: string = clientLinkStatePath(),
  now: () => number = Date.now,
): ClientLinkTunnelStatusProjection | null {
  try {
    readClientLinkState(path);
    return null;
  } catch {
    return { alias: "unknown", state: "failed", since: new Date(now()).toISOString(), reason: "sidecar_invalid" };
  }
}

export interface ClientLinkSupervisorDeps extends ClientLinkTunnelDeps, OrphanReapDeps {
  readSidecar?: () => ClientLinkState | null;
  /** Current link id of a connected link-transport client, or null when that no longer holds. */
  connectedLinkId?: () => string | null;
  /** Called once after the tunnel stopped because the link ended (the runtime recycles here). */
  onLinkEnded?: () => void;
  now?: () => number;
  random?: () => number;
  warn?: (message: string) => void;
}

export function clientTunnelPidfilePath(configDir?: string): string {
  return join(linkDir(configDir), "client-tunnel.pid");
}

/**
 * Pidfile body at `clientTunnelPidfilePath()`: `{ version: 1, linkId, pid, argv, ownerPid }`.
 * `ownerPid` is the process that spawned the tunnel. A tunnel is an orphan only while its owner
 * is gone; a live owner means the tunnel is managed and `reapOrphanTunnel` reports "owned".
 */
export interface ClientTunnelPidfile {
  version: 1;
  linkId: string;
  pid: number;
  argv: string[];
  ownerPid: number;
}

const STOP_TIMEOUT_MS = 5_000;
const TIMER_MS = 1_000;
const SPAWN_GRACE_MS = 5_000;

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePidfile(value: unknown): ClientTunnelPidfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.linkId !== "string" || typeof raw.pid !== "number"
    || !Number.isSafeInteger(raw.pid) || raw.pid < 1 || !Array.isArray(raw.argv)
    || raw.argv.length === 0 || raw.argv.some(item => typeof item !== "string")
    || typeof raw.ownerPid !== "number" || !Number.isSafeInteger(raw.ownerPid) || raw.ownerPid < 1) return null;
  return {
    version: 1,
    linkId: raw.linkId,
    pid: raw.pid,
    argv: raw.argv as string[],
    ownerPid: raw.ownerPid,
  };
}

function readPidfile(path: string): ClientTunnelPidfile | null {
  try {
    return parsePidfile(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    return null;
  }
}

function writePidfile(path: string, value: ClientTunnelPidfile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${JSON.stringify(value)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function removePidfileIfPid(path: string, pid: number): void {
  const current = readPidfile(path);
  if (current?.pid !== pid) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function linuxProcessArgv(pid: number): readonly string[] | null {
  try {
    const values = readFileSync(`/proc/${pid}/cmdline`).toString().split("\0");
    if (values.at(-1) === "") values.pop();
    return values.length > 0 ? values : null;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    return null;
  }
}

function timerDeps(deps: ClientLinkTunnelDeps): Required<Pick<ClientLinkTunnelDeps, "setTimer" | "clearTimer">> {
  return {
    setTimer: deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms)),
    clearTimer: deps.clearTimer ?? (timer => clearTimeout(timer)),
  };
}

async function stopChild(child: SshChild, deps: ClientLinkTunnelDeps): Promise<void> {
  const { setTimer, clearTimer } = timerDeps(deps);
  try {
    child.kill("SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  const exitedPromise = child.exited.then(() => { exited = true; }, () => { exited = true; });
  const timeout = new Promise<void>(resolve => {
    timer = setTimer(resolve, STOP_TIMEOUT_MS);
  });
  await Promise.race([exitedPromise, timeout]);
  if (timer !== undefined) clearTimer(timer);
  if (!exited) {
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export function spawnClientLinkTunnel(spec: ClientLinkTunnelSpec, deps: ClientLinkTunnelDeps = {}): ClientLinkTunnelHandle {
  if (!isLinkPort(spec.tunnelPort)) throw new Error("client tunnel port is outside the link range");
  const knownHostsFile = deps.knownHostsFile ?? linkKnownHostsPath(deps.configDir);
  const runner = deps.runner ?? createSshRunner();
  const argv = buildTunnelArgv({
    alias: spec.alias,
    direction: "L",
    bindPort: spec.tunnelPort,
    targetPort: spec.peerListenerPort,
    knownHostsFile,
  });
  const child = runner.spawnTunnel(argv);
  const pidfile = clientTunnelPidfilePath(deps.configDir);
  try {
    writePidfile(pidfile, { version: 1, linkId: spec.linkId, pid: child.pid, argv: [...argv], ownerPid: process.pid });
  } catch (error) {
    try { child.kill("SIGTERM"); } catch (killError) { if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError; }
    throw error;
  }

  let stopPromise: Promise<void> | undefined;
  const handleExit = (): void => {
    removePidfileIfPid(pidfile, child.pid);
  };
  const handle = {
    pid: child.pid,
    exited: child.exited,
    stderr: child.stderr,
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = stopChild(child, deps).finally(() => removePidfileIfPid(pidfile, child.pid));
      return stopPromise;
    },
  } satisfies ClientLinkTunnelHandle & { stderr?: Promise<string> };
  void child.exited.then(handleExit, handleExit);
  return handle;
}

export async function reapOrphanTunnel(deps: OrphanReapDeps = {}): Promise<OrphanTunnelResult> {
  const path = clientTunnelPidfilePath(deps.configDir);
  const pidfile = readPidfile(path);
  if (!pidfile) return { tunnel: "absent" };
  const isAlive = deps.isAlive ?? defaultIsAlive;
  if (isAlive(pidfile.ownerPid)) return { tunnel: "owned" };
  const platform = deps.platform ?? process.platform;
  if (platform !== "linux") return { tunnel: "unresolved", pid: pidfile.pid };
  const readProcessArgv = deps.readProcessArgv ?? linuxProcessArgv;
  const actualArgv = readProcessArgv(pidfile.pid);
  if (!actualArgv || !sameArgv(actualArgv, pidfile.argv)) {
    try { unlinkSync(path); } catch (error) { if (!isMissingPathError(error)) throw error; }
    return { tunnel: "absent" };
  }
  const signal = deps.signal ?? defaultSignal;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try { signal(pidfile.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  await sleep(STOP_TIMEOUT_MS);
  if (isAlive(pidfile.pid)) {
    try { signal(pidfile.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  try { unlinkSync(path); } catch (error) { if (!isMissingPathError(error)) throw error; }
  return { tunnel: "reaped" };
}

function defaultConnectedLinkId(): string | null {
  const state = readClientConnectionState();
  if (state.kind !== "connected" || !isLinkConnection(state.value)) return null;
  return state.value.link?.linkId ?? null;
}

export function createClientLinkSupervisor(deps: ClientLinkSupervisorDeps = {}): ClientLinkSupervisor {
  const readSidecar = deps.readSidecar ?? (() => readClientLinkState(clientLinkStatePath(deps.configDir)));
  const connectedLinkId = deps.connectedLinkId ?? defaultConnectedLinkId;
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const setSupervisorTimer = deps.setTimer
    ?? ((callback: () => void, ms: number) => setInterval(callback, ms) as unknown as ReturnType<typeof setTimeout>);
  const clearSupervisorTimer = deps.clearTimer
    ?? ((timer: ReturnType<typeof setTimeout>) => clearInterval(timer as unknown as ReturnType<typeof setInterval>));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopping = false;
  let initialized = false;
  let initializing = false;
  let onLinkEndedCalled = false;
  let child: ClientLinkTunnelHandle | undefined;
  let state: TunnelState = IDLE;
  let linkId: string | null = null;
  let failure: ClientLinkSupervisorStatus | undefined;
  let tickFlight: Promise<void> | undefined;

  const readCurrent = (): { sidecar: ClientLinkState | null; invalid: boolean } => {
    try {
      return { sidecar: readSidecar(), invalid: false };
    } catch (error) {
      deps.warn?.("client link sidecar could not be read");
      return { sidecar: null, invalid: true };
    }
  };

  const stopTunnel = async (): Promise<void> => {
    const current = child;
    child = undefined;
    state = reduceTunnel(state, { type: "stop" });
    if (current) await current.stop();
  };

  const endLink = async (): Promise<void> => {
    await stopTunnel();
    if (onLinkEndedCalled || stopping) return;
    linkId = null;
    onLinkEndedCalled = true;
    deps.onLinkEnded?.();
  };

  const spawn = (sidecar: ClientLinkState): void => {
    if (stopping || child || state.kind === "failed") return;
    try {
      child = spawnClientLinkTunnel({
        linkId: sidecar.linkId,
        alias: sidecar.alias,
        tunnelPort: sidecar.tunnelPort,
        peerListenerPort: sidecar.peerListenerPort,
      }, deps);
      linkId = sidecar.linkId;
      state = reduceTunnel(state, { type: "spawn", now: now() }, random);
      const current = child;
      void current.exited.then(async () => {
        if (child !== current) return;
        child = undefined;
        const stderr = (current as ClientLinkTunnelHandle & { stderr?: Promise<string> }).stderr
          ? await (current as ClientLinkTunnelHandle & { stderr?: Promise<string> }).stderr!.catch(() => "")
          : "";
        const next = reduceTunnel(state, { type: "exit", now: now(), stderrClass: classifySshStderr(stderr) }, random);
        state = next;
      }).catch(() => {
        if (child !== current) return;
        child = undefined;
        state = reduceTunnel(state, { type: "exit", now: now(), stderrClass: "network" }, random);
      });
    } catch (error) {
      state = { kind: "failed", since: now(), reason: "forward" };
      deps.warn?.("client link tunnel could not be started");
    }
  };

  const tick = async (): Promise<void> => {
    if (stopping || !initialized) return;
    const current = readCurrent();
    if (current.invalid) {
      failure = { kind: "failed", reason: "sidecar_invalid" };
      await stopTunnel();
      return;
    }
    const connected = connectedLinkId();
    if (!current.sidecar) {
      if (child || linkId) await endLink();
      return;
    }
    if (connected !== current.sidecar.linkId) {
      if (child || linkId) await endLink();
      return;
    }
    failure = undefined;
    const timestamp = now();
    state = reduceTunnel(state, { type: "tick", now: timestamp }, random);
    if (child && state.kind === "connecting" && timestamp - state.since >= SPAWN_GRACE_MS) {
      state = reduceTunnel(state, { type: "ready", now: timestamp }, random);
    }
    if (state.kind === "failed" && child) await stopTunnel();
    else if (!child && (state.kind === "idle" || dueForSpawn(state, timestamp))) spawn(current.sidecar);
  };

  const runTick = (): void => {
    if (tickFlight) return;
    tickFlight = tick().finally(() => { tickFlight = undefined; });
  };

  const initialize = async (): Promise<void> => {
    if (initializing || initialized || stopping) return;
    initializing = true;
    const current = readCurrent();
    if (current.invalid) {
      failure = { kind: "failed", reason: "sidecar_invalid" };
      initialized = true;
      initializing = false;
      return;
    }
    if (current.sidecar && connectedLinkId() === current.sidecar.linkId) {
      const orphan = await reapOrphanTunnel(deps);
      if (orphan.tunnel === "owned" || orphan.tunnel === "unresolved") {
        linkId = current.sidecar.linkId;
        state = { kind: "connected", since: now() };
        initialized = true;
        initializing = false;
        return;
      }
      const afterReap = readCurrent();
      if (!afterReap.invalid && afterReap.sidecar && connectedLinkId() === afterReap.sidecar.linkId) spawn(afterReap.sidecar);
    }
    initialized = true;
    initializing = false;
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      stopping = false;
      timer = setSupervisorTimer(runTick, TIMER_MS);
      void initialize().catch(() => {
        failure = { kind: "failed", reason: "sidecar_invalid" };
        initialized = true;
        initializing = false;
      });
    },
    async stop(): Promise<void> {
      if (stopping) {
        if (tickFlight) await tickFlight;
        return;
      }
      stopping = true;
      if (timer !== undefined) {
        clearSupervisorTimer(timer);
        timer = undefined;
      }
      if (tickFlight) await tickFlight;
      await stopTunnel();
      failure = undefined;
    },
    status(): ClientLinkSupervisorStatus {
      if (failure) return failure;
      if (!child && !linkId) return { kind: "stopped" };
      return { kind: "tunnel", linkId: linkId ?? "", state, pid: child?.pid ?? null };
    },
  };
}
