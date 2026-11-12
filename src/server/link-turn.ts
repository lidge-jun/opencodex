/**
 * The seam between the Responses pipeline and Remote Link activity holds (design T4 section 5).
 *
 * A link turn may carry an observer: a link WebSocket passes one in handleResponses options, and a
 * relayed HTTP request carries a short-lived random token header the link relay registered. The
 * pipeline reports the expanded input right after continuation expansion and before any upstream
 * I/O, and the final request log reports the terminal status and whether the terminal came from the
 * upstream. No content leaves this module: observers hash what they need. Nothing here runs for a
 * request that carries no observer.
 */

export interface LinkTurnObserver {
  /** The request body after continuation expansion succeeded. */
  expanded(body: unknown): void;
  /** Expansion failed (continuation miss); a capture cannot be made. */
  expansionFailed(): void;
  /** The turn's final request log: its terminal status, and "synthetic" when the proxy made it. */
  terminal(status: string | undefined, source: string | undefined): void;
}

export const LINK_TURN_HEADER = "x-opencodex-link-turn";

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

/** Right after continuation expansion succeeded, before upstream I/O. */
export function observeLinkTurnExpansion(explicit: LinkTurnObserver | undefined, req: Request, logCtx: object, body: unknown): void {
  const observer = claim(explicit, req);
  if (!observer) return;
  byLog.set(logCtx, observer);
  try { observer.expanded(body); } catch { /* an observer never breaks the turn */ }
}

/** Continuation expansion failed. */
export function failLinkTurnExpansion(explicit: LinkTurnObserver | undefined, req: Request, logCtx: object): void {
  const observer = claim(explicit, req);
  if (!observer) return;
  byLog.set(logCtx, observer);
  try { observer.expansionFailed(); } catch { /* an observer never breaks the turn */ }
}

/** Called by the final request log of every turn; a no-op unless a link turn bound this context. */
export function notifyLinkTurnFinal(logCtx: object, status: string | undefined): void {
  const observer = byLog.get(logCtx);
  if (!observer) return;
  byLog.delete(logCtx);
  const source = (logCtx as { terminalSource?: unknown }).terminalSource;
  try { observer.terminal(status, typeof source === "string" ? source : undefined); } catch { /* never breaks logging */ }
}

