import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Socket } from "node:net";
import type { LinkDiagnosticRecord, LinkDiagnosticSink } from "../link/diagnostics";
import { childLinkTraffic, type LinkTrafficBook, type LinkTrafficFlow } from "../link/traffic";
import { upgradeRequiredResponse } from "./link-ingress";
import { forwardLinkUpgradeHeaders, type LinkAdmissionResult, type LinkTunnelGate } from "./link-relay";
import { CODEX_WS_MAX_MESSAGE_HEADER, LINK_CHILD_WS_LIMITS, linkWebsocketChildReady, type LinkChildWebsocketLimits } from "./link-websocket-limits";
import { linkWebsocketAdvertised } from "./link-ws-advertisement";
import { encodeClientClose, encodeClientPong, encodeClientText, isWireCloseCode, LinkWsFrameReader, LinkWsProtocolError, type LinkWsFrameEvent } from "./link-ws-framer";
import { openLinkWebsocket, type LinkWebsocketSetupFailure } from "./link-ws-transport";

/**
 * The Responses WebSocket over a Remote Link, Child side (design T4 3.2 and 3.3).
 *
 * Codex's upgrade on the Child's listener is tried only when this build's release gate is open and the
 * Home advertised the feature on the last relay answer this Child applied; otherwise the ingress keeps
 * today's 426 and nothing touches the network. A tried upgrade passes, in order: no Origin; the link key;
 * the local caps and memory reservation; the tunnel gate (a connecting or reconnecting tunnel is held up
 * to 3 s, then 503, the only transient answer); one preflight and the upgrade on one authenticated
 * connection (link-ws-transport.ts); all inside an 8 s budget. Every other failure is today's 426, which
 * makes Codex use HTTP for that session.
 *
 * After the upgrade the Child relays whole text messages both ways without parsing or writing any of its
 * own: a binary message from Codex closes both legs with 1003; close codes are relayed (toward Codex 1005,
 * 1006 and 1015 become 1011; toward the Home, Codex's drop ends the connection without a close frame and a
 * close without a status becomes an empty close frame); pings stay per hop. A second message from Codex while
 * the previous one is still unflushed toward the Home closes both legs (1013 to Codex, 1001 to the Home), and
 * the Home leg is paused while more than 1 MiB waits toward Codex. No timer closes a socket Codex has open;
 * the only timers are the 5 s close bound and the same bound for a socket Bun upgraded but never opened. A
 * runtime stop closes every socket with 1001 on both legs. When the tunnel supervisor starts stopping (a Child
 * restart, or a link that ended and is about to be recycled), the relay drains first:
 * open sockets close with 1001 and every upgrade from then on, new or still in setup, gets the transient 503,
 * so Codex keeps its WebSocket session for the replacement instead of falling back to HTTP.
 */

export type LinkWsFallbackReason =
  | "local_optout" | "origin" | "credential" | "cap" | "memory" | "tunnel_failed" | "tunnel_connecting_timeout"
  | "preflight" | "not_advertised" | "home_refused" | "handshake" | "timeout" | "aborted" | "draining";

export type LinkWsCloseReason = "client" | "home" | "home_dropped" | "binary" | "protocol" | "overload" | "stopped";

export interface LinkWebsocketTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What the relay needs from the listener's link ingress. */
export interface LinkWebsocketTarget {
  tunnelPort: number;
  linkId?: string;
  apiKeyId?: string;
  linkKey: () => string | null;
}

export interface LinkWebsocketRelayDeps {
  tunnel?: LinkTunnelGate;
  diagnostic?: LinkDiagnosticSink;
  traffic?: LinkTrafficBook;
  limits?: Partial<LinkChildWebsocketLimits>;
  timers?: LinkWebsocketTimers;
  /** Test seam for the Home leg's setup. */
  open?: typeof openLinkWebsocket;
  /** The Child's release gate; linkWebsocketChildReady by default. */
  ready?: () => boolean;
  /** advertisedSeen; linkWebsocketAdvertised by default. */
  advertised?: (linkId: string | undefined) => boolean;
  /** The Child-local opt-out (D4): true keeps this Child on HTTP whatever its Home advertises. */
  optOut?: () => boolean;
  /** Test seam: told when a socket stops (true) or resumes (false) reading the Home leg. */
  onDownlinkPause?: (paused: boolean) => void;
  /** Test seam: told when a socket's slot and reservation are released (its Home connection closed). */
  onReleased?: () => void;
}

