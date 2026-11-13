import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { linkDir, linkKnownHostsPath, linkStorePath } from "./paths";
import { buildTunnelArgv } from "./ssh-argv";
import { nextLinkConnectionGeneration } from "./relay-auth";
import { createSshRunner, type SshChild, type SshRunner } from "./ssh-runner";
import { defaultSshCaptureOpener, openSshCapture, retainSshCapture, type SshCaptureOpener } from "./ssh-capture";
import type { LinkDiagnosticSink } from "./diagnostics";
import { createTunnelHistoryBook, exitCause, type TunnelCause, type TunnelHistory } from "./tunnel-history";
import {
  classifySshStderr,
  dueForSpawn,
  failedSpawnTunnel,
  HOME_TUNNEL_RETRY_POLICY,
  IDLE,
  reduceTunnel,
  type TunnelFailure,
  type TunnelState,
} from "./tunnel-state";
import { effectiveLinkRoutes, emptyLinkStore, readLinkStore, type LinkRecord, type LinkStore } from "./store";
import { CANDIDATE_KILL_GRACE_MS, createRouteRounds, type LinkRouteStatus } from "./route-rounds";
import type { RouteProofRegistry } from "./route-proof";

export type LinkTunnelStatus =
  | {
    linkId: string;
    direction: "hub-initiated";
    state: TunnelState;
    pid: number | null;
    orphan?: "orphan-unverified";
    /** Attempts, last change and last failure cause of this tunnel (`tunnel-history.ts`). */
    history?: TunnelHistory;
    /** Links with several routes only (src/link/route-rounds.ts). */
    routes?: LinkRouteStatus;
  }
  | {
    linkId: string;
    direction: "client-initiated";
    state: "client-owned";
    pid: null;
  };

export interface LinkSupervisor {
  start(): void;
  ensureStarted(): Promise<void>;
  reload(): Promise<void>;
  stopLink(linkId: string): Promise<void>;
  /** Reserve a link against reconnects and automatic spawns for a removal transaction. */
  holdLink?(linkId: string): () => void;
  /**
   * Restart one Home-initiated tunnel now: stop its child, forget the backoff or failed state,
   * and spawn a fresh attempt. False when the link is not a Home-initiated link of this store.
   */
  reconnect(linkId: string): Promise<boolean>;
  status(): readonly LinkTunnelStatus[];
  /** `<runtime instance>:<generation>` of a Home-initiated link's current tunnel; every spawn changes it. */
  connectionGeneration?(linkId: string): string | undefined;
  notifyAuthenticatedRequest?(apiKeyId: string): void;
  stop(): Promise<void>;
}

interface WatchedProcess {
  pid: number;
  argv: readonly string[];
  startTime?: number;
  /** Set while this supervisor is stopping the process it identified. */
  signal?: { at: number; killed: boolean };
}

interface OrphanWatch {
  /**
   * The link record instance it belongs to; a removed or one-route record retires it. A reload that
   * replaces a flagged multi-route record re-keys it to the new instance as observe-only.
   */
  instance: string;
  /** The pidfile content the watch last saw; only this file is ever removed by it. */
  file: { pid: number; argv: readonly string[]; startTime?: number };
  /** Every process this pidfile has named since the watch began; the link stays blocked until all are gone. */
  processes: WatchedProcess[];
  /** Set once its record was replaced: it never signals or removes the pidfile, also when it ends. */
  observeOnly?: true;
}

interface Pidfile {
  version: 1;
  linkId: string;
  pid: number;
  argv: string[];
  /** Multi-route tunnels only: the process start time (/proc/<pid>/stat field 22) written right after spawn. */
  startTime?: number;
}

export interface LinkSupervisorDeps {
  readStore?: () => LinkStore;
  writeStore?: (store: LinkStore) => void;
  runner?: SshRunner;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  /** Start time of a live process (Linux /proc/<pid>/stat field 22), null when unreadable or gone. */
  readProcessStartTime?: (pid: number) => number | null;
  killProcess?: (pid: number, signal?: NodeJS.Signals) => void;
  /** false when the pid does not exist, true when it does, null when that cannot be told. */
  processAlive?: (pid: number) => boolean | null;
  pidfileDir?: string;
  /** The link's pidfile, null only when there is none; throws when one exists but cannot be read or parsed. */
  readPidfile?: (path: string) => Pidfile | null;
  writePidfile?: (path: string, pidfile: Pidfile) => void;
  removePidfile?: (path: string) => void;
  platform?: NodeJS.Platform;
  random?: () => number;
  apiKeys?: () => readonly { id: string; name: string }[];
  revokeApiKey?: (id: string) => boolean;
  warn?: (message: string) => void;
  /** Where tunnel state changes are recorded; production passes the bounded diagnostics file. */
  diagnostic?: LinkDiagnosticSink;
  /** Bounded drain of `diagnostic` at stop. */
  flushDiagnostics?: () => Promise<void>;
  /** Opt-in SSH capture (src/link/ssh-capture.ts); defaults to the one for this link directory. */
  sshCapture?: SshCaptureOpener;
  /** Readiness proofs of multi-route candidates; without it no multi-route link can be proven. */
  routeProof?: RouteProofRegistry;
}

const TIMER_MS = 1_000;
const SPAWN_GRACE_MS = 5_000;
/**
 * A retry runs while the network may still be down, and ssh can wait out its whole ConnectTimeout
 * (10 s for the TCP connect, the SSH handshake and key exchange, see ssh-argv.ts) before it exits.
 * A retry is promoted only once it has outlived that, so an attempt that never reached the Child
 * does not read connected and restart the outage clock. Like the first attempt's five seconds,
 * liveness is a heuristic: authentication and the forward request come after ConnectTimeout, so
 * one that stalls past the grace reads connected until ssh exits.
 */
