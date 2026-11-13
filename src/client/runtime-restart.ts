/**
 * The connected client runtime's answer to the bound `POST /api/system/restart` (OCX-6).
 *
 * It is the same restart `ocx restart` drives on a standalone proxy, with one difference the
 * Remote Link parity work requires: a failed restart keeps the old runtime. That is only possible
 * when this process starts its own replacement, so:
 *
 * - Under the desktop app or a viable service supervisor the restart is refused (409
 *   `restart_supervised`) and the runtime keeps serving. The supervisor owns this process and its
 *   port; handing off to it means exiting before anything proves the replacement can start.
 * - Unless the connection it serves is no longer the durable one (`ocx disconnect`, or a newer
 *   connect). Then there is nothing to keep, and under every owner the restart hands off to the
 *   standalone recycle, which exits the way that owner relaunches (desktop 75, service 1) or spawns
 *   its own replacement. Without this a Home-driven leave over SSH could not finish under the
 *   desktop app or a service: `ocx restart` refused and the stale client runtime kept serving.
 * - Otherwise the listener drains, a replacement `ocx start` is spawned and must answer within the
 *   budget. Success exits this process. A replacement that exited, or never answered and was then
 *   stopped, leaves this process to bind the port again, start a fresh tunnel supervisor and
 *   republish its records: the old runtime keeps serving and the CLI, still seeing its pid,
 *   reports the restart as failed.
 *
 * Everything runs inside {@link CLIENT_RESTART_BUDGET_MS} from acceptance.
 */
import {
  CLIENT_RESTART_DRAIN_MS,
  CLIENT_RESTART_READY_BY_MS,
  isDesktopSupervised,
} from "../lib/system-restart-contract";
import type { OcxClientConnectionConfig } from "../types";
import { isMarkedSupervisedServiceChild } from "../service/service-child-ownership";
import { sameClientConnectionOwner, type readClientConnectionState } from "./state";

type ClientConnectionState = ReturnType<typeof readClientConnectionState>;

/**
 * `service-unproven`: a service manager's marker shows it launched and owns this process, but its
 * relaunch cannot be proven (for example a systemd unit started by hand while disabled). Neither
 * exiting for it nor detaching from it is safe, so the restart is refused.
 */
export type ClientRestartSupervisor = "service" | "desktop" | "service-unproven";

/** Verdicts that keep the runtime: an owner exists, but exiting for it or detaching is not proven safe. */
export function restartRefusedByOwner(supervisor: ClientRestartSupervisor | null): supervisor is "service-unproven" {
  return supervisor === "service-unproven";
}

export type ClientRestartAdmission =
  | { kind: "accepted"; alreadyRestarting: boolean }
  | { kind: "stopping" }
  | { kind: "supervised"; supervisor: ClientRestartSupervisor };

export interface ClientRestartIo {
  /** A signal shutdown has claimed this runtime; it cannot admit a replacement. */
  stopping?: () => boolean;
  /** Which supervisor owns this process, or null when it starts its own replacement. */
  supervisor(): Promise<ClientRestartSupervisor | null>;
  /** The durable connection is no longer the one this runtime serves. */
  connectionChanged?: () => boolean;
  /**
   * Positive evidence of who owns this process ({@link restartOwnerProven}). Without it the
   * ended-connection recycle is never reached and the restart is origin/dev's.
   */
  ownerProven?: () => boolean;
  /**
   * Hand off to what the durable state now calls for; exits the process for its owner to relaunch.
   * Receives the same supervisor verdict as the refusal path (a service only when it is viable).
   */
  recycle?: (supervisor: ClientRestartSupervisor | null) => Promise<void>;
  /**
   * Fence syncs before anything stops: resolves false when they could not be fenced, and the
   * restart is then abandoned with this runtime still serving.
   */
  fence?: () => Promise<boolean>;
  /** Stop the tunnel supervisor and the listener, giving in-flight requests up to `drainMs`. */
  stop(drainMs: number): Promise<void>;
  /** Start the replacement; resolves once it answers, rejects when none survives. */
  spawnReplacement(deadlineAt: number): Promise<void>;
  /** Serve again on this process: listener, fresh tunnel supervisor, records. */
  resume(): Promise<void>;
  exitProcess(code: number): void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

export interface ClientRestartController {
  request(): Promise<ClientRestartAdmission>;
  /** Only an accepted flight owns routing; a supervisor check does not. */
  hasHandoff(): boolean;
  /** Join the accepted flight before signal teardown; may reject on a failed exit callback. */
  settled(): Promise<void>;
}

/** Stable, path-free label for a failure (an error message can carry a path). */
function failureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "failed";
}

