/**
 * Dashboard-driven Codex app-server restart (#1046 follow-up).
 *
 * The defect: Codex builds a static model manager from the catalog once at
 * app-server startup and never rereads the file, so an app-server that outlives a
 * catalog write serves a roster that no longer exists on disk. Detection already
 * existed and already fired — but it warns on stderr, and the thing keeping an SSH
 * workspace's app-server alive is the Codex app, not a human at a terminal.
 *
 * This module is the consent boundary the startup path deliberately refuses to
 * cross (see `warnIfStaleCodexAppServersAfterStartupWrite`): a login is not consent
 * to interrupt an in-flight turn, but a dashboard click is.
 *
 * The route is a thin adapter over these two functions. Decisions live here so a
 * test can drive every branch through {@link CodexRestartServiceIo} instead of
 * mocking modules — a route test that could not stub this would really terminate
 * the developer's own Codex.
 *
 * Plan and audit history: `devlog/_fin/260815_gui_codex_restart/010_phase1_backend_endpoint.md`.
 */
import {
  collectCodexAppServerCatalogState,
  listCodexAppServerProcesses,
  readProcessStartMsBatch,
  resetCodexAppServerCatalogStateCache,
  restartCodexAppServers,
} from "./app-server-processes";
import type { CodexAppServerProcessIo } from "./app-server-processes";
import type {
  CodexAppServerStateResponse,
  CodexRestartResponse,
} from "../lib/codex-restart-contract";
import { isProcessAlive } from "../lib/process-control";
import { getServerListenPort } from "../server/lifecycle";

export interface CodexRestartServiceIo {
  /** Process-layer seam, forwarded to every app-server-processes call. */
  processIo?: CodexAppServerProcessIo;
  /** Catalog refresh seam. Resolves to whether a catalog or cache write happened. */
  syncCatalog?: (port?: number) => Promise<boolean>;
  /**
   * Live listen port. `config.port` names the PREFERRED port; after a fallback
   * start the bound port differs, and syncing the preferred one would point Codex
   * at a dead listener (same reason the CLI startup path passes the live port).
   */
  listenPort?: () => number | undefined;
  collectState?: typeof collectCodexAppServerCatalogState;
  listProcesses?: typeof listCodexAppServerProcesses;
  restart?: typeof restartCodexAppServers;
  resetStateCache?: () => void;
  /** Start-time reader used to re-confirm process identity before signalling. */
  readStartMs?: (pids: readonly number[], timeoutMs?: number) => Map<number, number | null>;
}

// The final identity read happens synchronously inside the signal loop. Keep its
// fail-closed wait much shorter than the initial batched classification query so
// one slow ps/CIM lookup cannot consume the full platform timeout per target.
const FINAL_IDENTITY_READ_TIMEOUT_MS = 1_500;

/**
 * Thrown by the final identity gate when a pid no longer belongs to the process
 * that was classified. restartCodexAppServers turns a kill throw into a `failed`
 * entry, which is the honest outcome: nothing was signalled and the caller is told.
 */
class CodexAppServerIdentityChanged extends Error {
  constructor(pid: number) {
    super(`codex app-server identity changed before signal (pid ${pid})`);
    this.name = "CodexAppServerIdentityChanged";
  }
}


/**
 * Single-flight latch. Two dashboard surfaces can each hold their own controller,
 * so a user can press restart twice while the first request is still syncing the
 * catalog. Without this, the second call re-signals processes the first already
 * terminated and both report success — and it widens the window in which a pid can
 * be recycled between classification and signalling.
 */
let inFlight: Promise<CodexRestartResponse> | null = null;

export function readCodexAppServerState(
  io: CodexRestartServiceIo = {},
): CodexAppServerStateResponse {
  const status = (io.collectState ?? collectCodexAppServerCatalogState)(io.processIo ?? {});
  return { state: status.state, runningCount: status.processes.length };
}