const RETRY_GRACE_MS = 15_000;

/** A retry whose ssh child is still running: reconnecting, or failed under the retry policy. */
function retryInFlight(state: TunnelState): boolean {
  return (state.kind === "reconnecting" || state.kind === "failed") && state.inFlight === true;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parsePidfile(text: string): Pidfile | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const body = raw as Record<string, unknown>;
    if (body.version !== 1 || typeof body.linkId !== "string" || typeof body.pid !== "number"
      || !Number.isSafeInteger(body.pid) || body.pid < 1 || !Array.isArray(body.argv)
      || body.argv.some(value => typeof value !== "string")
      || (body.startTime !== undefined && (typeof body.startTime !== "number" || !Number.isSafeInteger(body.startTime) || body.startTime < 0))) return null;
    return {
      version: 1, linkId: body.linkId, pid: body.pid, argv: body.argv as string[],
      ...(typeof body.startTime === "number" ? { startTime: body.startTime } : {}),
    };
  } catch {
    return null;
  }
}

function linuxProcessArgv(pid: number): readonly string[] | null {
  try {
    const values = readFileSync(`/proc/${pid}/cmdline`).toString().split("\0");
    if (values.at(-1) === "") values.pop();
    return values.length > 0 ? values : null;
  } catch {
    return null;
  }
}

/** Field 22 of /proc/<pid>/stat, counted after the command name's closing parenthesis. */
function linuxProcessStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const value = Number(fields[19]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function defaultProcessAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? false : code === "EPERM" ? true : null;
  }
}

function defaultKillProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try { process.kill(pid, signal); } catch { /* the process may already have exited */ }
}

