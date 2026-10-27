import { Agent, request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { serviceApiTokenFingerprint } from "../lib/service-secrets";
import { clearableDeadline } from "../lib/abort";
import { packageVersion } from "../lib/package-version";
import { linkPeerReportHeaders } from "../link/peer-report";
import { buildPeerFeatures } from "../remote/features";
import {
  LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_TIMEOUT_MS, LINK_RELAY_AUTH_VERSION,
  LINK_RELAY_PROBE_HEADER, LINK_RELAY_SESSION_HEADER, linkRelayChallenge, linkRelayProofMatches,
} from "../link/relay-auth";

export interface BoundLinkRelayTarget {
  tunnelPort: number;
  admissionKey: string;
  linkId?: string;
  apiKeyId?: string;
}

export class LinkRelayAuthenticationError extends Error {
  constructor(readonly unrecognized = false) {
    super(unrecognized ? "link relay authentication unavailable; upgrade the Home and Child or re-link"
      : "link relay authentication failed");
    this.name = "LinkRelayAuthenticationError";
  }
}

/** Only the credential-free preflight deadline expired; no data request has begun. */
export class LinkRelayAuthTimeoutError extends Error {
  constructor() {
    super("link relay authentication timed out");
    this.name = "LinkRelayAuthTimeoutError";
  }
}

/** One physical connection, ever. A closed keep-alive socket cannot trigger a silent reconnect. */
class SingleConnectionAgent extends Agent {
  socket: Socket | undefined;
  private opened = false;
  private closeFlight?: Promise<void>;
  /** Drain the socket close event before the request reports a terminal outcome. */
  close(): Promise<void> {
    if (this.closeFlight) return this.closeFlight;
    const socket = this.socket;
    this.closeFlight = !socket || socket.closed ? Promise.resolve()
      : new Promise<void>(resolve => { socket.once("close", () => resolve()); });
    this.destroy();
    return this.closeFlight;
  }
  override createConnection(...[options, callback]: Parameters<Agent["createConnection"]>): ReturnType<Agent["createConnection"]> {
    if (this.opened) {
      if (!callback) throw new LinkRelayAuthenticationError();
      callback(new LinkRelayAuthenticationError(), this.socket!);
      return undefined;
    }
    this.opened = true;
    this.socket = super.createConnection(options, callback) as Socket;
    return this.socket;
  }
}

function requestOnConnection(
  url: URL, init: RequestInit, agent: SingleConnectionAgent, authenticatedSocket?: Socket,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers));
    // No implicit decompression negotiation; handle an explicitly encoded response below anyway.
    headers["accept-encoding"] = "identity";
    const outgoing = request(url, {
      method: init.method ?? "GET", headers, agent, signal: init.signal ?? undefined,
      maxHeaderSize: 64 * 1024,
    }, resolve);
    outgoing.on("error", reject);
    outgoing.on("upgrade", (_response, socket) => { socket.destroy(); reject(new LinkRelayAuthenticationError()); });
    outgoing.on("socket", socket => {
      if (authenticatedSocket && socket !== authenticatedSocket) outgoing.destroy(new LinkRelayAuthenticationError());
    });
    void (async () => {
      const body = init.body;
      if (body instanceof ReadableStream) {
        const reader = body.getReader();
        const abort = () => { void reader.cancel(init.signal?.reason).catch(() => {}); };
        init.signal?.addEventListener("abort", abort, { once: true });
        outgoing.once("close", abort);
        try {
          for (;;) {
            init.signal?.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            // Await the write callback: upstream backpressure never buffers the whole upload.
            await new Promise<void>((done, fail) => outgoing.write(next.value,
              error => error ? fail(error) : done()));
          }
        } finally {
          init.signal?.removeEventListener("abort", abort);
          outgoing.removeListener("close", abort);
          try { await reader.cancel(); } catch { /* preserve the upload outcome */ }
          reader.releaseLock();
        }
      } else if (body != null) {
        if (typeof body === "string" || body instanceof Uint8Array) outgoing.write(body);
        else throw new TypeError("unsupported link relay body");
      }
      outgoing.end();
    })().catch(error => { outgoing.destroy(error instanceof Error ? error : new Error("link upload failed")); reject(error); });
  });
}

function responseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  }
  return headers;
}

/** Node HTTP compatibility is confined here; the relay continues to expose a Web Response/stream. */
async function responseOnConnection(incoming: IncomingMessage, agent: SingleConnectionAgent, method: string): Promise<Response> {
  const headers = responseHeaders(incoming);
  const status = incoming.statusCode ?? 502;
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    for await (const _chunk of incoming) { /* drain a header-only response */ }
    await agent.close();
    return new Response(null, { status, headers });
  }
  let source: Readable = incoming;
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : undefined;
  if (encoding && encoding !== "identity" && !decoder) {
    throw new Error("unsupported link response encoding");
  }
  if (decoder) {
    incoming.on("error", error => decoder.destroy(error));
    source = incoming.pipe(decoder);
  }
  const reader = (Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>).getReader();
  let finished = false;
  const finish = async () => {
    if (finished) return agent.close();
    finished = true;
    if (source !== incoming) source.destroy();
    await agent.close();
    try { reader.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { await finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { await finish(); controller.error(error); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { await finish(); }
    },
  }, { highWaterMark: 0 }), { status, headers });
}

let peerReport: Record<string, string> | undefined;

