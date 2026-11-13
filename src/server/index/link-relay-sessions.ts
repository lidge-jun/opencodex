import type { Server } from "bun";
import { createHash } from "node:crypto";
import {
  LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_TIMEOUT_MS, LINK_RELAY_AUTH_VERSION, LINK_RELAY_CONNECTION_HEADER,
  LINK_RELAY_CONNECTION_PROOF_HEADER, LINK_RELAY_PROBE_HEADER, LINK_RELAY_SESSION_HEADER, linkConnectionProof,
  linkRelayProof, linkRelayProofMatches, LINK_RELAY_WS_STATE_HEADER, LINK_RELAY_WS_STATE_PROOF_HEADER, linkWebsocketStateProof,
} from "../../link/relay-auth";
import { parseLinkPeerReport, type LinkPeerObservations } from "../../link/peer-report";
import { linkActivityCounts, type LinkActivity } from "../../link/child-activity";
import type { LinkSessionGrant, LinkUpgradeOutcome } from "./link-websocket";
import type { LinkTrafficBook } from "../../link/traffic";
import { LINK_HOME_FEATURES_HEADER } from "../../link/request-compression";
import { linkRelayWaitObserver } from "./link-websocket-limits";

/** A 200 `GET /v1/catalog` whose body the Child read to the end (wp2 catalog freshness). */
export interface LinkCatalogServed { linkId: string | null; keyId: string | null; etag: string }

interface Session {
  peer: string;
  keyId: string;
  linkId: string;
  fingerprint: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  release: () => void;
}

export interface LinkRelaySessionOptions {
  fingerprints: (keyId: string, linkId: string) => readonly string[];
  /** Tests can use a bounded shorter reservation; production uses five seconds. */
  reservationMs?: number;
  /** Where a verified challenge records the Child's report, and a known link's version mismatch. */
  peers?: LinkPeerObservations;
  /** The current tunnel connection of a Home-initiated link, announced with each proof. */
  connectionGeneration?: (linkId: string) => string | undefined;
  /** Per-link model-traffic book owned by the listener lifecycle (D5); survives rebinds. */
  activity?: LinkActivity;
  /**
   * Called after a 200 `GET /v1/catalog` body was read to the end and the stream closed. linkId comes from the relay
   * session; a legacy key admission gives null and the response's `x-opencodex-key-id`. The etag is the sha256 of the
   * bytes served, the same value as `catalogEtag(body)`. Cancel, abort, a read error and HEAD report nothing.
   */
  catalogServed?: (served: LinkCatalogServed) => void;
  /**
   * The Responses WebSocket over the link (link-websocket.ts). Called only for a request with an
   * Upgrade header on a session this book has just consumed and verified; it owns the session's
   * lease when it handles the request. Absent, or answering handled: false, the request keeps
   * today's path.
   */
  upgrade?: (req: Request, server: Server<unknown>, grant: LinkSessionGrant) => LinkUpgradeOutcome;
  /** Whether verified answers advertise the link WebSocket; the header pair is sent only while on. */
  websocketAdvertised?: () => boolean;
  /**
   * A relayed POST /v1/responses on a verified session, before dispatch: it may return results a
   * closed link WebSocket of the same link and own thread was waiting for (link-websocket.ts holds).
   * Must not consume the request body. The returned decision is called once with true only when the
   * handler answered below 400, so a request refused before or after reading its body releases nothing.
   */
  observeResponsesRequest?: (linkId: string, req: Request) => ((accepted: boolean) => void) | void;
  /**
   * Per-link body bytes of verified relay-session requests (#3023), owned by the listener lifecycle.
   * The response side is counted as it streams; the request side is its declared Content-Length,
   * because wrapping the native request would lose the identity Bun's requestIP/timeout need.
   */
  traffic?: LinkTrafficBook;
  /**
   * This Home's served peer features, named on every relay-auth answer (#3023) so a Child learns on
   * the very connection that will carry its body whether it may send it zstd. Absent = not named.
   */
  homeFeatures?: () => readonly string[];
}

