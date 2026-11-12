/**
 * Every cap, budget and timeout of the Responses WebSocket over a Remote Link, Home side, in one
 * place so review can change a number without hunting for it. The values are the recommended
 * answers to the owner decisions the feature depends on (D3: per-link and overall caps and the
 * transport memory budget); nothing here turns the feature on.
 */
const MiB = 1024 * 1024;

export interface LinkWebsocketLimits {
  /** Largest message a Child may send; Bun closes a larger one with 1009 before the handler. */
  maxMessageBytes: number;
  /** Bun's per-socket send-buffer limit. Sends above it are refused, never dropped silently. */
  backpressureLimitBytes: number;
  /** Open plus upgrading link sockets per link (D3). */
  perLinkSockets: number;
  /** Open plus upgrading link sockets across all links (D3). */
  totalSockets: number;
  /** The transport worst case one link socket reserves at admission (design 6.3). */
  socketReservationBytes: number;
  /** The process budget those reservations draw from (D3). */
  memoryBudgetBytes: number;
  /** While any link socket exists, every socket's authorization is re-checked this often. */
  sweepIntervalMs: number;
  /** An idle link socket is fenced and closed after this long (design 6.5). */
  idleCloseMs: number;
  /** A link socket older than this closes at its next idle moment, forcing re-authentication. */
  maxAgeMs: number;
  /** After the switch goes off, open sockets drain for at most this long (design 2.5). */
  drainDeadlineMs: number;
}

export const LINK_WS_LIMITS: Readonly<LinkWebsocketLimits> = Object.freeze({
  maxMessageBytes: 8 * MiB,
  backpressureLimitBytes: 8 * MiB,
  perLinkSockets: 8,
  totalSockets: 24,
  socketReservationBytes: 32 * MiB,
  memoryBudgetBytes: 768 * MiB,
  sweepIntervalMs: 30_000,
  idleCloseMs: 10 * 60_000,
  maxAgeMs: 60 * 60_000,
  drainDeadlineMs: 60 * 60_000,
});

/** Close code for a socket whose link, key or fingerprint no longer authorizes it. */
export const LINK_WS_REVOKED_CLOSE = { code: 4401, reason: "link revoked" } as const;
/** Close code for a socket closed because the feature was switched off. */
export const LINK_WS_DISABLED_CLOSE = { code: 1000, reason: "link websocket disabled" } as const;
/** Close code for a link socket idle for idleCloseMs. */
export const LINK_WS_IDLE_CLOSE = { code: 1000, reason: "link websocket idle" } as const;
/** Close code for a link socket past maxAgeMs, at its next idle moment. */
export const LINK_WS_AGE_CLOSE = { code: 1000, reason: "link websocket reauthenticate" } as const;

/**
 * Release gate. The reservation above assumes the link-only bounded pump of design 6.2 (per-event
 * backpressure wait, 256 KiB framing slices), which is not in this build yet. Until the slice that
 * lands it sets this to true, linkResponsesWebsocket cannot admit or advertise anything, whatever
 * the config says. Tests of the admission path turn it on for themselves only.
 */
let transportReady = false;

export function linkWebsocketTransportReady(): boolean {
  return transportReady;
}

export function setLinkWebsocketTransportReadyForTests(ready: boolean): void {
  transportReady = ready;
}

