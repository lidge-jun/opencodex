import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { formatErrorResponse } from "../../bridge";
import { resolveResponsesApiAuth, type RequestPolicyView } from "../auth-cors";
import { isDraining } from "../lifecycle";
import { buildResponsesWsData, selectForwardHeaders, type LinkSocketBinding, type WsData } from "../ws-bridge";
import { tryReserveCodexWebSocket } from "../../codex/websocket-registry";
import type { AdmissionReservation } from "../../lib/admission";
import { sessionLaneIdFromRequest } from "../request-log-conversation";
import { classifyUsageClient } from "../../usage/client";
import type { LinkActivity, LinkSocketActivity } from "../../link/child-activity";
import type { ActivityHolds, FingerprintMark, StoredMark } from "../../link/ws-activity-holds";
import type { LinkWsCloseReason, LinkWsCounters, LinkWsRefusal } from "../../link/status-projection";
import type { LinkTurnObserver } from "../link-turn";
import { resultKeysOf } from "../../codex/websocket-activity";
import {
  LINK_WS_AGE_CLOSE, LINK_WS_DISABLED_CLOSE, LINK_WS_IDLE_CLOSE, LINK_WS_LIMITS, LINK_WS_REVOKED_CLOSE, type LinkWebsocketLimits, linkWebsocketLimitOverrides,
} from "./link-websocket-limits";

/**
 * The Responses WebSocket over a Remote Link, Home side (design T4 section 2).
 *
 * A link upgrade is admitted only on a relay session that link-relay-sessions.ts has just consumed
 * and verified on the same TCP connection (S1, S4). Admission is one synchronous function; every
 * frame the socket later receives re-runs the authorization check before the shared handler sees
 * it (S3), so a revoked link, a rotated or removed key, or an edited links.json stops new turns at
 * the next frame and running ones at the next sweep.
 */

/** The verified relay session an upgrade arrived on. release is the session's drain lease. */
export interface LinkSessionGrant {
  keyId: string;
  linkId: string;
  fingerprint: string;
  release: () => void;
}

/** handled: false leaves the request on today's path (the hub-link route table refuses it with 404). */
export type LinkUpgradeOutcome = { handled: false } | { handled: true; response: Response | undefined };

type LeaseState = "reserved" | "upgrading" | "upgraded" | "released" | "closed";

/**
 * The single owner of every lease one link upgrade holds (design 2.3). Leases are released in
 * reverse order, exactly once: by a refusal, abort, throw or failed upgrade before the socket
 * exists, or by the socket's close callback after it does. Nothing else releases them.
 */
export class LinkUpgradeLeases {
  private current: LeaseState = "reserved";
  private readonly releases: Array<() => void>;

  constructor(session: () => void) {
    this.releases = [session];
  }

  get state(): LeaseState { return this.current; }

  /** Adds a lease while admission is still deciding; after that a late lease is returned at once. */
  add(release: () => void): void {
    if (this.current === "reserved") this.releases.push(release);
    else release();
  }

  upgrading(): void { if (this.current === "reserved") this.current = "upgrading"; }

  upgraded(): void { if (this.current === "upgrading") this.current = "upgraded"; }

  /** Refusal, abort, throw or failed upgrade. No effect once the socket owns the leases. */
  release(): void {
    if (this.current !== "reserved" && this.current !== "upgrading") return;
    this.current = "released";
    this.drain();
  }

  /** The socket's close callback. */
  closed(): void {
    if (this.current === "upgraded") {
      this.current = "closed";
      this.drain();
    } else this.release();
  }

  private drain(): void {
    while (this.releases.length) {
      const release = this.releases.pop()!;
      try { release(); } catch { /* one failed release must not keep the others */ }
    }
  }
}

