import type { Server, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { readBoundedResponseBytes } from "../lib/bounded-body";
import { clearableDeadline } from "../lib/abort";
import {
  LIVE_CLIENT_PROTOCOL_HEADERS,
  parseLiveSidebandTarget,
  sanitizeStandaloneRealtimeQuery,
  type LiveSidebandTarget,
} from "../server/live";
import { hasProxyAdmissionSecretShape } from "../server/auth-cors";
import type { OcxClientConnectionConfig } from "../types";
import { readServiceApiTokenState } from "../lib/service-secrets";
import { assertNoClientDisconnectPending, readClientConnectionState } from "./state";

export const VOICE_RELAY_DEFAULT_PORT = 10_111;
export const VOICE_RELAY_BODY_MAX_BYTES = 16 * 1024 * 1024;
export const VOICE_RELAY_WS_FRAME_MAX_BYTES = 1024 * 1024;
export const VOICE_RELAY_WS_PENDING_MAX_BYTES = 4 * 1024 * 1024;
export const VOICE_RELAY_WS_PENDING_MAX_FRAMES = 64;
export const VOICE_RELAY_WS_BACKPRESSURE_MAX_BYTES = 4 * 1024 * 1024;
export const VOICE_RELAY_CONNECT_TIMEOUT_MS = 15_000;
export const VOICE_RELAY_TOTAL_TIMEOUT_MS = 120_000;
export const VOICE_RELAY_WS_IDLE_SECONDS = 120;
export const VOICE_RELAY_CLOSE_FALLBACK_MS = 2_000;

const HTTP_REQUEST_HEADERS = [
  "accept", "accept-language", "authorization", "chatgpt-account-id", "content-type",
  ...LIVE_CLIENT_PROTOCOL_HEADERS,
] as const;
const WS_REQUEST_HEADERS = ["authorization", "chatgpt-account-id", ...LIVE_CLIENT_PROTOCOL_HEADERS] as const;
const HTTP_RESPONSE_HEADERS = [
  "cache-control", "content-language", "content-type", "location", "openai-processing-ms", "retry-after",
] as const;

export interface VoiceRelayCredential {
  connection: OcxClientConnectionConfig;
  token: string;
}

export interface VoiceRelayOptions {
  port?: number;
  allowStandalone?: boolean;
  credential?: VoiceRelayCredential;
  connectionCheck?: (expected: VoiceRelayCredential) => boolean;
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  closeFallbackMs?: number;
  monitorIntervalMs?: number;
}

export interface VoiceRelayHandle {
  port: number;
  origin: string;
  done: Promise<"stopped" | "connection_changed">;
  stop(): void;
}

interface VoiceRelayWsData {
  upstreamUrl: string;
  headers: Record<string, string>;
  upstream?: WebSocket;
  pending: Array<string | Buffer>;
  pendingBytes: number;
  opened: boolean;
  closing: boolean;
  handshakeTimer?: ReturnType<typeof setTimeout>;
  closeTimer?: ReturnType<typeof setTimeout>;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function frameBytes(value: string | Buffer | ArrayBuffer | ArrayBufferView): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  return value.byteLength;
}

function relayHeaders(source: Headers, names: readonly string[]): Headers {
  const output = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) output.set(name, value);
  }
  return output;
}

function secretEquals(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(actualBytes, expectedBytes);
}

function removeRelayAdmissionBearer(headers: Headers, connectedToken: string): void {
  const match = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1]?.trim();
  if (!bearer) return;
  if (secretEquals(bearer, connectedToken)
    || hasProxyAdmissionSecretShape(bearer)) {
    headers.delete("authorization");
  }
}

