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
  /** `ocx restart` bound to this generation (see {@link bindRestartToRuntime}); true when it completed. */
  restart: (target: RuntimeGeneration) => Promise<boolean>;
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

/** The message for a state that is not disconnected, or null when it is. */
function notDisconnected(state: DisconnectClientState): string | null {
  if (state.kind === "disconnected") return null;
  if (state.kind === "connected") return "Disconnect finished, but a new connection was made on this machine after this disconnect; its client runtime was left alone. If this machine should leave its Home, run ocx disconnect again.";
  return `Disconnect finished, but the client state is ${state.kind} (${state.reason}), so the client runtime was not restarted. Inspect it with ocx connect status, fix the client state, then run ocx disconnect again.`;
}

/**
 * Exit 0 only when the durable state is disconnected (read after the observation and again before
 * exit 0) and no client runtime is left: none answered, a non-client runtime answered, or the
 * restart left a live non-client runtime. Everything else exits 1 with what was seen and what to run.
 */
export async function restartRuntimeAfterDisconnect(deps: DisconnectRuntimeDeps): Promise<number> {
  const info = deps.info ?? (line => console.log(line));
  const error = deps.error ?? (line => console.error(line));
  const observed = await deps.observe();
  if (observed.kind === "unknown") {
    error("Disconnected, but this machine could not confirm whether the client runtime stopped: a recorded OpenCodex process did not answer. Check with ocx status; if it still serves as a client, run on this machine: ocx restart");
    return 1;
  }
  const client = observed.kind === "live" && observed.live.role === "client" ? observed.live : null;
  // Captured before the state is read: a runtime a later connect starts is a later generation.
  const target = client ? deps.capture(client) : null;
  if (client && !target) {
    error(`Disconnected, but this machine could not identify the running client runtime${client.pid ? ` (pid ${client.pid})` : ""}: its runtime record is missing or names another process. It was not restarted. Check with ocx status, then run on this machine: ocx restart`);
    return 1;
  }
  const before = notDisconnected(deps.connectionState());
  if (before) { error(before); return 1; }
  if (!client || !target) return 0;
  // A --json caller reads one document from stdout; restart progress goes to stderr.
  const originalLog = console.log;
  if (deps.json) console.log = (...args: unknown[]) => console.error(...args);
  let ok = false;
  try { ok = await deps.restart(target); } finally { console.log = originalLog; }
  // Standalone is claimed only for what actually serves now: a live runtime that is not a client.
  const after = await deps.observe();
  if (after.kind === "live" && after.live.role !== "client") {
    const late = notDisconnected(deps.connectionState());
    if (late) { error(late); return 1; }
    (deps.json ? error : info)("The client runtime was restarted; this machine now runs standalone OpenCodex.");
    return 0;
  }
  if (after.kind === "live") {
    error(ok
      ? "The restart completed, but the runtime still answers as a client. Check with ocx status and ocx connect status on this machine."
      : `Disconnected, but the client runtime${client.pid ? ` (pid ${client.pid})` : ""} still serves the old connection. Run on this machine: ocx restart`);
    return 1;
  }
  error("Disconnected, but this machine could not confirm a standalone runtime afterwards (none answered, or the probe could not decide). Check with ocx status; start one with ocx restart (or the desktop app or ocx service start, whichever owns it).");
  return 1;
}
