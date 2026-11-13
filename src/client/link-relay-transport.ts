import { Agent, request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { serviceApiTokenFingerprint } from "../lib/service-secrets";
import { clearableDeadline } from "../lib/abort";
import { packageVersion } from "../lib/package-version";
import { linkPeerReportHeaders } from "../link/peer-report";
import { buildPeerFeatures } from "../remote/features";
import {
  LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_TIMEOUT_MS, LINK_RELAY_AUTH_VERSION, LINK_RELAY_CONNECTION_HEADER,
  LINK_RELAY_CONNECTION_PROOF_HEADER, LINK_RELAY_PROBE_HEADER, LINK_RELAY_SESSION_HEADER, linkConnectionProof,
  linkRelayChallenge, linkRelayProofMatches,
} from "../link/relay-auth";
import { forgetVerifiedHomeConnection, recordVerifiedHomeConnection } from "./link-connection";
import { linkChildReportFeatures } from "../link/compatibility";
import { childLinkTraffic, type LinkTrafficBook, type LinkTrafficFlow } from "../link/traffic";
import { LINK_HOME_FEATURES_HEADER } from "../link/request-compression";
import { recordLinkHomeFeatures } from "./link-home-features";
import { applyLinkWebsocketAnswer, linkWebsocketAnswer, nextLinkPreflightSequence, type LinkWebsocketAnswer } from "./link-ws-advertisement";

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

/**
 * One physical connection, ever. A closed keep-alive socket cannot trigger a silent reconnect.
 * Exported for the link WebSocket's upgrade (link-ws-transport.ts), which runs on the same kind of connection.
 */
export class SingleConnectionAgent extends Agent {
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

export function requestOnConnection(
  url: URL, init: RequestInit, agent: SingleConnectionAgent, authenticatedSocket?: Socket, onSent?: (bytes: number) => void,
  onUploadSettled?: (finished: boolean) => void, onBodySettled?: () => void,
): Promise<IncomingMessage> {
  // Nothing below keeps `init`: listeners on the request live until its connection closes, and a
  // prepared body must not stay reachable through them after its write completed.
  const method = init.method ?? "GET", signal = init.signal ?? undefined, initHeaders = init.headers;
  let pendingBody = init.body;
  return new Promise((resolve, reject) => {
    // Once: true when every body write completed, false when the request or its socket closed first.
    // Response headers alone prove neither, since a Home may answer before it reads the upload, so
    // the caller's body lease (onBodySettled) is released here too.
    let uploadSettled = false;
    const settleUpload = (finished: boolean) => {
      if (uploadSettled) return;
      uploadSettled = true;
      onUploadSettled?.(finished);
      onBodySettled?.();
    };
    const headers = Object.fromEntries(new Headers(initHeaders));
    // No implicit decompression negotiation; handle an explicitly encoded response below anyway.
    headers["accept-encoding"] = "identity";
    const outgoing = request(url, {
      method, headers, agent, signal,
      maxHeaderSize: 64 * 1024,
    }, resolve);
    outgoing.on("error", reject);
    outgoing.once("close", () => settleUpload(false));
    outgoing.on("upgrade", (_response, socket) => { socket.destroy(); reject(new LinkRelayAuthenticationError()); });
    outgoing.on("socket", socket => {
      if (authenticatedSocket && socket !== authenticatedSocket) outgoing.destroy(new LinkRelayAuthenticationError());
      // Before the agent's own close listener, so a cut upload is settled before the request reports its end.
      socket.once("close", () => settleUpload(false));
    });
    void (async () => {
      const body = pendingBody;
      pendingBody = null;
      if (body instanceof ReadableStream) {
        const reader = body.getReader();
        const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
        signal?.addEventListener("abort", abort, { once: true });
        outgoing.once("close", abort);
        try {
          for (;;) {
            signal?.throwIfAborted();
            const next = await reader.read();
            if (next.done) break;
            // Await the write callback: upstream backpressure never buffers the whole upload.
            await new Promise<void>((done, fail) => outgoing.write(next.value,
              error => error ? fail(error) : done()));
            onSent?.(next.value.byteLength);
          }
          settleUpload(true);
        } finally {
          signal?.removeEventListener("abort", abort);
          outgoing.removeListener("close", abort);
          try { await reader.cancel(); } catch { /* preserve the upload outcome */ }
          reader.releaseLock();
        }
      } else if (body != null) {
        if (typeof body === "string" || body instanceof Uint8Array) {
          // Counted once the socket took it, like each streamed chunk; a write that never completes counts
          // nothing, and the body settles with its write or with the request's close.
          const bytes = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
          outgoing.write(body, error => {
            if (error) { settleUpload(false); return; }
            onSent?.(bytes);
            settleUpload(true);
          });
        } else throw new TypeError("unsupported link relay body");
      } else settleUpload(true);
      outgoing.end();
    })().catch(error => {
      settleUpload(false);
      outgoing.destroy(error instanceof Error ? error : new Error("link upload failed"));
      reject(error);
    });
  });
}

/**
 * A data request's flow that ends only once both halves settled: the response (through `end`) and
 * the upload (through `uploaded`). It is complete only when both finished, so a Home that answered in
 * full before reading the whole body still leaves the request incomplete and `toHomeBytes` flagged as
 * a lower bound.
 */
function untilBothSettled(flow: LinkTrafficFlow): { flow: LinkTrafficFlow; uploaded(finished: boolean): void } {
  let response: boolean | undefined, upload: boolean | undefined;
  const settle = () => { if (response !== undefined && upload !== undefined) flow.end(response && upload); };
  return {
    flow: {
      toHome: bytes => flow.toHome(bytes), fromHome: bytes => flow.fromHome(bytes), uncounted: () => flow.uncounted(),
      end(complete) { if (response === undefined) { response = complete; settle(); } },
    },
    uploaded(finished) { if (upload === undefined) { upload = finished; settle(); } },
  };
}

function responseHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
    headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
  }
  return headers;
}

