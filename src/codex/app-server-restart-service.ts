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
  readStartMs?: (pids: readonly number[]) => Map<number, number | null>;
}

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
    // enumeration must not be reported as "nothing was running".
    code: before.state === "unknown" ? "enumeration_unavailable" : "nothing_running",
  });

  // `unknown` is not only the empty enumeration-failure case: the classifier also
  // returns it WITH processes when the catalog mtime or a start time is unreadable.
  // In that state it has not established that any server predates the catalog, so
  // signalling would kill a possibly-current app-server on a guess.
  if (before.state === "unknown" || before.processes.length === 0) return nothingToDo();

  // The classifier carries { pid, startedAtMs } and no command line, but
  // restartCodexAppServers needs the full identity so it can refuse to signal a
  // recycled pid. Re-list and intersect on pid rather than reconstructing an
  // identity we never verified.
  const classifiedStarts = new Map(
    before.processes.map(entry => [entry.pid, entry.startedAtMs] as const),
  );
  const live = (io.listProcesses ?? listCodexAppServerProcesses)(io.processIo ?? {});
  const candidates = live.filter(process => classifiedStarts.has(process.pid));

  // A pid plus a command line is not an identity: a replacement app-server launched
  // by the same Codex install has both. Re-read start times and drop any candidate
  // whose process started after the reading we classified, so a recycled pid can
  // never receive a signal meant for the process that held it.
  const platform = io.processIo?.platform ?? process.platform;
  const startsNow = candidates.length > 0
    ? (io.readStartMs ?? (pids => readProcessStartMsBatch(pids, platform)))(
      candidates.map(process => process.pid),
    )
    : new Map<number, number | null>();
  const targets = candidates.filter(process => {
    const classified = classifiedStarts.get(process.pid) ?? null;
    const current = startsNow.get(process.pid) ?? null;
    // An unreadable start time on either side means we cannot prove sameness.
    if (classified === null || current === null) return false;
    return classified === current;
  });

  if (targets.length === 0) {
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
    kill: (pid, signal) => {
      const classified = classifiedStarts.get(pid) ?? null;
      const current = (io.readStartMs ?? (pids => readProcessStartMsBatch(pids, platform)))([pid])
        .get(pid) ?? null;
      if (classified === null || current === null || classified !== current) {
        throw new CodexAppServerIdentityChanged(pid);
      }
      const send = io.processIo?.kill ?? ((target: number, sig: NodeJS.Signals) => {
        process.kill(target, sig);
      });
      send(pid, signal);
    },
  };

  const result = (io.restart ?? restartCodexAppServers)(targets, guardedProcessIo);
  const clean = result.surviving.length === 0 && result.failed.length === 0;
  return {
    success: clean,
    stateBefore: before.state,
    synced,
    requested: result.requested,
    stopped: result.stopped,
    surviving: result.surviving,
    // Project { pid, error } down to pids: an OS error message can embed a path
    // or the account name.
    failed: result.failed.map(entry => entry.pid),
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

