export interface TrayProxyLive { port: number }

export interface TrayProxyServiceState {
  installed: boolean;
  startable: boolean;
  summary: string;
}

export interface TrayProxyStartIo {
  findLive: () => Promise<TrayProxyLive | null>;
  /** Normal Start is idempotent; restart fallback refuses a target that reappeared. */
  existingIsSuccess?: boolean;
  diagnoseService: () => TrayProxyServiceState;
  startService: () => void | Promise<void>;
  startDirect: () => void | Promise<void>;
  waitForProxy: () => Promise<TrayProxyLive | null>;
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface ProxyRestartLive {
  pid: number | null;
  port: number;
  hostname?: string;
  source: "runtime" | "config";
}

export type ProxyRestartRequestOutcome =
  | { accepted: true }
  | { accepted: false; uncertain: boolean; error?: unknown };

export type ProxyRestartResult =
  | { ok: true; mode: "started" }
  | { ok: true; mode: "skipped" }
  | { ok: true; mode: "restarted"; live: ProxyRestartLive }
  | { ok: false; phase: "start" | "identity" | "request" | "replacement"; error?: unknown };

export type ProxyRestartDiscovery =
  | { status: "live"; live: ProxyRestartLive }
  | { status: "absent" }
  | { status: "uncertain"; error?: unknown };

export interface ProxyRestartDiscoveryIo {
  findLive: () => Promise<ProxyRestartLive | null>;
  waitBetweenChecks?: () => Promise<void>;
  expired?: () => boolean;
}

export interface ProxyRestartIo {
  findLive: () => Promise<ProxyRestartDiscovery>;
  startWhenStopped: () => boolean | "skipped" | Promise<boolean | "skipped">;
  requestInPlaceRestart: (
    previous: ProxyRestartLive,
  ) => ProxyRestartRequestOutcome | Promise<ProxyRestartRequestOutcome>;
  waitForReplacement: (previous: ProxyRestartLive) => Promise<ProxyRestartLive | null>;
  /** Pause between start attempts; defaults to a short sleep. Tests pass a recorder. */
  waitBetweenAttempts?: () => Promise<void>;
}

/**
 * Confirm absence twice before restart is allowed to select a start-only path.
 * A live target appearing during confirmation is uncertainty, not success: the
 * caller must not claim it restarted a process it never asked to restart.
 */
export async function discoverStableProxyForRestart(
  io: ProxyRestartDiscoveryIo,
): Promise<ProxyRestartDiscovery> {
  let first: ProxyRestartLive | null;
  try {
    first = await io.findLive();
  } catch (error) {
    return { status: "uncertain", error };
  }
  if (first) return { status: "live", live: first };
  if (io.expired?.()) {
    return { status: "uncertain", error: new Error("restart_discovery_deadline_expired") };
  }

  await (io.waitBetweenChecks ?? (() => Bun.sleep(100)))();
  let second: ProxyRestartLive | null;
  try {
    second = await io.findLive();
  } catch (error) {
    return { status: "uncertain", error };
  }
  if (second) {
    return {
      status: "uncertain",
      error: new Error("restart_target_appeared_during_absence_confirmation"),
    };
  }
  if (io.expired?.()) {
    return { status: "uncertain", error: new Error("restart_discovery_deadline_expired") };
  }
  return { status: "absent" };
}

export function isProxyReplacement(
  previous: ProxyRestartLive,
  candidate: ProxyRestartLive | null,
): candidate is ProxyRestartLive & { pid: number } {
  return previous.pid !== null
    && candidate?.pid !== null
    && candidate?.pid !== undefined
    && candidate.source === "runtime"
    && candidate.port === previous.port
    && candidate.pid !== previous.pid;
}

/** Side-effect coordinator for the tray's fixed proxy-start action. */
export async function runTrayProxyStart(io: TrayProxyStartIo): Promise<boolean> {
  const live = await io.findLive();
  if (live) {
    if (io.existingIsSuccess === false) {
      io.error("Proxy appeared while restart was confirming absence; no start was attempted.");
      return false;
    }
    io.info(`Proxy already running on port ${live.port}.`);
    return true;
  }

  const service = io.diagnoseService();
  if (service.installed && !service.startable) {
    io.error(`Cannot start from the tray because the installed service is not viable: ${service.summary}`);
    io.error("Repair or remove the service before starting a direct proxy.");
    return false;
  }

  if (service.startable) await io.startService();
  else await io.startDirect();

  const started = await io.waitForProxy();
  if (!started) {
    io.error("Proxy did not become healthy after the tray start action.");
    return false;
  }
  io.info(`Proxy running on port ${started.port}.`);
  return true;
}

/**
 * Shared restart transaction for both `ocx restart` and the Windows tray.
 *
 * A live proxy restarts itself through POST /api/system/restart. That lifecycle owns
 * drain, supervisor handoff, exact replacement identity, and managed-routing
 * preservation. Re-implementing restart as `stop` + `start` here races a late service
 * child and lets ordinary /api/stop restore native routing between the two halves.
 * When no proxy is live there is nothing to recycle, so restart degrades to the
 * caller's normal start path.
 *
 * One invocation is the whole transaction: transient races are retried inside it so the
 * operator never has to re-run the command by hand. An uncertain discovery round is
 * re-observed, a failed start is retried, and a replacement that never arrives triggers
 * one strong re-observation (a crashed proxy reads absent and is started fresh; a late
 * replacement still proves success). A live target is never stopped to make room, so the
 * no-stop/start-fallback invariant holds: absence is confirmed twice before anything starts.
 */
/**
 * Start attempts per restart transaction. A service child that is still exiting, a port
 * that has not been released yet, or a supervisor that has not re-armed all fail the
 * first attempt and succeed on the next; an install that is actually broken still fails
 * fast enough to read the error. A deliberate operator refusal (`"skipped"`) never retries.
 */
const RESTART_START_ATTEMPTS = 3;

/** Discovery rounds per restart transaction; an uncertain round is a transient race. */
const RESTART_DISCOVERY_ATTEMPTS = 3;

async function startRestartedProxy(
  io: ProxyRestartIo,
  waitBetweenAttempts: () => Promise<void>,
): Promise<ProxyRestartResult> {
  let lastError: unknown;
  let sawError = false;
  for (let attempt = 0; attempt < RESTART_START_ATTEMPTS; attempt++) {
    if (attempt > 0) await waitBetweenAttempts();
    try {
      const started = await io.startWhenStopped();
      if (started === "skipped") return { ok: true, mode: "skipped" };
      if (started) return { ok: true, mode: "started" };
      sawError = false;
    } catch (error) {
      sawError = true;
      lastError = error;
    }
  }
  return sawError
    ? { ok: false, phase: "start", error: lastError }
    : { ok: false, phase: "start" };
}

export async function runProxyRestart(io: ProxyRestartIo): Promise<ProxyRestartResult> {
  const waitBetweenAttempts = io.waitBetweenAttempts ?? (() => Bun.sleep(500));
  // An uncertain round is a transient appear/vanish race, not a verdict: re-observe a
  // few times before failing, so one invocation survives a supervisor mid-handoff.
  let discovery: ProxyRestartDiscovery = { status: "uncertain", error: new Error("restart_discovery_no_attempt") };
  for (let attempt = 0; attempt < RESTART_DISCOVERY_ATTEMPTS; attempt++) {
    if (attempt > 0) await waitBetweenAttempts();
    try {
      discovery = await io.findLive();
    } catch (error) {
      discovery = { status: "uncertain", error };
    }
    if (discovery.status !== "uncertain") break;
  }

  if (discovery.status === "uncertain") {
    return { ok: false, phase: "request", error: discovery.error };
  }

  if (discovery.status === "absent") {
    return startRestartedProxy(io, waitBetweenAttempts);
  }

  const previous = discovery.live;

  if (previous.pid === null || previous.source !== "runtime") {
    return { ok: false, phase: "identity" };
  }

  let request: ProxyRestartRequestOutcome;
  try {
    request = await io.requestInPlaceRestart(previous);
  } catch (error) {
    // The request may have reached the proxy before the response connection failed.
    // Keep observing the original identity; never replay or fall back to stop/start.
    request = { accepted: false, uncertain: true, error };
  }

  if (!request.accepted && !request.uncertain) {
    return { ok: false, phase: "request", error: request.error };
  }

  let replacement: ProxyRestartLive | null;
  try {
    replacement = await io.waitForReplacement(previous);
  } catch (error) {
    return { ok: false, phase: "replacement", error };
  }
  if (replacement) return { ok: true, mode: "restarted", live: replacement };
  // The replacement never arrived: re-observe once instead of failing blind. A proxy
  // that crashed mid-restart reads absent (safe to start fresh — nothing live can race
  // the bind); a replacement that landed just past the deadline still proves success;
  // the same PID or another uncertain round fails closed exactly as before. A live
  // target is never stopped to make room: the no-stop/start-fallback invariant holds.
  let again: ProxyRestartDiscovery;
  try {
    again = await io.findLive();
  } catch (error) {
    return { ok: false, phase: "replacement", error };
  }
  if (again.status === "absent") return startRestartedProxy(io, waitBetweenAttempts);
  if (again.status === "live" && isProxyReplacement(previous, again.live)) {
    return { ok: true, mode: "restarted", live: again.live };
  }
  return request.accepted
    ? { ok: false, phase: "replacement" }
    : { ok: false, phase: "request", error: request.error };
}
