/**
 * `ocx disconnect` ends the connection in the durable state; the runtime that served it keeps
 * running until something restarts it. Left alone it still answered as a client, so the machine
 * was neither a working Child nor standalone, and a Home could not link it again. Disconnect
 * therefore restarts a live client runtime itself (the same restart as `ocx restart`, which a
 * disconnected client runtime hands to whichever owner holds it), and fails with the remaining
 * step when that restart does not complete or when it cannot tell whether one is still running.
 */
export interface DisconnectRuntimeDeps {
  /** Liveness that separates a confirmed absence from a probe that could not decide. */
  observe: () => Promise<
    | { kind: "live"; live: { pid: number | null; role?: string } }
    | { kind: "absent" | "unknown"; live: null }
  >;
  /** `ocx restart`; resolves true once a replacement is verified. */
  restart: () => Promise<boolean>;
  json: boolean;
  info?: (line: string) => void;
  error?: (line: string) => void;
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
  // A --json caller reads one document from stdout; restart progress goes to stderr.
  const originalLog = console.log;
  if (deps.json) console.log = (...args: unknown[]) => console.error(...args);
  let ok = false;
  try { ok = await deps.restart(); } finally { console.log = originalLog; }
  if (ok) {
    (deps.json ? error : info)("The client runtime was restarted; this machine now runs standalone OpenCodex.");
    return 0;
  }
  error(`Disconnected, but the client runtime${live.pid ? ` (pid ${live.pid})` : ""} still serves the old connection. Run on this machine: ocx restart`);
  return 1;
}
