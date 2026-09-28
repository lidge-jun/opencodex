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

export type ProxyRestartStartOutcome =
  | { status: "started" }
  | { status: "skipped" }
  | { status: "failed"; launch: "never" | "exited" | "unknown"; error?: unknown };

/** Only the launched child's observed exit (or no launch) permits another attempt. */
export function restartStartOutcome(
  started: boolean,
  child: { exitCode: number | null; signalCode: string | null } | null,
  error?: unknown,
): ProxyRestartStartOutcome {
  if (started) return { status: "started" };
  return {
    status: "failed",
    launch: child === null ? "never" : child.exitCode !== null || child.signalCode !== null ? "exited" : "unknown",
    error,
  };
}

export interface ProxyRestartDiscoveryIo {
  findLive: () => Promise<ProxyRestartLive | null>;
  waitBetweenChecks?: () => Promise<void>;
  expired?: () => boolean;
}

export interface ProxyRestartIo {
  findLive: () => Promise<ProxyRestartDiscovery>;
  startWhenStopped: (recoveringLiveRestart: boolean) => ProxyRestartStartOutcome | Promise<ProxyRestartStartOutcome>;
  requestInPlaceRestart: (
    previous: ProxyRestartLive,
  ) => ProxyRestartRequestOutcome | Promise<ProxyRestartRequestOutcome>;
  waitForReplacement: (previous: ProxyRestartLive) => Promise<ProxyRestartLive | null>;
  /** Pause between start attempts; defaults to a short sleep. Tests pass a recorder. */
  waitBetweenAttempts?: () => Promise<void>;
  /**
   * Strong re-observation after a missed replacement. Defaults to `findLive`, but the
   * production wiring passes a fresh bounded window: by the time the replacement wait
   * expires, the shared observe deadline has expired too, so reusing it would answer
   * `uncertain` forever and the crash-recovery path could never run.
   */
  reobserveAfterReplacement?: (previous: ProxyRestartLive) => Promise<ProxyRestartDiscovery>;
  /** A failed recovery start must recheck under a fresh window after the shared deadline. */
  recheckAfterFailedStart?: () => Promise<ProxyRestartDiscovery>;
}

/**
 * Poll for a departed predecessor inside a bounded confirmation window. Each round is
 * already a strong observation (the caller supplies it); this only decides whether
 * another round still fits: absent and valid-replacement verdicts return immediately,
 * while the still-live old PID (or another uncertain round) keeps polling until the
 * budget check refuses. A replacement that lands late in the window is still attested
 * instead of being cut off by the wait that reserved the window.
 */
export async function pollReplacementDeparture(
  observe: () => Promise<ProxyRestartDiscovery>,
  previous: ProxyRestartLive,
  shouldContinue: () => boolean,
  wait: () => Promise<void>,
): Promise<ProxyRestartDiscovery> {
  for (;;) {
    const round = await observe();
    if (round.status === "absent") return round;
    if (round.status === "live" && isProxyReplacement(previous, round.live)) return round;
    if (!shouldContinue()) return round;
    await wait();
  }
}

export async function waitForProxyReplacement(
  previous: ProxyRestartLive,
  deadlineAt: number,
  observe: (deadlineAt: number) => Promise<ProxyRestartLive | null>,
): Promise<ProxyRestartLive | null> {
  while (Date.now() < deadlineAt) {
    const live = await observe(deadlineAt);
    if (Date.now() >= deadlineAt) return null;
    if (isProxyReplacement(previous, live)) return live;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs > 0) await Bun.sleep(Math.min(250, remainingMs));
  }
  return null;
}

export function reobserveRestartReplacement(
  previous: ProxyRestartLive,
  deadlineAt: number,
  observe: (end: number) => Promise<ProxyRestartDiscovery>,
): Promise<ProxyRestartDiscovery> {
  const windowMs = Math.min(5_000, deadlineAt - Date.now());
  if (windowMs < 1_500) return Promise.resolve({
    status: "uncertain", error: new Error("restart_reobserve_window_exhausted"),
  });
  const end = Date.now() + windowMs;
  return pollReplacementDeparture(() => observe(end), previous, () => Date.now() + 750 < end, () => Bun.sleep(250));
}