export function createLinkSupervisor(deps: LinkSupervisorDeps = {}): LinkSupervisor {
  const storePath = linkStorePath();
  const storeDir = deps.pidfileDir ?? linkDir();
  const readStore = deps.readStore ?? (() => readLinkStore(storePath));
  const runner = deps.runner ?? createSshRunner();
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, ms) => setInterval(callback, ms));
  const clearTimer = deps.clearTimer ?? ((timer: ReturnType<typeof setInterval>) => clearInterval(timer));
  const platform = deps.platform ?? process.platform;
  const readProcessArgv = deps.readProcessArgv ?? (platform === "linux" ? linuxProcessArgv : () => null);
  const readProcessStartTime = deps.readProcessStartTime ?? (platform === "linux" ? linuxProcessStartTime : () => null);
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const loadPidfile = deps.readPidfile ?? ((path: string): Pidfile | null => {
    let text: string;
    try { text = readFileSync(path, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const pidfile = parsePidfile(text);
    if (pidfile === null) throw new Error("link pidfile unreadable");
    return pidfile;
  });
  /** Every reader except the orphan-flag lift treats an unreadable pidfile as none, as before. */
  const readPidfile = (path: string): Pidfile | null => {
    try { return loadPidfile(path); } catch { return null; }
  };
  const writePidfile = deps.writePidfile ?? ((path: string, pidfile: Pidfile) => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    atomicWriteFile(path, `${JSON.stringify(pidfile)}\n`);
  });
  const removePidfile = deps.removePidfile ?? ((path: string) => {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const sshCapture = deps.sshCapture ?? defaultSshCaptureOpener(storeDir);
  // Runs at server start even with no links, so an earlier process's capture files still expire.
  if (!deps.sshCapture) retainSshCapture(storeDir);

  let store: LinkStore = emptyLinkStore();
  let started = false;
  let stopping = false;
  let lifecycleFlight: Promise<void> | undefined;
  let lifecycleRevision = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const states = new Map<string, TunnelState>();
  /** stopAt/killed/warned: a failed link's child the tick stopped, kept until its exit is seen. */
  const children = new Map<string, { child: SshChild; argv: readonly string[]; spawnedAt: number; stopAt?: number; killed?: boolean; warned?: boolean }>();
  /**
   * Tunnel children (one-route tunnels, multi-route candidates and proven tunnels) a stop sent SIGTERM
   * and is awaiting; the tick sends SIGKILL after the grace.
   */
  const draining = new Set<{ child: SshChild; stopAt: number; killed: boolean }>();
  /** Per-link generation, advanced by spawns and explicit stop/removal reservations. */
  const generations = new Map<string, number>();
  /** The process-unique connection name of each link's current ssh child, minted at spawn. */
  const connectionNames = new Map<string, string>();
  const linkRevisions = new Map<string, number>();
  /** Reconnects in flight, so overlapping requests for one link restart it once. */
  const reconnects = new Map<string, Promise<boolean>>();
  const holds = new Map<string, number>();
  const orphanUnverified = new Set<string>();
  /** The generation of the child whose exit is still being classified, per link. */
  const exiting = new Map<string, number>();
  const recordInstances = new Map<string, string>();
  /** Multi-route links blocked by an earlier tunnel, watched until it is gone (src/link/route-rounds.ts relies on it). */
  const orphanWatches = new Map<string, OrphanWatch>();
  /**
   * Multi-route links blocked by a pidfile that exists but cannot be read or parsed, read again every
   * tick; false once a reload replaced the record, so the watch that file may become only observes.
   */
  const unreadablePidfiles = new Map<string, boolean>();
  const history = createTunnelHistoryBook({
    diagnostic: deps.diagnostic,
    tunnelPort: linkId => store.links.find(link => link.id === linkId)?.tunnelPort,
  });

  const reconcileApiKeys = (): void => {
    const keys = deps.apiKeys?.() ?? [];
    if (!deps.revokeApiKey || keys.length === 0) return;
    const referenced = new Set(store.links.map(link => link.apiKeyId));
    for (const key of keys) {
      if (!key.name.startsWith("link:") || referenced.has(key.id)) continue;
      try {
        if (deps.revokeApiKey(key.id)) warn(`[link] revoked orphaned link key id=${key.id}`);
      } catch (error) {
        warn(`[link] orphaned link key revoke failed id=${key.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const pidfilePath = (linkId: string): string => join(storeDir, `${linkId}.pid`);

  const recordInstance = (record: LinkRecord, listenerPort: number | null): string => JSON.stringify([
    record.id,
    record.alias,
    record.direction,
    record.hostKeyFingerprint,
    record.tunnelPort,
    record.apiKeyId,
    record.createdAt,
    listenerPort,
    // How ssh reaches the alias: an edit of either restarts the tunnel on the new route instead of keeping the old one.
    record.explicitRoute ?? null,
    record.exclusive ?? false,
  ]);

  const conditionalRemovePidfile = (linkId: string, pid: number): void => {
    const path = pidfilePath(linkId);
    const current = readPidfile(path);
    if (current?.linkId === linkId && current.pid === pid) dropStalePidfile(linkId);
  };

  const reapOrphans = (): void => {
    for (const record of store.links) {
      if (rounds.isMultiRoute(record)) {
        recheckPidfile(record);
        continue;
      }
      const pidfile = readPidfile(pidfilePath(record.id));
      if (!pidfile || pidfile.linkId !== record.id) continue;
      // macOS deliberately has no exact argv source here. A ps rendering is not an identity proof.
      if (platform !== "linux") {
        orphanUnverified.add(record.id);
        continue;
      }
      const actualArgv = readProcessArgv(pidfile.pid);
      if (actualArgv && sameArgv(actualArgv, pidfile.argv)) {
        try { killProcess(pidfile.pid); } finally { dropStalePidfile(record.id); }
      } else {
        orphanUnverified.add(record.id);
      }
    }
  };

  /**
   * The pidfile's own process, identified by pid, exact argv and start time. "gone" and "different"
   * both mean the recorded process has exited (a different one may reuse the pid); "unreadable" means
   * a live pid whose identity could not be read, which never counts as gone.
   */
  const processIdentity = (pid: number, argv: readonly string[], startTime: number): "same" | "gone" | "different" | "unreadable" => {
    const actualArgv = readProcessArgv(pid);
    const actualStart = readProcessStartTime(pid);
    if (actualArgv === null || actualStart === null) return processAlive(pid) === false ? "gone" : "unreadable";
    return sameArgv(actualArgv, argv) && actualStart === startTime ? "same" : "different";
  };

  /**
   * Remove a link's pidfile once its process is gone, or has been sent SIGTERM (an earlier one-route
   * ssh matched at startup), or once this process's own child has exited or been stopped. A removal
   * that fails (a read-only directory, a sharing lock) is warned and never stops the caller: a tick goes on
   * to every other link, an exit is still classified, a stop or reload completes, and the block it
   * was lifting stays lifted. The file left behind is mostly harmless: on Linux with a start time the
   * next start sees its process gone; without a start time, a pid reused by another process blocks a
   * multi-route link at the next start until that process exits.
   */
  const dropStalePidfile = (linkId: string): void => {
    try { removePidfile(pidfilePath(linkId)); } catch { warn(`[link] stale pidfile could not be removed link=${linkId}`); }
  };

  /**
   * A multi-route link never starts a candidate while an earlier tunnel of it may live: the readiness
   * proof's attribution relies on that. Only a process proven to be the pidfile's own (pid, argv and
   * the start time written at spawn) is signalled, and its identity is re-read before every signal.
   * Every blocked pidfile stays watched without signals, and the block lifts once the process is shown
   * gone (or its pid now names another process); the link's first round then starts.
   * With act false (a reload that replaced the record) nothing is signalled or removed: the new
   * instance's watch only observes, as no watch acts for a replaced instance.
   */
  const reapMultiRouteOrphan = (record: LinkRecord, pidfile: Pidfile, act = true): void => {
    const watched: WatchedProcess = { pid: pidfile.pid, argv: pidfile.argv, ...(pidfile.startTime === undefined ? {} : { startTime: pidfile.startTime }) };
    if (processGone(watched)) { if (act) dropStalePidfile(record.id); return; }
    orphanUnverified.add(record.id);
    const identity = platform === "linux" && pidfile.startTime !== undefined ? processIdentity(pidfile.pid, pidfile.argv, pidfile.startTime) : "unreadable";
    if (act && identity === "same") {
      killProcess(pidfile.pid, "SIGTERM");
      watched.signal = { at: now(), killed: false };
    }
    orphanWatches.set(record.id, {
      instance: recordInstance(record, store.listenerPort), file: fileIdentity(pidfile), processes: [watched], ...(act ? {} : { observeOnly: true as const }),
    });
  };

  /**
   * A multi-route link's block, settled from its pidfile: the earlier tunnel it names is watched, no
   * pidfile (ENOENT) lifts the block, and one that exists but cannot be read or parsed keeps it, since
   * it may name the ssh still holding the port. That file is read again every tick, so making it
   * readable or deleting it settles the block without a restart.
   */
  const recheckPidfile = (record: LinkRecord, act = true): void => {
    let file: Pidfile | null;
    try { file = loadPidfile(pidfilePath(record.id)); } catch {
      if (!unreadablePidfiles.has(record.id)) warn(`[link] pidfile unreadable; link stays blocked link=${record.id}`);
      unreadablePidfiles.set(record.id, (unreadablePidfiles.get(record.id) ?? true) && act);
      orphanUnverified.add(record.id);
      return;
    }
    unreadablePidfiles.delete(record.id);
    if (file !== null && file.linkId === record.id) reapMultiRouteOrphan(record, file, act);
    if (!orphanWatches.has(record.id)) orphanUnverified.delete(record.id);
  };

  const fileIdentity = (pidfile: Pidfile): OrphanWatch["file"] => ({ pid: pidfile.pid, argv: pidfile.argv, ...(pidfile.startTime === undefined ? {} : { startTime: pidfile.startTime }) });

  /** True when the process has exited (or, with a recorded start time on Linux, its pid names another one). */
  const processGone = (watched: WatchedProcess): boolean => {
    if (watched.startTime !== undefined && platform === "linux") {
      const identity = processIdentity(watched.pid, watched.argv, watched.startTime);
      return identity === "gone" || identity === "different";
    }
    return processAlive(watched.pid) === false;
  };

  const sameFile = (file: Pidfile, seen: OrphanWatch["file"]): boolean =>
    file.pid === seen.pid && sameArgv(file.argv, seen.argv) && file.startTime === seen.startTime;

  /** A watch belongs to one record instance; it never acts for a removed, replaced or one-route link. */
  const watchCurrent = (linkId: string, watch: OrphanWatch): boolean => {
    const record = store.links.find(link => link.id === linkId);
    return record !== undefined && rounds.isMultiRoute(record) && recordInstance(record, store.listenerPort) === watch.instance;
  };

  const tickOrphanWatches = (current: number): void => {
    for (const [linkId, watch] of [...orphanWatches]) {
      if (!watchCurrent(linkId, watch)) { orphanWatches.delete(linkId); continue; }
      // A pidfile that exists but cannot be read may name another tunnel now: it never ends the watch.
      let file: Pidfile | null = null;
      let unreadable = false;
      try { file = loadPidfile(pidfilePath(linkId)); } catch { unreadable = true; }
      if (file !== null && file.linkId === linkId && !sameFile(file, watch.file)) {
        // Another owner replaced the pidfile: nothing is signalled any more, and the replacement joins
        // the watched processes; the link stays blocked until every one of them is gone.
        for (const watched of watch.processes) delete watched.signal;
        watch.file = fileIdentity(file);
        // Identity is pid, argv and start time together: a replacement that reuses an old pid is a new process.
        if (!watch.processes.some(watched => watched.pid === file.pid && sameArgv(watched.argv, file.argv) && watched.startTime === file.startTime)) {
          watch.processes.push({ pid: file.pid, argv: file.argv, ...(file.startTime === undefined ? {} : { startTime: file.startTime }) });
        }
      }
      watch.processes = watch.processes.filter(watched => !processGone(watched));
      if (watch.processes.length === 0) {
        orphanWatches.delete(linkId);
        if (unreadable) {
          // Every watched process is gone, but the file cannot say what it names: stay blocked and read
          // it again every tick. Whatever it names once readable is a replacement to this watch, so it
          // is only observed: no signal, no removal.
          if (!unreadablePidfiles.has(linkId)) warn(`[link] pidfile unreadable; link stays blocked link=${linkId}`);
          unreadablePidfiles.set(linkId, false);
          continue;
        }
        orphanUnverified.delete(linkId);
        if (!watch.observeOnly && file !== null && file.linkId === linkId && sameFile(file, watch.file)) dropStalePidfile(linkId);
        // The link was waiting for this: start its first round now.
        const record = store.links.find(link => link.id === linkId);
        if (record && !children.has(linkId) && (states.get(linkId) ?? IDLE).kind === "idle") spawnFor(record);
        continue;
      }
      for (const watched of watch.processes) {
        const signal = watched.signal;
        if (!signal || watched.startTime === undefined || watch.observeOnly) continue;
        if (file === null || processIdentity(watched.pid, watched.argv, watched.startTime) !== "same") {
          // Cannot tell it is ours any more: no further signal; the watch goes on.
          delete watched.signal;
        } else if (!signal.killed && current - signal.at >= 2_000) {
          signal.killed = true;
          killProcess(watched.pid, "SIGKILL");
        } else if (current - signal.at >= 4_000) {
          // Still there: nothing is signalled again; the link stays blocked until the watch sees it gone.
          delete watched.signal;
        }
      }
    }
    for (const [linkId, act] of [...unreadablePidfiles]) {
      const record = store.links.find(link => link.id === linkId);
      if (!record || !rounds.isMultiRoute(record) || !orphanUnverified.has(linkId) || orphanWatches.has(linkId)) {
        unreadablePidfiles.delete(linkId);
        continue;
      }
      recheckPidfile(record, act);
      // Nothing is left to wait for: start the link's first round now, as a watch that ends does.
      if (!orphanUnverified.has(linkId) && !children.has(linkId) && (states.get(linkId) ?? IDLE).kind === "idle") spawnFor(record);
    }
  };

  /** Every state change goes through here, so the history sees each transition and its cause. */
  const put = (linkId: string, next: TunnelState, cause: TunnelCause | null = null): TunnelState => {
    const before = states.get(linkId) ?? IDLE;
    states.set(linkId, next);
    history.observe(linkId, before, next, cause, now());
    return next;
  };

  const setEvent = (linkId: string, event: Parameters<typeof reduceTunnel>[1], cause: TunnelCause | null = null): TunnelState =>
    put(linkId, reduceTunnel(states.get(linkId) ?? IDLE, event, deps.random, HOME_TUNNEL_RETRY_POLICY), cause);

  /** Fail a link whose attempt could not start; a due retry that fails this way counts as one. */
  const failAttempt = (linkId: string, prior: TunnelState | undefined, reason: TunnelFailure, cause: TunnelCause): void => {
    put(linkId, failedSpawnTunnel(prior, reason, now(), HOME_TUNNEL_RETRY_POLICY), cause);
  };

  /** Every tunnel child's exit, one-route or multi-route, goes through here. */
  const watchExit = (linkId: string, child: SshChild, generation: number): void => {
    void child.exited.then(async () => {
      if (children.get(linkId)?.child !== child) return;
      children.delete(linkId);
      conditionalRemovePidfile(linkId, child.pid);
      if (stopping) return;
      exiting.set(linkId, generation);
      try {
        let stderr = "";
        // An unreadable stderr (the runner rejects it past its size cap) still reports the exit.
        try { stderr = child.stderr ? await child.stderr : ""; } catch { /* classified as unknown */ }
        // A reconnect may have started a fresh child meanwhile; its own lifecycle owns the state.
        if (generations.get(linkId) !== generation) return;
        if (rounds.exited(linkId, child, stderr)) return;
        const stderrClass = classifySshStderr(stderr);
        setEvent(linkId, { type: "exit", now: now(), stderrClass }, exitCause(stderrClass));
      } finally {
        if (exiting.get(linkId) === generation) exiting.delete(linkId);
      }
    }).catch(() => {
      if (children.get(linkId)?.child !== child) return;
      children.delete(linkId);
      conditionalRemovePidfile(linkId, child.pid);
      if (stopping) return;
      if (rounds.exited(linkId, child, "")) return;
      setEvent(linkId, { type: "exit", now: now(), stderrClass: "network" }, "network");
    });
  };

  const rounds = createRouteRounds({
    runner,
    now,
    random: () => (deps.random ?? Math.random)(),
    knownHostsFile: () => linkKnownHostsPath(),
    listenerPort: () => store.listenerPort,
    record: linkId => store.links.find(link => link.id === linkId),
    blocked: linkId => stopping || holds.has(linkId) || orphanUnverified.has(linkId),
    busy: () => lifecycleFlight !== undefined,
    ownsChild: (linkId, child) => children.get(linkId)?.child === child,
    spawnTunnel(record, destination, stderrLine) {
      if (store.listenerPort === null) throw new Error("link listener unavailable");
      const argv = buildTunnelArgv({
        alias: record.alias,
        destination,
        direction: "R",
        bindPort: record.tunnelPort,
        targetPort: store.listenerPort,
        knownHostsFile: linkKnownHostsPath(),
        // OpenSSH confirms the granted remote listener at DEBUG1; the tap keeps today's classifier lines only.
        logLevel: "DEBUG1",
        // A record with a route list cannot carry an explicit route (store.ts rejects it). If one ever arrives here,
        // buildTunnelArgv refuses an explicit route for any destination but the alias instead of ignoring it.
        route: record.explicitRoute ?? null,
      });
      const child = runner.spawnTunnel(argv, { stderrLine });
      const generation = (generations.get(record.id) ?? 0) + 1;
      generations.set(record.id, generation);
      const connection = nextLinkConnectionGeneration();
      connectionNames.set(record.id, connection);
      exiting.delete(record.id);
      children.set(record.id, { child, argv, spawnedAt: now() });
      // Owned and watched before anything else can fail, so a failed pidfile write never leaves an untracked tunnel.
      watchExit(record.id, child, generation);
      try {
        const startTime = readProcessStartTime(child.pid);
        writePidfile(pidfilePath(record.id), { version: 1, linkId: record.id, pid: child.pid, argv, ...(startTime === null ? {} : { startTime }) });
      } catch {
        return { child, generation: connection, setupFailed: true };
      }
      return { child, generation: connection };
    },
    captureTap(linkId) {
      const capture = openSshCapture(sshCapture, "home", linkId);
      return capture ? line => capture.stderrLine(line) : undefined;
    },
    setEvent: (linkId, event, cause) => setEvent(linkId, event, cause ?? null),
    deferRetry(linkId, at) {
      const state = states.get(linkId);
      if (state && (state.kind === "reconnecting" || state.kind === "failed") && state.retryAt !== undefined && state.retryAt < at) {
        states.set(linkId, { ...state, retryAt: at });
      }
    },
    attempted: linkId => history.spawned(linkId),
    ...(deps.routeProof ? { routeProof: deps.routeProof } : {}),
    warn,
  });

  const spawnFor = (record: LinkRecord): void => {
    if (stopping || holds.has(record.id) || record.direction !== "hub-initiated" || children.has(record.id)) return;
    // Only a fresh link or a due attempt spawns. A reload must neither skip the backoff nor start
    // a second child while an exited one is still reporting its stderr.
    const prior = states.get(record.id);
    if (prior && prior.kind !== "idle" && !dueForSpawn(prior, now())) return;
    if (store.listenerPort === null) {
      // Retried like any forward failure; a reload that brings the listener back starts it fresh.
      failAttempt(record.id, prior, "forward", "listener_unavailable");
      return;
    }
    // Several routes: an ordered, proven selection round (src/link/route-rounds.ts) instead.
    if (rounds.begin(record)) return;
    let argv: string[];
    try {
      // Off unless the operator opened a capture window on this machine; then only the level changes.
      const capture = openSshCapture(sshCapture, "home", record.id);
      argv = buildTunnelArgv({
        alias: record.alias,
        direction: "R",
        bindPort: record.tunnelPort,
        targetPort: store.listenerPort,
        knownHostsFile: linkKnownHostsPath(),
        ...(capture ? { logLevel: capture.logLevel } : {}),
        route: record.explicitRoute ?? null,
      });
      const child = capture ? runner.spawnTunnel(argv, { stderrLine: capture.stderrLine }) : runner.spawnTunnel(argv);
      const generation = (generations.get(record.id) ?? 0) + 1;
      generations.set(record.id, generation);
      connectionNames.set(record.id, nextLinkConnectionGeneration());
      // An older child's exit still being classified no longer speaks for this link.
      exiting.delete(record.id);
      children.set(record.id, { child, argv, spawnedAt: now() });
      orphanUnverified.delete(record.id);
      history.spawned(record.id);
      setEvent(record.id, { type: "spawn", now: now() });
      // Watched before the pidfile write can fail, so a child whose write failed still has its exit seen.
      watchExit(record.id, child, generation);
      writePidfile(pidfilePath(record.id), { version: 1, linkId: record.id, pid: child.pid, argv });
    } catch {
      failAttempt(record.id, prior, "forward", "spawn_failed");
    }
  };

  const tick = (): void => {
    // The SIGKILL for any tunnel child a stop is draining runs even while lifecycle work is pending or the
    // supervisor shuts down: no reload, removal, reconnect or shutdown waits on an ssh that ignores SIGTERM.
    // (A candidate route-rounds already halted with SIGKILL gets a fresh stop time here, so a second SIGKILL
    // on the same unreaped process: harmless.)
    for (const drain of draining) {
      if (drain.killed || now() - drain.stopAt < CANDIDATE_KILL_GRACE_MS) continue;
      drain.killed = true;
      try { drain.child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    if (stopping) return;
    // Route deadlines run even while lifecycle work is pending, so a stuck reload cannot stretch a probe.
    for (const record of store.links) if (rounds.isMultiRoute(record) && !holds.has(record.id)) rounds.tick(record.id);
    if (lifecycleFlight) return;
    const current = now();
    tickOrphanWatches(current);
    for (const record of store.links) {
      if (record.direction !== "hub-initiated") continue;
      if (holds.has(record.id)) continue;
      // The exit is still being classified. Failing the link on the outage clock now would make
      // a later host-key or auth exit land on a failed state that ignores it.
      if (exiting.has(record.id)) continue;
      const before = states.get(record.id) ?? IDLE;
      const child = children.get(record.id);
      if (rounds.isMultiRoute(record)) {
        // Promotion comes only from a proven candidate; the outage clock still runs across rounds.
        const next = setEvent(record.id, { type: "tick", now: current }, "timeout");
        if (next.kind === "failed" && !next.inFlight && (rounds.inRound(record.id) || child)) {
          states.set(record.id, { ...next, inFlight: true });
        } else if (dueForSpawn(next, current)) {
          spawnFor(record);
        }
        continue;
      }
      // Promotion is checked before the outage limit, so a child that has outlived its grace by the
      // time this tick runs (at the limit, or late after a sleep) is promoted rather than killed.
      // An idle Child may send no catalog request for hours; for a retry, staying up past the
      // retry grace is the proof instead, as five seconds is for a first attempt.
      if (child && ((before.kind === "connecting" && current - before.since >= SPAWN_GRACE_MS)
        || (retryInFlight(before) && current - child.spawnedAt >= RETRY_GRACE_MS))) {
        setEvent(record.id, { type: "ready", now: current });
        continue;
      }
      const next = setEvent(record.id, { type: "tick", now: current }, "timeout");
      if (next.kind === "failed" && !next.inFlight && child && retryInFlight(before)) {
        // A retry started just before the outage limit has not had its grace yet. It carries on as
        // the failed state's retry instead of being killed with a link that may already be back.
        states.set(record.id, { ...next, inFlight: true });
      } else if (next.kind === "failed" && !next.inFlight && child) {
        // A failed link with a running child (its pidfile write failed): stop it, SIGKILL after the grace,
        // and keep it until its exit is seen, as a stopped candidate is. watchExit then forgets it and
        // removes the pidfile naming it; until then no retry and no round starts past it.
        if (child.stopAt === undefined) {
          child.stopAt = current;
          try { child.child.kill("SIGTERM"); } catch { /* already gone */ }
        } else if (!child.killed && current - child.stopAt >= CANDIDATE_KILL_GRACE_MS) {
          child.killed = true;
          try { child.child.kill("SIGKILL"); } catch { /* already gone */ }
        } else if (child.killed && !child.warned && current - child.stopAt >= 2 * CANDIDATE_KILL_GRACE_MS) {
          // Its exit was never seen: the link stays failed and owned, as a halted candidate does, and says so once.
          child.warned = true;
          warn(`[link] tunnel exit unconfirmed link=${record.id}`);
        }
      } else if (dueForSpawn(next, current)) {
        spawnFor(record);
      }
    }
  };

  const syncTimer = (): void => {
    const hasHubLinks = store.links.some(record => record.direction === "hub-initiated");
    if (hasHubLinks && timer === undefined && !stopping) timer = setTimer(tick, TIMER_MS);
    if (!hasHubLinks && timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };

  const begin = (): void => {
    if (started || stopping) return;
    store = readStore();
    reconcileApiKeys();
    reapOrphans();
    started = true;
    for (const record of store.links) recordInstances.set(record.id, recordInstance(record, store.listenerPort));
    for (const record of store.links) {
      if (record.direction === "hub-initiated") spawnFor(record);
    }
    syncTimer();
  };

  const runLifecycle = (operation: () => void | Promise<void>): Promise<void> => {
    // Every caller keeps its own operation and completion; no later reload can replace a stop.
    const flight = (lifecycleFlight ?? Promise.resolve()).catch(() => {}).then(operation).finally(() => {
      if (lifecycleFlight === flight) lifecycleFlight = undefined;
    });
    lifecycleFlight = flight;
    return flight;
  };

  const stopChild = async (linkId: string): Promise<void> => {
    rounds.cancel(linkId);
    const current = children.get(linkId);
    if (!current) {
      put(linkId, IDLE);
      return;
    }
    const generation = generations.get(linkId);
    children.delete(linkId);
    current.child.kill("SIGTERM");
    // A child the tick already stopped keeps its stop time and its SIGKILL.
    const drain = { child: current.child, stopAt: current.stopAt ?? now(), killed: current.killed === true };
    draining.add(drain);
    try { await current.child.exited; } finally { draining.delete(drain); }
    conditionalRemovePidfile(linkId, current.child.pid);
    // A stop or removal reservation made while this child exited owns the next state.
    if (generations.get(linkId) === generation) put(linkId, IDLE);
  };

  const invalidateLink = (linkId: string): void => {
    linkRevisions.set(linkId, (linkRevisions.get(linkId) ?? 0) + 1);
    generations.set(linkId, (generations.get(linkId) ?? 0) + 1);
    rounds.cancel(linkId);
  };

  const holdLink = (linkId: string): (() => void) => {
    holds.set(linkId, (holds.get(linkId) ?? 0) + 1);
    invalidateLink(linkId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (holds.get(linkId) ?? 1) - 1;
      if (remaining) holds.set(linkId, remaining); else holds.delete(linkId);
    };
  };

  return {
    start() {
      if (lifecycleFlight) return;
      begin();
    },
    connectionGeneration(linkId) {
      return children.has(linkId) ? connectionNames.get(linkId) : undefined;
    },
    ensureStarted() {
      return runLifecycle(begin);
    },
    async reload() {
      lifecycleRevision += 1;
      await runLifecycle(async () => {
        if (stopping) return;
        if (!started) {
          begin();
          return;
        }
        const nextStore = readStore();
        const nextInstances = new Map(nextStore.links.map(record => [record.id, recordInstance(record, nextStore.listenerPort)]));
        const knownBefore = new Set(recordInstances.keys());
        const changed = new Set<string>();
        const routesEdited: LinkRecord[] = [];
        const gainedRoutes: LinkRecord[] = [];
        const gainedOnChange: string[] = [];
        for (const record of nextStore.links) {
          if (recordInstances.get(record.id) !== undefined && recordInstances.get(record.id) !== nextInstances.get(record.id)) {
            changed.add(record.id);
            // A changed record that also goes from one route to several never reaches the gained-routes
            // check below; it settles from its pidfile with the flagged changed links, after the reload
            // stopped its child (whose pidfile may not name it: a failed write keeps an older one).
            const before = store.links.find(link => link.id === record.id);
            if (before && !rounds.isMultiRoute(before) && rounds.isMultiRoute(record)) gainedOnChange.push(record.id);
            continue;
          }
          const before = store.links.find(link => link.id === record.id);
          if (!before || sameArgv(effectiveLinkRoutes(before), effectiveLinkRoutes(record))) continue;
          // A route edit restarts nothing unless the tunnel's own route is gone, or the link changes
          // between one route and several while no adoptable tunnel runs.
          const wasMulti = rounds.isMultiRoute(before);
          const isMulti = rounds.isMultiRoute(record);
          const live = wasMulti ? rounds.liveRoute(record.id) : children.has(record.id) ? before.alias : undefined;
          if (live !== undefined && !effectiveLinkRoutes(record).includes(live)) { changed.add(record.id); continue; }
          if (wasMulti && !isMulti) {
            if (rounds.inRound(record.id) && live !== record.alias) { changed.add(record.id); continue; }
            rounds.forget(record.id);
          } else if (!wasMulti && isMulti) {
            const child = children.get(record.id);
            const state = states.get(record.id);
            // An unproven child is stopped by this reload; its link then settles from its pidfile as above.
            if (child && state?.kind !== "connected") { changed.add(record.id); gainedOnChange.push(record.id); continue; }
            if (child && state?.kind === "connected") rounds.adopt(record, child.child, state.since);
            gainedRoutes.push(record);
          }
          routesEdited.push(record);
        }
        // Nothing of a changed or removed link's old round may advance while the stops below await,
        // and no orphan watch acts for a record instance that is gone or no longer has several routes.
        // A changed record does not end an earlier tunnel that may still hold the Child's port (a new
        // listener port changes every instance and keeps every tunnel port). A flagged link that stays
        // multi-route keeps its watch, re-keyed to the new instance and observe-only (it never acts for
        // a replaced instance); one with nothing watched is settled again from its pidfile below.
        const flaggedChanged = [...changed].filter(linkId => orphanUnverified.has(linkId));
        for (const linkId of changed) {
          rounds.cancel(linkId);
          const watch = orphanWatches.get(linkId);
          const next = nextStore.links.find(link => link.id === linkId);
          if (watch && orphanUnverified.has(linkId) && next && rounds.isMultiRoute(next)) {
            watch.instance = recordInstance(next, nextStore.listenerPort);
            watch.observeOnly = true;
            for (const watched of watch.processes) delete watched.signal;
          } else {
            orphanWatches.delete(linkId);
          }
        }
        // A removed link takes its block with it; a link added again later is settled from its pidfile below.
        for (const linkId of recordInstances.keys()) {
          if (nextInstances.has(linkId)) continue;
          rounds.cancel(linkId);
          orphanWatches.delete(linkId);
          orphanUnverified.delete(linkId);
          unreadablePidfiles.delete(linkId);
        }
        for (const record of nextStore.links) if (!rounds.isMultiRoute(record)) orphanWatches.delete(record.id);
        store = nextStore;
        // A one-route link that gains routes with no running child (its spawn failed: ssh missing, say)
        // settles from its pidfile, flagged or not: removing a link drops its flag, so a re-added link
        // may carry none. Watch an earlier process, or lift the flag when there is none (recheckPidfile:
        // an unreadable pidfile keeps the flag).
        for (const record of gainedRoutes) {
          if (orphanWatches.has(record.id) || children.has(record.id)) continue;
          recheckPidfile(record);
        }
        if (routesEdited.some(record => rounds.isMultiRoute(record))) rounds.recheckClient();
        for (const record of routesEdited) if (rounds.isMultiRoute(record)) rounds.routesChanged(record);
        for (const [linkId] of [...children]) {
          if (nextInstances.has(linkId) && !changed.has(linkId)) continue;
          await stopChild(linkId);
          states.delete(linkId);
          history.forget(linkId);
          orphanUnverified.delete(linkId);
          recordInstances.delete(linkId);
          if (stopping) return;
        }
        for (const record of nextStore.links) {
          if (changed.has(record.id)) {
            rounds.cancel(record.id);
            states.delete(record.id);
            history.forget(record.id);
            orphanUnverified.delete(record.id);
          }
        }
        for (const linkId of flaggedChanged) {
          const record = nextStore.links.find(link => link.id === linkId);
          if (!record || !rounds.isMultiRoute(record)) continue;
          if (orphanWatches.has(linkId)) orphanUnverified.add(linkId);
          else recheckPidfile(record, false);
        }
        for (const linkId of gainedOnChange) {
          const record = nextStore.links.find(link => link.id === linkId);
          if (!record || flaggedChanged.includes(linkId) || orphanWatches.has(linkId)) continue;
          // Observe-only, as for a changed record (a route edit that restarts the child keeps its instance).
          recheckPidfile(record, false);
        }
        // A link new to this process settles from its pidfile as it would at startup.
        for (const record of nextStore.links) if (!knownBefore.has(record.id) && rounds.isMultiRoute(record)) recheckPidfile(record);
        for (const linkId of [...states.keys()]) {
          if (!nextInstances.has(linkId)) { history.forget(linkId); rounds.forget(linkId); }
        }
        recordInstances.clear();
        for (const [linkId, instance] of nextInstances) recordInstances.set(linkId, instance);
        for (const record of nextStore.links) {
          if (stopping || record.direction !== "hub-initiated" || children.has(record.id)) continue;
          spawnFor(record);
        }
        syncTimer();
      });
    },
    stopLink(linkId: string) {
      invalidateLink(linkId);
      return runLifecycle(() => stopChild(linkId));
    },
    holdLink,
    reconnect(linkId: string) {
      const inFlight = reconnects.get(linkId);
      if (inFlight) return inFlight;
      const linkRevision = linkRevisions.get(linkId);
      let restarted = false;
      const flight = runLifecycle(async () => {
        if (stopping || !started || holds.has(linkId) || linkRevisions.get(linkId) !== linkRevision) return;
        const record = store.links.find(link => link.id === linkId && link.direction === "hub-initiated");
        if (!record) return;
        // An earlier tunnel of a multi-route link that may still live is never bypassed by a reconnect.
        if (rounds.isMultiRoute(record) && orphanUnverified.has(linkId)) return;
        // A preceding reload may have spawned a new generation; it is the current one we drain.
        const generation = generations.get(linkId);
        const revision = lifecycleRevision;
        const instance = recordInstance(record, store.listenerPort);
        await stopChild(linkId);
        const latest = readStore();
        const fresh = latest.links.find(link => link.id === linkId && link.direction === "hub-initiated");
        if (stopping || holds.has(linkId) || generations.get(linkId) !== generation
          || lifecycleRevision !== revision || !fresh || recordInstance(fresh, latest.listenerPort) !== instance) return;
        spawnFor(fresh);
        restarted = true;
      }).then(() => restarted).finally(() => { reconnects.delete(linkId); });
      reconnects.set(linkId, flight);
      return flight;
    },
    notifyAuthenticatedRequest(apiKeyId: string) {
      for (const record of store.links) {
        // A multi-route link is promoted only by its candidate's correlated readiness proof.
        if (rounds.isMultiRoute(record)) continue;
        if (record.direction === "hub-initiated" && record.apiKeyId === apiKeyId && children.has(record.id)) {
          const state = states.get(record.id);
          if (state?.kind === "connecting" || state?.kind === "reconnecting" || (state && retryInFlight(state))) {
            setEvent(record.id, { type: "ready", now: now() });
          }
        }
      }
    },
    status() {
      return store.links.map(record => {
        if (record.direction === "client-initiated") {
          return { linkId: record.id, direction: record.direction, state: "client-owned", pid: null };
        }
        const child = children.get(record.id);
        const recorded = history.get(record.id);
        const routes = rounds.isMultiRoute(record) ? rounds.status(record.id) : undefined;
        return {
          linkId: record.id,
          direction: record.direction,
          state: states.get(record.id) ?? IDLE,
          pid: child?.child.pid ?? null,
          ...(orphanUnverified.has(record.id) ? { orphan: "orphan-unverified" as const } : {}),
          ...(recorded ? { history: recorded } : {}),
          ...(routes ? { routes } : {}),
        };
      });
    },
    async stop() {
      stopping = true;
      rounds.stop();
      try {
        await runLifecycle(async () => {
          // Every stop runs to its end, so one that fails cannot cut short another child's drain.
          const results = await Promise.allSettled([...children.keys()].map(stopChild));
          const failed = results.find(result => result.status === "rejected");
          if (failed) throw failed.reason;
          for (const record of store.links) {
            if (record.direction === "hub-initiated") put(record.id, IDLE);
          }
        });
      } finally {
        // The timer runs until the stops above are done: it alone sends SIGKILL to a child that ignores
        // SIGTERM. It goes even when a stop failed, so it never keeps the process alive.
        if (timer !== undefined) {
          clearTimer(timer);
          timer = undefined;
        }
      }
      try { await deps.flushDiagnostics?.(); } catch { /* best effort */ }
    },
  };
}

export type { Pidfile };