export interface LinkWebsocketData { leg: HomeLeg }

/**
 * Design 9.3, Child side: display-only, in memory, reset at restart; reasons are closed sets. A non-local
 * `Origin` is refused (403) by the ingress before the relay and is not counted here.
 */
export interface LinkWebsocketCounters {
  open: number;
  settingUp: number;
  upgrades: number;
  fallbacks: Partial<Record<LinkWsFallbackReason, number>>;
  closes: Partial<Record<LinkWsCloseReason, number>>;
  /**
   * Text message payload bytes Codex sent on link sockets (L2), counted on arrival while the Home leg is
   * open, forwarded or not; a binary message, and anything after the Home leg began closing, is not counted.
   */
  fromCodexBytes: number;
  /** Message payload bytes sent to Codex on link sockets. */
  toCodexBytes: number;
}

const defaultTimers: LinkWebsocketTimers = {
  setTimeout(callback, ms) {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

/** The one transient answer (design 3.2, D2): never a code Codex treats as terminal. */
function tunnelReconnecting(): Response {
  return Response.json({ error: { type: "server_error", code: "link_websocket_unavailable", message: "The link to the Home is reconnecting; retry." } },
    { status: 503, headers: { "cache-control": "no-store" } });
}

/** A close code relayed to the other leg: 1005, 1006, 1015 and anything that may not appear on the wire become 1011. */
function relayCloseCode(code: number | null): number {
  return code !== null && isWireCloseCode(code) ? code : 1011;
}

const FAILURE_REASON: Record<LinkWebsocketSetupFailure, LinkWsFallbackReason> = {
  disabled: "not_advertised", credential: "credential", preflight: "preflight", not_advertised: "not_advertised", home_refused: "home_refused",
  handshake: "handshake", timeout: "timeout", aborted: "aborted",
};

/**
 * One Codex socket and its Home leg. The leg is created paused; it starts reading once Bun has opened the
 * local socket, and the bytes the Home sent with its 101 are read first. A close decided before Bun opened
 * the local socket is kept and applied when it opens. The leg's reservation is released only once the Home
 * connection has actually closed (`onReleased`), so a closing socket still counts against the caps.
 *
 * A socket counts (one request in the traffic book, a close reason) only once Codex's socket is open: from
 * `attach` (Bun 1.4 runs `open` inside `server.upgrade`) or `upgraded`, whichever comes first; a local
 * upgrade that failed ends through `abandon` and counts nothing. If Bun upgraded the socket but never opens
 * it, the leg stops after the close bound, so it cannot hold its slot.
 */
export class HomeLeg {
  private readonly reader: LinkWsFrameReader;
  private local: Pick<ServerWebSocket<LinkWebsocketData>, "send" | "close" | "getBufferedAmount"> | null = null;
  private flow: LinkTrafficFlow | null = null;
  private opened = false;
  private attachTimer: unknown;
  private paused = false;
  private homeClosed = false;
  private localClosed = false;
  private pendingLocalClose: { code: number; reason: string } | null = null;
  private closeTimer: unknown;
  private ended = false;
  private released = false;

  constructor(
    private readonly socket: Socket,
    private readonly head: Buffer,
    private readonly limits: LinkChildWebsocketLimits,
    private readonly timers: LinkWebsocketTimers,
    private readonly beginFlow: () => LinkTrafficFlow,
    private readonly onEnd: (reason: LinkWsCloseReason) => void,
    private readonly onReleased: () => void,
    private readonly onPause?: (paused: boolean) => void,
    private readonly onBytes?: (direction: "fromCodex" | "toCodex", bytes: number) => void,
  ) {
    this.reader = new LinkWsFrameReader({ maxMessageBytes: limits.homeMessageBytes, maxFragments: limits.maxFragments });
    socket.pause();
    socket.on("data", chunk => this.fromHome(chunk as Buffer));
    socket.on("error", () => { /* the close below ends the leg */ });
    socket.on("close", () => this.homeGone());
    // A connection that ended before this leg existed has already emitted its close.
    if (socket.destroyed) queueMicrotask(() => this.homeGone());
    this.attachTimer = timers.setTimeout(() => { this.attachTimer = undefined; if (!this.local) this.stop(); }, limits.closeHandshakeMs);
  }

  attach(local: Pick<ServerWebSocket<LinkWebsocketData>, "send" | "close" | "getBufferedAmount">): void {
    this.clearAttachTimer();
    this.markOpened();
    this.local = local;
    if (this.pendingLocalClose) {
      const { code, reason } = this.pendingLocalClose;
      this.pendingLocalClose = null;
      try { local.close(code, reason); } catch { /* already closed */ }
      return;
    }
    if (this.head.length) this.fromHome(this.head);
    if (!this.ended && !this.paused) this.socket.resume();
  }

  /** Bun accepted the local upgrade: the socket is Codex's from here on. */
  upgraded(): void {
    this.markOpened();
  }

  /**
   * The local upgrade failed (Bun refused or threw): close the Home leg and count nothing. If Bun had already
   * opened Codex's socket before failing, the socket is Codex's: both legs close as on a stop, counted once.
   */
  abandon(): void {
    if (this.ended) return;
    if (this.opened) {
      this.stop();
      return;
    }
    this.closeHome(1001, "");
    this.finish("stopped");
  }

  private markOpened(): void {
    if (this.opened || this.ended) return;
    this.opened = true;
    this.flow = this.beginFlow();
  }

  private clearAttachTimer(): void {
    if (this.attachTimer === undefined) return;
    this.timers.clearTimeout(this.attachTimer);
    this.attachTimer = undefined;
  }

  private fromHome(chunk: Buffer): void {
    if (this.ended || this.homeClosed) return;
    // Events completed before a framing error in the same chunk are delivered first, in wire order.
    const events: LinkWsFrameEvent[] = [];
    let refused: unknown = null;
    try {
      this.reader.push(chunk, events);
    } catch (error) {
      refused = error;
    }
    for (const event of events) {
      if (this.ended) return;
      if (event.type === "text") {
        this.flow?.fromHome(event.bytes);
        const sent = this.local?.send(event.data) ?? 0;
        if (sent === 0) { this.closeBoth(1013, "link websocket overloaded", 1001, "overload"); return; }
        this.onBytes?.("toCodex", event.bytes);
        if (!this.paused && (this.local?.getBufferedAmount() ?? 0) > this.limits.downlinkPauseBytes) {
          this.paused = true;
          this.socket.pause();
          this.onPause?.(true);
        }
      } else if (event.type === "binary") {
        this.closeBoth(1003, "binary messages are not relayed", 1003, "binary");
        return;
      } else if (event.type === "ping") {
        this.socket.write(encodeClientPong(event.payload));
      } else if (event.type === "close") {
        // The Home closed: echo its close to finish the handshake, then relay it to Codex. The Home ends the
        // connection; if it does not within the bound, the Child does.
        this.homeClosed = true;
        try { this.socket.end(encodeClientClose(event.code ?? undefined, event.reason)); } catch { /* already gone */ }
        this.armCloseTimer();
        this.closeLocal(relayCloseCode(event.code), event.reason);
        this.finish("home");
        return;
      }
    }
    if (refused !== null && !this.ended) {
      // A Home message over the limit, or a frame no server may send: both legs close (1011 to Codex).
      const code = refused instanceof LinkWsProtocolError ? refused.closeCode : 1002;
      this.closeBoth(1011, "home message refused", code, "protocol");
    }
  }

  /** Bun reports the local send buffer drained. */
  drained(): void {
    if (!this.paused || this.ended) return;
    if ((this.local?.getBufferedAmount() ?? 0) > this.limits.downlinkPauseBytes) return;
    this.paused = false;
    this.socket.resume();
    this.onPause?.(false);
  }

  /** A message from Codex. */
  fromCodex(message: string | Buffer): void {
    if (this.ended || this.homeClosed) return;
    if (typeof message !== "string") { this.closeBoth(1003, "binary messages are not relayed", 1003, "binary"); return; }
    const bytes = Buffer.byteLength(message);
    this.onBytes?.("fromCodex", bytes);
    // One unflushed message at most: Bun cannot pause delivery, so a second one while the first is still
    // queued toward the Home is an overload, never a buffer that grows.
    if (this.socket.writableLength > 0) { this.closeBoth(1013, "link websocket overloaded", 1001, "overload"); return; }
    this.socket.write(encodeClientText(message), error => { if (!error) this.flow?.toHome(bytes); });
  }

  /**
   * Codex's socket closed (or Bun closed it); the Home leg follows as it happened: Codex's drop (1006 with no
   * reason) ends the Home connection without a close frame, a close without a status (1005) becomes an empty
   * close frame, anything else is relayed (1015, codes that may not appear on the wire, and a 1006 Bun reports
   * with its own reason, such as an oversized message it refused with 1009, as 1011).
   */
  localGone(code: number, reason = ""): void {
    this.localClosed = true;
    if (this.ended) return;
    if (code === 1006 && reason === "") {
      this.homeClosed = true;
      this.socket.destroy();
    } else {
      this.closeHome(code === 1005 ? null : relayCloseCode(code), "");
    }
    // A 1006 (Codex's drop, or Bun's own close of an oversized message) is no close frame from Codex: the
    // request is incomplete, as the Home counts the same socket.
    this.finish("client", code !== 1006);
  }

  /** A runtime stop: both legs close with 1001. */
  stop(): void {
    if (this.ended) return;
    this.closeBoth(1001, "link websocket stopping", 1001, "stopped");
  }

  private homeGone(): void {
    if (this.closeTimer !== undefined) { this.timers.clearTimeout(this.closeTimer); this.closeTimer = undefined; }
    if (!this.ended) {
      // The Home's connection ended without a close frame (a tunnel drop, a killed Home): 1011 to Codex.
      this.homeClosed = true;
      this.closeLocal(1011, "home connection ended");
      this.finish("home_dropped");
    }
    if (this.released) return;
    this.released = true;
    this.onReleased();
  }

  private closeBoth(localCode: number, localReason: string, homeCode: number, why: LinkWsCloseReason): void {
    this.closeHome(homeCode, "");
    this.closeLocal(localCode, localReason);
    this.finish(why);
  }

  private closeLocal(code: number, reason: string): void {
    if (this.localClosed) return;
    this.localClosed = true;
    if (!this.local) { this.pendingLocalClose = { code, reason }; return; }
    try { this.local.close(code, reason); } catch { /* already closed */ }
  }

  private armCloseTimer(): void {
    if (this.closeTimer !== undefined) return;
    this.closeTimer = this.timers.setTimeout(() => { this.closeTimer = undefined; this.socket.destroy(); }, this.limits.closeHandshakeMs);
  }

  /**
   * Start the close handshake on the Home leg (`null`: a close frame without a status); the Home's own
   * close or the 5 s bound ends the connection.
   */
  private closeHome(code: number | null, reason: string): void {
    if (this.homeClosed) return;
    this.homeClosed = true;
    try { this.socket.write(code === null ? encodeClientClose() : encodeClientClose(code, reason)); } catch { /* already gone */ }
    this.socket.resume();
    this.armCloseTimer();
    // The Home's close reply ends the handshake; anything else it still sends is dropped.
    this.socket.removeAllListeners("data");
    this.socket.on("data", chunk => {
      try {
        for (const event of this.reader.push(chunk as Buffer)) {
          if (event.type === "close") { this.socket.destroy(); return; }
        }
      } catch { this.socket.destroy(); }
    });
    // A reader stopped by a protocol error parses nothing more: flush the close and let the Home end the connection.
    if (this.reader.closed) this.socket.end();
  }

  /** `complete`: a close frame ended the socket; by default true for home, client and stopped. */
  private finish(reason: LinkWsCloseReason, complete = reason === "home" || reason === "client" || reason === "stopped"): void {
    if (this.ended) return;
    this.ended = true;
    this.clearAttachTimer();
    if (this.paused) this.onPause?.(false);
    // A socket Codex never had (a failed local upgrade) counts nothing: no request, no close.
    if (!this.opened) return;
    // Complete when a close ended it, from either side; a drop, an overload or a refused message is incomplete.
    this.flow?.end(complete);
    this.onEnd(reason);
  }
}

export function createLinkWebsocketRelay(deps: LinkWebsocketRelayDeps = {}) {
  const limits: LinkChildWebsocketLimits = { ...LINK_CHILD_WS_LIMITS, ...deps.limits };
  const timers = deps.timers ?? defaultTimers;
  const ready = deps.ready ?? linkWebsocketChildReady;
  const advertised = deps.advertised ?? linkWebsocketAdvertised;
  const open = deps.open ?? openLinkWebsocket;
  const traffic = deps.traffic ?? childLinkTraffic;
  const optOut = deps.optOut ?? (() => false);
  let openSockets = 0;
  let settingUp = 0;
  let reservedBytes = 0;
  const legs = new Set<HomeLeg>();
  // Upgrades still in setup: a stop aborts them, and nothing set up after a stop is kept.
  const setups = new Set<AbortController>();
  let stopping = false;
  // The tunnel supervisor is stopping (a Child restart): every upgrade from now on gets the transient 503.
  let draining = false;
  const counted = { upgrades: 0, fallbacks: {} as LinkWebsocketCounters["fallbacks"], closes: {} as LinkWebsocketCounters["closes"], fromCodexBytes: 0, toCodexBytes: 0 };
  const countBytes = (direction: "fromCodex" | "toCodex", bytes: number): void => {
    if (direction === "fromCodex") counted.fromCodexBytes += bytes; else counted.toCodexBytes += bytes;
  };

  const diagnostic = (event: LinkDiagnosticRecord["event"], outcome: LinkDiagnosticRecord["outcome"]): void => {
    try { deps.diagnostic?.({ event, outcome }); } catch { /* diagnostics never alter the relay */ }
  };
  const fallback = (reason: LinkWsFallbackReason): Response => {
    counted.fallbacks[reason] = (counted.fallbacks[reason] ?? 0) + 1;
    diagnostic("link_ws_fallback", reason);
    return upgradeRequiredResponse();
  };
  const drained = (): Response => {
    counted.fallbacks.draining = (counted.fallbacks.draining ?? 0) + 1;
    diagnostic("link_ws_fallback", "draining");
    return tunnelReconnecting();
  };
  const closeAll = (): number => {
    stopping = true;
    for (const setup of [...setups]) setup.abort(new DOMException("link websocket stopping", "AbortError"));
    const all = [...legs];
    for (const leg of all) leg.stop();
    return all.length;
  };
  // Drain before the tunnel goes: a socket closed here reconnects to whatever serves next, and an upgrade
  // meanwhile is told to retry rather than to use HTTP for the rest of its session.
  try {
    deps.tunnel?.onStopping?.(() => {
      if (draining) return;
      draining = true;
      closeAll();
    });
  } catch { /* a gate without the hook never drains */ }

  return {
    /**
     * Design 3.2 step 2: whether an upgrade may try the Home at all. False keeps today's 426 with no network
     * I/O. With the release gate closed nothing is counted or written; with it open, the Child-local opt-out
     * and an unadvertised Home are counted in memory (never in the diagnostics file). While the relay drains,
     * an upgrade goes on to its 503 whatever the Home last advertised (the opt-out still keeps it on HTTP).
     */
    wanted(linkId: string | undefined): boolean {
      try {
        if (!ready()) return false;
        const why: LinkWsFallbackReason | null = optOut() ? "local_optout" : draining || advertised(linkId) ? null : "not_advertised";
        if (why) counted.fallbacks[why] = (counted.fallbacks[why] ?? 0) + 1;
        return why === null;
      } catch { return false; }
    },

    /** Steps 1 and 3 to 11. Resolves undefined once the local socket is upgraded. */
    async upgrade(req: Request, server: Server<unknown>, target: LinkWebsocketTarget): Promise<Response | undefined> {
      if (draining) return drained();
      if (req.headers.has("origin")) return fallback("origin");
      const admissionKey = target.linkKey();
      if (!admissionKey || !target.linkId || !target.apiKeyId) return fallback("credential");
      if (openSockets + settingUp >= limits.openSockets || settingUp >= limits.settingUp) return fallback("cap");
      if (reservedBytes + limits.socketReservationBytes > limits.memoryBudgetBytes) return fallback("memory");
      const headers = forwardLinkUpgradeHeaders(req.headers, admissionKey);
      if (!headers) return fallback("handshake");
      settingUp += 1;
      reservedBytes += limits.socketReservationBytes;
      let reservation: "setup" | "open" | "released" = "setup";
      const release = (): void => {
        if (reservation === "released") return;
        if (reservation === "setup") settingUp -= 1; else openSockets -= 1;
        reservedBytes -= limits.socketReservationBytes;
        reservation = "released";
      };
      const budget = new AbortController();
      setups.add(budget);
      const onLocalAbort = () => budget.abort(req.signal.reason);
      req.signal.addEventListener("abort", onLocalAbort, { once: true });
      if (req.signal.aborted) onLocalAbort();
      let expired = false;
      const budgetTimer = timers.setTimeout(() => { expired = true; budget.abort(new DOMException("link websocket setup budget", "TimeoutError")); }, limits.setupBudgetMs);
      const stopBudget = (): void => { setups.delete(budget); timers.clearTimeout(budgetTimer); req.signal.removeEventListener("abort", onLocalAbort); };
      const failed = (reason: LinkWsFallbackReason): Response => {
        stopBudget();
        release();
        if (draining) return drained();
        return fallback(expired && (reason === "aborted" || reason === "preflight") ? "timeout" : reason);
      };
      // Every ownership check is raced against the budget: a stalled lookup cannot hold the request or its reservation.
      const proof = async (gate: LinkTunnelGate): Promise<LinkAdmissionResult | null> => {
        if (budget.signal.aborted) return null;
        let onAbort!: () => void;
        const aborted = new Promise<null>(resolve => { onAbort = () => resolve(null); budget.signal.addEventListener("abort", onAbort, { once: true }); });
        try { return await Promise.race([Promise.resolve(gate.connected()), aborted]); }
        finally { budget.signal.removeEventListener("abort", onAbort); }
      };
      try {
        // Step 5: the tunnel gate. A Home-initiated link's gate always matches and goes straight on.
        const tunnel = deps.tunnel;
        if (!tunnel) return failed("tunnel_failed");
        let admission = await proof(tunnel);
        // A deadline proves neither a foreign owner nor a broken tunnel: one fresh proof, as the HTTP relay gives it.
        if (admission?.kind === "deadline") admission = await proof(tunnel);
        if (!admission) return failed("aborted");
        if (admission.kind !== "match") {
          if (!tunnel.pending()) return failed(budget.signal.aborted ? "aborted" : "tunnel_failed");
          await tunnel.waitForConnected(limits.tunnelHoldMs, budget.signal);
          if (budget.signal.aborted) return failed("aborted");
          admission = await proof(tunnel);
          if (!admission) return failed("aborted");
          if (admission.kind !== "match") {
            if (!tunnel.pending()) return failed("tunnel_failed");
            stopBudget();
            release();
            counted.fallbacks.tunnel_connecting_timeout = (counted.fallbacks.tunnel_connecting_timeout ?? 0) + 1;
            diagnostic("link_ws_fallback", "tunnel_connecting_timeout");
            return tunnelReconnecting();
          }
        }
        if (budget.signal.aborted) return failed("aborted");
        // Steps 6 to 9 on one authenticated connection.
        const setup = await open({ tunnelPort: target.tunnelPort, admissionKey, linkId: target.linkId, apiKeyId: target.apiKeyId }, headers,
          { signal: budget.signal, preflightMs: limits.preflightMs, upgradeMs: limits.setupBudgetMs, timers, ready });
        if (!setup.ok) return failed(FAILURE_REASON[setup.reason]);
        stopBudget();
        if (req.signal.aborted || expired || stopping) {
          setup.socket.destroy();
          release();
          return draining ? drained() : fallback(expired ? "timeout" : "aborted");
        }
        const linkId = target.linkId;
        // The reservation is held until the Home connection has actually closed.
        const leg = new HomeLeg(setup.socket, setup.head, limits, timers, () => traffic.begin(linkId),
          reason => { counted.closes[reason] = (counted.closes[reason] ?? 0) + 1; diagnostic("link_ws_close", reason); },
          () => {
            legs.delete(leg);
            release();
            try { deps.onReleased?.(); } catch { /* a test seam never alters the relay */ }
          },
          deps.onDownlinkPause, countBytes);
        legs.add(leg);
        settingUp -= 1;
        openSockets += 1;
        reservation = "open";
        // Step 11: Codex's own 101 names the message limit, so Codex sends a larger request over HTTP.
        let upgraded = false;
        try {
          upgraded = server.upgrade(req, { data: { leg } satisfies LinkWebsocketData, headers: { [CODEX_WS_MAX_MESSAGE_HEADER]: String(limits.localMessageBytes) } });
        } catch {
          upgraded = false;
        }
        if (!upgraded) {
          // Codex never had this socket: the Home leg closes, nothing is counted but the fallback, and the
          // reservation is released once the Home connection has closed.
          leg.abandon();
          return fallback("handshake");
        }
        leg.upgraded();
        counted.upgrades += 1;
        diagnostic("link_ws_open", "connected");
        return undefined;
      } catch {
        return failed("handshake");
      }
    },

    /** The listener's websocket handler for link sockets. */
    handler(): WebSocketHandler<LinkWebsocketData> {
      return {
        maxPayloadLength: limits.localMessageBytes,
        backpressureLimit: limits.localBackpressureBytes,
        closeOnBackpressureLimit: false,
        idleTimeout: 0,
        perMessageDeflate: false,
        open(ws) { ws.data.leg.attach(ws); },
        message(ws, message) { ws.data.leg.fromCodex(message); },
        drain(ws) { ws.data.leg.drained(); },
        close(ws, code, reason) { ws.data.leg.localGone(code, reason); },
      };
    },

    /** A runtime stop: every link socket closes with 1001 on both legs, and every upgrade still in setup is aborted. */
    closeAll,

    snapshot(): { open: number; settingUp: number; reservedBytes: number } {
      return { open: openSockets, settingUp, reservedBytes };
    },

    /** Design 9.3: this Child's counters (display only). */
    counters(): LinkWebsocketCounters {
      return { open: openSockets, settingUp, upgrades: counted.upgrades, fallbacks: { ...counted.fallbacks }, closes: { ...counted.closes },
        fromCodexBytes: counted.fromCodexBytes, toCodexBytes: counted.toCodexBytes };
    },
  };
}

export type LinkWebsocketRelay = ReturnType<typeof createLinkWebsocketRelay>;