export function performCodexRestart(
  io: CodexRestartServiceIo = {},
): Promise<CodexRestartResponse> {
  if (inFlight) return inFlight;
  const run = runCodexRestart(io).finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Test hook: drop the single-flight latch between cases. */
export function resetCodexRestartInFlightForTests(): void {
  inFlight = null;
}

async function runCodexRestart(io: CodexRestartServiceIo): Promise<CodexRestartResponse> {
  // Refresh the catalog FIRST. A user pressing "restart Codex" wants the new
  // roster; stopping app-servers before the write would hand the replacement the
  // same stale file it just lost.
  let synced = false;
  try {
    const port = (io.listenPort ?? getServerListenPort)();
    synced = await (io.syncCatalog ?? defaultSyncCatalog)(port);
  } catch {
    // A sync failure must not block the restart: an operator whose picker is stale
    // still benefits from the app-server exiting and rereading whatever is on disk.
  }

  // The classifier memoizes for 5s when every io field is defaulted, so a reading
  // taken before the write above would otherwise be replayed after it.
  (io.resetStateCache ?? resetCodexAppServerCatalogStateCache)();
  const before = (io.collectState ?? collectCodexAppServerCatalogState)(io.processIo ?? {});

  const nothingToDo = (): CodexRestartResponse => ({
    success: true,
    stateBefore: before.state,
    synced,
    requested: [],
    stopped: [],
    surviving: [],
    failed: [],
    // Enumeration failure reads as `unknown`, never `not_running` (#857): a failed
    // enumeration must not be reported as a clean no-op. `nothing_running` is the
    // wire-compatible "no stale restart target remained" result; stateBefore
    // distinguishes no process, an already-current process, and a later exit.
    code: before.state === "unknown" ? "enumeration_unavailable" : "nothing_running",
  });

  // Only a stale verdict establishes that any server predates the catalog.
  // `unknown` can include processes with unreadable timestamps, while `fresh`
  // explicitly establishes that none should be interrupted.
  const catalogMtimeMs = before.catalogMtimeMs;
  if (before.state !== "stale" || catalogMtimeMs === null || before.processes.length === 0) {
    return nothingToDo();
  }

  // The classifier carries { pid, startedAtMs } and no command line, but
  // restartCodexAppServers needs the full identity so it can refuse to signal a
  // recycled pid. Re-list and intersect on pid rather than reconstructing an
  // identity we never verified.
  const isUsableStartMs = (value: number | null): value is number =>
    value !== null && Number.isFinite(value) && value >= 0;
  const classifiedStarts = new Map<number, number>();
  const unresolved = new Set<number>();
  for (const entry of before.processes) {
    if (!isUsableStartMs(entry.startedAtMs)) {
      // A stale aggregate carrying an unreadable row is inconsistent, but still
      // not permission to forget a process that may be running the old catalog.
      unresolved.add(entry.pid);
    } else if (entry.startedAtMs <= catalogMtimeMs) {
      classifiedStarts.set(entry.pid, entry.startedAtMs);
    }
  }
  const live = (io.listProcesses ?? listCodexAppServerProcesses)(io.processIo ?? {});
  const candidates = live.filter(process => classifiedStarts.has(process.pid));
  const candidatePids = new Set(candidates.map(process => process.pid));
  const isAlive = io.processIo?.isAlive ?? isProcessAlive;

  // An empty second listing can mean that every stale target exited, but the
  // default platform enumerator also fails closed to an empty list. Distinguish
  // those cases with the existing liveness seam: a still-live classified pid
  // whose command identity cannot be recovered must keep the outcome unsettled.
  for (const pid of classifiedStarts.keys()) {
    if (candidatePids.has(pid)) continue;
    try {
      if (isAlive(pid)) unresolved.add(pid);
    } catch {
      // A liveness probe failure is not proof that the stale process exited.
      unresolved.add(pid);
    }
  }

  // A pid plus a command line is not an identity: a replacement app-server launched
  // by the same Codex install has both. Re-read start times and drop any candidate
  // whose process started after the reading we classified, so a recycled pid can
  // never receive a signal meant for the process that held it.
  const platform = io.processIo?.platform ?? process.platform;
  const readStartMs = io.readStartMs
    ?? ((pids: readonly number[], timeoutMs?: number) => readProcessStartMsBatch(pids, platform, timeoutMs));
  const startsNow = candidates.length > 0
    ? readStartMs(candidates.map(process => process.pid))
    : new Map<number, number | null>();
  const targets = candidates.filter(process => {
    const classified = classifiedStarts.get(process.pid) ?? null;
    const current = startsNow.get(process.pid) ?? null;
    // An unreadable or changed start time means we cannot prove this live pid is
    // the stale process we classified. Refuse the signal, but do not report the
    // request as settled while that pid may still hold the old catalog.
    if (classified === null || current === null || classified !== current) {
      unresolved.add(process.pid);
      return false;
    }
    return true;
  });

  if (targets.length === 0 && unresolved.size === 0) {
    // Every classified process exited, or the pid now belongs to a different
    // process. Reporting "stopped" would claim credit for work this request did
    // not do.
    return {
      success: true,
      stateBefore: before.state,
      synced,
      requested: [],
      stopped: [],
      surviving: [],
      failed: [],
      code: "nothing_running",
    };
  }

  // Final identity gate, applied at the moment of signalling rather than before it.
  //
  // restartCodexAppServers re-lists and compares pid+command-line immediately
  // before SIGTERM, but a replacement app-server launched by the same Codex
  // install has BOTH of those. The start time is the field that distinguishes
  // them, and it is not part of that comparison, so the check above (done before
  // the call) still leaves a window: the original can exit and a replacement can
  // claim its pid in between.
  //
  // Wrapping `kill` closes the window: this runs inside restartCodexAppServers'
  // own signalling loop, so the start time is re-read at the last possible moment.
  // An unreadable start time refuses the signal — on a recycled pid, guessing
  // costs the user the turn that is running right now.
  const guardedProcessIo: CodexAppServerProcessIo = {
    ...(io.processIo ?? {}),
    beforeSignal: (pid, signal) => {
      const classified = classifiedStarts.get(pid) ?? null;
      const current = readStartMs([pid], FINAL_IDENTITY_READ_TIMEOUT_MS)
        .get(pid) ?? null;
      if (!isUsableStartMs(classified) || !isUsableStartMs(current) || classified !== current) {
        throw new CodexAppServerIdentityChanged(pid);
      }
      io.processIo?.beforeSignal?.(pid, signal);
    },
  };

  const result = targets.length > 0
    ? (io.restart ?? restartCodexAppServers)(targets, guardedProcessIo)
    : { requested: [], stopped: [], surviving: [], failed: [] };
  const stoppedSet = new Set(result.stopped);
  const survivingSet = new Set(result.surviving);
  const failedSet = new Set(result.failed.map(entry => entry.pid));
  for (const pid of failedSet) survivingSet.add(pid);
  for (const pid of unresolved) {
    survivingSet.add(pid);
    failedSet.add(pid);
  }
  const requestedSet = new Set([
    ...targets.map(target => target.pid),
    ...result.requested,
    ...stoppedSet,
    ...survivingSet,
    ...failedSet,
  ]);

  // A helper stop can race with a still-live pid, and a custom seam or final
  // helper re-list can omit a requested pid from every terminal bucket. Recheck
  // every non-survivor instead of interpreting either case as a successful stop.
  for (const pid of requestedSet) {
    if (survivingSet.has(pid)) continue;
    try {
      if (isAlive(pid)) survivingSet.add(pid);
      else if (!stoppedSet.has(pid)) stoppedSet.add(pid);
    } catch {
      survivingSet.add(pid);
      failedSet.add(pid);
    }
  }
  for (const pid of survivingSet) stoppedSet.delete(pid);

  const ascending = (left: number, right: number) => left - right;
  const requested = [...requestedSet].sort(ascending);
  const stopped = [...stoppedSet].sort(ascending);
  const surviving = [...survivingSet].sort(ascending);
  const failed = [...failedSet].sort(ascending);
  const clean = surviving.length === 0;
  return {
    success: clean,
    stateBefore: before.state,
    synced,
    requested,
    stopped,
    surviving,
    // Project { pid, error } down to pids: an OS error message can embed a path
    // or the account name. Identity-verification failures use the same private-
    // data-free pid projection and remain unsettled for the GUI.
    failed,
    code: clean ? "stopped" : "partially_stopped",
  };
}

async function defaultSyncCatalog(port?: number): Promise<boolean> {
  const { syncModelsToCodex } = await import("./sync");
  // `undefined` config takes syncModelsToCodex's own loadConfig() default; `null`
  // log keeps this request path silent.
  const result = await syncModelsToCodex(port, undefined, null);
  return result.catalogWritten || result.cacheSynced;
}
