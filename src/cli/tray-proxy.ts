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
 */
export async function runProxyRestart(io: ProxyRestartIo): Promise<ProxyRestartResult> {
  let discovery: ProxyRestartDiscovery;
  try {
    discovery = await io.findLive();
  } catch (error) {
    return { ok: false, phase: "request", error };
  }

  if (discovery.status === "uncertain") {
    return { ok: false, phase: "request", error: discovery.error };
  }

  if (discovery.status === "absent") {
    try {
      const started = await io.startWhenStopped();
      if (started === "skipped") return { ok: true, mode: "skipped" };
      return started ? { ok: true, mode: "started" } : { ok: false, phase: "start" };
    } catch (error) {
      return { ok: false, phase: "start", error };
    }
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

  try {
    const replacement = await io.waitForReplacement(previous);
    if (replacement) return { ok: true, mode: "restarted", live: replacement };
    return request.accepted
      ? { ok: false, phase: "replacement" }
      : { ok: false, phase: "request", error: request.error };
  } catch (error) {
    return { ok: false, phase: "replacement", error };
  }
}
