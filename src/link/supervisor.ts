import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { linkDir, linkKnownHostsPath, linkStorePath } from "./paths";
import { buildTunnelArgv } from "./ssh-argv";
import { createSshRunner, type SshChild, type SshRunner } from "./ssh-runner";
import {
  classifySshStderr,
  dueForSpawn,
  IDLE,
  reduceTunnel,
  type TunnelState,
} from "./tunnel-state";
import { emptyLinkStore, readLinkStore, type LinkRecord, type LinkStore } from "./store";

export type LinkTunnelStatus =
  | {
    linkId: string;
    direction: "hub-initiated";
    state: TunnelState;
    pid: number | null;
    orphan?: "orphan-unverified";
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
  stopLink(linkId: string): Promise<void>;
  status(): readonly LinkTunnelStatus[];
  stop(): Promise<void>;
}

interface Pidfile {
  version: 1;
  linkId: string;
  pid: number;
  argv: string[];
}

export interface LinkSupervisorDeps {
  readStore?: () => LinkStore;
  writeStore?: (store: LinkStore) => void;
  runner?: SshRunner;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearTimer?: (timer: ReturnType<typeof setInterval>) => void;
  readProcessArgv?: (pid: number) => readonly string[] | null;
  killProcess?: (pid: number) => void;
  pidfileDir?: string;
  readPidfile?: (path: string) => Pidfile | null;
  writePidfile?: (path: string, pidfile: Pidfile) => void;
  removePidfile?: (path: string) => void;
  platform?: NodeJS.Platform;
  random?: () => number;
}

const TIMER_MS = 1_000;

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
      || body.argv.some(value => typeof value !== "string")) return null;
    return { version: 1, linkId: body.linkId, pid: body.pid, argv: body.argv as string[] };
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