/**
 * Node HTTP compatibility is confined here; the relay continues to expose a Web Response/stream.
 * `flow` counts the response body as it arrives on the socket, before any decoding, and ends
 * complete when the body reached its end, incomplete on a cancel or an error.
 */
async function responseOnConnection(
  incoming: IncomingMessage, agent: SingleConnectionAgent, method: string, flow?: LinkTrafficFlow,
): Promise<Response> {
  const headers = responseHeaders(incoming);
  const status = incoming.statusCode ?? 502;
  if (method === "HEAD" || status === 204 || status === 205 || status === 304) {
    for await (const chunk of incoming) flow?.fromHome((chunk as Buffer).byteLength);
    await agent.close();
    flow?.end(true);
    return new Response(null, { status, headers });
  }
  let source: Readable = incoming;
  const encoding = headers.get("content-encoding")?.trim().toLowerCase();
  const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress() : undefined;
  if (encoding && encoding !== "identity" && !decoder) {
    throw new Error("unsupported link response encoding");
  }
  // Counted as the bytes leave the socket's stream, before any adapter queue or decoder, so a
  // cancel after they were read still counts them; pipe() keeps the caller's backpressure.
  const counter = flow ? new Transform({
    transform(chunk: Buffer, _encoding, done) { flow.fromHome(chunk.byteLength); done(null, chunk); },
  }) : undefined;
  if (counter) {
    incoming.on("error", error => counter.destroy(error));
    source = incoming.pipe(counter);
  }
  if (decoder) {
    const upstream = source;
    upstream.on("error", error => decoder.destroy(error));
    source = upstream.pipe(decoder);
  }
  const reader = (Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>).getReader();
  let finished = false;
  const finish = async () => {
    if (finished) return agent.close();
    finished = true;
    if (source !== incoming) source.destroy();
    counter?.destroy();
    await agent.close();
    try { reader.releaseLock(); } catch { /* a cancelled read may still be settling */ }
  };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { flow?.end(true); await finish(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { flow?.end(false); await finish(); controller.error(error); }
    },
    async cancel(reason) {
      flow?.end(false);
      try { await reader.cancel(reason); } finally { await finish(); }
    },
  }, { highWaterMark: 0 }), { status, headers });
}

/** Test seam: the response half alone, over any readable that looks like an IncomingMessage. */
export const linkResponseOnConnectionForTests = (incoming: IncomingMessage, close: () => Promise<void>, method: string, flow?: LinkTrafficFlow) =>
  responseOnConnection(incoming, { close } as SingleConnectionAgent, method, flow);

let peerReport: Record<string, string> | undefined;

/**
 * The credential-free challenge for one connection; the proof binds this nonce to the link key. It
 * takes its preflight number when it starts, which orders the Home's WebSocket advertisement.
 */
export function relayChallenge(target: BoundLinkRelayTarget, origin: URL) {
  const preflight = nextLinkPreflightSequence();
  const challenge = linkRelayChallenge(serviceApiTokenFingerprint(target.admissionKey), target.apiKeyId!, target.linkId!);
  const probe = new URL(LINK_RELAY_AUTH_PATH, origin);
  probe.search = new URLSearchParams({ version: LINK_RELAY_AUTH_VERSION, key: target.apiKeyId!,
    link: target.linkId!, nonce: challenge.nonce, proof: challenge.caller }).toString();
  // The challenge also carries this Child's version and features for the Home's link status.
  peerReport ??= linkPeerReportHeaders(packageVersion("0.0.0"), linkChildReportFeatures(buildPeerFeatures()));
  return { challenge, probe, headers: peerReport, preflight };
}

/**
 * Called only after the Home's relay proof verified. Keep its connection generation when its own
 * proof binds it to this nonce and key; otherwise the connection is unknown, never the old value.
 * Its Responses WebSocket state is applied under the preflight ordering rule (link-ws-advertisement.ts)
 * and returned, so an upgrade decides from its own answer.
 */
