import { timingSafeEqual } from "node:crypto";
import { resolve, sep } from "node:path";
import { loadPlatformConfig } from "./config";
import { Database } from "./db";
import { GATEWAY_ASSERTION_HEADER, signGatewayAssertion } from "./security";
import {
  PlatformStore,
  type InstanceRecord,
  type RelayDeviceActor,
  type TerminalSessionRecord,
} from "./store";

const config = loadPlatformConfig();
const database = new Database(config.PLATFORM_DATABASE_URL);
const store = new PlatformStore(database, config);

const INSTANCE_COOKIE = "__Host-ocxr_instance";
const RELAY_MAX_PAYLOAD = 64 * 1024;
const RELAY_MAX_BUFFERED = 1024 * 1024;
const RELAY_FRAME_HEADER_SIZE = 18;
const RELAY_PROTOCOL_VERSION = 1;
const RELAY_FRAME_OPEN = 1;
const RELAY_FRAME_DATA = 2;
const RELAY_FRAME_CLOSE = 3;
const RELAY_HOST = new URL(config.PLATFORM_RELAY_URL).hostname.toLowerCase();
const WEB_ROOT = resolve(import.meta.dir, "../../web/dist");
const REQUEST_HEADER_DENY = new Set([
  "connection", "cookie", "host", "proxy-authorization", "proxy-authenticate",
  "upgrade",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
  "x-opencodex-api-key", GATEWAY_ASSERTION_HEADER, "x-ocxr-synthetic",
  "x-opencodex-remote-token",
]);
const RESPONSE_HEADER_DENY = new Set([
  "connection", "set-cookie", "set-cookie2", "proxy-authenticate", "proxy-authorization",
  GATEWAY_ASSERTION_HEADER,
]);