/** One book per bound listener. A pending proof reserves the bind before the data request arrives. */
export function createLinkRelaySessions(options: LinkRelaySessionOptions) {
  const sessions = new Map<string, Session>();
  const drains = new Set<() => void>();
  let closing = false;
  let active = 0;
  const reservationMs = options.reservationMs ?? LINK_RELAY_AUTH_TIMEOUT_MS;
  const refuse = () => new Response(null, { status: 404 });
  const peerOf = (req: Request, server: Server<unknown>): string | null => {
    const peer = server.requestIP(req);
    return peer ? `${peer.address}:${peer.port}` : null;
  };
  const acquire = () => {
    active += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--active === 0) { for (const resolve of drains) resolve(); drains.clear(); }
    };
  };
  const consume = (nonce: string): Session | undefined => {
    const session = sessions.get(nonce);
    if (session) { clearTimeout(session.timer); sessions.delete(nonce); }
    return session;
  };

  return {
    /** Forced process shutdown retires unused proofs before closing their sockets. */
    abortReservations(): void {
      closing = true;
      for (const nonce of [...sessions.keys()]) consume(nonce)?.release();
    },
    /** Refuse new work, but keep reservations and active bodies alive until they settle. */
    async drain(): Promise<void> {
      closing = true;
      if (active > 0) await new Promise<void>(resolve => drains.add(resolve));
    },
    async dispatch<T>(req: Request, server: Server<T>, dispatch: (req: Request, server: Server<T>) => Promise<Response>): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === LINK_RELAY_AUTH_PATH) {
        if (closing || req.method !== "GET" || sessions.size >= 256 || req.headers.has("upgrade")
          || req.headers.has("authorization") || req.headers.has("x-opencodex-api-key")) return refuse();
        const q = url.searchParams;
        if ([...q.keys()].length !== 5 || ["version", "key", "link", "nonce", "proof"].some(name => q.getAll(name).length !== 1)) return refuse();
        const keyId = q.get("key")!, linkId = q.get("link")!, nonce = q.get("nonce")!;
        if (q.get("version") !== LINK_RELAY_AUTH_VERSION) {
          // Unverifiable, but only for a link and key this Home issued: status names the mismatch.
          const version = q.get("version")!;
          if (/^[1-9]\d{0,3}$/.test(version) && options.fingerprints(keyId, linkId).length > 0) options.peers?.refuse(linkId, version);
          return refuse();
        }
        const peer = peerOf(req, server as Server<unknown>);
        if (!peer || sessions.has(nonce)) return refuse();
        const fingerprint = options.fingerprints(keyId, linkId).find(candidate =>
          linkRelayProofMatches(q.get("proof"), linkRelayProof(candidate, "caller", keyId, linkId, nonce)));
        if (!fingerprint) return refuse();
        options.peers?.observe(linkId, LINK_RELAY_AUTH_VERSION, parseLinkPeerReport(req.headers));
        let generation: string | undefined;
        try { generation = options.connectionGeneration?.(linkId); } catch { generation = undefined; }
        const connectionProof = generation === undefined ? null : linkConnectionProof(fingerprint, keyId, linkId, nonce, generation);
        let advertised = false;
        try { advertised = options.websocketAdvertised?.() === true; } catch { advertised = false; }
        const websocketProof = advertised ? linkWebsocketStateProof(fingerprint, keyId, linkId, nonce, "on") : null;
        const features = options.homeFeatures?.() ?? [];
        const answer = () => new Response(null, { status: 204, headers: {
          "x-opencodex-link-proof": linkRelayProof(fingerprint, "listener", keyId, linkId, nonce)!,
          "cache-control": "no-store",
          ...(features.length > 0 ? { [LINK_HOME_FEATURES_HEADER]: features.join(",") } : {}),
          ...(connectionProof ? { [LINK_RELAY_CONNECTION_HEADER]: generation!, [LINK_RELAY_CONNECTION_PROOF_HEADER]: connectionProof } : {}),
          ...(websocketProof ? { [LINK_RELAY_WS_STATE_HEADER]: "on", [LINK_RELAY_WS_STATE_PROOF_HEADER]: websocketProof } : {}),
        } });
        // A readiness probe closes after this answer and sends no data request, so it reserves
        // nothing: no session to consume, no capacity and no drain lease held until expiry.
        if (req.headers.get(LINK_RELAY_PROBE_HEADER) === "1") return answer();
        const release = acquire();
        const timer = setTimeout(() => { consume(nonce)?.release(); }, reservationMs);
        sessions.set(nonce, { peer, keyId, linkId, fingerprint, release, timer, expiresAt: Date.now() + reservationMs });
        return answer();
      }
      const nonce = req.headers.get(LINK_RELAY_SESSION_HEADER);
      let release: () => void;
      let sessionLink: string | null = null;
      if (nonce !== null) {
        // A proof received on one HTTP socket never authorizes another socket, even on the same port.
        const session = consume(nonce);
        if (!session) return refuse();
        release = session.release;
        sessionLink = session.linkId;
        if (session.peer !== peerOf(req, server as Server<unknown>) || Date.now() >= session.expiresAt
          || !options.fingerprints(session.keyId, session.linkId).includes(session.fingerprint)) {
          release(); return refuse();
        }
        // Keep the native Request identity: Bun's requestIP/timeout APIs need the original request.
        // The link turn header is ours alone (src/server/link-turn.ts): never accepted from a peer.
        try { req.headers.delete(LINK_RELAY_SESSION_HEADER); req.headers.delete("x-opencodex-link-turn"); } catch { release(); return refuse(); }
        if (options.upgrade && req.headers.has("upgrade")) {
          const outcome = options.upgrade(req, server as Server<unknown>, { keyId: session.keyId, linkId: session.linkId, fingerprint: session.fingerprint, release });
          if (outcome.handled) return outcome.response as Response;
        }
      } else {
        if (closing) return new Response(null, { status: 503 });
        // Older peers may still use the ordinary key admission. Its response also owns a drain lease.
        release = acquire();
      }
      // Activity wraps the release every path below calls (body end, cancel, abort, HEAD, dispatch throw); both halves
      // are idempotent. A relay-session request counts from session validation, so a refused proof never counts. A
      // legacy key admission counts only once its response status is known and below 400: until then the key has not
      // been accepted, so an unauthenticated or refused request never touches inFlight or lastDataEndAt.
      const countsActivity = options.activity !== undefined && linkActivityCounts(url, req);
      const beginActivity = (): void => {
        const lease = release;
        const end = options.activity!.begin(sessionLink);
        release = () => { end(); lease(); };
      };
      if (countsActivity && sessionLink !== null) beginActivity();
      let decideObservation: ((accepted: boolean) => void) | undefined;
      if (sessionLink !== null && req.method === "POST" && url.pathname === "/v1/responses") {
        try { decideObservation = options.observeResponsesRequest?.(sessionLink, req) ?? undefined; } catch { /* observation never blocks the request */ }
      }
      let flow: ReturnType<LinkTrafficBook["begin"]> | undefined;
      try {
        flow = sessionLink !== null ? options.traffic?.begin(sessionLink) : undefined;
        if (flow) {
          const declared = req.headers.get("content-length");
          if (declared !== null && /^\d+$/.test(declared.trim())) flow.toHome(Number(declared.trim()));
          else if (req.body !== null) flow.uncounted();
        }
      } catch (error) {
        // Accounting that fails before dispatch still decides a pending body observation and returns the lease.
        decideObservation?.(false);
        try { flow?.end(false); } catch { /* the original failure is the one reported */ } finally { release(); }
        throw error;
      }
      // Socket cancellation before headers is terminal too; an upstream handler that is
      // settling its own cleanup cannot keep a dead transport's listener lease forever.
      // An abort before headers also decides a pending body observation (not accepted) and drops its unclaimed turn token.
      const beforeHeadersAbort = () => { decideObservation?.(false); flow?.end(false); release(); };
      req.signal.addEventListener("abort", beforeHeadersAbort, { once: true });
      if (req.signal.aborted) beforeHeadersAbort();
      try {
        const response = await dispatch(req, server);
        decideObservation?.(response.status < 400 && !req.signal.aborted);
        req.signal.removeEventListener("abort", beforeHeadersAbort);
        if (countsActivity && sessionLink === null && response.status < 400 && !req.signal.aborted) beginActivity();
        if (!response.body || req.method === "HEAD") { flow?.end(true); release(); return response; }
        const reader = response.body.getReader();
        const catalogHash = options.catalogServed && req.method === "GET" && url.pathname === "/v1/catalog" && url.search === ""
          && response.status === 200 ? createHash("sha256") : null;
        const catalogKeyId = sessionLink === null ? response.headers.get("x-opencodex-key-id") : null;
        const reportCatalog = (): void => {
          if (!catalogHash) return;
          try {
            options.catalogServed!({ linkId: sessionLink, keyId: catalogKeyId, etag: `"${catalogHash.digest("hex")}"` });
          } catch (error) {
            console.warn(`[link] catalog pull record failed: ${error instanceof Error ? error.name : "unknown"}`);
          }
        };
        let ended = false;
        // A cancel resolves a pending read as done; that end is not a completed body.
        let cancelled = false;
        // Test-only stall signal (link-websocket-limits.ts): set from each chunk handed over until the reader asks again.
        const waitObserver = sessionLink !== null ? linkRelayWaitObserver() : null;
        let waiting = false;
        const stopWaiting = (): void => { if (waiting) { waiting = false; waitObserver?.(false); } };
        const finish = () => {
          if (ended) return;
          ended = true;
          stopWaiting();
          req.signal.removeEventListener("abort", aborted);
          release();
        };
        const cancel = async (reason?: unknown) => {
          cancelled = true;
          flow?.end(false);
          try { await reader.cancel(reason); } finally { finish(); }
        };
        const aborted = () => { void cancel(req.signal.reason).catch(() => {}); };
        req.signal.addEventListener("abort", aborted, { once: true });
        if (req.signal.aborted) aborted();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            stopWaiting();
            try {
              const next = await reader.read();
              if (next.done) { flow?.end(!cancelled); finish(); controller.close(); if (!cancelled) reportCatalog(); }
              else {
                catalogHash?.update(next.value); flow?.fromHome(next.value.byteLength); controller.enqueue(next.value);
                if (waitObserver && !ended) { waiting = true; waitObserver(true); }
              }
            } catch (error) { flow?.end(false); finish(); controller.error(error); }
          },
          cancel,
        }, { highWaterMark: 0 });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        decideObservation?.(false); req.signal.removeEventListener("abort", beforeHeadersAbort);
        try { flow?.end(false); } catch { /* the original failure is the one reported */ } finally { release(); }
        throw error;
      }
    },
  };
}