function defaultKillProcess(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* the process may already have exited */ }
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
  const killProcess = deps.killProcess ?? defaultKillProcess;
  const readPidfile = deps.readPidfile ?? ((path: string) => {
    try { return parsePidfile(readFileSync(path, "utf8")); } catch { return null; }
  });
  const writePidfile = deps.writePidfile ?? ((path: string, pidfile: Pidfile) => {
    mkdirSync(storeDir, { recursive: true, mode: 0o700 });
    atomicWriteFile(path, `${JSON.stringify(pidfile)}\n`);
  });
  const removePidfile = deps.removePidfile ?? ((path: string) => {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });

  let store: LinkStore = emptyLinkStore();
  let started = false;
  let stopping = false;
  let startFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const states = new Map<string, TunnelState>();
  const children = new Map<string, { child: SshChild; argv: readonly string[] }>();
  const orphanUnverified = new Set<string>();

  const pidfilePath = (linkId: string): string => join(storeDir, `${linkId}.pid`);

  const conditionalRemovePidfile = (linkId: string, pid: number): void => {
    const path = pidfilePath(linkId);
    const current = readPidfile(path);
    if (current?.linkId === linkId && current.pid === pid) removePidfile(path);
  };

  const reapOrphans = (): void => {
    for (const record of store.links) {
      const pidfile = readPidfile(pidfilePath(record.id));
      if (!pidfile || pidfile.linkId !== record.id) continue;
      // macOS deliberately has no exact argv source here. A ps rendering is not an identity proof.
      if (platform !== "linux") {
        orphanUnverified.add(record.id);
        continue;
      }
      const actualArgv = readProcessArgv(pidfile.pid);
      if (actualArgv && sameArgv(actualArgv, pidfile.argv)) {
        try { killProcess(pidfile.pid); } finally { removePidfile(pidfilePath(record.id)); }
      } else {
        orphanUnverified.add(record.id);
      }
    }
  };

  const setEvent = (linkId: string, event: Parameters<typeof reduceTunnel>[1]): TunnelState => {
    const next = reduceTunnel(states.get(linkId) ?? IDLE, event, deps.random);
    states.set(linkId, next);
    return next;
  };

  const spawnFor = (record: LinkRecord): void => {
    if (stopping || record.direction !== "hub-initiated" || children.has(record.id)) return;
    if (store.listenerPort === null) {
      states.set(record.id, { kind: "failed", since: now(), reason: "forward" });
      return;
    }
    let argv: string[];
    try {
      argv = buildTunnelArgv({
        alias: record.alias,
        direction: "R",
        bindPort: record.tunnelPort,
        targetPort: store.listenerPort,
        knownHostsFile: linkKnownHostsPath(),
      });
      const child = runner.spawnTunnel(argv);
      children.set(record.id, { child, argv });
      orphanUnverified.delete(record.id);
      setEvent(record.id, { type: "spawn", now: now() });
      setEvent(record.id, { type: "ready", now: now() });
      writePidfile(pidfilePath(record.id), { version: 1, linkId: record.id, pid: child.pid, argv });
      void child.exited.then(async () => {
        if (children.get(record.id)?.child !== child) return;
        children.delete(record.id);
        conditionalRemovePidfile(record.id, child.pid);
        if (stopping) return;
        const stderr = child.stderr ? await child.stderr : "";
        const next = setEvent(record.id, { type: "exit", now: now(), stderrClass: classifySshStderr(stderr) });
        if (next.kind === "failed") return;
      }).catch(() => {
        if (children.get(record.id)?.child !== child) return;
        children.delete(record.id);
        conditionalRemovePidfile(record.id, child.pid);
        if (!stopping) setEvent(record.id, { type: "exit", now: now(), stderrClass: "network" });
      });
    } catch {
      states.set(record.id, { kind: "failed", since: now(), reason: "forward" });
    }
  };

  const tick = (): void => {
    if (stopping) return;
    const current = now();
    for (const record of store.links) {
      if (record.direction !== "hub-initiated") continue;
      const next = setEvent(record.id, { type: "tick", now: current });
      const child = children.get(record.id);
      if (next.kind === "failed" && child) {
        child.child.kill("SIGTERM");
        children.delete(record.id);
        conditionalRemovePidfile(record.id, child.child.pid);
      } else if (dueForSpawn(next, current)) {
        spawnFor(record);
      }
    }
  };

  const begin = (): void => {
    if (started) return;
    store = readStore();
    reapOrphans();
    started = true;
    for (const record of store.links) {
      if (record.direction === "hub-initiated") spawnFor(record);
    }
    if (store.links.some(record => record.direction === "hub-initiated")) timer = setTimer(tick, TIMER_MS);
  };

  return {
    start() {
      begin();
    },
    ensureStarted() {
      if (!startFlight) {
        startFlight = Promise.resolve().then(begin).finally(() => {
          startFlight = undefined;
        });
      }
      return startFlight;
    },
    async stopLink(linkId) {
      const current = children.get(linkId);
      if (!current) {
        states.set(linkId, IDLE);
        return;
      }
      children.delete(linkId);
      current.child.kill("SIGTERM");
      await current.child.exited;
      conditionalRemovePidfile(linkId, current.child.pid);
      states.set(linkId, IDLE);
    },
    status() {
      return store.links.map(record => {
        if (record.direction === "client-initiated") {
          return { linkId: record.id, direction: record.direction, state: "client-owned", pid: null };
        }
        const child = children.get(record.id);
        return {
          linkId: record.id,
          direction: record.direction,
          state: states.get(record.id) ?? IDLE,
          pid: child?.child.pid ?? null,
          ...(orphanUnverified.has(record.id) ? { orphan: "orphan-unverified" as const } : {}),
        };
      });
    },
    async stop() {
      stopping = true;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      const active = [...children.entries()];
      for (const [linkId, current] of active) {
        children.delete(linkId);
        current.child.kill("SIGTERM");
      }
      await Promise.all(active.map(async ([linkId, current]) => {
        await current.child.exited;
        conditionalRemovePidfile(linkId, current.child.pid);
        states.set(linkId, IDLE);
      }));
      for (const record of store.links) {
        if (record.direction === "hub-initiated") states.set(record.id, IDLE);
      }
    },
  };
}

export type { Pidfile };
