/**
 * The process-local "sibling instance" mark.
 *
 * A sibling is what `decideStartWithLiveOwner` calls `"sibling"`: `ocx start --port <other>` while a
 * live proxy already serves the configured port. Only an independent `OPENCODEX_HOME` gets past the
 * state-directory spend-ledger lease, and that independence ends at its own directory: the sibling
 * still shares `CODEX_HOME`, `~/.claude`, `~/.grok`, the shell rc hook and the launchd domain with
 * the live owner. A sibling that ran the ordinary startup sync therefore re-pointed Codex at its own
 * port, and every thread broke with "Connection refused" once the sibling exited or was killed. The
 * owner's client routing is the owner's, for this process's whole lifetime.
 *
 * So `handleStart` sets this mark the moment it takes the sibling path, before the server binds and
 * before any client write, and the local-client gate (`localClientSyncAllowed` in
 * `desired-state.ts`), the restore entry points, the catalog convergence funnel, the owned-catalog
 * refresh, the Claude writers, the stop teardown and the management route guard all consult it. The
 * sibling still serves direct requests on its own port.
 *
 * One-way and process-local on purpose. A mark that could be cleared would let a later code path
 * resume writing mid-lifetime, and a persisted one would outlive the process it describes. Worker
 * threads do not see it; that is acceptable because history jobs start only from inject and
 * restore, and both return before spawning one.
 *
 * A sibling runs the no-op native-main lifecycle (the gate is closed), so it never contends for the
 * native-main owner lease and cannot take ownership from the live proxy across that proxy's
 * restarts. Its data-plane native-main admission is the same as a Codex-OFF proxy's: an `auth.json`
 * refresh still runs under the machine-wide exclusive claim. The native-main mutation routes are
 * refused by the management guard instead.
 *
 * The one hand-off is to this process's own replacement. A sibling's dashboard drain-and-restart and
 * its standalone recycle spawn a fresh `ocx start` that re-probes; if the owner is down for that
 * moment, the replacement used to start as an unmarked owner, re-point Codex at itself and persist
 * `config.port`. Those spawns carry a port plus a one-use record nonce from `sibling-handoff.ts`.
 * `handleStart` consumes the record before any probe; an env port alone grants nothing.
 *
 * Deliberately import-free: the gate, the server and the CLI all read it, and a leaf cannot form a
 * cycle.
 */

let livePort: number | null = null;

/** Mark this process as a sibling of the proxy serving `port`. Idempotent; never unset. */
export function markSiblingStart(port: number): void {
  livePort = port;
}

/** The live owner's port when this process is a sibling, otherwise `null`. */
export function siblingOfLivePort(): number | null {
  return livePort;
}

/** Test seam only: production never clears the mark. */
export function resetSiblingStartForTests(): void {
  livePort = null;
}

/**
 * The one line a sibling prints wherever it declines a shared client write.
 *
 * With the sibling's own port it describes the split; without one (a skip deep inside a writer
 * that does not know the port) it names what was left alone.
 */
export function siblingSkipMessage(ownPort?: number): string {
  const live = livePort ?? "unknown";
  return ownPort === undefined
    ? `Client routing stays on the proxy at port ${live}; this instance does not rewrite Codex, Grok or Claude configs.`
    : `Client routing stays on the proxy at port ${live}; this instance serves direct requests on port ${ownPort} only.`;
}

/**
 * The optional runtime-record field that tells a later `ocx stop` it is stopping a sibling.
 * Empty when unmarked, so a non-sibling record stays byte-identical.
 */
export function siblingRuntimeField(): { siblingOfPort?: number } {
  return livePort === null ? {} : { siblingOfPort: livePort };
}

/** The env var a sibling hands its own replacement `ocx start`: the live owner's port. */
export const SIBLING_OF_PORT_ENV = "OCX_SIBLING_OF_PORT";
export const SIBLING_HANDOFF_NONCE_ENV = "OCX_SIBLING_HANDOFF_NONCE";

type Env = Record<string, string | undefined>;

/** The owner port an inherited marker names, or `null` when absent or not a TCP port. */
export function parseSiblingMarker(raw: string | undefined): number | null {
  const trimmed = raw?.trim() ?? "";
  if (!/^[0-9]{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Honor a port only when its one-use handoff record was consumed. Both env fields are stripped
 * before any probe, including on refusal, so a later detached child cannot inherit them.
 */
export function honorSiblingMarker(env: Env, consumeHandoff: (port: number, nonce: string | undefined) => boolean): number | null {
  const port = parseSiblingMarker(env[SIBLING_OF_PORT_ENV]);
  const nonce = env[SIBLING_HANDOFF_NONCE_ENV];
  delete env[SIBLING_OF_PORT_ENV];
  delete env[SIBLING_HANDOFF_NONCE_ENV];
  if (port === null || !consumeHandoff(port, nonce)) return null;
  markSiblingStart(port);
  return port;
}

/** A copy of `env` for this process's own replacement, with a one-use handoff when marked. */
export function withSiblingMarker<T extends Env>(env: T, issueHandoff?: (port: number) => string): T {
  const next: Env = withoutSiblingMarker(env);
  if (livePort !== null) {
    if (!issueHandoff) throw new Error("Sibling replacement requires a one-use handoff issuer.");
    next[SIBLING_OF_PORT_ENV] = String(livePort);
    next[SIBLING_HANDOFF_NONCE_ENV] = issueHandoff(livePort);
  }
  return next as T;
}

/** A copy of `env` for a child that must start as an ordinary owner (`ocx ensure`, the tray). */
export function withoutSiblingMarker<T extends Env>(env: T): T {
  const next: Env = { ...env };
  delete next[SIBLING_OF_PORT_ENV];
  delete next[SIBLING_HANDOFF_NONCE_ENV];
  return next as T;
}

/**
 * Whether `ocx stop` of a sibling runtime found the live owner instead of the sibling.
 *
 * A hard-killed sibling leaves its record behind with a dead pid, so the stop falls through to
 * discovery, and discovery ends on the configured port, where the live owner answers. Stopping that
 * proxy is the outage the sibling design exists to prevent. The found proxy is the owner when it
 * answers on `siblingOfPort`, or when only the configured-port fallback reached it (the sibling's
 * own record did not answer). `live` is `findLiveProxy`'s result.
 */
export function siblingStopFoundOwner(
  siblingOfPort: number | undefined,
  live: { port: number; source: "runtime" | "config" } | null,
): boolean {
  if (siblingOfPort === undefined || live === null) return false;
  return live.port === siblingOfPort || live.source === "config";
}
