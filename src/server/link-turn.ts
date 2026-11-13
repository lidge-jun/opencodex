/**
 * The seam between the Responses pipeline and Remote Link activity holds (design T4 section 5).
 *
 * A link turn may carry an observer: a link WebSocket passes one in handleResponses options, and a
 * relayed HTTP request carries a short-lived random token header the link relay registered. The
 * pipeline reports the expanded input right after continuation expansion and before any upstream
 * I/O, and the final request log reports the terminal status and whether the terminal came from the
 * upstream. No content leaves this module: observers hash what they need. Nothing here runs for a
 * request that carries no observer.
 *
 * While the link WebSocket feature is on, an observer also describes the request for the request log
 * (design T4 section 9.1): its transport and hashed thread and turn refs. This module records the
 * continuation outcome on the log context as `link`, so the final row carries it.
 */
import type { LinkContinuationReason, LinkRequestLogCarrier, LinkTransport } from "../usage/link-log-fields";

/** What a link observer contributes to the request log; null when it describes nothing. */
export interface LinkTurnLogFields { transport: LinkTransport; first: boolean; threadRef?: string; turnRef?: string }

export interface LinkTurnObserver {
  /**
   * The request body after continuation expansion. chain "unexpanded" means previous_response_id was
   * left for the upstream: the body is only a delta, so it is never a fingerprint and never matches one.
   */
  expanded(body: unknown, chain?: LinkTurnChain): void;
  /** Expansion failed (continuation miss); a capture cannot be made. */
  expansionFailed(): void;
  /** The turn's final request log: its terminal status, and "synthetic" when the proxy made it. */
  terminal(status: string | undefined, source: string | undefined): void;
  /** Request-log fields; present only while the link WebSocket feature is on. */
  logFields?(body: unknown): LinkTurnLogFields | null;
  /**
   * Set only while the link WebSocket feature is on (#8601): the turn's upstream body is read only as its client drains,
   * so a stalled link reader holds about one upstream chunk instead of the pipeline's inspection read-ahead.
   */
  pacedReads?: boolean;
}

/** The continuation outcome preparation saw: expanded locally, left for the upstream, or none sent. */
export type LinkTurnChain = "chained" | "unexpanded" | "none";

export const LINK_TURN_HEADER = "x-opencodex-link-turn";

/** A paced link turn's upstream chunks are relayed in slices of at most this size, so each relay stage holds one slice. */
export const LINK_PACED_SLICE_BYTES = 256 * 1024;

const byToken = new Map<string, LinkTurnObserver>();
const byLog = new WeakMap<object, LinkTurnObserver>();

/** Registers an observer for one relayed request; the caller sets the returned token as LINK_TURN_HEADER. */
export function registerLinkTurnToken(observer: LinkTurnObserver): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  byToken.set(token, observer);
  return token;
}

/** Drops a token the pipeline never claimed (a request refused before preparation). */
export function releaseLinkTurnToken(token: string): void {
  byToken.delete(token);
}

/** Registered tokens no pipeline has claimed or the relay released yet (bounded by requests in flight). */
export function pendingLinkTurnTokens(): number {
  return byToken.size;
}

function claim(explicit: LinkTurnObserver | undefined, req: Request): LinkTurnObserver | undefined {
  const token = req.headers.get(LINK_TURN_HEADER);
  if (token !== null) {
    // Never forwarded: the header exists only between the link relay and this point.
    try { req.headers.delete(LINK_TURN_HEADER); } catch { /* immutable headers carry nothing further */ }
  }
  if (explicit) return explicit;
  if (!token) return undefined;
  const observer = byToken.get(token);
  byToken.delete(token);
  return observer;
}

function describe(observer: LinkTurnObserver, logCtx: object, body: unknown, outcome: { continuation: "chained" | "full" | "miss"; reason?: LinkContinuationReason } | ((first: boolean) => { continuation: "full"; reason: LinkContinuationReason })): void {
  let fields: LinkTurnLogFields | null = null;
  try { fields = observer.logFields?.(body) ?? null; } catch { fields = null; }
  if (!fields) return;
  const resolved = typeof outcome === "function" ? outcome(fields.first) : outcome;
  (logCtx as LinkRequestLogCarrier).link = {
    transport: fields.transport, continuation: resolved.continuation,
    ...(resolved.reason ? { continuationReason: resolved.reason } : {}),
    ...(fields.threadRef ? { threadRef: fields.threadRef } : {}),
    ...(fields.turnRef ? { turnRef: fields.turnRef } : {}),
  };
}

/**
 * Right after continuation expansion succeeded, before upstream I/O. An unexpanded continuation goes
 * to an upstream that owns the history (chained) unless preparation refuses it (markLinkTurnMissing).
 */
export function observeLinkTurnExpansion(explicit: LinkTurnObserver | undefined, req: Request, logCtx: object, body: unknown, chain: LinkTurnChain = "none"): void {
  const observer = claim(explicit, req);
  if (!observer) return;
  byLog.set(logCtx, observer);
  describe(observer, logCtx, body, chain === "none"
    ? (first: boolean) => ({ continuation: "full" as const, reason: first ? "first" as const : "client" as const })
    : { continuation: "chained" });
  try { observer.expanded(body, chain); } catch { /* an observer never breaks the turn */ }
}

/** Continuation expansion failed: a miss with the replay failure's reason. */
export function failLinkTurnExpansion(explicit: LinkTurnObserver | undefined, req: Request, logCtx: object, body?: unknown, reason?: LinkContinuationReason): void {
  const observer = claim(explicit, req);
  if (!observer) return;
  byLog.set(logCtx, observer);
  describe(observer, logCtx, body, { continuation: "miss", ...(reason ? { reason } : {}) });
  try { observer.expansionFailed(); } catch { /* an observer never breaks the turn */ }
}

/** Preparation refused an unexpanded continuation (the history is nowhere): a miss, reason missing. */
export function markLinkTurnMissing(logCtx: object): void {
  const link = (logCtx as LinkRequestLogCarrier).link;
  if (link) (logCtx as LinkRequestLogCarrier).link = { ...link, continuation: "miss", continuationReason: "missing" };
}

/** Whether a link turn bound to this context reads its upstream only as its client drains; false for every other request. */
export function linkTurnPacesReads(logCtx: object): boolean {
  return byLog.get(logCtx)?.pacedReads === true;
}

/** Called by the final request log of every turn; a no-op unless a link turn bound this context. */
export function notifyLinkTurnFinal(logCtx: object, status: string | undefined): void {
  const observer = byLog.get(logCtx);
  if (!observer) return;
  byLog.delete(logCtx);
  const source = (logCtx as { terminalSource?: unknown }).terminalSource;
  try { observer.terminal(status, typeof source === "string" ? source : undefined); } catch { /* never breaks logging */ }
}

