/**
 * `ocx disconnect` ends the connection in the durable state; the runtime that served it keeps
 * running until something restarts it. Left alone it still answered as a client, so the machine
 * was neither a working Child nor standalone, and a Home could not link it again. Disconnect
 * therefore restarts that runtime itself (the same restart as `ocx restart`, which a disconnected
 * client runtime hands to whichever owner holds it), bound to the runtime generation it observed,
 * and exits 0 only when no client runtime remained or a live standalone runtime answers afterwards.
 * Every other outcome exits 1, so a Home-driven leave stops before its own `ocx restart`.
 */
import type { ProxyRestartIo, ProxyRestartLive, ProxyRestartRequestOutcome } from "./tray-proxy";
import { RESTART_OWNERS, type RestartOwner } from "../client/runtime-restart";

function isHandledRestartOwner(value: string | undefined): value is RestartOwner {
  return value !== undefined && (RESTART_OWNERS as readonly string[]).includes(value);
}

/**
 * One runtime process: its runtime record. The attestation secret is created per process
 * (src/lib/local-management-attestation.ts createLocalAttestationSecret), so a new process at a
 * reused pid has a different one.
 */
export interface RuntimeGeneration {
  pid: number;
  port: number;
  hostname?: string;
  attestationSecret: string;
  /** The owner the runtime classified from positive evidence; absent for a bare flag or an older runtime. */
  restartOwner?: string;
}

export type DisconnectClientState =
  | { kind: "disconnected" }
  | { kind: "connected" }
  | { kind: "invalid" | "mismatched"; reason: string };