function localAuthorityAllowed(req: Request, port: number): boolean {
  let url: URL;
  try { url = new URL(req.url); } catch { return false; }
  const localHost = url.hostname === "127.0.0.1" || url.hostname.toLowerCase() === "localhost";
  if (!localHost || url.port !== String(port)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:"
      && (parsed.hostname === "127.0.0.1" || parsed.hostname.toLowerCase() === "localhost")
      && parsed.port === String(port)
      && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function postRouteAllowed(url: URL, method: string): boolean {
  return method === "POST" && (url.pathname === "/v1/live" || url.pathname === "/v1/realtime/calls");
}

export function voiceRelayWebSocketRouteAllowed(url: URL, allowStandalone = false): boolean {
  const target = parseLiveSidebandTarget(url.pathname, url.searchParams, url.search.slice(1));
  if (!target) return false;
  return allowStandalone
    || target.style === "frameless-path"
    || target.style === "realtime-calls-path"
    || target.style === "realtime-query";
}

function sanitizedWebSocketPath(url: URL, target: LiveSidebandTarget): string {
  const query = sanitizeStandaloneRealtimeQuery(url.search.slice(1));
  if (target.style === "realtime-query") {
    const params = new URLSearchParams(query);
    // Keep the parser-validated call id authoritative if duplicate values were supplied.
    params.delete("call_id");
    params.set("call_id", target.callId);
    return `${url.pathname}?${params.toString()}`;
  }
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

function upstreamUrl(origin: string, local: URL, websocket: boolean): string {
  const target = new URL(`${local.pathname}${local.search}`, `${origin}/`);
  if (websocket) target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function credentialStillOwned(expected: VoiceRelayCredential): boolean {
  try {
    assertNoClientDisconnectPending();
    const state = readClientConnectionState();
    const token = readServiceApiTokenState();
    return state.kind === "connected"
      && JSON.stringify(state.value) === JSON.stringify(expected.connection)
      && !state.value.pendingOperation
      && token.kind === "present"
      && token.fingerprint === expected.connection.tokenFingerprint;
  } catch {
    return false;
  }
}

export function loadVoiceRelayCredential(): VoiceRelayCredential {
  assertNoClientDisconnectPending();
  const state = readClientConnectionState();
  if (state.kind !== "connected" || state.value.pendingOperation) {
    throw new Error("voice relay requires a complete, stable 'ocx connect' connection");
  }
  const token = readServiceApiTokenState();
  if (token.kind !== "present" || token.fingerprint !== state.value.tokenFingerprint) {
    throw new Error(token.kind === "unsafe"
      ? "connected voice relay credential is unreadable or unsafe"
      : "connected voice relay credential is missing or no longer owned");
  }
  return { connection: structuredClone(state.value), token: token.token };
}

async function readRequest(req: Request, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer> | Response> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) return jsonError(413, "voice_relay_request_too_large");
  }
  try {
    const result = await readBoundedResponseBytes(new Response(req.body), {
      maxBytes,
      signal,
      inactivityTimeoutMs: VOICE_RELAY_CONNECT_TIMEOUT_MS,
    });
    return result.oversized ? jsonError(413, "voice_relay_request_too_large") : result.bytes;
  } catch {
    return jsonError(req.signal.aborted ? 499 : 408, req.signal.aborted ? "voice_relay_client_closed" : "voice_relay_request_timeout");
  }
}

async function relayHttp(req: Request, url: URL, credential: VoiceRelayCredential, options: VoiceRelayOptions): Promise<Response> {
  const totalTimeoutMs = options.totalTimeoutMs ?? VOICE_RELAY_TOTAL_TIMEOUT_MS;
  const total = AbortSignal.timeout(totalTimeoutMs);
  const lifetime = AbortSignal.any([req.signal, total]);
  const body = await readRequest(req, VOICE_RELAY_BODY_MAX_BYTES, lifetime);
  if (body instanceof Response) return body;
  if (!(options.connectionCheck ?? credentialStillOwned)(credential)) return jsonError(409, "voice_relay_connection_changed");
  const headers = relayHeaders(req.headers, HTTP_REQUEST_HEADERS);
  removeRelayAdmissionBearer(headers, credential.token);
  headers.set("x-opencodex-api-key", credential.token);
  const connect = clearableDeadline(options.connectTimeoutMs ?? VOICE_RELAY_CONNECT_TIMEOUT_MS, lifetime);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(upstreamUrl(credential.connection.serverUrl, url, false), {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: connect.signal,
    });
  } catch {
    return jsonError(connect.didExpire() ? 504 : 502, connect.didExpire() ? "voice_relay_connect_timeout" : "voice_relay_upstream_unreachable");
  } finally {
    connect.clear();
  }
  if (response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return jsonError(502, "voice_relay_redirect_refused");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > VOICE_RELAY_BODY_MAX_BYTES) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return jsonError(502, "voice_relay_response_too_large");
  }
  try {
    const result = await readBoundedResponseBytes(response, {
      maxBytes: VOICE_RELAY_BODY_MAX_BYTES,
      signal: lifetime,
      inactivityTimeoutMs: options.connectTimeoutMs ?? VOICE_RELAY_CONNECT_TIMEOUT_MS,
    });
    if (result.oversized) return jsonError(502, "voice_relay_response_too_large");
    return new Response(result.bytes, { status: response.status, statusText: response.statusText, headers: relayHeaders(response.headers, HTTP_RESPONSE_HEADERS) });
  } catch {
    return jsonError(504, "voice_relay_response_timeout");
  }
}

