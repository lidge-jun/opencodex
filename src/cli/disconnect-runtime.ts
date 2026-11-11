/**
 * `ocx disconnect` ends the connection in the durable state; the runtime that served it keeps
 * running until something restarts it. Left alone it still answered as a client, so the machine
 * was neither a working Child nor standalone, and a Home could not link it again. Disconnect
 * therefore restarts that runtime itself (the same restart as `ocx restart`, which a disconnected
 * client runtime hands to whichever owner holds it), bound to the runtime it observed, and fails
 * with the remaining step unless a live standalone runtime answers afterwards.
 */
import type { ProxyRestartIo } from "./tray-proxy";

export interface DisconnectRuntimeDeps {
  /** Liveness that separates a confirmed absence from a probe that could not decide. */
  observe: () => Promise<
    | { kind: "live"; live: { pid: number | null; role?: string } }
    | { kind: "absent" | "unknown"; live: null }
  >;
  /** `ocx restart` bound to this pid (see {@link bindRestartToPid}); resolves true when it completed. */
  restart: (expectedPid: number | null) => Promise<boolean>;
  /** The durable state is still disconnected (no connect landed after this disconnect). */
  stillDisconnected: () => boolean;
  json: boolean;
  info?: (line: string) => void;
  error?: (line: string) => void;
}

/**
 * Bind a restart to the runtime disconnect observed. The restart discovers its target again; a
 * connect that committed in between can have started a new client runtime there, and restarting
 * that one would interrupt a working connection. So the request is sent only to the same pid (the
 * client listener admits it only for that pid too, via the expected-pid header), and a runtime that
 * is gone gets no generic start: the caller then reports what it observes.
 */
export function bindRestartToPid(io: ProxyRestartIo, expectedPid: number | null): ProxyRestartIo {
  return {
    ...io,
    startWhenStopped: () => ({ status: "skipped" }),
    requestInPlaceRestart: previous => (expectedPid === null || previous.pid !== expectedPid
      ? { accepted: false, uncertain: false, error: new Error("restart_target_changed") }
      : io.requestInPlaceRestart(previous)),
  };
}

export async function restartRuntimeAfterDisconnect(deps: DisconnectRuntimeDeps): Promise<number> {
  const info = deps.info ?? (line => console.log(line));
  const error = deps.error ?? (line => console.error(line));
  const observed = await deps.observe();
  if (observed.kind === "unknown") {
    error("Disconnected, but this machine could not confirm whether the client runtime stopped: a recorded OpenCodex process did not answer. Check with ocx status; if it still serves as a client, run on this machine: ocx restart");
    return 1;
  }
  if (observed.kind !== "live" || observed.live.role !== "client") return 0;
  const live = observed.live;
  // A connect that landed after this disconnect owns that runtime now; restarting it is not ours.
  if (!deps.stillDisconnected()) {
    (deps.json ? error : info)("The running client runtime was left alone: a new connection was made after this disconnect.");
    return 0;
  }
  // A --json caller reads one document from stdout; restart progress goes to stderr.
  const originalLog = console.log;
  if (deps.json) console.log = (...args: unknown[]) => console.error(...args);
  let ok = false;
  try { ok = await deps.restart(live.pid); } finally { console.log = originalLog; }
  // Standalone is claimed only for what actually serves now: a live runtime that is not a client.
  const after = await deps.observe();
  if (after.kind === "live" && after.live.role !== "client") {
    (deps.json ? error : info)("The client runtime was restarted; this machine now runs standalone OpenCodex.");
    return 0;
  }
  if (after.kind === "live") {
    error(ok
      ? "The restart completed, but the runtime still answers as a client. Check with ocx status and ocx connect status on this machine."
      : `Disconnected, but the client runtime${live.pid ? ` (pid ${live.pid})` : ""} still serves the old connection. Run on this machine: ocx restart`);
    return 1;
  }
  error("Disconnected, but this machine could not confirm a standalone runtime afterwards (none answered, or the probe could not decide). Check with ocx status; start one with ocx restart (or the desktop app or ocx service start, whichever owns it).");
  return 1;
}