/** Design 2.3 step 1: exactly a Codex Responses upgrade, with nothing a browser or an extension adds. */
export function linkResponsesUpgradeShape(req: Request): boolean {
  if (req.method !== "GET") return false;
  let url: URL;
  try { url = new URL(req.url); } catch { return false; }
  if (url.pathname !== "/v1/responses" || url.search !== "") return false;
  const headers = req.headers;
  if (headers.get("upgrade")?.toLowerCase() !== "websocket") return false;
  if (!(headers.get("connection") ?? "").toLowerCase().split(",").some(token => token.trim() === "upgrade")) return false;
  if (headers.get("sec-websocket-version") !== "13" || !headers.get("sec-websocket-key")) return false;
  return !headers.has("origin") && !headers.has("sec-websocket-protocol") && !headers.has("sec-websocket-extensions");
}

export interface LinkWebsocketTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LinkWebsocketGateDeps {
  /** linkResponsesWebsocketEnabled(config), read on every upgrade and every sweep. */
  enabled(): boolean;
  /** The hub-link request policy (the same view serve-options admits link requests with). */
  policy(): RequestPolicyView;
  /**
   * The authorization check: an uncached, fail-closed links.json read still names (linkId, keyId),
   * and the key still has the fingerprint the session was proved with. Must not throw or await.
   */
  authorized(identity: { keyId: string; linkId: string; fingerprint: string }): boolean;
  draining?: () => boolean;
  reserveSocket?: () => AdmissionReservation<ServerWebSocket<WsData>> | null;
  limits?: Partial<LinkWebsocketLimits>;
  timers?: LinkWebsocketTimers;
  /** Wall clock for idle, age and the drain deadline. */
  now?: () => number;
  /** The per-link activity book: a busy link socket counts in flight there (design T4 section 5). */
  activity?: LinkActivity;
  /** Durable holds: a busy close leaves one, and the crash fence is armed before the first upgrade. */
  holds?: ActivityHolds;
}

