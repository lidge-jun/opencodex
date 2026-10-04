/**
 * Identity-carrying coordinator for the CLI-newer update restart.
 *
 * An in-place restart respawns the live process from its own installation, so a
 * restart accepted from a newer CLI would keep serving the old build. Instead of
 * refusing (or stopping whatever happens to be live), this coordinator carries
 * the attested restart identity (PID/port) through every step and revalidates it
 * under the ownership lease through the existing guarded-stop mechanism
 * (runApprovedStop): a changed, unknown, or non-runtime owner refuses before any
 * stop is attempted, the start runs only after the intended target shows
 * stopped, and the replacement is accepted only when it serves this exact CLI
 * version on the expected port. Every boundary is injected for tests; no real
 * service is touched by the regression suite.
 */
import type { LiveProxy } from "../server/proxy-liveness";
import { runResolve, type ResolveJson } from "./resolve";
import type { StopApproval } from "./stop-approval";
import type { StopOutcome } from "./stop-report";
import type { ProxyRestartStartOutcome } from "./tray-proxy";

/** Attested restart identity observed before the CLI-newer refusal. */
export interface RestartUpdateTarget {
  pid: number;
  port: number;
}

export type RestartUpdateRefusal =
  | "target-changed"
  | "stop-refused"
  | "stop-failed"
  | "target-not-confirmed-stopped"
  | "start-failed"
  | "replacement-unverified";

export type RestartUpdateResult =
  | { ok: true; live: LiveProxy }
  | { ok: false; reason: RestartUpdateRefusal; detail?: string };

export interface RestartUpdateIo {
  findLive: () => Promise<LiveProxy | null>;
  resolve: () => Promise<ResolveJson | null>;
  stopGuarded: (approval: StopApproval) => Promise<StopOutcome>;
  startWhenStopped: (recoveringLiveRestart: boolean) => Promise<ProxyRestartStartOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cliVersion: string;
}

/** Bounded re-observation shared by the stopped and replacement waits. */
async function pollLive(
  findLive: () => Promise<LiveProxy | null>,
  deadlineAt: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
  accept: (live: LiveProxy | null) => boolean,
): Promise<LiveProxy | null> {
  for (;;) {
    const live = await findLive();
    if (accept(live)) return live;
    const remaining = deadlineAt - now();
    if (remaining <= 0) return null;
    await sleep(Math.min(250, remaining));
  }
}

/** Production resolve reader: one JSON document, null on any other outcome. */
export async function readResolveJson(): Promise<ResolveJson | null> {
  const lines: string[] = [];
  const code = await runResolve({ json: true }, {
    stdout: { log: (line: string) => { lines.push(line); } },
    stderr: { error: () => {} },
  });
  if (code !== 0 || lines.length !== 1) return null;
  try {
    return JSON.parse(lines[0] as string) as ResolveJson;
  } catch {
    return null;
  }
}

const STOPPED_CONFIRM_BUDGET_MS = 10_000;

export async function runRestartUpdate(
  target: RestartUpdateTarget,
  deadlineAt: number,
  io: RestartUpdateIo,
): Promise<RestartUpdateResult> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? Bun.sleep;
  const fail = (reason: RestartUpdateRefusal, detail?: string): RestartUpdateResult =>
    ({ ok: false, reason, ...(detail === undefined ? {} : { detail }) });
  const resolved = await io.resolve();
  if (resolved === null) return fail("target-changed", "the runtime could not be re-resolved");
  const liveness = resolved.liveness;
  if (liveness.status !== "live" || liveness.pid === null || liveness.port === null) {
    return fail("target-changed", "the approved runtime is no longer live");
  }
  if (liveness.pid !== target.pid || liveness.port !== target.port) {
    return fail("target-changed", "the live PID/port no longer match the attested restart target");
  }
  if (liveness.source !== "runtime") {
    return fail("target-changed", "the live runtime is no longer attested");
  }
  if (liveness.role === "client") {
    return fail("target-changed", "the runtime now routes as a client");
  }
  const approval: StopApproval = {
    pid: target.pid,
    port: target.port,
    hostname: liveness.hostname ?? "",
    configHome: resolved.configHome,
    cliVersion: io.cliVersion,
    compatibilityToken: resolved.takeover.kind === "supported" ? resolved.takeover.token : "",
  };
  const stopped = await io.stopGuarded(approval);
  if (!stopped.ok) {
    const refused = stopped.summary.outcome === "approval-changed";
    return fail(refused ? "stop-refused" : "stop-failed", stopped.summary.message);
  }
  const stoppedDeadline = Math.min(deadlineAt, now() + STOPPED_CONFIRM_BUDGET_MS);
  const gone = await pollLive(io.findLive, stoppedDeadline, now, sleep,
    live => live === null || live.port !== target.port);
  if (gone === null && now() >= stoppedDeadline) {
    return fail("target-not-confirmed-stopped", "the expected port still answers after the stop");
  }
  const started = await io.startWhenStopped(true);
  if (started.status !== "started") {
    return fail("start-failed", "the replacement proxy did not start");
  }
  const replacement = await pollLive(io.findLive, deadlineAt, now, sleep,
    live => live !== null && live.source === "runtime" && live.port === target.port
      && live.pid !== null && live.version === io.cliVersion);
  if (replacement === null) {
    return fail("replacement-unverified", "no healthy replacement serving this CLI version appeared in time");
  }
  return { ok: true, live: replacement };
}
