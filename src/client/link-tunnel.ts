import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, isMissingPathError } from "../config/atomic-write";
import { getConfigPath } from "../config/paths";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { linkDir, linkKnownHostsPath } from "../link/paths";
import { buildTunnelArgv } from "../link/ssh-argv";
import { createSshRunner, type SshChild, type SshRunner } from "../link/ssh-runner";
import {
  CLIENT_TUNNEL_RETRY_POLICY,
  classifySshStderr,
  dueForSpawn,
  failedTunnel,
  IDLE,
  reduceTunnel,
  type StderrClass,
  type TunnelState,
} from "../link/tunnel-state";
import { isLinkPort } from "../link/ports";
import { isLinkConnection, readClientConnectionState } from "./state";
import { clientLinkStatePath, readClientLinkState, type ClientLinkState } from "./link-state";
import type { LinkTunnelGate } from "./link-relay";

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
  | { tunnel: "owned"; pid?: number }
  | { tunnel: "unresolved"; pid: number };

/** A macOS process as `ps -o ppid= -o args=` shows it: the parent pid and the space-joined argv. */
export interface DarwinProcessInfo {
  ppid: number;
  args: string;
}

export interface OrphanReapDeps {
  configDir?: string;
  platform?: NodeJS.Platform;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  /** macOS: the parent pid and argv of `pid`, or null when they cannot be read. */
  readProcessInfo?: (pid: number) => DarwinProcessInfo | null;
  isAlive?: (pid: number) => boolean;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What the periodic keyed probe last saw, for display only: it never changes a connected tunnel.
 * `home_not_ready` is a Home that admitted the key but reports its own startup readiness as pending
 * or failed; its link still works.
 */
export type ClientTunnelProbeReason = "unauthorized" | "home_unreachable" | "home_not_ready";

export type ClientLinkSupervisorStatus =
  | { kind: "stopped" }
  | { kind: "tunnel"; linkId: string; state: TunnelState; pid: number | null; probe?: ClientTunnelProbeReason }
  | { kind: "failed"; reason: "sidecar_invalid" };

export interface ClientLinkTunnelStatusProjection {
  alias: string;
  state: "failed";
  since: string;
  reason: "sidecar_invalid";
}

/** The supervisor is also the relay's tunnel gate: requests wait on it while it reconnects. */
export interface ClientLinkSupervisor extends LinkTunnelGate {
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

/** `connectedLinkId` when the connection state could not be read (a write in flight, a bad file). */
export const CONNECTION_UNREADABLE = "unreadable";

export interface ClientLinkSupervisorDeps extends ClientLinkTunnelDeps, OrphanReapDeps {
  readSidecar?: () => ClientLinkState | null;
  /**
   * Current link id of a connected link-transport client, null when that no longer holds, or
   * `CONNECTION_UNREADABLE` when the connection state could not be read.
   */
  connectedLinkId?: () => string | null | typeof CONNECTION_UNREADABLE;
  /** Called once after the tunnel stopped because the link ended (the runtime recycles here). */
  onLinkEnded?: () => void;
  /** The link key for the keyed readiness probe. The runtime passes its cached key source. */
  linkKey?: () => string | null;
  fetchImpl?: typeof fetch;
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
const REAP_POLL_MS = 100;
const TIMER_MS = 1_000;
/** Consecutive unreadable reads before the supervisor acts on them. */
export const INVALID_READ_TICKS = 3;
/** How often a connected tunnel is probed. The result is display-only. */
export const CONNECTED_PROBE_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_BACKOFF_MAX_MS = 5_000;
/** A Home `/readyz` body is a few hundred bytes; a larger one is not the Home's. */
const PROBE_BODY_MAX_BYTES = 4_096;
/** Requests that may wait on a reconnecting tunnel at once; more are answered 503 at once. */
export const CLIENT_LINK_MAX_HOLDS = 64;

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

/** `ps -ww -o ppid= -o args= -p <pid>`: one line, the right-aligned parent pid, one space, the argv. */
function darwinProcessInfo(pid: number): DarwinProcessInfo | null {
  try {
    const result = Bun.spawnSync(["/bin/ps", "-ww", "-o", "ppid=", "-o", "args=", "-p", String(pid)], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return null;
    const match = /^\s*(\d+) (.+)$/.exec(result.stdout.toString().replace(/\r?\n$/, ""));
    return match ? { ppid: Number(match[1]), args: match[2]! } : null;
  } catch {
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

type TunnelIdentity =
  | { kind: "gone" }
  | { kind: "other" }
  | { kind: "ours"; orphaned: boolean }
  | { kind: "unknown" };

/**
 * Whether the pidfile's process is still our tunnel. Linux compares `/proc/<pid>/cmdline` with
 * the recorded argv. macOS compares `ps` args with the argv joined by spaces and reports the
 * process orphaned only when launchd (pid 1) is its parent. Elsewhere a live process is unknown.
 */
function tunnelIdentity(
  pidfile: ClientTunnelPidfile,
  platform: NodeJS.Platform,
  deps: OrphanReapDeps,
  isAlive: (pid: number) => boolean,
): TunnelIdentity {
  if (platform === "linux") {
    const actualArgv = (deps.readProcessArgv ?? linuxProcessArgv)(pidfile.pid);
    if (!actualArgv) return { kind: "gone" };
    return sameArgv(actualArgv, pidfile.argv) ? { kind: "ours", orphaned: true } : { kind: "other" };
  }
  if (!isAlive(pidfile.pid)) return { kind: "gone" };
  if (platform !== "darwin") return { kind: "unknown" };
  const info = (deps.readProcessInfo ?? darwinProcessInfo)(pidfile.pid);
  if (!info) return { kind: "unknown" };
  if (info.args !== pidfile.argv.join(" ")) return { kind: "other" };
  return { kind: "ours", orphaned: info.ppid === 1 };
}

/**
 * Settle a leftover tunnel pidfile before a new tunnel starts.
 *
 * - A pidfile whose process is gone, or is provably another program (a reused pid, as after a
 *   reboot), is stale: it is removed and the result is `absent`, so a new tunnel starts.
 * - While the owner lives, a tunnel that is still ours (or cannot be told apart) is `owned`.
 * - After the owner exits, a proven orphan is reaped: Linux on an exact `/proc` argv match, macOS
 *   on an exact `ps` argv match with launchd as the parent. TERM, up to five seconds, KILL.
 * - Anything else is `unresolved`: never signalled; the caller watches it.
 */
export async function reapOrphanTunnel(deps: OrphanReapDeps = {}): Promise<OrphanTunnelResult> {
  const path = clientTunnelPidfilePath(deps.configDir);
  const pidfile = readPidfile(path);
  if (!pidfile) return { tunnel: "absent" };
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const platform = deps.platform ?? process.platform;
  const identity = tunnelIdentity(pidfile, platform, deps, isAlive);
  if (identity.kind === "gone" || identity.kind === "other") {
    removePidfileIfPid(path, pidfile.pid);
    return { tunnel: "absent" };
  }
  if (isAlive(pidfile.ownerPid)) return { tunnel: "owned", pid: pidfile.pid };
  if (identity.kind !== "ours" || !identity.orphaned) return { tunnel: "unresolved", pid: pidfile.pid };
  const signal = deps.signal ?? defaultSignal;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  try { signal(pidfile.pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  for (let waited = 0; waited < STOP_TIMEOUT_MS && isAlive(pidfile.pid); waited += REAP_POLL_MS) await sleep(REAP_POLL_MS);
  if (isAlive(pidfile.pid)) {
    try { signal(pidfile.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  removePidfileIfPid(path, pidfile.pid);
  return { tunnel: "reaped" };
}

function defaultConnectedLinkId(): string | null | typeof CONNECTION_UNREADABLE {
  const state = readClientConnectionState();
  if (state.kind === "invalid" || state.kind === "mismatched") return CONNECTION_UNREADABLE;
  if (state.kind !== "connected" || !isLinkConnection(state.value)) return null;
  return state.value.link?.linkId ?? null;
}

function fileSignature(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    return isMissingPathError(error) ? "missing" : null;
  }
}

/**
 * `read` again only when the file at `path` changed, so a steady link costs one stat per check
 * instead of a parse. A read that throws, a value `keep` refuses, or a failed stat is never cached.
 */
export function readWhenFileChanges<T>(path: () => string, read: () => T, keep: (value: T) => boolean = () => true): () => T {
  let cached: { signature: string; value: T } | null = null;
  return () => {
    const signature = fileSignature(path());
    if (signature !== null && cached?.signature === signature) return cached.value;
    cached = null;
    const value = read();
    if (signature !== null && keep(value)) cached = { signature, value };
    return value;
  };
}

/** `ready` and `home_not_ready` both prove the link works; the rest do not. */
type ProbeResult = "ready" | ClientTunnelProbeReason;

/** Whether a 503 `/readyz` body is the Home's own readiness answer (`service: "opencodex"`). */
async function isOpencodexReadiness(response: Response, signal: AbortSignal): Promise<boolean> {
  try {
    const { bytes, oversized } = await readBoundedResponseBytes(response, { maxBytes: PROBE_BODY_MAX_BYTES, signal });
    if (oversized) return false;
    const body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return typeof body === "object" && body !== null && (body as { service?: unknown }).service === "opencodex";
  } catch {
    return false;
  }
}

/**
 * `GET /readyz` through the tunnel with the link key; the key is sent as a header only. The Home's
 * link listener answers 401 before it reaches `/readyz`, so both a 200 and a 503 carrying the
 * Home's readiness body prove that the forward reaches that listener and that the key is admitted.
 * The 503 only means the Home's own startup readiness is pending or failed, which does not stop
 * relayed requests; it is reported as `home_not_ready`, for display.
 */
async function probeTunnel(fetchImpl: typeof fetch, tunnelPort: number, key: string, stop: AbortSignal): Promise<ProbeResult> {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(PROBE_TIMEOUT_MS)]);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${tunnelPort}/readyz`, {
      headers: { "x-opencodex-api-key": key },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
    if (response.status === 503) return await isOpencodexReadiness(response, signal) ? "home_not_ready" : "home_unreachable";
    try { await response.body?.cancel(); } catch { /* the body is not needed */ }
    if (response.status === 200) return "ready";
    return response.status === 401 || response.status === 403 ? "unauthorized" : "home_unreachable";
  } catch {
    return "home_unreachable";
  }
}

export function createClientLinkSupervisor(deps: ClientLinkSupervisorDeps = {}): ClientLinkSupervisor {
  const sidecarPath = (): string => clientLinkStatePath(deps.configDir);
  const readSidecar = deps.readSidecar ?? readWhenFileChanges(sidecarPath, () => readClientLinkState(sidecarPath()));
  const connectedLinkId = deps.connectedLinkId
    ?? readWhenFileChanges(getConfigPath, defaultConnectedLinkId, value => value !== CONNECTION_UNREADABLE);
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const policy = CLIENT_TUNNEL_RETRY_POLICY;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const linkKey = deps.linkKey ?? (() => null);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setSupervisorTimer = deps.setTimer ?? ((callback: () => void, ms: number) => {
    const interval = setInterval(callback, ms);
    (interval as { unref?: () => void }).unref?.();
    return interval as unknown as ReturnType<typeof setTimeout>;
  });
  const clearSupervisorTimer = deps.clearTimer
    ?? ((timer: ReturnType<typeof setTimeout>) => clearInterval(timer as unknown as ReturnType<typeof setInterval>));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopping = false;
  let initialized = false;
  let initializing = false;
  let onLinkEndedCalled = false;
  let child: ClientLinkTunnelHandle | undefined;
  /** A leftover tunnel this supervisor may not signal: watched, and replaced once it dies. */
  let adopted: number | null = null;
  let state: TunnelState = IDLE;
  let linkId: string | null = null;
  let failure: ClientLinkSupervisorStatus | undefined;
  let tickFlight: Promise<void> | undefined;
  /** The one keyed probe in flight, which tunnel it probes, and the abort that stop() fires. */
  let probeFlight: { child: ClientLinkTunnelHandle | undefined; adopted: number | null; abort: AbortController } | undefined;
  let probe: ClientTunnelProbeReason | null = null;
  let nextProbeAt = 0;
  let probeFailures = 0;
  let invalidReads = 0;
  /** A leftover tunnel pidfile has not been settled yet; nothing may spawn until it is. */
  let reapPending = true;
  const waiters = new Set<(connected: boolean) => void>();

  /** The tunnel is being (re)established, so a request may wait for it instead of failing. */
  const pending = (): boolean => !stopping && failure === undefined
    && ((started && !initialized) || state.kind === "connecting" || state.kind === "reconnecting");

  const settleWaiters = (): void => {
    if (waiters.size === 0) return;
    const connected = !stopping && failure === undefined && state.kind === "connected";
    if (!connected && pending()) return;
    for (const settle of [...waiters]) settle(connected);
  };

  const setState = (next: TunnelState): void => {
    state = next;
    settleWaiters();
  };

  const awaitingReady = (): boolean => state.kind === "connecting" || state.kind === "reconnecting"
    || (state.kind === "failed" && state.inFlight === true);

  const readCurrent = (): { sidecar: ClientLinkState | null; invalid: boolean } => {
    try {
      return { sidecar: readSidecar(), invalid: false };
    } catch {
      deps.warn?.("client link sidecar could not be read");
      return { sidecar: null, invalid: true };
    }
  };

  const readConnectedLinkId = (): string | null | typeof CONNECTION_UNREADABLE => {
    try {
      return connectedLinkId();
    } catch {
      return CONNECTION_UNREADABLE;
    }
  };

  /** Drops the probe in flight; its answer, if it still comes, is ignored. */
  const abortProbe = (): void => {
    const flight = probeFlight;
    probeFlight = undefined;
    flight?.abort.abort();
  };

  /** Stops our own child only; the tunnel state is left for the caller to decide. */
  const killChild = async (): Promise<void> => {
    const current = child;
    child = undefined;
    probe = null;
    abortProbe();
    if (current) await current.stop();
  };

  const stopTunnel = async (): Promise<void> => {
    adopted = null;
    setState(reduceTunnel(state, { type: "stop" }));
    await killChild();
  };

  const endLink = async (): Promise<void> => {
    await stopTunnel();
    if (onLinkEndedCalled || stopping) return;
    linkId = null;
    onLinkEndedCalled = true;
    deps.onLinkEnded?.();
  };

  const onExit = (stderrClass: StderrClass): void => {
    setState(reduceTunnel(state, { type: "exit", now: now(), stderrClass }, random, policy));
  };

  const spawn = (sidecar: ClientLinkState): void => {
    if (stopping || child || adopted !== null || reapPending) return;
    const timestamp = now();
    if (state.kind === "failed" && !dueForSpawn(state, timestamp)) return;
    try {
      child = spawnClientLinkTunnel({
        linkId: sidecar.linkId,
        alias: sidecar.alias,
        tunnelPort: sidecar.tunnelPort,
        peerListenerPort: sidecar.peerListenerPort,
      }, deps);
    } catch {
      setState(failedTunnel("forward", timestamp, policy, state.kind === "failed" ? state.since : timestamp));
      deps.warn?.("client link tunnel could not be started");
      return;
    }
    linkId = sidecar.linkId;
    probe = null;
    probeFailures = 0;
    nextProbeAt = timestamp;
    setState(reduceTunnel(state, { type: "spawn", now: timestamp }, random, policy));
    const current = child;
    void current.exited.then(async () => {
      if (child !== current) return;
      child = undefined;
      probe = null;
      const stderr = (current as ClientLinkTunnelHandle & { stderr?: Promise<string> }).stderr
        ? await (current as ClientLinkTunnelHandle & { stderr?: Promise<string> }).stderr!.catch(() => "")
        : "";
      onExit(classifySshStderr(stderr));
    }).catch(() => {
      if (child !== current) return;
      child = undefined;
      probe = null;
      onExit("network");
    });
  };

  /**
   * Applies one keyed probe's answer. While the tunnel is being established an answer that proves
   * the link (`ready`, or `home_not_ready`) promotes it to connected; otherwise the next probe backs
   * off from one to five seconds, or up to 30 seconds once the link reads failed (a revoked key or a
   * stopped Home costs one probe per 30 s). While connected the answer is display-only, and the next
   * probe is 30 seconds out.
   */
  const applyProbe = (result: ProbeResult, wasConnected: boolean): void => {
    const timestamp = now();
    const reason = result === "ready" ? null : result;
    if (wasConnected) {
      if (state.kind === "connected") probe = reason;
      nextProbeAt = timestamp + CONNECTED_PROBE_MS;
      return;
    }
    if ((result === "ready" || result === "home_not_ready") && awaitingReady()) {
      probe = reason;
      probeFailures = 0;
      nextProbeAt = timestamp + CONNECTED_PROBE_MS;
      setState(reduceTunnel(state, { type: "ready", now: timestamp }, random, policy));
      return;
    }
    probe = reason;
    probeFailures += 1;
    const cap = state.kind === "failed" ? CONNECTED_PROBE_MS : PROBE_BACKOFF_MAX_MS;
    nextProbeAt = timestamp + Math.min(cap, 1_000 * 2 ** Math.min(probeFailures - 1, 16));
  };

  /**
   * Starts one keyed probe without waiting for it, so a slow Home never delays the check that
   * notices a disconnect, and stop() aborts it instead of waiting up to the probe timeout.
   */
  const startProbe = (tunnelPort: number, key: string): void => {
    const flight = { child, adopted, abort: new AbortController() };
    probeFlight = flight;
    const wasConnected = state.kind === "connected";
    void probeTunnel(fetchImpl, tunnelPort, key, flight.abort.signal).then(result => {
      // An aborted probe, or one whose tunnel exited meanwhile, says nothing about the next tunnel.
      if (probeFlight !== flight) return;
      probeFlight = undefined;
      if (stopping || child !== flight.child || adopted !== flight.adopted) return;
      applyProbe(result, wasConnected);
    }, () => {
      if (probeFlight === flight) probeFlight = undefined;
    });
  };

  /**
   * Settles a leftover tunnel pidfile once, before this supervisor's first spawn: a proven orphan
   * is reaped and a live tunnel that may not be ours is adopted. It needs a valid, matching read
   * after the reap; without one it stays pending and the next check that has one runs it again.
   */
  const settleLeftover = async (): Promise<void> => {
    const orphan = await reapOrphanTunnel(deps);
    if (stopping) return;
    const afterReap = readCurrent();
    if (afterReap.invalid || !afterReap.sidecar || readConnectedLinkId() !== afterReap.sidecar.linkId) return;
    reapPending = false;
    if ((orphan.tunnel === "owned" || orphan.tunnel === "unresolved") && orphan.pid !== undefined && isAlive(orphan.pid)) {
      // A leftover tunnel that may not be ours to stop: watch it and probe through it, and
      // start our own once it dies. It is never signalled.
      adopted = orphan.pid;
      linkId = afterReap.sidecar.linkId;
      nextProbeAt = now();
      setState({ kind: "connecting", since: now() });
      return;
    }
    spawn(afterReap.sidecar);
  };

  const tick = async (): Promise<void> => {
    if (stopping || !initialized) return;
    const current = readCurrent();
    const connected = current.invalid ? null : readConnectedLinkId();
    if (current.invalid || connected === CONNECTION_UNREADABLE) {
      // A single unreadable read (a write in progress, a transient I/O error) must not end a
      // healthy link; only INVALID_READ_TICKS in a row do.
      invalidReads += 1;
      if (invalidReads < INVALID_READ_TICKS) return;
      if (current.invalid) {
        failure = { kind: "failed", reason: "sidecar_invalid" };
        await stopTunnel();
      } else if (child || linkId || adopted !== null) {
        await endLink();
      }
      settleWaiters();
      return;
    }
    invalidReads = 0;
    if (!current.sidecar || connected !== current.sidecar.linkId) {
      if (child || linkId || adopted !== null) await endLink();
      return;
    }
    failure = undefined;
    const sidecar = current.sidecar;
    if (reapPending) {
      // The start-up read was unreadable or did not match, so a leftover tunnel was never
      // settled. Settle it now, before anything spawns, so an orphan cannot keep the port.
      await settleLeftover();
      settleWaiters();
      return;
    }
    if (adopted !== null && !isAlive(adopted)) {
      // The leftover tunnel is gone: start our own on this tick.
      adopted = null;
      probe = null;
      setState(IDLE);
    }
    setState(reduceTunnel(state, { type: "tick", now: now() }, random, policy));
    // An adopted tunnel is the attempt in flight: it is never killed, so a timeout leaves it
    // probed, and it can still be promoted, until it dies.
    if (state.kind === "failed" && !state.inFlight && adopted !== null) setState({ ...state, inFlight: true });
    if (state.kind === "failed" && !state.inFlight && child) await killChild();
    // A probe still running for a tunnel that has since exited or died answers nothing useful.
    if (probeFlight && (probeFlight.child !== child || probeFlight.adopted !== adopted)) abortProbe();
    // While requests are held the backoff does not apply: one probe per check (one a second), so a
    // forward that just came up releases them at once. Held requests exist only while it is down.
    if ((child || adopted !== null) && (state.kind === "connected" || awaitingReady()) && !probeFlight
      && (now() >= nextProbeAt || waiters.size > 0)) {
      // Without the committed key nothing can be proven, and the relay refuses requests anyway.
      const key = linkKey();
      if (key) startProbe(sidecar.tunnelPort, key);
    }
    if (!child && adopted === null && (state.kind === "idle" || dueForSpawn(state, now()))) spawn(sidecar);
    settleWaiters();
  };

  const runTick = (): void => {
    if (tickFlight) return;
    tickFlight = tick().finally(() => { tickFlight = undefined; });
  };

  const initialize = async (): Promise<void> => {
    if (initializing || initialized || stopping) return;
    initializing = true;
    try {
      const current = readCurrent();
      if (current.invalid) {
        failure = { kind: "failed", reason: "sidecar_invalid" };
        return;
      }
      // An unreadable or mismatched read leaves the leftover tunnel for the first check that
      // reads a matching link (reapPending), so no tunnel is ever spawned over an unreaped one.
      if (!current.sidecar || readConnectedLinkId() !== current.sidecar.linkId) return;
      await settleLeftover();
    } finally {
      initialized = true;
      initializing = false;
      settleWaiters();
    }
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
        settleWaiters();
      });
    },
    async stop(): Promise<void> {
      if (stopping) {
        if (tickFlight) await tickFlight;
        return;
      }
      stopping = true;
      abortProbe();
      settleWaiters();
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
      if (!child && !linkId && adopted === null) return { kind: "stopped" };
      return {
        kind: "tunnel",
        linkId: linkId ?? "",
        state,
        pid: child?.pid ?? adopted,
        ...(probe ? { probe } : {}),
      };
    },
    pending,
    waitForConnected(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      if (!stopping && failure === undefined && state.kind === "connected") return Promise.resolve(true);
      if (!pending() || waiters.size >= CLIENT_LINK_MAX_HOLDS || signal?.aborted || !(timeoutMs > 0)) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>(resolve => {
        let holdTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => settle(false);
        const settle = (connected: boolean): void => {
          if (!waiters.delete(settle)) return;
          if (holdTimer !== undefined) clearTimeout(holdTimer);
          signal?.removeEventListener("abort", onAbort);
          resolve(connected);
        };
        waiters.add(settle);
        holdTimer = setTimeout(() => settle(false), timeoutMs);
        (holdTimer as { unref?: () => void }).unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