/** Production recovery recheck: the original restart deadline may already be spent. */
export function recheckRestartFailedStart(
  observe: (end: number) => Promise<ProxyRestartDiscovery>,
): Promise<ProxyRestartDiscovery> {
  const end = Date.now() + 5_000;
  return observe(end);
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
 * An uncertain discovery round is re-observed. A failed start is retried only after
 * proof that it never launched or its child exited; a health miss is insufficient.
 * A missed replacement gets a bounded re-observation. A live target is never stopped
 * to make room, and absence is confirmed twice before any fresh start.
 */
/**
 * A proven pre-launch refusal or observed child exit can be retried within this bound.
 * A deliberate operator refusal (`"skipped"`) never retries.
 */
const RESTART_START_ATTEMPTS = 3;

/** Discovery rounds per restart transaction; an uncertain round is a transient race. */
const RESTART_DISCOVERY_ATTEMPTS = 3;

/**
 * Start leg with phase evidence. A bare boolean cannot tell a pre-launch refusal from
 * a child that was launched but is not healthy yet, or from post-health steps that
 * threw on an already-live proxy — and blindly respawning on any of those risks a
 * second proxy racing the first for the port. So every failed attempt is followed by a
 * beat and a strong re-observation: a live proxy attests success (no second start),
 * and only confirmed absence plus launch proof earns another attempt.
 */
async function startRestartedProxy(
  io: ProxyRestartIo,
  waitBetweenAttempts: () => Promise<void>,
  recoveringLiveRestart: boolean,
  /** The restarted proxy's identity; recovery success must be a different process. */
  previous?: ProxyRestartLive,
): Promise<ProxyRestartResult> {
  let originalError: unknown;
  for (let attempt = 0; attempt < RESTART_START_ATTEMPTS; attempt++) {
    let outcome: ProxyRestartStartOutcome;
    try {
      outcome = await io.startWhenStopped(recoveringLiveRestart);
    } catch (error) {
      // An unstructured exception can have happened after launch.
      outcome = { status: "failed", launch: "unknown", error };
    }
    if (outcome.status === "skipped") return recoveringLiveRestart
      ? { ok: false, phase: "replacement" } : { ok: true, mode: "skipped" };
    if (outcome.status === "started") {
      if (!previous) return { ok: true, mode: "started" };
      // Recovery after a live restart: the start path counts any healthy proxy it finds as
      // started, and the ORIGINAL process reappearing would satisfy it. Success needs an
      // identity-verified replacement — a different runtime PID on the original port —
      // observed in a fresh window; anything else fails closed as a missed replacement.
      let confirm: ProxyRestartDiscovery;
      try {
        confirm = await (io.recheckAfterFailedStart?.() ?? io.findLive());
      } catch (error) {
        return { ok: false, phase: "replacement", error };
      }
      return confirm.status === "live" && isProxyReplacement(previous, confirm.live)
        ? { ok: true, mode: "started" }
        : { ok: false, phase: "replacement" };
    }
    if (attempt === 0) originalError = outcome.error;
    // Beat first: a child that was just launched may still be binding, and post-health
    // steps may have thrown on an already-live proxy. Re-observe before deciding: live
    // attests success (never a second start), only confirmed absence earns a retry.
    await waitBetweenAttempts();
    let recheck: ProxyRestartDiscovery;
    try {
      recheck = await (io.recheckAfterFailedStart?.() ?? io.findLive());
    } catch {
      return { ok: false, phase: "start", error: originalError };
    }
    // Runtime-attested only: a config-sourced observation is not proof a proxy serves,
    // so it keeps the start failure instead of reporting a success nobody earned.
    // A throw on an attested-live proxy is different from a clean refusal: post-health
    // work failed on a serving process, so the error propagates instead of converting
    // to success — still without spawning again.
    const attested = recheck.status === "live"
      && recheck.live.pid !== null
      && recheck.live.source === "runtime";
    // Recovery after a live restart: the old PID coming back is not a replacement this
    // command started. It is serving, so never start another over it, and never call it
    // success either.
    if (attested && previous && recheck.status === "live" && !isProxyReplacement(previous, recheck.live)) {
      return { ok: false, phase: "replacement" };
    }
    if (attested && outcome.error !== undefined) return { ok: false, phase: "start", error: originalError };
    if (attested) return { ok: true, mode: "started" };
    if (outcome.launch === "unknown" || recheck.status !== "absent") {
      return { ok: false, phase: "start", error: originalError };
    }
  }
  return { ok: false, phase: "start", error: originalError };
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
    return startRestartedProxy(io, waitBetweenAttempts, false);
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
  const reobserveHook = io.reobserveAfterReplacement;
  const reobserve = reobserveHook ? () => reobserveHook(previous) : io.findLive;
  let again: ProxyRestartDiscovery;
  try {
    again = await reobserve();
  } catch (error) {
    return { ok: false, phase: "replacement", error };
  }
  if (again.status === "absent") {
    // Only an ACCEPTED restart earns a recovery start. After an uncertain request the old
    // proxy may merely be mid-restart and reappear; starting one here could race it.
    if (!request.accepted) return { ok: false, phase: "request", error: request.error };
    return startRestartedProxy(io, waitBetweenAttempts, true, previous);
  }
  if (again.status === "live" && isProxyReplacement(previous, again.live)) {
    return { ok: true, mode: "restarted", live: again.live };
  }
  return request.accepted
    ? { ok: false, phase: "replacement" }
    : { ok: false, phase: "request", error: request.error };
}