/** The credential-free challenge for one connection; the proof binds this nonce to the link key. */
function relayChallenge(target: BoundLinkRelayTarget, origin: URL) {
  const challenge = linkRelayChallenge(serviceApiTokenFingerprint(target.admissionKey), target.apiKeyId!, target.linkId!);
  const probe = new URL(LINK_RELAY_AUTH_PATH, origin);
  probe.search = new URLSearchParams({ version: LINK_RELAY_AUTH_VERSION, key: target.apiKeyId!,
    link: target.linkId!, nonce: challenge.nonce, proof: challenge.caller }).toString();
  // The challenge also carries this Child's version and features for the Home's link status.
  peerReport ??= linkPeerReportHeaders(packageVersion("0.0.0"), buildPeerFeatures());
  return { challenge, probe, headers: peerReport };
}

/**
 * The outcome of the credential-free preflight alone: `ok` when the Home answered with a proof
 * only the holder of the link key can make, `unrecognized` for a peer without the route (404),
 * `auth_failed` for any other answer, and `unreachable` when nothing answered in time.
 */
export type LinkRelayPreflightResult = "ok" | "unreachable" | "auth_failed" | "unrecognized";

/**
 * Run only the preflight a relayed request starts with, on its own connection, and close it. It
 * sends no link key, no data request and no body; the Child's readiness uses it to learn whether
 * the Home answers through the tunnel right now. It is marked probe-only, so the Home reserves no
 * session for a data request that never comes. The response body is never read.
 */
export async function probeLinkRelayPreflight(
  target: BoundLinkRelayTarget, options: { timeoutMs?: number } = {},
): Promise<LinkRelayPreflightResult> {
  const timeoutMs = options.timeoutMs ?? LINK_RELAY_AUTH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("invalid link relay preflight timeout");
  if (!target.linkId || !target.apiKeyId) return "auth_failed";
  const origin = new URL(`http://127.0.0.1:${target.tunnelPort}`);
  let request: ReturnType<typeof relayChallenge>;
  try { request = relayChallenge(target, origin); } catch { return "auth_failed"; }
  const agent = new SingleConnectionAgent({ keepAlive: false, maxSockets: 1, maxFreeSockets: 0 });
  const deadline = clearableDeadline(timeoutMs);
  try {
    const response = await requestOnConnection(request.probe, {
      method: "GET", signal: deadline.signal, headers: { ...request.headers, [LINK_RELAY_PROBE_HEADER]: "1" },
    }, agent);
    const proof = response.headers["x-opencodex-link-proof"];
    if (response.statusCode === 204 && typeof proof === "string" && linkRelayProofMatches(proof, request.challenge.expected)) return "ok";
    return response.statusCode === 404 ? "unrecognized" : "auth_failed";
  } catch {
    return "unreachable";
  } finally {
    deadline.clear();
    await agent.close();
  }
}

/**
 * Authenticate and stream one request on the SAME socket; never fall back to an ordinary fetch.
 * LinkRelayAuthTimeoutError certifies that only the credential-free preflight expired before
 * data-request construction. Caller aborts and failures after that boundary keep their own errors.
 */
export async function fetchBoundLinkRelay(
  target: BoundLinkRelayTarget, destination: string, init: RequestInit,
  options: { authTimeoutMs?: number } = {},
): Promise<Response> {
  const authTimeoutMs = options.authTimeoutMs ?? LINK_RELAY_AUTH_TIMEOUT_MS;
  if (!Number.isFinite(authTimeoutMs) || authTimeoutMs <= 0) throw new RangeError("invalid link relay auth timeout");
  if (!target.linkId || !target.apiKeyId) throw new LinkRelayAuthenticationError();
  const url = new URL(destination);
  if (url.origin !== `http://127.0.0.1:${target.tunnelPort}`) throw new LinkRelayAuthenticationError();
  const { challenge, probe, headers: preflightHeaders } = relayChallenge(target, url);
  const agent = new SingleConnectionAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const deadline = clearableDeadline(authTimeoutMs, init.signal ?? undefined);
  let dataRequestStarted = false;
  try {
    const response = await requestOnConnection(probe, { method: "GET", signal: deadline.signal, headers: preflightHeaders }, agent);
    const socket = agent.socket;
    const proof = response.headers["x-opencodex-link-proof"];
    if (response.statusCode !== 204 || typeof proof !== "string" || !linkRelayProofMatches(proof, challenge.expected)) {
      throw new LinkRelayAuthenticationError(response.statusCode === 404);
    }
    // Drain the credential-free response before the Agent can reuse its socket.
    for await (const chunk of response) {
      if (chunk.length) throw new LinkRelayAuthenticationError();
    }
    deadline.signal.throwIfAborted();
    deadline.clear();
    init.signal?.throwIfAborted();
    if (!socket || socket.destroyed || socket !== agent.socket) throw new LinkRelayAuthenticationError();
    const headers = new Headers(init.headers);
    headers.set(LINK_RELAY_SESSION_HEADER, challenge.nonce);
    dataRequestStarted = true;
    const incoming = await requestOnConnection(url, { ...init, headers }, agent, socket);
    return await responseOnConnection(incoming, agent, init.method ?? "GET");
  } catch (error) {
    const authDeadlineExpired = !dataRequestStarted && deadline.didExpire()
      && !(error instanceof LinkRelayAuthenticationError);
    await agent.close();
    if (authDeadlineExpired && !init.signal?.aborted) throw new LinkRelayAuthTimeoutError();
    throw error;
  } finally { deadline.clear(); }
}