export interface DisconnectRuntimeDeps {
  /** Liveness that separates a confirmed absence from a probe that could not decide. */
  observe: () => Promise<
    | { kind: "live"; live: { pid: number | null; port: number; role?: string } }
    | { kind: "absent" | "unknown"; live: null }
  >;
  /** The runtime record of the observed runtime, only when it names that pid and port. */
  capture: (live: { pid: number | null; port: number }) => RuntimeGeneration | null;
  /** The durable client state, read right before the restart. */
  connectionState: () => DisconnectClientState;
  /**
   * `ocx restart` bound to this generation (see {@link bindRestartToRuntime}). `refusedBy` names a
   * supervisor that refused it: an owning service manager whose relaunch could not be proven.
   */
  restart: (target: RuntimeGeneration) => Promise<{ ok: boolean; refusedBy?: "service-unproven" }>;
  json: boolean;
  info?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Bind a restart to one runtime generation. The restart discovers its target again, and a connect
 * that committed in between can have started a new client runtime there, even at a reused pid.
 * The request goes out only for the captured pid and port, and the runtime record it attests and
 * derives the restart capability from is the captured one: a different process cannot prove that
 * secret, so it is refused before the restart request is sent, and its listener would reject the
 * capability anyway. A runtime that is gone gets no generic start.
 */
export function bindRestartToRuntime(
  io: ProxyRestartIo,
  target: RuntimeGeneration,
  request: (previous: ProxyRestartLive, readRuntime: (pid: number) => RuntimeGeneration | null) => ProxyRestartRequestOutcome | Promise<ProxyRestartRequestOutcome>,
): ProxyRestartIo {
  return {
    ...io,
    startWhenStopped: () => ({ status: "skipped" }),
    requestInPlaceRestart: previous => (previous.pid !== target.pid || previous.port !== target.port
      ? { accepted: false, uncertain: false, error: new Error("restart_target_changed") }
      : request(previous, pid => (pid === target.pid ? target : null))),
  };
}

/** What is known about the runtime answering when the advice is given. */
export type AnsweringRuntime =
  | { kind: "captured"; pid: number | null; refusedBy?: "service-unproven" }
  | { kind: "different"; pid: number | null }
  | { kind: "unknown" }
  | { kind: "none" };

/**
 * The only source of recovery advice for every exit-1 outcome of this step. A plain
 * `ocx restart` is advised only while the state read now is disconnected and either the captured
 * runtime is still the one answering, or nothing answers at all (a start, nothing to interrupt).
 * Any other state gets what was seen and `ocx status` inspection, never a restart.
 */
export function recoveryAdvice(state: DisconnectClientState, answering: AnsweringRuntime): string {
  if (state.kind === "connected") {
    return "A new connection is in use on this machine; inspect it with ocx status and ocx connect status and do not restart it. If this machine should leave its Home, run ocx disconnect again.";
  }
  if (state.kind !== "disconnected") {
    return `The client state is ${state.kind} (${state.reason}). Inspect it with ocx connect status and ocx status, fix the client state, then run ocx disconnect again.`;
  }
  switch (answering.kind) {
    case "captured": return answering.refusedBy
      ? `The client runtime${answering.pid ? ` (pid ${answering.pid})` : ""} still serves the old connection, and its service manager did not allow a restart from here. Restart it through the manager: ocx service restart (check ocx service status).`
      : `The client runtime${answering.pid ? ` (pid ${answering.pid})` : ""} still serves the old connection. Run on this machine: ocx restart`;
    case "different": return `A different client runtime${answering.pid ? ` (pid ${answering.pid})` : ""} answers now, so it was not restarted; inspect it with ocx status and ocx connect status before restarting anything.`;
    case "unknown": return "Which runtime answers could not be determined; inspect with ocx status and ocx connect status, and restart a client runtime only while ocx connect status reports disconnected.";
    case "none": return "No runtime answers; start one with ocx restart (or the desktop app or ocx service start, whichever owns it).";
  }
}

/**
 * Exit 0 only when no client runtime remains and the state is disconnected: read once after the
 * observation when no runtime or a non-client runtime answered, and again after a restart. Every
 * exit-1 outcome is a headline plus {@link recoveryAdvice} computed from the state read at that point.
 */
export async function restartRuntimeAfterDisconnect(deps: DisconnectRuntimeDeps): Promise<number> {
  const info = deps.info ?? (line => console.log(line));
  const error = deps.error ?? (line => console.error(line));
  const fail = (headline: string, answering: AnsweringRuntime): number => {
    error(`${headline} ${recoveryAdvice(deps.connectionState(), answering)}`);
    return 1;
  };
  const observed = await deps.observe();
  if (observed.kind === "unknown") {
    return fail("Disconnected, but this machine could not confirm whether the client runtime stopped: a recorded OpenCodex process did not answer.", { kind: "unknown" });
  }
  const client = observed.kind === "live" && observed.live.role === "client" ? observed.live : null;
  // Captured before the state is read: a runtime a later connect starts is a later generation.
  const target = client ? deps.capture(client) : null;
  if (client && !target) {
    return fail(`Disconnected, but this machine could not identify the running client runtime${client.pid ? ` (pid ${client.pid})` : ""}: its runtime record is missing or names another process, so it was not restarted.`, { kind: "unknown" });
  }
  // Only a record that states an owner this step handles (written by a runtime with this change:
  // the desktop app, a service manager with a current marker, or no supervisor) is restarted. Any
  // other record, a bare OCX_SERVICE=1 runtime or one started before this change, is left exactly
  // as origin/dev's `ocx disconnect` left it: no restart request, the disconnect's own exit 0.
  if (target && !isHandledRestartOwner(target.restartOwner)) return 0;
  const before = deps.connectionState();
  if (before.kind !== "disconnected") {
    error(`Disconnect finished, but the client runtime was not restarted. ${recoveryAdvice(before, { kind: "unknown" })}`);
    return 1;
  }
  if (!client || !target) return 0;
  // A --json caller reads one document from stdout; restart progress goes to stderr.
  const originalLog = console.log;
  if (deps.json) console.log = (...args: unknown[]) => console.error(...args);
  let ok = false;
  let refusedBy: "service-unproven" | undefined;
  try { ({ ok, refusedBy } = await deps.restart(target)); } finally { console.log = originalLog; }
  const after = await deps.observe();
  if (after.kind === "live" && after.live.role !== "client") {
    const late = deps.connectionState();
    if (late.kind !== "disconnected") {
      error(`The client runtime was restarted, but the client state changed meanwhile. ${recoveryAdvice(late, { kind: "unknown" })}`);
      return 1;
    }
    (deps.json ? error : info)("The client runtime was restarted; this machine now runs standalone OpenCodex.");
    return 0;
  }
  if (after.kind === "live") {
    const answering = deps.capture(after.live);
    const who: AnsweringRuntime = !answering ? { kind: "unknown" }
      : answering.attestationSecret === target.attestationSecret ? { kind: "captured", pid: after.live.pid, ...(refusedBy ? { refusedBy } : {}) }
      : { kind: "different", pid: after.live.pid };
    if (ok && who.kind === "captured") {
      return fail("The restart completed, but the runtime still answers as a client.", { kind: "unknown" });
    }
    return fail(ok ? "The restart completed, but a client runtime answers." : "Disconnected, but the restart did not complete.", who);
  }
  return fail("Disconnected, but this machine could not confirm a standalone runtime afterwards.", after.kind === "absent" ? { kind: "none" } : { kind: "unknown" });
}