function cookieValue(req: Request, name: string): string | null {
  for (const segment of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = segment.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function safeEqual(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function remoteCredential(req: Request): string | null {
  const explicit = req.headers.get("x-opencodex-remote-token")?.trim();
  if (explicit) return `Bearer ${explicit}`;
  const authorization = req.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  return token?.startsWith("ocxr_") ? authorization : null;
}

function bearerToken(req: Request): string | null {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || null;
}

function requestHostname(req: Request): string {
  return (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
}

function requestOriginMatches(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.hostname.toLowerCase() === requestHostname(req)
      && (parsed.protocol === "https:" || (parsed.protocol === "http:" && parsed.hostname === "localhost"));
  } catch {
    return false;
  }
}

function browserAccessRedirect(req: Request): Response | null {
  if (req.method !== "GET" || req.headers.get("upgrade")?.toLowerCase() === "websocket") return null;
  const acceptsHtml = req.headers.get("sec-fetch-dest") === "document"
    || (req.headers.get("accept") ?? "").includes("text/html");
  if (!acceptsHtml) return null;
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  const suffix = `.${config.PLATFORM_INSTANCE_DOMAIN.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) return null;
  return new Response(null, {
    status: 302,
    headers: {
      location: `${config.PLATFORM_BASE_URL.replace(/\/$/, "")}/access/${encodeURIComponent(slug)}`,
      "cache-control": "no-store",
    },
  });
}

function sanitizeRequestHeaders(req: Request, target: URL, assertion: string): Headers {
  const headers = new Headers();
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (
      REQUEST_HEADER_DENY.has(lower)
      || lower.startsWith("cf-")
      || lower.startsWith("sec-websocket-")
      || lower.startsWith("x-ocxr-")
    ) continue;
    if (lower === "authorization" && value.replace(/^Bearer\s+/i, "").startsWith("ocxr_")) continue;
    headers.append(name, value);
  }
  headers.set("host", "127.0.0.1:10100");
  headers.set("origin", "http://127.0.0.1:10100");
  headers.set(GATEWAY_ASSERTION_HEADER, assertion);
  headers.set("x-ocxr-target-path", `${target.pathname}${target.search}`);
  return headers;
}

function sanitizeResponseHeaders(response: Response, publicHost: string): Headers {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (RESPONSE_HEADER_DENY.has(lower) || lower.startsWith("cf-") || lower.startsWith("x-ocxr-")) continue;
    if (lower === "location") {
      headers.set(name, value.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost):10100/i, `https://${publicHost}`));
    } else {
      headers.append(name, value);
    }
  }
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

function privateUrl(instance: InstanceRecord, requestUrl: URL): URL {
  return new URL(`${requestUrl.pathname}${requestUrl.search}`, `http://${instance.privateHostname}:10101`);
}

const activeRequests = new Map<string, Set<AbortController>>();
const activeSockets = new Map<string, Set<Bun.ServerWebSocket<SocketData>>>();
const relayAgents = new Map<string, Bun.ServerWebSocket<SocketData>>();
const relayTerminals = new Map<string, Bun.ServerWebSocket<SocketData>>();
function track(instanceId: string, controller: AbortController): () => void {
  const set = activeRequests.get(instanceId) ?? new Set<AbortController>();
  set.add(controller);
  activeRequests.set(instanceId, set);
  return () => {
    set.delete(controller);
    if (!set.size) activeRequests.delete(instanceId);
  };
}

function socketInstanceId(socket: Bun.ServerWebSocket<SocketData>): string {
  return socket.data.kind === "relay-agent" ? socket.data.device.instanceId : socket.data.instance.id;
}

function trackSocket(socket: Bun.ServerWebSocket<SocketData>): void {
  const instanceId = socketInstanceId(socket);
  const sockets = activeSockets.get(instanceId) ?? new Set<Bun.ServerWebSocket<SocketData>>();
  sockets.add(socket);
  activeSockets.set(instanceId, sockets);
}

function untrackSocket(socket: Bun.ServerWebSocket<SocketData>): void {
  const instanceId = socketInstanceId(socket);
  const sockets = activeSockets.get(instanceId);
  sockets?.delete(socket);
  if (!sockets?.size) activeSockets.delete(instanceId);
}

function streamWithLifecycle(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    cleanup();
  };
  return new ReadableStream({
    async pull(output) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish();
          output.close();
        } else {
          output.enqueue(chunk.value);
        }
      } catch (error) {
        finish();
        output.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

async function listenForRevocations(): Promise<void> {
  const client = await database.pool.connect();
  client.on("notification", message => {
    if (message.channel !== "instance_state" || !message.payload) return;
    try {
      const { instanceId, status } = JSON.parse(message.payload) as { instanceId: string; status?: string };
      if (!["suspending", "suspended", "deleting", "deleted"].includes(status ?? "")) return;
      for (const controller of activeRequests.get(instanceId) ?? []) controller.abort("instance disabled");
      for (const socket of activeSockets.get(instanceId) ?? []) socket.close(1008, "instance disabled");
      activeRequests.delete(instanceId);
      activeSockets.delete(instanceId);
    } catch { /* malformed NOTIFY payload is ignored */ }
  });
  client.on("error", error => console.error("gateway PostgreSQL listener failed", error.message));
  await client.query("LISTEN instance_state");
}

interface ProxySocketData {
  kind: "proxy";
  instance: InstanceRecord;
  userId: string;
  url: URL;
  headers: Headers;
  queued: Array<string | Buffer>;
  upstream?: WebSocket;
}

interface RelayAgentSocketData {
  kind: "relay-agent";
  device: RelayDeviceActor & { instanceId: string };
}

interface RelayTerminalSocketData {
  kind: "relay-terminal";
  instance: InstanceRecord;
  userId: string;
  session: TerminalSessionRecord;
}

type SocketData = ProxySocketData | RelayAgentSocketData | RelayTerminalSocketData;

function uuidBytes(value: string): Buffer {
  const hex = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error("invalid relay session id");
  return Buffer.from(hex, "hex");
}

function uuidString(value: Buffer): string {
  if (value.length !== 16) throw new Error("invalid relay session bytes");
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function relayFrame(kind: number, sessionId: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (![RELAY_FRAME_OPEN, RELAY_FRAME_DATA, RELAY_FRAME_CLOSE].includes(kind)) throw new Error("invalid relay frame kind");
  if (payload.length > RELAY_MAX_PAYLOAD) throw new Error("relay frame is too large");
  return Buffer.concat([Buffer.from([RELAY_PROTOCOL_VERSION, kind]), uuidBytes(sessionId), payload]);
}

function parseRelayFrame(message: Buffer): { kind: number; sessionId: string; payload: Buffer } {
  if (message.length < RELAY_FRAME_HEADER_SIZE || message.length > RELAY_FRAME_HEADER_SIZE + RELAY_MAX_PAYLOAD) {
    throw new Error("invalid relay frame length");
  }
  if (message[0] !== RELAY_PROTOCOL_VERSION || ![RELAY_FRAME_OPEN, RELAY_FRAME_DATA, RELAY_FRAME_CLOSE].includes(message[1])) {
    throw new Error("invalid relay frame header");
  }
  return {
    kind: message[1],
    sessionId: uuidString(message.subarray(2, RELAY_FRAME_HEADER_SIZE)),
    payload: message.subarray(RELAY_FRAME_HEADER_SIZE),
  };
}

function sendBounded(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): boolean {
  if (socket.getBufferedAmount() > RELAY_MAX_BUFFERED) {
    socket.close(1013, "relay backpressure");
    return false;
  }
  socket.send(message);
  return true;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

async function workspaceAsset(req: Request, url: URL): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const indexPath = resolve(WEB_ROOT, "index.html");
  const candidate = resolve(WEB_ROOT, `.${requestedPath}`);
  if (!candidate.startsWith(`${WEB_ROOT}${sep}`)) return new Response("Not found", { status: 404 });

  let file = Bun.file(candidate);
  let fellBackToIndex = false;
  if (!(await file.exists())) {
    // Missing immutable assets must fail instead of returning HTML under a JS/CSS
    // cache key. Only extensionless browser routes participate in SPA fallback.
    if (requestedPath.startsWith("/assets/") || /\/[^/]+\.[^/]+$/.test(requestedPath)) {
      return new Response("Not found", { status: 404 });
    }
    file = Bun.file(indexPath);
    fellBackToIndex = true;
  }
  if (!(await file.exists())) return new Response("Workspace UI is not built", { status: 503 });
  const response = new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "cache-control": fellBackToIndex || requestedPath === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
      "content-type": file.type,
      "content-security-policy": "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
  return response;
}

let gatewayServer: Bun.Server<SocketData>;

async function authenticate(req: Request): Promise<{ instance: InstanceRecord; userId: string } | null> {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? "";
  if (url.pathname === "/healthz" && safeEqual(req.headers.get("x-ocxr-synthetic"), config.syntheticHealthToken)) {
    const result = await store.resolveGatewayRequest(host, null, null, "/_synthetic");
    if (result) return { ...result, userId: "synthetic-health" };
    // Synthetic health still needs to resolve an active instance, but has no
    // user session. Resolve it through a constrained direct query.
    const slug = host.toLowerCase().replace(/:\d+$/, "").replace(`.${config.PLATFORM_INSTANCE_DOMAIN.toLowerCase()}`, "");
    const found = await database.query<{
      id: string; owner_id: string; name: string; slug: string; private_hostname: string;
      transport_mode: InstanceRecord["transportMode"];
      status: InstanceRecord["status"]; created_at: Date; updated_at: Date;
    }>(`SELECT i.* FROM instances i JOIN users u ON u.id=i.owner_id
        WHERE i.slug=$1 AND i.status IN ('connecting','online','degraded','offline') AND i.deleted_at IS NULL AND u.status='active'`, [slug]);
    const row = found.rows[0];
    return row ? { userId: "synthetic-health", instance: {
      id: row.id, ownerId: row.owner_id, name: row.name, slug: row.slug,
      privateHostname: row.private_hostname, transportMode: row.transport_mode, status: row.status,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    } } : null;
  }
  return store.resolveGatewayRequest(
    host,
    remoteCredential(req),
    cookieValue(req, INSTANCE_COOKIE),
    url.pathname,
  );
}

gatewayServer = Bun.serve<SocketData>({
  port: config.PLATFORM_GATEWAY_PORT,
  hostname: config.PLATFORM_GATEWAY_HOST,
  async fetch(req, server) {
    const url = new URL(req.url);
    const host = req.headers.get("host") ?? "";
    if (url.pathname === "/_ocxr/agent") {
      if (
        req.headers.get("upgrade")?.toLowerCase() !== "websocket"
        || requestHostname(req) !== RELAY_HOST
      ) return new Response("Not found", { status: 404 });
      const token = bearerToken(req);
      const device = token ? await store.authorizeRelayToken(token) : null;
      if (!device?.instanceId) return new Response("Unauthorized", { status: 401 });
      const upgraded = server.upgrade(req, {
        data: { kind: "relay-agent", device: { ...device, instanceId: device.instanceId } },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 502 });
    }
    if (url.pathname === "/_ocxr/exchange" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const exchanged = code ? await store.exchangeInstanceAuthorization(host, code) : null;
      if (!exchanged) return new Response("Not found", { status: 404 });
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${INSTANCE_COOKIE}=${encodeURIComponent(exchanged.token)}; Path=/; Expires=${exchanged.expiresAt.toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
          "cache-control": "no-store",
        },
      });
    }

    const auth = await authenticate(req);
    if (!auth) {
      return browserAccessRedirect(req)
        ?? new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
    }

    if (auth.instance.transportMode === "outbound-relay") {
      if (url.pathname === "/healthz" && req.method === "GET") {
        return jsonResponse({ ok: true, relay: true });
      }
      const terminalPath = url.pathname.match(/^\/_ocxr\/terminal\/([0-9a-f-]{36})$/i);
      if (terminalPath && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const session = await store.resolveTerminalSession(auth.userId, auth.instance.id, terminalPath[1]);
        if (!session || !relayAgents.has(session.deviceId)) {
          return new Response("Remote computer unavailable", { status: 409 });
        }
        const upgraded = server.upgrade(req, {
          data: { kind: "relay-terminal", instance: auth.instance, userId: auth.userId, session },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 502 });
      }
      if (url.pathname === "/api/v1/workspace" && req.method === "GET") {
        const devices = (await store.listRelayDevices(auth.userId, auth.instance.id)).map(device => ({
          ...device,
          relayOnline: relayAgents.has(device.id),
        }));
        return jsonResponse({
          instance: {
            id: auth.instance.id,
            name: auth.instance.name,
            slug: auth.instance.slug,
            status: devices.some(device => device.relayOnline) ? "online" : "offline",
          },
          devices,
          limits: { maxSessionsPerDevice: 4, maxFrameBytes: RELAY_MAX_PAYLOAD },
        });
      }
      if (url.pathname === "/api/v1/terminal-sessions" && req.method === "POST") {
        if (!requestOriginMatches(req)) return jsonResponse({ error: "origin rejected" }, 403);
        if (Number(req.headers.get("content-length") ?? "0") > 4096) {
          return jsonResponse({ error: "request too large" }, 413);
        }
        let input: { deviceId?: unknown; commandProfile?: unknown };
        try {
          input = await req.json();
        } catch {
          return jsonResponse({ error: "invalid request" }, 400);
        }
        const commandProfile = input.commandProfile;
        if (
          typeof input.deviceId !== "string"
          || !/^[0-9a-f-]{36}$/i.test(input.deviceId)
          || !["shell", "codex", "claude"].includes(String(commandProfile))
        ) return jsonResponse({ error: "invalid request" }, 400);
        if (!relayAgents.has(input.deviceId)) return jsonResponse({ error: "remote computer unavailable" }, 409);
        try {
          const session = await store.createTerminalSession(
            auth.userId,
            auth.instance.id,
            input.deviceId,
            commandProfile as TerminalSessionRecord["commandProfile"],
          );
          return jsonResponse({
            session,
            websocketPath: `/_ocxr/terminal/${session.id}`,
          }, 201);
        } catch (error) {
          return jsonResponse({ error: error instanceof Error ? error.message : "session rejected" }, 409);
        }
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_ocxr/")) {
        return jsonResponse({ error: "not found" }, 404);
      }
      return workspaceAsset(req, url);
    }
    const target = privateUrl(auth.instance, url);
    const assertion = signGatewayAssertion(config, {
      instanceId: auth.instance.id,
      userId: auth.userId,
      method: req.method,
      url,
    });
    const headers = sanitizeRequestHeaders(req, target, assertion);

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const wsTarget = new URL(target);
      wsTarget.protocol = "ws:";
      const upgraded = server.upgrade(req, {
        data: { kind: "proxy", instance: auth.instance, userId: auth.userId, url: wsTarget, headers, queued: [] },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 502 });
    }

    const controller = new AbortController();
    const untrack = track(auth.instance.id, controller);
    const abort = () => controller.abort(req.signal.reason);
    const cleanup = () => {
      req.signal.removeEventListener("abort", abort);
      untrack();
    };
    if (req.signal.aborted) abort();
    else req.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        signal: controller.signal,
        // Required by Bun for streaming request bodies.
        duplex: req.body ? "half" : undefined,
      } as RequestInit);
      if (url.pathname === "/healthz") await store.recordHealth(auth.instance.id, "gateway", response.ok);
      const body = response.body
        ? streamWithLifecycle(response.body, controller, cleanup)
        : null;
      if (!body) cleanup();
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeResponseHeaders(response, host),
      });
    } catch {
      cleanup();
      if (url.pathname === "/healthz") await store.recordHealth(auth.instance.id, "gateway", false);
      return new Response("Upstream unavailable", { status: 502 });
    }
  },
  websocket: {
    open(ws) {
      trackSocket(ws);
      if (ws.data.kind === "proxy") {
        const data = ws.data;
        const upstream = new WebSocket(data.url, { headers: Object.fromEntries(data.headers) } as never);
        data.upstream = upstream;
        upstream.binaryType = "arraybuffer";
        upstream.addEventListener("open", () => {
          for (const message of data.queued.splice(0)) upstream.send(message);
        });
        upstream.addEventListener("message", event => {
          if (typeof event.data === "string") ws.send(event.data);
          else if (event.data instanceof ArrayBuffer) ws.send(event.data);
        });
        upstream.addEventListener("close", event => ws.close(event.code, event.reason));
        upstream.addEventListener("error", () => ws.close(1011, "upstream error"));
        return;
      }
      if (ws.data.kind === "relay-agent") {
        const previous = relayAgents.get(ws.data.device.deviceId);
        relayAgents.set(ws.data.device.deviceId, ws);
        if (previous && previous !== ws) previous.close(1012, "agent reconnected");
        return;
      }
      const previous = relayTerminals.get(ws.data.session.id);
      relayTerminals.set(ws.data.session.id, ws);
      if (previous && previous !== ws) previous.close(1008, "terminal session already connected");
      const agent = relayAgents.get(ws.data.session.deviceId);
      if (!agent || agent.data.kind !== "relay-agent") {
        ws.close(1013, "remote computer unavailable");
        return;
      }
      void store.markTerminalConnected(ws.data.session.id);
      sendBounded(agent, relayFrame(
        RELAY_FRAME_OPEN,
        ws.data.session.id,
        Buffer.from(JSON.stringify({ commandProfile: ws.data.session.commandProfile })),
      ));
    },
    message(ws, message) {
      if (ws.data.kind === "proxy") {
        if (ws.data.upstream?.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
        else ws.data.queued.push(typeof message === "string" ? message : Buffer.from(message));
        return;
      }
      if (typeof message === "string") {
        ws.close(1003, "binary relay frames required");
        return;
      }
      const bytes = Buffer.from(message);
      if (ws.data.kind === "relay-agent") {
        let frame: ReturnType<typeof parseRelayFrame>;
        try {
          frame = parseRelayFrame(bytes);
        } catch {
          ws.close(1008, "invalid relay frame");
          return;
        }
        const terminal = relayTerminals.get(frame.sessionId);
        if (!terminal || terminal.data.kind !== "relay-terminal") return;
        if (terminal.data.session.deviceId !== ws.data.device.deviceId) {
          ws.close(1008, "relay session ownership mismatch");
          return;
        }
        if (frame.kind === RELAY_FRAME_CLOSE) terminal.close(1000, "remote terminal closed");
        else sendBounded(terminal, frame.payload);
        return;
      }
      if (bytes.length > RELAY_MAX_PAYLOAD) {
        ws.close(1009, "relay frame is too large");
        return;
      }
      const agent = relayAgents.get(ws.data.session.deviceId);
      if (!agent || agent.data.kind !== "relay-agent") {
        ws.close(1013, "remote computer unavailable");
        return;
      }
      sendBounded(agent, relayFrame(RELAY_FRAME_DATA, ws.data.session.id, bytes));
    },
    close(ws, code, reason) {
      untrackSocket(ws);
      if (ws.data.kind === "proxy") {
        if (ws.data.upstream && ws.data.upstream.readyState < WebSocket.CLOSING) ws.data.upstream.close(code, reason);
        return;
      }
      if (ws.data.kind === "relay-terminal") {
        if (relayTerminals.get(ws.data.session.id) === ws) relayTerminals.delete(ws.data.session.id);
        void store.markTerminalClosed(ws.data.session.id);
        const agent = relayAgents.get(ws.data.session.deviceId);
        if (agent?.data.kind === "relay-agent") {
          sendBounded(agent, relayFrame(RELAY_FRAME_CLOSE, ws.data.session.id));
        }
        return;
      }
      if (relayAgents.get(ws.data.device.deviceId) !== ws) return;
      relayAgents.delete(ws.data.device.deviceId);
      for (const terminal of relayTerminals.values()) {
        if (terminal.data.kind === "relay-terminal" && terminal.data.session.deviceId === ws.data.device.deviceId) {
          terminal.close(1013, "remote computer disconnected");
        }
      }
      void store.markRelayDisconnected(ws.data.device.deviceId);
    },
  },
});

void listenForRevocations();
console.log(`OpenCodex Remote gateway listening on ${config.PLATFORM_GATEWAY_HOST}:${config.PLATFORM_GATEWAY_PORT}`);
