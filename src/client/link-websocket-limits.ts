/**
 * Every cap, budget and timeout of the Responses WebSocket over a Remote Link, Child side (design T4
 * sections 3.2, 3.3 and 6), in one place so review can change a number without hunting for it. The
 * values are the recommended answers to the owner decisions the feature depends on (D2, D3); nothing
 * here turns the feature on.
 */
const KiB = 1024;
const MiB = 1024 * KiB;

export interface LinkChildWebsocketLimits {
  /** Steps 5 to 9 of design 3.2 (tunnel gate, preflight, upgrade); below Codex's 15 s connect timeout. */
  setupBudgetMs: number;
  /** How long an upgrade waits for a Child tunnel that is connecting or reconnecting before 503. */
  tunnelHoldMs: number;
  /** The credential-free preflight on the upgrade's own connection. */
  preflightMs: number;
  /** Open plus setting-up link sockets on this Child (D3). */
  openSockets: number;
  /** Of those, sockets still in setup. */
  settingUp: number;
  /** The transport worst case one link socket reserves at admission (design 6.3). */
  socketReservationBytes: number;
  /** The process budget those reservations draw from (D3). */
  memoryBudgetBytes: number;
  /** Largest message the Home may send: one SSE event of at most 4 MiB, plus room for framing. */
  homeMessageBytes: number;
  /** Largest message Codex may send; advertised to Codex in the local 101 (C7). */
  localMessageBytes: number;
  /** Frames one Home message may be split into. */
  maxFragments: number;
  /** Above this many bytes buffered toward Codex, the Child stops reading the Home leg until it drains. */
  downlinkPauseBytes: number;
  /** Bun's send-buffer limit on the local socket; the pause above keeps sends far below it. */
  localBackpressureBytes: number;
  /** A close the Child starts on the Home leg waits this long for the Home's close before it destroys the socket. */
  closeHandshakeMs: number;
}

export const LINK_CHILD_WS_LIMITS: Readonly<LinkChildWebsocketLimits> = Object.freeze({
  setupBudgetMs: 8_000,
  tunnelHoldMs: 3_000,
  preflightMs: 5_000,
  openSockets: 8,
  settingUp: 4,
  socketReservationBytes: 32 * MiB,
  memoryBudgetBytes: 256 * MiB,
  homeMessageBytes: 4 * MiB + 64 * KiB,
  localMessageBytes: 8 * MiB,
  maxFragments: 4_096,
  downlinkPauseBytes: 1 * MiB,
  localBackpressureBytes: 8 * MiB,
  closeHandshakeMs: 5_000,
});

/** The header Codex reads on a 101 to keep larger requests off the socket (codex-rs C7). */
export const CODEX_WS_MAX_MESSAGE_HEADER = "x-codex-websocket-max-message-bytes";

/**
 * Release gate, Child side. While false, every Codex upgrade gets today's 426 with no network I/O,
 * whatever a Home advertises. It stays false until the framer's client conformance run (Autobahn
 * fuzzingserver, design 3.3) and the Child's transport-only RSS acceptance (design 6.3) have passed.
 * Tests of the relay turn it on for themselves only.
 */
let childReady = false;

export function linkWebsocketChildReady(): boolean {
  return childReady;
}

export function setLinkWebsocketChildReadyForTests(ready: boolean): void {
  childReady = ready;
}

/**
 * Test-only stall signal for the Child's HTTP relay (src/client/link-relay.ts), the counterpart of the Home's
 * setLinkRelayWaitObserverForTests: told true when a relayed response has handed its reader a chunk and the
 * reader has not asked for the next one, and false when it asks again or cancels, or the relay ends, after which it
 * never reports true again. It is for the Child's memory acceptance (design 6.3), to see the relay hold a stalled
 * reader. Null in production, where the relay builds its response exactly as without it.
 */
let childRelayWaitObserver: ((waiting: boolean) => void) | null = null;

export function linkChildRelayWaitObserver(): ((waiting: boolean) => void) | null {
  return childRelayWaitObserver;
}

export function setLinkChildRelayWaitObserverForTests(observer: ((waiting: boolean) => void) | null): void {
  childRelayWaitObserver = observer;
}
