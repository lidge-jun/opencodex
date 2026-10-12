import type { Server } from "bun";
import {
  LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_TIMEOUT_MS, LINK_RELAY_AUTH_VERSION,
  LINK_RELAY_SESSION_HEADER, linkRelayProof, linkRelayProofMatches,
} from "../../link/relay-auth";

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
        if (q.get("version") !== LINK_RELAY_AUTH_VERSION || [...q.keys()].length !== 5
          || ["version", "key", "link", "nonce", "proof"].some(name => q.getAll(name).length !== 1)) return refuse();
        const keyId = q.get("key")!, linkId = q.get("link")!, nonce = q.get("nonce")!;
        const peer = peerOf(req, server as Server<unknown>);
        if (!peer || sessions.has(nonce)) return refuse();
        const fingerprint = options.fingerprints(keyId, linkId).find(candidate =>
          linkRelayProofMatches(q.get("proof"), linkRelayProof(candidate, "caller", keyId, linkId, nonce)));
        if (!fingerprint) return refuse();
        const release = acquire();
        const timer = setTimeout(() => { consume(nonce)?.release(); }, reservationMs);
        sessions.set(nonce, { peer, keyId, linkId, fingerprint, release, timer, expiresAt: Date.now() + reservationMs });
        return new Response(null, { status: 204, headers: {
          "x-opencodex-link-proof": linkRelayProof(fingerprint, "listener", keyId, linkId, nonce)!,
          "cache-control": "no-store",
        } });
      }
      const nonce = req.headers.get(LINK_RELAY_SESSION_HEADER);
      let release: () => void;
      if (nonce !== null) {
        // A proof received on one HTTP socket never authorizes another socket, even on the same port.
        const session = consume(nonce);
        if (!session) return refuse();
        release = session.release;
        if (session.peer !== peerOf(req, server as Server<unknown>) || Date.now() >= session.expiresAt
          || !options.fingerprints(session.keyId, session.linkId).includes(session.fingerprint)) {
          release(); return refuse();
        }
        // Keep the native Request identity: Bun's requestIP/timeout APIs need the original request.
        try { req.headers.delete(LINK_RELAY_SESSION_HEADER); } catch { release(); return refuse(); }
      } else {
        if (closing) return new Response(null, { status: 503 });
        // Older peers may still use the ordinary key admission. Its response also owns a drain lease.
        release = acquire();
      }
      // Socket cancellation before headers is terminal too; an upstream handler that is
      // settling its own cleanup cannot keep a dead transport's listener lease forever.
      const beforeHeadersAbort = () => release();
      req.signal.addEventListener("abort", beforeHeadersAbort, { once: true });
      if (req.signal.aborted) beforeHeadersAbort();
      try {
        const response = await dispatch(req, server);
        req.signal.removeEventListener("abort", beforeHeadersAbort);
        if (!response.body || req.method === "HEAD") { release(); return response; }
        const reader = response.body.getReader();
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          req.signal.removeEventListener("abort", aborted);
          release();
        };
        const cancel = async (reason?: unknown) => {
          try { await reader.cancel(reason); } finally { finish(); }
        };
        const aborted = () => { void cancel(req.signal.reason).catch(() => {}); };
        req.signal.addEventListener("abort", aborted, { once: true });
        if (req.signal.aborted) aborted();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { finish(); controller.close(); }
              else controller.enqueue(next.value);
            } catch (error) { finish(); controller.error(error); }
          },
          cancel,
        }, { highWaterMark: 0 });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) { req.signal.removeEventListener("abort", beforeHeadersAbort); release(); throw error; }
    },
  };
}