export function createClientRestartController(io: ClientRestartIo): ClientRestartController {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const warn = io.warn ?? ((message: string) => console.warn(message));
  let flight: Promise<void> | null = null;

  const run = async (acceptedAt: number): Promise<void> => {
    // Let the 202 reach the CLI before the listener starts closing.
    await sleep(200);
    // A sync already past admission must stand down before the teardown. Without that fence it
    // could commit while the listener closes, so the restart does not start; the CLI sees this
    // process still serving and reports the restart as failed.
    let fenced = false;
    try { fenced = io.fence ? await io.fence() : true; } catch (error) { warn(`[client] restart: syncs could not be fenced (${failureCode(error)})`); }
    if (!fenced) {
      warn("[client] restart: in-flight syncs could not be fenced; this runtime keeps serving");
      return;
    }
    try {
      await io.stop(CLIENT_RESTART_DRAIN_MS);
    } catch (error) {
      warn(`[client] restart: stopping the runtime failed (${failureCode(error)}); continuing`);
    }
    try {
      await io.spawnReplacement(acceptedAt + CLIENT_RESTART_READY_BY_MS);
    } catch (error) {
      warn(`[client] restart: the replacement did not start (${failureCode(error)}); this runtime keeps serving`);
      try {
        await io.resume();
      } catch (resumeError) {
        warn(`[client] restart: this runtime could not serve again (${failureCode(resumeError)}); run 'ocx start'`);
        await io.exitProcess(1);
      }
      return;
    }
    await io.exitProcess(0);
  };

  return {
    hasHandoff: () => flight !== null,
    async request() {
      if (io.stopping?.()) return { kind: "stopping" };
      // Only positive ownership evidence opens the ended-connection recycle; without it (a bare
      // OCX_SERVICE=1) the request takes origin/dev's path below.
      if (io.recycle && (io.ownerProven?.() ?? true) && io.connectionChanged?.()) {
        if (flight) return { kind: "accepted", alreadyRestarting: true };
        // An owner that cannot be proven to relaunch this process keeps it, connection ended or not.
        const owner = await io.supervisor();
        if (io.stopping?.()) return { kind: "stopping" };
        if (restartRefusedByOwner(owner)) return { kind: "supervised", supervisor: owner };
        if (flight) return { kind: "accepted", alreadyRestarting: true };
        const recycle = io.recycle, changed = io.connectionChanged;
        // Let the 202 reach the CLI before the listener closes, then confirm the connection is
        // still ended: a connect that committed meanwhile keeps this runtime (the CLI reports kept).
        // The recheck is the last step before the recycle, after the (asynchronous) supervisor lookup.
        flight = sleep(200).then(async () => {
          const supervisor = await io.supervisor();
          if (restartRefusedByOwner(supervisor)) { warn("[client] restart: this runtime's owner could not be proven to relaunch it; it keeps serving"); return; }
          if (changed()) await recycle(supervisor);
        }).finally(() => { flight = null; });
        return { kind: "accepted", alreadyRestarting: false };
      }
      const supervisor = await io.supervisor();
      if (io.stopping?.()) return { kind: "stopping" };
      if (supervisor) return { kind: "supervised", supervisor };
      if (flight) return { kind: "accepted", alreadyRestarting: true };
      flight = run(now()).finally(() => { flight = null; });
      return { kind: "accepted", alreadyRestarting: false };
    },
    async settled() {
      await flight;
    },
  };
}

/** Production supervision check: the desktop app, then a service that will really relaunch us. */
export async function clientRestartSupervisor(): Promise<ClientRestartSupervisor | null> {
  const { diagnoseService } = await import("../service/diagnostics");
  const { isServiceViable } = await import("../service/orchestration");
  return classifyClientRestartSupervisor({ desktop: isDesktopSupervised(), env: process.env, diagnose: diagnoseService, legacyServiceViable: isServiceViable });
}