/** What the gate keeps per open link socket. */
interface SocketState {
  openedAt: number;
  /** When the socket last became idle; null while busy. */
  idleSince: number | null;
  /** When this socket started draining after the switch went off; null while on. */
  drainingSince: number | null;
  /** A create arrived while a turn ran during the drain: close once the turn ends. */
  closeAfterTurn: boolean;
  book: LinkSocketActivity | null;
  unsubscribe: () => void;
  /** HMAC of the socket's own thread id; undefined until known, null when it has none. */
  threadHash: string | null | undefined;
  /** Closed by revocation: such a close leaves no hold (design 5). */
  revoked: boolean;
  /** Turns that entered the pipeline on this socket; the first one is logged as continuation full, reason first. */
  turnsSeen: number;
  /**
   * One entry per turn that entered the pipeline, keyed by the handler's turn id and written and
   * cleared only by that turn's own observer and cleanup: "pending" until expansion, then its
   * fingerprint, or "unknown" when expansion or hashing failed or Codex sent no turn id, and "done"
   * once its own terminal arrived (no longer cut work). The turn's cleanup removes the entry.
   */
  captures: Map<number, FingerprintMark | "pending" | "unknown" | "done">;
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function inputItems(body: Record<string, unknown>): unknown[] {
  return Array.isArray(body.input) ? body.input : body.input === undefined ? [] : [body.input];
}

/** Codex's own turn id (client_metadata.turn_id); optional on Codex's side. */
function turnIdOf(body: Record<string, unknown>): string | null {
  const metadata = bodyRecord(body.client_metadata);
  return typeof metadata.turn_id === "string" && metadata.turn_id ? metadata.turn_id : null;
}

/** Design 5 capture: the expanded input's length and HMAC, with the turn reference. */
export function fingerprintCapture(holds: ActivityHolds, body: unknown): FingerprintMark | "unknown" {
  const record = bodyRecord(body);
  const turnId = turnIdOf(record);
  if (!turnId) return "unknown";
  try {
    const items = inputItems(record);
    if (items.length === 0) return "unknown";
    return { n: items.length, inputHmac: holds.inputHmac(items), turnRef: holds.turnRef(turnId) };
  } catch { return "unknown"; }
}

/**
 * Rules (a)-(c): the fingerprinted marks of this link that a request re-sends: an inference request
 * (generate is not false) of the same own thread and turn whose expanded input starts with the cut
 * request's input. Rule (d), an upstream-completed terminal, is checked by the caller at the end.
 */
export function marksResent(holds: ActivityHolds, linkId: string, threadHash: string | null, body: unknown): StoredMark[] {
  const record = bodyRecord(body);
  if (!threadHash || record.generate === false || !holds.hasMarks(linkId)) return [];
  const turnId = turnIdOf(record);
  if (!turnId) return [];
  try {
    const items = inputItems(record);
    return holds.markCandidates(linkId, threadHash, holds.turnRef(turnId))
      .filter(mark => items.length >= mark.n && holds.inputHmac(items.slice(0, mark.n)) === mark.inputHmac);
  } catch { return []; }
}

/** Rule (d): only a terminal the upstream itself reported as completed releases a running mark; no provenance is not enough. */
export function upstreamCompleted(status: string | undefined, source: string | undefined): boolean {
  return status === "completed" && source === "upstream";
}

/** Design 9.1: the hashed thread and turn refs of a link request; a ref that cannot be made is left out. */
export function linkLogRefs(holds: ActivityHolds, linkId: string, threadId: string, body: unknown): { threadRef?: string; turnRef?: string } {
  const turnId = turnIdOf(bodyRecord(body));
  const ref = (kind: "thread" | "turn", id: string | null): string | null => {
    if (!id) return null;
    try { return holds.logRef(kind, linkId, id); } catch { return null; }
  };
  const threadRef = ref("thread", threadId || threadIdOf(bodyRecord(body)));
  const turnRef = ref("turn", turnId);
  return { ...(threadRef ? { threadRef } : {}), ...(turnRef ? { turnRef } : {}) };
}

function threadIdOf(body: Record<string, unknown>): string | null {
  const metadata = bodyRecord(body.client_metadata);
  return typeof metadata.thread_id === "string" && metadata.thread_id ? metadata.thread_id : null;
}

const defaultTimers: LinkWebsocketTimers = {
  setInterval(callback, ms) {
    const handle = setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval(handle) { clearInterval(handle as ReturnType<typeof setInterval>); },
};

function capacityRefusal(): Response {
  return formatErrorResponse(426, "upgrade_required", "Remote Link WebSocket capacity reached; use HTTP.", { code: "link_websocket_capacity" });
}

function unauthorized(): Response {
  return formatErrorResponse(401, "authentication_error", "opencodex API key required");
}

export function createLinkWebsocketGate(deps: LinkWebsocketGateDeps) {
  const limits: LinkWebsocketLimits = { ...LINK_WS_LIMITS, ...linkWebsocketLimitOverrides(), ...deps.limits };
  const timers = deps.timers ?? defaultTimers;
  const draining = deps.draining ?? isDraining;
  // A full shared gate lets a link upgrade reclaim an idle link socket, never a local one.
  const reserveSocket = deps.reserveSocket ?? (() => tryReserveCodexWebSocket({ reclaim: "link" }));
  const now = deps.now ?? Date.now;
  const states = new WeakMap<ServerWebSocket<WsData>, SocketState>();
  // Admission counts open plus upgrading sockets; a lease in the bundle gives each slot back.
  const admitted = new Map<string, number>();
  let admittedTotal = 0;
  let reservedBytes = 0;
  // Open sockets, by link, for the revocation hooks and the sweep.
  const sockets = new Map<string, Set<ServerWebSocket<WsData>>>();
  let sweepHandle: unknown;
  // False from last-link close() until the next bind: a session reserved before close() must not
  // become a socket close() never sees, or the listener drain would wait on it forever.
  let accepting = true;
  // Upgraded but not yet opened: Bun runs open() after the fetch returns, so a revoke or close() in
  // between must still reach the socket. The value is the close it owes when it opens.
  const pending = new Map<LinkSocketBinding, { code: number; reason: string } | null>();
  // Design 9.3: display-only counters per link, in memory, reset at restart; reasons are closed sets.
  const counted = new Map<string, { upgrades: number; refused: Partial<Record<LinkWsRefusal, number>>; closes: Partial<Record<LinkWsCloseReason, number>> }>();
  const tally = (linkId: string, create: boolean) => {
    let entry = counted.get(linkId);
    if (!entry && create) { entry = { upgrades: 0, refused: {}, closes: {} }; counted.set(linkId, entry); }
    return entry;
  };
  // Why the gate itself closed a socket; a close the gate did not start is classified by its code.
  const fencedBy = new WeakMap<LinkSocketBinding, LinkWsCloseReason>();
  const FENCE_REASONS = new Map<{ code: number; reason: string }, LinkWsCloseReason>([
    [LINK_WS_REVOKED_CLOSE, "revoked"], [LINK_WS_DISABLED_CLOSE, "disabled"], [LINK_WS_IDLE_CLOSE, "idle"], [LINK_WS_AGE_CLOSE, "age"],
  ]);

  const authorized = (identity: { keyId: string; linkId: string; fingerprint: string }): boolean => {
    try { return deps.authorized(identity); } catch { return false; }
  };

  const fence = (ws: ServerWebSocket<WsData>, close: { code: number; reason: string }): void => {
    const link = ws.data.link;
    if (!link || link.fenced) return;
    link.fenced = true;
    const why = FENCE_REASONS.get(close);
    if (why) fencedBy.set(link, why);
    const state = states.get(ws);
    if (state && close === LINK_WS_REVOKED_CLOSE) state.revoked = true;
    if (ws.data.responsesActivity) ws.data.responsesActivity.closing = true;
    try { ws.data.cancel?.(); } catch { /* the close below still ends the socket */ }
    try { ws.close(close.code, close.reason); } catch { /* already closing */ }
  };

  const allSockets = (): ServerWebSocket<WsData>[] => [...sockets.values()].flatMap(set => [...set]);

  const enabledNow = (): boolean => { try { return deps.enabled(); } catch { return false; } };

  /** Design 2.5: drain starts once, at the first sweep or frame that sees the switch off. */
  const startDrain = (state: SocketState): void => {
    if (state.drainingSince === null) state.drainingSince = now();
  };

  const pastDeadline = (state: SocketState): boolean =>
    state.drainingSince !== null && now() - state.drainingSince >= limits.drainDeadlineMs;

  /**
   * Re-evaluated whenever the socket's activity changes, and by the sweep. A busy socket is never
   * closed here: drain and age wait for the running turn, and idle closes need idle.
   */
  const settle = (ws: ServerWebSocket<WsData>, state: SocketState, fromSweep: boolean): void => {
    const link = ws.data.link;
    const activity = ws.data.responsesActivity;
    if (!link || link.fenced || !activity) return;
    if (state.drainingSince !== null) {
      if (state.closeAfterTurn && !activity.running) { fence(ws, LINK_WS_DISABLED_CLOSE); return; }
      if (activity.idle) { fence(ws, LINK_WS_DISABLED_CLOSE); return; }
      if (pastDeadline(state)) {
        if (activity.running) state.closeAfterTurn = true;
        else fence(ws, LINK_WS_DISABLED_CLOSE);
      }
      return;
    }
    if (!activity.idle) return;
    if (now() - state.openedAt >= limits.maxAgeMs) { fence(ws, LINK_WS_AGE_CLOSE); return; }
    if (fromSweep && state.idleSince !== null && now() - state.idleSince >= limits.idleCloseMs) fence(ws, LINK_WS_IDLE_CLOSE);
  };

  const observe = (ws: ServerWebSocket<WsData>, state: SocketState): void => {
    const activity = ws.data.responsesActivity;
    if (!activity) return;
    const idle = activity.idle;
    if (idle && state.idleSince === null) state.idleSince = now();
    if (!idle) state.idleSince = null;
    state.book?.busy(!idle);
    settle(ws, state, false);
  };

  /**
   * The drain rule for one frame on a draining socket (design 2.5). Only a create is decided here;
   * anything else goes to the shared handler as usual. Parses only while draining.
   */
  const admitWhileDraining = (ws: ServerWebSocket<WsData>, state: SocketState, raw: string | Buffer): boolean => {
    let frame: Record<string, unknown> | null = null;
    try { frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>; } catch { frame = null; }
    if (!frame || frame.type !== "response.create") return true;
    const activity = ws.data.responsesActivity;
    if (!activity) { fence(ws, LINK_WS_DISABLED_CLOSE); return false; }
    // A running turn is never cancelled by the drain: the frame is dropped and the socket closes after it.
    if (activity.running) { state.closeAfterTurn = true; return false; }
    if (!pastDeadline(state) && !activity.untracked && activity.returnsPending(frame.input)) return true;
    fence(ws, LINK_WS_DISABLED_CLOSE);
    return false;
  };

  /**
   * Learns the socket's own thread from its first create when the handshake carried none. Release
   * itself happens only when the shared handler admits a turn (onAccepted, below), so a warmup or a
   * refused create never releases a hold.
   */
  const learnThread = (state: SocketState, raw: string | Buffer): void => {
    const holds = deps.holds!;
    if (state.threadHash !== undefined) return;
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>; } catch { return; }
    if (frame.type !== "response.create") return;
    if (state.threadHash === undefined) {
      const metadata = frame.client_metadata as Record<string, unknown> | undefined;
      const threadId = metadata && typeof metadata.thread_id === "string" && metadata.thread_id ? metadata.thread_id : null;
      try { state.threadHash = threadId ? holds.threadHash(threadId) : null; } catch { state.threadHash = null; }
    }
  };

  /** Design 5: a socket that closes while busy, for any reason except revocation, leaves a hold. */
  const holdOnClose = (ws: ServerWebSocket<WsData>): void => {
    const holds = deps.holds;
    const link = ws.data.link;
    const state = states.get(ws);
    const activity = ws.data.responsesActivity;
    if (!holds || !link || !state || state.revoked || !activity) return;
    const pendingKeys = activity.pendingKeys();
    if (!activity.running && pendingKeys.length === 0 && !activity.untracked) return;
    // Snapshot, in this task, every turn's capture: a fingerprint becomes a mark released on its own;
    // a turn that closed before its capture, or could not be fingerprinted, becomes an unknown mark.
    const marks: FingerprintMark[] = [];
    let unknown = 0;
    for (const capture of state.captures.values()) {
      if (typeof capture === "object") marks.push(capture); else if (capture !== "done") unknown += 1;
    }
    unknown += Math.max(0, activity.runningTurns - state.captures.size);
    holds.add(link.linkId, { threadHash: state.threadHash ?? null, pendingKeys, runningMarks: unknown, marks, untracked: activity.untracked });
  };

  const sweep = (): void => {
    const on = enabledNow();
    for (const ws of allSockets()) {
      const link = ws.data.link;
      if (!link || link.fenced) continue;
      if (!authorized(link)) { fence(ws, LINK_WS_REVOKED_CLOSE); continue; }
      const state = states.get(ws);
      if (!state) continue;
      if (!on) startDrain(state);
      settle(ws, state, true);
    }
  };

  const track = (ws: ServerWebSocket<WsData>, linkId: string): void => {
    let set = sockets.get(linkId);
    if (!set) { set = new Set(); sockets.set(linkId, set); }
    set.add(ws);
    if (sweepHandle === undefined) sweepHandle = timers.setInterval(sweep, limits.sweepIntervalMs);
  };

  const untrack = (ws: ServerWebSocket<WsData>, linkId: string): void => {
    const set = sockets.get(linkId);
    if (set?.delete(ws) && set.size === 0) sockets.delete(linkId);
    if (sockets.size === 0 && sweepHandle !== undefined) {
      timers.clearInterval(sweepHandle);
      sweepHandle = undefined;
    }
  };

  const admitSlot = (linkId: string): (() => void) | null => {
    const perLink = admitted.get(linkId) ?? 0;
    if (perLink >= limits.perLinkSockets || admittedTotal >= limits.totalSockets) return null;
    admitted.set(linkId, perLink + 1);
    admittedTotal += 1;
    return () => {
      const left = (admitted.get(linkId) ?? 1) - 1;
      if (left > 0) admitted.set(linkId, left); else admitted.delete(linkId);
      admittedTotal -= 1;
    };
  };

  const reserveMemory = (): (() => void) | null => {
    if (reservedBytes + limits.socketReservationBytes > limits.memoryBudgetBytes) return null;
    reservedBytes += limits.socketReservationBytes;
    return () => { reservedBytes -= limits.socketReservationBytes; };
  };

  return {
    /**
     * Called by link-relay-sessions.ts right after it consumed and verified a session, for a request
     * that carries an Upgrade header. Synchronous: no await between the checks and server.upgrade.
     */
    upgrade<T>(req: Request, server: Server<T>, grant: LinkSessionGrant): LinkUpgradeOutcome {
      if (!linkResponsesUpgradeShape(req)) return { handled: false };
      let on = false;
      try { on = deps.enabled(); } catch { on = false; }
      // Off: the request keeps today's path and today's refusal, byte for byte.
      if (!on) return { handled: false };
      const leases = new LinkUpgradeLeases(grant.release);
      let binding: LinkSocketBinding | undefined;
      const refuse = (response: Response, reason: LinkWsRefusal): LinkUpgradeOutcome => {
        leases.release();
        const entry = tally(grant.linkId, true)!;
        entry.refused[reason] = (entry.refused[reason] ?? 0) + 1;
        return { handled: true, response };
      };
      try {
        if (req.signal.aborted) return refuse(formatErrorResponse(426, "upgrade_required", "The upgrade request was aborted."), "aborted");
        if (!accepting || draining()) return refuse(formatErrorResponse(503, "server_error", "The Home is shutting down.", { code: "server_draining" }), "draining");
        // S2: the credential on the upgrade is the key the relay proof was made with.
        const admission = resolveResponsesApiAuth(req, deps.policy());
        if (!admission || admission.kind !== "configured" || admission.keyId !== grant.keyId) return refuse(unauthorized(), "unauthorized");
        if (!authorized(grant)) return refuse(unauthorized(), "unauthorized");
        // Design 5: the crash fence is durable before any link socket exists; without it, no upgrade.
        if (deps.holds && !deps.holds.arm()) {
          return refuse(formatErrorResponse(426, "upgrade_required", "Remote Link WebSocket activity cannot be recorded; use HTTP.", { code: "link_websocket_unavailable" }), "unavailable");
        }
        const memory = reserveMemory();
        if (!memory) return refuse(capacityRefusal(), "memory");
        leases.add(memory);
        const slot = admitSlot(grant.linkId);
        if (!slot) return refuse(capacityRefusal(), "cap");
        leases.add(slot);
        const socketLease = reserveSocket();
        if (!socketLease) return refuse(capacityRefusal(), "cap");
        leases.add(() => socketLease.release());
        const data = buildResponsesWsData(
          selectForwardHeaders(req.headers),
          admission,
          socketLease,
          sessionLaneIdFromRequest(req.headers),
          classifyUsageClient(req.headers),
        );
        binding = { linkId: grant.linkId, keyId: grant.keyId, fingerprint: grant.fingerprint, fenced: false, leases };
        data.nativeControlDisabled = true;
        data.link = binding;
        if (req.signal.aborted) return refuse(formatErrorResponse(426, "upgrade_required", "The upgrade request was aborted."), "aborted");
        leases.upgrading();
        pending.set(binding, null);
        if (!(server as unknown as Server<WsData>).upgrade(req, { data })) {
          pending.delete(binding);
          return refuse(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), "failed");
        }
        leases.upgraded();
        tally(grant.linkId, true)!.upgrades += 1;
        return { handled: true, response: undefined };
      } catch {
        if (binding) pending.delete(binding);
        return refuse(formatErrorResponse(426, "upgrade_required", "WebSocket upgrade failed"), "failed");
      }
    },

    /** The link listener's websocket handler: the shared Responses handler behind the link checks. */
    handler(base: WebSocketHandler<WsData>): WebSocketHandler<WsData> {
      return {
        ...base,
        maxPayloadLength: limits.maxMessageBytes,
        backpressureLimit: limits.backpressureLimitBytes,
        closeOnBackpressureLimit: false,
        idleTimeout: 0,
        perMessageDeflate: false,
        open(ws) {
          const link = ws.data.link;
          if (!link) { ws.close(1011, "link socket without a binding"); return; }
          const owed = pending.get(link) ?? null;
          pending.delete(link);
          track(ws, link.linkId);
          base.open?.(ws);
          const state: SocketState = {
            openedAt: now(), idleSince: null, drainingSince: null, closeAfterTurn: false,
            book: deps.activity?.beginSocket(link.linkId) ?? null, unsubscribe: () => {},
            threadHash: undefined, revoked: false, captures: new Map(), turnsSeen: 0,
          };
          if (deps.holds) {
            const holds = deps.holds;
            const linkId = link.linkId;
            // One observer per turn, created when the turn enters the pipeline (websocket-handler.ts).
            ws.data.linkTurnObserver = (turnId: number): LinkTurnObserver => {
              state.captures.set(turnId, "pending");
              const ordinal = ++state.turnsSeen;
              let resent: StoredMark[] = [];
              const own = (value: FingerprintMark | "unknown" | "done"): void => { if (state.captures.has(turnId)) state.captures.set(turnId, value); };
              return {
                expanded(body, chain) {
                  // A delta left for the upstream proves nothing about the full input: unknown, and no match.
                  if (chain === "unexpanded") { own("unknown"); resent = []; return; }
                  own(fingerprintCapture(holds, body));
                  resent = marksResent(holds, linkId, state.threadHash ?? null, body);
                },
                expansionFailed() { own("unknown"); },
                // The link WebSocket exists only while the feature is on: its turns read the upstream as the socket drains (#8601).
                pacedReads: true,
                logFields: body => ({ transport: "websocket", first: ordinal === 1,
                  ...linkLogRefs(holds, linkId, ws.data.headers?.get("thread-id")?.trim() ?? "", body) }),
                terminal(status, source) {
                  // The turn's own entry ends with its own terminal, superseded or not.
                  own("done");
                  if (resent.length && state.threadHash && upstreamCompleted(status, source)) holds.releaseMarks(linkId, state.threadHash, resent);
                },
              };
            };
            // The turn's cleanup (websocket-handler.ts): its entry goes, whether or not a terminal came.
            ws.data.linkTurnEnded = (turnId: number): void => { state.captures.delete(turnId); };
          }
          // Codex sends its own thread id on the handshake; a socket without it may name one in its
          // first create's client_metadata (observeForHolds).
          const threadId = ws.data.headers?.get("thread-id");
          if (deps.holds && threadId) {
            // A reference key that cannot be loaded leaves the hold operator-only rather than failing the socket.
            try { state.threadHash = deps.holds.threadHash(threadId); } catch { state.threadHash = null; }
          }
          states.set(ws, state);
          const activity = ws.data.responsesActivity;
          if (activity) {
            // A refused or failed turn on this socket leaves its results owed (design 5).
            activity.restoreRefusedResults = true;
            const stopChange = activity.onChange(() => observe(ws, state));
            // An admitted turn may return results a closed socket of this link and own thread waited for.
            // Each turn settles only holds that existed when it began (another socket may reuse an id later).
            const beganAt = new WeakMap<object, number>();
            const stopBegin = deps.holds ? activity.onBegin(input => {
              if (input && typeof input === "object") beganAt.set(input, deps.holds!.sequence());
            }) : () => {};
            const stopAccepted = deps.holds ? activity.onAccepted(input => {
              const holds = deps.holds!;
              const began = input && typeof input === "object" ? beganAt.get(input) : undefined;
              if (began !== undefined && holds.releasable(link.linkId)) holds.observe(link.linkId, state.threadHash ?? null, resultKeysOf(input), began);
            }) : () => {};
            state.unsubscribe = () => { stopChange(); stopBegin(); stopAccepted(); };
            observe(ws, state);
          }
          // A revoke or last-link close() that ran between the upgrade and now still applies.
          if (owed) fence(ws, owed);
          else if (!accepting) fence(ws, LINK_WS_REVOKED_CLOSE);
        },
        // Bun calls drain when the send buffer empties; a link pump waits for it (design 6.2).
        drain(ws) {
          ws.data.link?.drained?.();
          base.drain?.(ws);
        },
        message(ws, raw) {
          const link = ws.data.link;
          if (!link || link.fenced) return;
          // S3: every message, of any type, before the shared handler can admit a turn.
          if (!authorized(link)) { fence(ws, LINK_WS_REVOKED_CLOSE); return; }
          const state = states.get(ws);
          if (state) {
            if (!enabledNow()) startDrain(state);
            if (state.drainingSince !== null && !admitWhileDraining(ws, state, raw)) return;
            if (deps.holds) learnThread(state, raw);
          }
          return base.message?.(ws, raw);
        },
        close(ws, code, reason) {
          try {
            // Snapshot before the shared close cancels the turn: a busy socket leaves a hold.
            holdOnClose(ws);
            // A link pump waiting for a drain stops waiting once the socket is gone.
            ws.data.link?.drained?.();
            base.close?.(ws, code, reason);
          } finally {
            const link = ws.data.link;
            const state = states.get(ws);
            if (state) {
              state.unsubscribe();
              state.book?.end();
              states.delete(ws);
            }
            if (link) {
              pending.delete(link);
              untrack(ws, link.linkId);
              // Counted only for a link still known: a removed link's counters are not recreated by its last closes.
              const entry = tally(link.linkId, false);
              const why: LinkWsCloseReason = fencedBy.get(link) ?? (code === 1000 || code === 1001 ? "client" : code === 1006 ? "dropped" : "other");
              if (entry) entry.closes[why] = (entry.closes[why] ?? 0) + 1;
              link.leases.closed();
            }
          }
        },
      };
    },

    /** Design 9.3: one link's live counters (display only). */
    transport(linkId: string): LinkWsCounters {
      const entry = counted.get(linkId);
      return { open: sockets.get(linkId)?.size ?? 0, upgrades: entry?.upgrades ?? 0, refused: { ...entry?.refused }, closes: { ...entry?.closes } };
    },

    /** A removed link's counters go with it. */
    forgetTransport(linkId: string): void {
      counted.delete(linkId);
    },

    /** The Home's own revoke path, in the same task as its commit. Returns how many were closed. */
    closeLink(linkId: string): number {
      const set = [...(sockets.get(linkId) ?? [])];
      for (const ws of set) fence(ws, LINK_WS_REVOKED_CLOSE);
      let owed = 0;
      for (const binding of pending.keys()) {
        if (binding.linkId !== linkId) continue;
        pending.set(binding, LINK_WS_REVOKED_CLOSE);
        owed += 1;
      }
      return set.length + owed;
    },

    /** Last link removed: no new link socket, and every open one closes before the listener drains. */
    closeAll(): number {
      accepting = false;
      const all = allSockets();
      for (const ws of all) fence(ws, LINK_WS_REVOKED_CLOSE);
      for (const binding of pending.keys()) pending.set(binding, LINK_WS_REVOKED_CLOSE);
      return all.length + pending.size;
    },

    /** A listener bound again after close() accepts link upgrades again. */
    accept(): void { accepting = true; },

    sweep,

    /** Process stop: the listener closes the sockets; only the timer is ours to clear. */
    dispose(): void {
      if (sweepHandle !== undefined) timers.clearInterval(sweepHandle);
      sweepHandle = undefined;
    },

    snapshot(): { open: number; admitted: number; reservedBytes: number; sweeping: boolean } {
      return { open: allSockets().length, admitted: admittedTotal, reservedBytes, sweeping: sweepHandle !== undefined };
    },
  };
}

export type LinkWebsocketGate = ReturnType<typeof createLinkWebsocketGate>;