export function noteHomeConnection(
  target: BoundLinkRelayTarget, nonce: string, headers: IncomingMessage["headers"], preflight: number,
): { features: readonly string[] | null; websocket: LinkWebsocketAnswer } {
  if (!target.linkId || !target.apiKeyId) return { features: null, websocket: "off" };
  const fingerprint = serviceApiTokenFingerprint(target.admissionKey);
  const websocket = linkWebsocketAnswer(headers, { fingerprint, keyId: target.apiKeyId, linkId: target.linkId, nonce });
  applyLinkWebsocketAnswer(target.linkId, preflight, websocket);
  // What this Home serves, as it named it on this verified answer (#3023). Recorded for the next
  // request's decision and returned so this connection's own body can be chosen from it.
  const named = headers[LINK_HOME_FEATURES_HEADER];
  const features = recordLinkHomeFeatures(target.linkId, typeof named === "string" ? named : null);
  const generation = headers[LINK_RELAY_CONNECTION_HEADER];
  const proof = headers[LINK_RELAY_CONNECTION_PROOF_HEADER];
  const expected = typeof generation === "string"
    ? linkConnectionProof(fingerprint, target.apiKeyId, target.linkId, nonce, generation)
    : null;
  if (typeof generation === "string" && typeof proof === "string" && linkRelayProofMatches(proof, expected)) {
    recordVerifiedHomeConnection(target.linkId, generation);
  } else forgetVerifiedHomeConnection(target.linkId);
  return { features, websocket };
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
    if (response.statusCode === 204 && typeof proof === "string" && linkRelayProofMatches(proof, request.challenge.expected)) {
      noteHomeConnection(target, request.challenge.nonce, response.headers, request.preflight);
      return "ok";
    }
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
 *
 * Every link body is counted here (#3023), so the relay and the Child's own reads of the Home
 * count alike: a request from the moment its data request starts on the authenticated socket,
 * each request-body chunk once the socket took it, and each response-body chunk as it arrives,
 * before any decoding. A failed challenge or a refused connection sent no data and counts nothing.
 */
export async function fetchBoundLinkRelay(
  target: BoundLinkRelayTarget, destination: string, init: RequestInit,
  options: {
    authTimeoutMs?: number;
    traffic?: LinkTrafficBook;
    /**
     * Choose the request body once this connection's Home has proved itself and named its
     * features: a prepared body's zstd form only when this very answer names the capability.
     */
    selectBody?: (homeFeatures: readonly string[] | null) => { body: Uint8Array<ArrayBuffer>; headers: Record<string, string> };
    /** Called once the data request's body was flushed to the socket or the request was torn down. */
    onBodySettled?: () => void;
  } = {},
): Promise<Response> {
  const authTimeoutMs = options.authTimeoutMs ?? LINK_RELAY_AUTH_TIMEOUT_MS;
  if (!Number.isFinite(authTimeoutMs) || authTimeoutMs <= 0) throw new RangeError("invalid link relay auth timeout");
  if (!target.linkId || !target.apiKeyId) throw new LinkRelayAuthenticationError();
  const url = new URL(destination);
  if (url.origin !== `http://127.0.0.1:${target.tunnelPort}`) throw new LinkRelayAuthenticationError();
  const { challenge, probe, headers: preflightHeaders, preflight } = relayChallenge(target, url);
  const agent = new SingleConnectionAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  const deadline = clearableDeadline(authTimeoutMs, init.signal ?? undefined);
  let dataRequestStarted = false;
  let flow: ReturnType<typeof untilBothSettled> | undefined;
  try {
    const response = await requestOnConnection(probe, { method: "GET", signal: deadline.signal, headers: preflightHeaders }, agent);
    const socket = agent.socket;
    const proof = response.headers["x-opencodex-link-proof"];
    if (response.statusCode !== 204 || typeof proof !== "string" || !linkRelayProofMatches(proof, challenge.expected)) {
      throw new LinkRelayAuthenticationError(response.statusCode === 404);
    }
    const homeFeatures = noteHomeConnection(target, challenge.nonce, response.headers, preflight).features;
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
    let body = init.body;
    if (options.selectBody) {
      const chosen = options.selectBody(homeFeatures);
      body = chosen.body;
      for (const [name, value] of Object.entries(chosen.headers)) headers.set(name, value);
    }
    dataRequestStarted = true;
    flow = target.linkId ? untilBothSettled((options.traffic ?? childLinkTraffic).begin(target.linkId)) : undefined;
    const incoming = await requestOnConnection(url, { ...init, headers, body }, agent, socket, bytes => flow?.flow.toHome(bytes),
      finished => flow?.uploaded(finished), options.onBodySettled);
    return await responseOnConnection(incoming, agent, init.method ?? "GET", flow?.flow);
  } catch (error) {
    flow?.flow.end(false);
    const authDeadlineExpired = !dataRequestStarted && deadline.didExpire()
      && !(error instanceof LinkRelayAuthenticationError);
    await agent.close();
    // The connection is gone, so an upload that has not settled yet never will.
    flow?.uploaded(false);
    if (authDeadlineExpired && !init.signal?.aborted) throw new LinkRelayAuthTimeoutError();
    throw error;
  } finally { deadline.clear(); }
}
