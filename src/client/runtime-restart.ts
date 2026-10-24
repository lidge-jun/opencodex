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
import { sameClientConnectionOwner, type readClientConnectionState } from "./state";

type ClientConnectionState = ReturnType<typeof readClientConnectionState>;

export type ClientRestartSupervisor = "service" | "desktop";

export type ClientRestartAdmission =
  | { kind: "accepted"; alreadyRestarting: boolean }
  | { kind: "supervised"; supervisor: ClientRestartSupervisor };

export interface ClientRestartIo {
  /** Which supervisor owns this process, or null when it starts its own replacement. */
  supervisor(): Promise<ClientRestartSupervisor | null>;
  /** Stop the tunnel supervisor and the listener, giving in-flight requests up to `drainMs`. */
  stop(drainMs: number): Promise<void>;
  /** Start the replacement; resolves once it answers, rejects when none survives. */
  spawnReplacement(deadlineAt: number): Promise<void>;
  /** Serve again on this process: listener, fresh tunnel supervisor, records. */
  resume(): Promise<void>;
  exitProcess(code: number): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

export interface ClientRestartController {
  request(): Promise<ClientRestartAdmission>;
  /** Settles when the restart in flight (if any) has finished or rolled back. Tests only. */
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
        io.exitProcess(1);
      }
      return;
    }
    io.exitProcess(0);
  };

  return {
    async request() {
      const supervisor = await io.supervisor();
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
  if (isDesktopSupervised()) return "desktop";
  if (process.env.OCX_SERVICE !== "1") return null;
  // Same viability test as the standalone restart: stale service assets would not relaunch.
  const { isServiceViable } = await import("../service/orchestration");
  return isServiceViable() ? "service" : null;
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
