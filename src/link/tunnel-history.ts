/**
 * What the Home remembers about one `-R` tunnel besides its current state: how many ssh attempts
 * the current outage has cost, the last state change and the last failure with its cause. It lives
 * in memory next to the supervisor's state, appears in `GET /api/link/status` as `tunnel`, and
 * each change it records also goes to the bounded diagnostics file (`diagnostics.ts`), so a link
 * that failed for an hour leaves evidence of why after the fact.
 *
 * Nothing here carries ssh output, argv, host names or keys: a cause is one of a fixed set of
 * words, and times are numbers.
 */
import type { LinkDiagnosticSink } from "./diagnostics";
import type { StderrClass, TunnelState } from "./tunnel-state";

export type TunnelCause =
  | "auth" | "hostkey" | "forward" | "remote_forward_conflict" | "timeout" | "network" | "unknown"
  | "spawn_failed" | "listener_unavailable";

export const TUNNEL_CAUSES: readonly TunnelCause[] = [
  "auth", "hostkey", "forward", "remote_forward_conflict", "timeout", "network", "unknown",
  "spawn_failed", "listener_unavailable",
];

export interface TunnelTransitionRecord {
  from: TunnelState["kind"];
  to: TunnelState["kind"];
  at: number;
  cause: TunnelCause | null;
}

export interface TunnelHistory {
  /** ssh attempts started since the link was last connected (0 while connected). */
  attempt: number;
  lastTransition: TunnelTransitionRecord | null;
  lastFailure: { cause: TunnelCause; at: number } | null;
}

export function exitCause(stderrClass: StderrClass): TunnelCause {
  return stderrClass === "remote_forward" ? "remote_forward_conflict" : stderrClass;
}

/**
 * A retry of a failed link ended without connecting: one that ran while the state read failed, or
 * one that could not even start (the retry count still grew).
 */
function retryFailedAgain(before: TunnelState, after: TunnelState): boolean {
  if (before.kind !== "failed" || after.kind !== "failed" || after.inFlight === true) return false;
  return before.inFlight === true || (after.retries ?? 0) > (before.retries ?? 0);
}

export interface TunnelHistoryBook {
  /** Count one ssh attempt for the link. */
  spawned(linkId: string): void;
  /** Record a state change; `cause` names why the link left a working state, when known. */
  observe(linkId: string, before: TunnelState, after: TunnelState, cause: TunnelCause | null, at: number): void;
  get(linkId: string): TunnelHistory | undefined;
  forget(linkId: string): void;
}

export function createTunnelHistoryBook(
  options: { diagnostic?: LinkDiagnosticSink; tunnelPort?: (linkId: string) => number | undefined } = {},
): TunnelHistoryBook {
  const histories = new Map<string, TunnelHistory>();
  const entry = (linkId: string): TunnelHistory => {
    let history = histories.get(linkId);
    if (!history) {
      history = { attempt: 0, lastTransition: null, lastFailure: null };
      histories.set(linkId, history);
    }
    return history;
  };
  return {
    spawned(linkId) {
      entry(linkId).attempt += 1;
    },
    observe(linkId, before, after, cause, at) {
      const refailed = retryFailedAgain(before, after);
      if (before.kind === after.kind && !refailed) return;
      const history = entry(linkId);
      if (after.kind === "connected" || after.kind === "idle") history.attempt = 0;
      if (cause && (after.kind === "failed" || after.kind === "reconnecting")) history.lastFailure = { cause, at };
      history.lastTransition = { from: before.kind, to: after.kind, at, cause };
      const retryAt = after.kind === "failed" || after.kind === "reconnecting" ? after.retryAt : undefined;
      const tunnelPort = options.tunnelPort?.(linkId);
      try {
        options.diagnostic?.({
          event: "tunnel_transition",
          outcome: cause ?? (after.kind === "connected" ? "connected" : after.kind === "idle" ? "stopped" : "spawned"),
          state: after.kind,
          previousState: before.kind,
          attempt: history.attempt,
          ...(tunnelPort !== undefined ? { tunnelPort } : {}),
          ...(retryAt !== undefined ? { retryAfterMs: Math.max(0, retryAt - at) } : {}),
        });
      } catch { /* Diagnostics never change the tunnel lifecycle. */ }
    },
    get(linkId) {
      const history = histories.get(linkId);
      if (!history) return undefined;
      return {
        attempt: history.attempt,
        lastTransition: history.lastTransition && { ...history.lastTransition },
        lastFailure: history.lastFailure && { ...history.lastFailure },
      };
    },
    forget(linkId) {
      histories.delete(linkId);
    },
  };
}
