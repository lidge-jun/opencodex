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
  reload(): Promise<void>;
  stopLink(linkId: string): Promise<void>;
  status(): readonly LinkTunnelStatus[];
  notifyAuthenticatedRequest?(apiKeyId: string): void;
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
  apiKeys?: () => readonly { id: string; name: string }[];
  revokeApiKey?: (id: string) => boolean;
  warn?: (message: string) => void;
}

const TIMER_MS = 1_000;
const SPAWN_GRACE_MS = 5_000;

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
  const warn = deps.warn ?? ((message: string) => console.warn(message));

  let store: LinkStore = emptyLinkStore();
  let started = false;
  let stopping = false;
  let lifecycleFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const states = new Map<string, TunnelState>();
  const children = new Map<string, { child: SshChild; argv: readonly string[] }>();
  const orphanUnverified = new Set<string>();
  const recordInstances = new Map<string, string>();

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
  ]);

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
    if (states.get(record.id)?.kind === "failed") return;
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
      } else if (next.kind === "connecting" && child && current - next.since >= SPAWN_GRACE_MS) {
        setEvent(record.id, { type: "ready", now: current });
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

  let queuedLifecycle: (() => void | Promise<void>) | undefined;
  const runLifecycle = (operation: () => void | Promise<void>): Promise<void> => {
    if (lifecycleFlight) {
      queuedLifecycle = operation;
      return lifecycleFlight;
    }
    lifecycleFlight = (async () => {
      let next: (() => void | Promise<void>) | undefined = operation;
      while (next) {
        await next();
        next = queuedLifecycle;
        queuedLifecycle = undefined;
      }
    })().finally(() => {
      lifecycleFlight = undefined;
      queuedLifecycle = undefined;
    });
    return lifecycleFlight;
  };

  const stopLink = async (linkId: string): Promise<void> => {
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
  };

  return {
    start() {
      if (lifecycleFlight) return;
      begin();
    },
    ensureStarted() {
      return runLifecycle(begin);
    },
    async reload() {
      await runLifecycle(async () => {
        if (stopping) return;
        if (!started) {
          begin();
          return;
        }
        const nextStore = readStore();
        const nextInstances = new Map(nextStore.links.map(record => [record.id, recordInstance(record, nextStore.listenerPort)]));
        const changed = new Set<string>();
        for (const record of nextStore.links) {
          if (recordInstances.get(record.id) !== undefined && recordInstances.get(record.id) !== nextInstances.get(record.id)) {
            changed.add(record.id);
          }
        }
        store = nextStore;
        for (const [linkId] of [...children]) {
          if (nextInstances.has(linkId) && !changed.has(linkId)) continue;
          await stopLink(linkId);
          states.delete(linkId);
          orphanUnverified.delete(linkId);
          recordInstances.delete(linkId);
          if (stopping) return;
        }
        for (const record of nextStore.links) {
          if (changed.has(record.id)) {
            states.delete(record.id);
            orphanUnverified.delete(record.id);
          }
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
    stopLink,
    notifyAuthenticatedRequest(apiKeyId: string) {
      for (const record of store.links) {
        if (record.direction === "hub-initiated" && record.apiKeyId === apiKeyId && children.has(record.id)) {
          const state = states.get(record.id);
          if (state?.kind === "connecting" || state?.kind === "reconnecting") setEvent(record.id, { type: "ready", now: now() });
        }
      }
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
      if (lifecycleFlight) await lifecycleFlight;
    },
  };
}

export type { Pidfile };
