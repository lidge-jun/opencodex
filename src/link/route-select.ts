/**
 * Rules for a link with several routes, as pure functions: per-route cooldowns, the one class a
 * multi-route link reports to the tunnel reducer, and reading OpenSSH's own confirmation that the
 * remote listener was granted to this tunnel. Nothing here starts a process, a timer or reads a
 * clock; the supervisor feeds outcomes in.
 */
import { sshLineClassifies } from "./ssh-capture-redact";
import { classifySshStderr, nextDelayMs, type StderrClass } from "./tunnel-state";

/**
 * What one route did last. transient: network, timeout, unknown, probe deadline. readiness: the
 * correlated readiness proof did not pass in time. grant_unobserved: the candidate lived to its
 * deadline without OpenSSH confirming or refusing its remote listener.
 */
export type RouteOutcomeClass = "transient" | "readiness" | "grant_unobserved" | "forward" | "auth" | "hostkey";

const FORWARD_COOLDOWN_MS = 60_000;
const AUTH_COOLDOWN_MS = 5 * 60_000;
const HOSTKEY_COOLDOWN_MS = 10 * 60_000;

/**
 * How long a route rests after its consecutive failure number `failures` (1 for the first).
 * Transient outcomes use today's reconnect backoff; forward and auth keep the Home's flat retry
 * policy per route; a host-key refusal rests ten minutes and is retried only under strict checking.
 */
export function routeCooldownMs(outcome: RouteOutcomeClass, failures: number, random: () => number = Math.random): number {
  switch (outcome) {
    case "forward": return FORWARD_COOLDOWN_MS;
    case "auth": return AUTH_COOLDOWN_MS;
    case "hostkey": return HOSTKEY_COOLDOWN_MS;
    default: return nextDelayMs(Math.max(1, failures), random);
  }
}

/** A failed probe's or tunnel's stderr, as a route outcome. */
export function routeOutcomeOfStderr(stderr: string): RouteOutcomeClass {
  const cls = classifySshStderr(stderr);
  if (cls === "hostkey" || cls === "auth") return cls;
  if (cls === "forward" || cls === "remote_forward") return "forward";
  return "transient";
}

const RECOVERABILITY: readonly RouteOutcomeClass[] = ["hostkey", "auth", "forward"];

/**
 * The single class a multi-route link reports to the reducer: the most recoverable latest outcome
 * over every route, cooling ones included. A route's outcome is the last failure it recorded and
 * stays until that route is tried again or proven, so a route still resting after a host-key
 * refusal (up to 10 minutes) counts as hostkey however old that refusal is. A route never tried
 * counts as transient. Only a link whose every route's latest outcome refused the pinned key is
 * terminal.
 */
export function aggregateRouteClass(outcomes: readonly (RouteOutcomeClass | null)[]): StderrClass {
  if (outcomes.length === 0) return "network";
  let best = -1;
  for (const outcome of outcomes) {
    const rank = outcome === null ? -1 : RECOVERABILITY.indexOf(outcome);
    // Anything not listed (transient, readiness, grant_unobserved, never tried) is retried on the transient cadence.
    if (rank === -1) return "network";
    best = Math.max(best, rank);
  }
  return RECOVERABILITY[best] as StderrClass;
}

/** OpenSSH's own debug1 line (clientloop.c): "remote forward %s for: listen %s%s%d, connect %s:%d". */
const GRANT_LINE = /^debug1: remote forward (success|failure) for: listen 127\.0\.0\.1:(\d{1,5}), connect 127\.0\.0\.1:(\d{1,5})$/;

/** granted or refused when the line is OpenSSH's answer for exactly this forward; otherwise null. */
export function parseForwardGrant(line: string, tunnelPort: number, listenerPort: number): "granted" | "refused" | null {
  const match = GRANT_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (!match || Number(match[2]) !== tunnelPort || Number(match[3]) !== listenerPort) return null;
  return match[1] === "success" ? "granted" : "refused";
}

/**
 * The stderr tap of a multi-route candidate (it runs with LogLevel=DEBUG1). The grant observer sees
 * every line first and can neither throw nor change anything; the keep decision is exactly today's:
 * the operator's capture tap when a capture window is open, otherwise sshLineClassifies, so only
 * lines ssh prints at LogLevel=ERROR reach the exit classifier.
 */
export function composeGrantTap(
  tunnelPort: number,
  listenerPort: number,
  observe: (verdict: "granted" | "refused") => void,
  capture?: (line: string) => boolean,
): (line: string) => boolean {
  return line => {
    try {
      const verdict = parseForwardGrant(line, tunnelPort, listenerPort);
      if (verdict) observe(verdict);
    } catch { /* an observer failure changes nothing */ }
    return capture ? capture(line) : sshLineClassifies(line);
  };
}