/**
 * Positive evidence of who owns this process: the desktop app, a service manager's marker
 * (OCX_SERVICE_MANAGED or the Windows wrapper's protocol marker, read from the environment only),
 * or no OCX_SERVICE at all (every service OpenCodex registers sets it). No inference: a legacy
 * Windows service recognised only from its parent's command line counts as a bare OCX_SERVICE=1.
 * A bare OCX_SERVICE=1 is none of these: a service registered before the manager marker existed
 * and the proxies of ocx claude, ocx codex and ocx opencode all carry it.
 */
export function restartOwnerProven(input: { desktop: boolean; env: NodeJS.ProcessEnv; managed?: (env: NodeJS.ProcessEnv) => boolean }): boolean {
  return restartOwnerEvidence(input) !== null;
}

/** The owners this change handles, as a client runtime states them in its record (`restartOwner`). */
export type RestartOwner = "desktop" | "service-manager" | "none";
export const RESTART_OWNERS: readonly RestartOwner[] = ["desktop", "service-manager", "none"];

/** The classified owner from positive evidence, or null for a bare OCX_SERVICE=1 ({@link restartOwnerProven}). */
export function restartOwnerEvidence(input: { desktop: boolean; env: NodeJS.ProcessEnv; managed?: (env: NodeJS.ProcessEnv) => boolean }): RestartOwner | null {
  if (input.desktop) return "desktop";
  if ((input.managed ?? isMarkedSupervisedServiceChild)(input.env)) return "service-manager";
  return input.env.OCX_SERVICE !== "1" ? "none" : null;
}

/**
 * Ownership and relaunch are separate facts. With a manager's marker, only a service diagnostic
 * that is viable and running lets this process exit for the manager to relaunch it; otherwise it is
 * `service-unproven` and keeps the runtime. A bare OCX_SERVICE=1 keeps origin/dev's decision
 * unchanged (b1148220574917c8 src/client/runtime-restart.ts:114-119): a viable service, else none.
 */
export function classifyClientRestartSupervisor(input: {
  desktop: boolean;
  env: NodeJS.ProcessEnv;
  diagnose: () => { viable: boolean; running: boolean };
  /** origin/dev's check for a bare OCX_SERVICE=1: src/service/orchestration.ts isServiceViable. */
  legacyServiceViable: () => boolean;
  /** Manager-launched evidence; defaults to the current markers only (isMarkedSupervisedServiceChild). */
  managed?: (env: NodeJS.ProcessEnv) => boolean;
}): ClientRestartSupervisor | null {
  if (input.desktop) return "desktop";
  // The managed marker (launchd, systemd, WinSW) or the Windows wrapper's protocol marker.
  if (!(input.managed ?? isMarkedSupervisedServiceChild)(input.env)) {
    if (input.env.OCX_SERVICE !== "1") return null;
    return input.legacyServiceViable() ? "service" : null;
  }
  // Relaunch needs positive evidence: viable AND running (launchd's viable also covers an
  // unknown load state for its other callers; running there means loaded).
  const diagnostic = input.diagnose();
  return diagnostic.viable && diagnostic.running ? "service" : "service-unproven";
}

/**
 * After a failed replacement: serve the same connection again only while it is still the durable
 * one (same owner and link). Anything else, a disconnect or a different connection, goes to the
 * recycle, which starts what the current state calls for instead of a stale client runtime.
 */
export function clientRestartRollbackAction(
  served: OcxClientConnectionConfig,
  current: ClientConnectionState,
): "resume" | "recycle" {
  return current.kind === "connected" && sameClientConnectionOwner(current.value, served)
    && current.value.link?.linkId === served.link?.linkId
    ? "resume"
    : "recycle";
}

/**
 * Whether the served connection has provably ended: the durable state is disconnected, or names a
 * different connection. Unreadable or mismatched state is not proof, so a supervised restart keeps
 * refusing on it instead of exiting a runtime whose link may still work.
 */
export function clientConnectionEnded(served: OcxClientConnectionConfig, current: ClientConnectionState): boolean {
  // Callers pass readClientConnectionStateWithEvidence(): "disconnected" then means a saved config
  // with no client, never a missing file.
  if (current.kind === "disconnected") return true;
  return current.kind === "connected" && clientRestartRollbackAction(served, current) === "recycle";
}
