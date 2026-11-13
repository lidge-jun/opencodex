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
  /** After a send leaves more than this buffered, the link pump waits for Bun's drain (design 6.2). */
  sendThresholdBytes: number;
  /** The link pump feeds the SSE framer at most this much of an upstream chunk at a time. */
  framerSliceBytes: number;
  /** A link socket that does not drain for this long is closed; the turn's own stall bound. */
  sendStallMs: number;
  /** Durable activity holds per link, and across links, before a link becomes unknown (design 5). */
  holdsPerLink: number;
  holdsTotal: number;
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
  sendThresholdBytes: 1 * MiB,
  framerSliceBytes: 256 * 1024,
  sendStallMs: 300_000,
  holdsPerLink: 64,
  holdsTotal: 1024,
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
 * Release gate. linkResponsesWebsocket cannot admit or advertise anything while this is false,
 * whatever the config says. It stays false until the measured memory acceptance of design 6.3,
 * durable activity holds (section 5) and the release tests with the pinned Codex client are in
 * place. Tests of the admission path turn it on for themselves only.
 */
let transportReady = false;

export function linkWebsocketTransportReady(): boolean {
  return transportReady;
}

export function setLinkWebsocketTransportReadyForTests(ready: boolean): void {
  transportReady = ready;
}

/** Test-only overrides of LINK_WS_LIMITS for gates a test cannot construct itself (a Home started by startServer). */
let limitOverrides: Partial<LinkWebsocketLimits> | null = null;

export function linkWebsocketLimitOverrides(): Partial<LinkWebsocketLimits> | null { return limitOverrides; }

export function setLinkWebsocketLimitsForTests(overrides: Partial<LinkWebsocketLimits> | null): void {
  limitOverrides = overrides;
}

/** The link pump's stall timer (sendStallMs); tests replace it to fire the bound without waiting. */
export interface LinkPumpTimer {
  start(callback: () => void, ms: number): unknown;
  stop(handle: unknown): void;
}

const realPumpTimer: LinkPumpTimer = {
  start(callback, ms) {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  stop(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
let pumpTimer: LinkPumpTimer = realPumpTimer;

export function linkPumpTimer(): LinkPumpTimer { return pumpTimer; }

export function setLinkPumpTimerForTests(timer: LinkPumpTimer | null): void {
  pumpTimer = timer ?? realPumpTimer;
}

/** Test-only: told when a link pump starts (true) and stops (false) waiting for a drain. */
let pumpWaitObserver: ((waiting: boolean) => void) | null = null;

export function linkPumpWaitObserver(): ((waiting: boolean) => void) | null { return pumpWaitObserver; }

export function setLinkPumpWaitObserverForTests(observer: ((waiting: boolean) => void) | null): void {
  pumpWaitObserver = observer;
}

/**
 * Test-only: told when a relayed HTTP link response has handed its reader a chunk and waits for the next read (true),
 * and when that wait ends (false). Bun stops reading a body whose socket does not drain, so a stalled Child reader
 * leaves its relay waiting: the HTTP counterpart of the pump wait above (#8600).
 */
let relayWaitObserver: ((waiting: boolean) => void) | null = null;

export function linkRelayWaitObserver(): ((waiting: boolean) => void) | null { return relayWaitObserver; }

export function setLinkRelayWaitObserverForTests(observer: ((waiting: boolean) => void) | null): void {
  relayWaitObserver = observer;
}