function safeCloseCode(code: number): number {
  return code === 1000 || (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
    || (code >= 3000 && code <= 4999) ? code : 1011;
}

function safeCloseReason(reason: string): string {
  return /^[\x20-\x7e]{0,80}$/.test(reason) ? reason : "peer closed";
}

function startWebSocketPeer(
  downstream: ServerWebSocket<VoiceRelayWsData>,
  options: VoiceRelayOptions,
): void {
  const data = downstream.data;
  const factory = options.webSocketFactory ?? ((url, headers) => new WebSocket(url, { headers } as unknown as string[]));
  const finish = (code = 1000, reason = "") => {
    if (data.closing) return;
    data.closing = true;
    if (data.handshakeTimer) clearTimeout(data.handshakeTimer);
    data.pending = [];
    data.pendingBytes = 0;
    const upstream = data.upstream;
    try { if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close(code, reason); } catch { /* best effort */ }
    try { if (downstream.readyState < WebSocket.CLOSING) downstream.close(code, reason); } catch { /* best effort */ }
    if (data.closeTimer) clearTimeout(data.closeTimer);
    data.closeTimer = setTimeout(() => {
      data.closeTimer = undefined;
      try {
        if (upstream && upstream.readyState !== WebSocket.CLOSED) {
          (upstream as WebSocket & { terminate(): void }).terminate();
        }
      } catch { /* best effort */ }
      try { if (downstream.readyState !== WebSocket.CLOSED) downstream.terminate(); } catch { /* best effort */ }
    }, options.closeFallbackMs ?? VOICE_RELAY_CLOSE_FALLBACK_MS);
  };
  let upstream: WebSocket;
  try { upstream = factory(data.upstreamUrl, data.headers); }
  catch { finish(1011, "upstream connect failed"); return; }
  data.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  data.handshakeTimer = setTimeout(() => finish(1011, "upstream handshake timeout"), options.connectTimeoutMs ?? VOICE_RELAY_CONNECT_TIMEOUT_MS);
  upstream.addEventListener("open", () => {
    if (data.closing) return;
    if (data.handshakeTimer) clearTimeout(data.handshakeTimer);
    data.handshakeTimer = undefined;
    data.opened = true;
    const pending = data.pending;
    data.pending = [];
    data.pendingBytes = 0;
    for (const frame of pending) {
      const bytes = frameBytes(frame);
      if (upstream.bufferedAmount + bytes > VOICE_RELAY_WS_BACKPRESSURE_MAX_BYTES) {
        finish(1013, "upstream backpressure limit");
        return;
      }
      upstream.send(typeof frame === "string" ? frame : Uint8Array.from(frame));
    }
  }, { once: true });
  upstream.addEventListener("message", event => {
    if (data.closing) return;
    const payload = event.data;
    if (typeof payload === "string") {
      if (frameBytes(payload) > VOICE_RELAY_WS_FRAME_MAX_BYTES) { finish(1009, "message too large"); return; }
      if (downstream.getBufferedAmount() + frameBytes(payload) > VOICE_RELAY_WS_BACKPRESSURE_MAX_BYTES) { finish(1013, "client backpressure limit"); return; }
      downstream.send(payload);
      return;
    }
    if (payload instanceof ArrayBuffer) {
      if (payload.byteLength > VOICE_RELAY_WS_FRAME_MAX_BYTES) { finish(1009, "message too large"); return; }
      if (downstream.getBufferedAmount() + payload.byteLength > VOICE_RELAY_WS_BACKPRESSURE_MAX_BYTES) { finish(1013, "client backpressure limit"); return; }
      downstream.send(payload);
      return;
    }
    finish(1003, "unsupported frame");
  });
  upstream.addEventListener("close", event => finish(safeCloseCode(event.code), safeCloseReason(event.reason)));
  upstream.addEventListener("error", () => finish(1011, "upstream websocket error"), { once: true });
}

export function startVoiceRelay(options: VoiceRelayOptions = {}): VoiceRelayHandle {
  const credential = options.credential ?? loadVoiceRelayCredential();
  const port = options.port ?? VOICE_RELAY_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("voice relay port must be between 0 and 65535");
  const sessions = new Set<ServerWebSocket<VoiceRelayWsData>>();
  let resolveDone!: (reason: "stopped" | "connection_changed") => void;
  const done = new Promise<"stopped" | "connection_changed">(resolve => { resolveDone = resolve; });
  let stopped = false;
  let monitor: ReturnType<typeof setInterval> | undefined;
  let server!: Server<VoiceRelayWsData>;
  const stop = (reason: "stopped" | "connection_changed" = "stopped") => {
    if (stopped) return;
    stopped = true;
    if (monitor) clearInterval(monitor);
    for (const session of sessions) {
      try { session.close(1001, reason); } catch { /* best effort */ }
      try { (session.data.upstream as (WebSocket & { terminate(): void }) | undefined)?.terminate(); } catch { /* best effort */ }
      if (session.data.handshakeTimer) clearTimeout(session.data.handshakeTimer);
      if (session.data.closeTimer) clearTimeout(session.data.closeTimer);
      session.data.pending = [];
      session.data.pendingBytes = 0;
    }
    sessions.clear();
    try { server.stop(true); } catch { /* already stopped */ }
    resolveDone(reason);
  };
  server = Bun.serve<VoiceRelayWsData>({
    port,
    hostname: "127.0.0.1",
    async fetch(req, bunServer) {
      if (!localAuthorityAllowed(req, bunServer.port ?? port)) return jsonError(403, "voice_relay_origin_rejected");
      if (!(options.connectionCheck ?? credentialStillOwned)(credential)) {
        queueMicrotask(() => stop("connection_changed"));
        return jsonError(409, "voice_relay_connection_changed");
      }
      const url = new URL(req.url);
      const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const wsTarget = upgrade && req.method === "GET"
        ? parseLiveSidebandTarget(url.pathname, url.searchParams, url.search.slice(1))
        : null;
      const wsAllowed = wsTarget && (options.allowStandalone
        || wsTarget.style === "frameless-path"
        || wsTarget.style === "realtime-calls-path"
        || wsTarget.style === "realtime-query");
      if (wsAllowed && wsTarget) {
        const headers = relayHeaders(req.headers, WS_REQUEST_HEADERS);
        removeRelayAdmissionBearer(headers, credential.token);
        headers.set("x-opencodex-api-key", credential.token);
        if (bunServer.upgrade(req, { data: {
          upstreamUrl: upstreamUrl(credential.connection.serverUrl, new URL(sanitizedWebSocketPath(url, wsTarget), url), true),
          headers: Object.fromEntries(headers.entries()),
          pending: [], pendingBytes: 0, opened: false, closing: false,
        } })) return undefined;
        return jsonError(426, "voice_relay_upgrade_failed");
      }
      if (postRouteAllowed(url, req.method)) return relayHttp(req, url, credential, options);
      return jsonError(404, "voice_relay_route_not_found");
    },
    websocket: {
      maxPayloadLength: VOICE_RELAY_WS_FRAME_MAX_BYTES,
      idleTimeout: VOICE_RELAY_WS_IDLE_SECONDS,
      open(ws) { sessions.add(ws); startWebSocketPeer(ws, options); },
      message(ws, frame) {
        const data = ws.data;
        if (data.closing) return;
        const bytes = frameBytes(frame);
        if (bytes > VOICE_RELAY_WS_FRAME_MAX_BYTES) { ws.close(1009, "message too large"); return; }
        const upstream = data.upstream;
        if (!upstream || !data.opened || upstream.readyState !== WebSocket.OPEN) {
          if (data.pending.length >= VOICE_RELAY_WS_PENDING_MAX_FRAMES || data.pendingBytes + bytes > VOICE_RELAY_WS_PENDING_MAX_BYTES) {
            ws.close(1009, "pending messages exceeded limit");
            try { upstream?.close(1009, "pending messages exceeded limit"); } catch { /* best effort */ }
            data.closing = true;
            return;
          }
          data.pending.push(frame);
          data.pendingBytes += bytes;
          return;
        }
        if (upstream.bufferedAmount + bytes > VOICE_RELAY_WS_BACKPRESSURE_MAX_BYTES) {
          data.closing = true;
          ws.close(1013, "upstream backpressure limit");
          try { upstream.close(1013, "upstream backpressure limit"); } catch { /* best effort */ }
          return;
        }
        upstream.send(typeof frame === "string" ? frame : Uint8Array.from(frame));
      },
      close(ws, code, reason) {
        sessions.delete(ws);
        const data = ws.data;
        data.closing = true;
        data.pending = [];
        data.pendingBytes = 0;
        if (data.handshakeTimer) clearTimeout(data.handshakeTimer);
        const upstream = data.upstream;
        try { if (upstream && upstream.readyState < WebSocket.CLOSING) upstream.close(safeCloseCode(code), safeCloseReason(reason)); } catch { /* best effort */ }
        if (upstream && upstream.readyState !== WebSocket.CLOSED && !data.closeTimer) {
          data.closeTimer = setTimeout(() => {
            data.closeTimer = undefined;
            try {
              if (upstream.readyState !== WebSocket.CLOSED) {
                (upstream as WebSocket & { terminate(): void }).terminate();
              }
            } catch { /* best effort */ }
          }, options.closeFallbackMs ?? VOICE_RELAY_CLOSE_FALLBACK_MS);
        }
      },
    },
  });
  if (!options.credential || options.connectionCheck) {
    monitor = setInterval(() => {
      if (!(options.connectionCheck ?? credentialStillOwned)(credential)) stop("connection_changed");
    }, options.monitorIntervalMs ?? 1_000);
    if (typeof monitor === "object" && "unref" in monitor) monitor.unref();
  }
  const boundPort = server.port ?? port;
  return { port: boundPort, origin: `http://127.0.0.1:${boundPort}`, done, stop: () => stop() };
}
