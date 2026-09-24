"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const MAX_HEADER_TIMEOUT_MS = 120_000;
const MIN_CONCURRENT_REQUESTS = 64;
const MAX_CONCURRENT_REQUESTS = 128;
const POST_PATHS = new Set([
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/chat/completions",
  "/v1/messages",
]);
const GET_PATHS = new Set(["/v1/models", "/healthz", "/readyz"]);
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);
const FALLBACK_STRIP = new Set([
  "authorization", "x-api-key", "openai-organization", "openai-project",
  "cookie", "set-cookie", "proxy-authorization", "proxy-authenticate",
]);

function parseOrigin(value, name) {
  // Do not delegate this decision to DNS: a hosts-file override could make
  // `localhost` a remote credential-bearing upstream. Both guardian targets
  // have explicit ports, so only accept the canonical numeric form.
  const match = typeof value === "string" && /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(value);
  let origin;
  try { origin = new URL(value); } catch { throw new Error(`${name} must be an absolute URL`); }
  if (!match || Number(match[1]) > 65535 || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error(`${name} must be a canonical numeric loopback http origin`);
  }
  return origin;
}

function writeJson(response, status, body) {
  if (response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function safeLog(log, event, detail) {
  try { log(event, detail); } catch { /* diagnostics cannot affect routing */ }
}

function filteredHeaders(headers, fallback, fallbackKey) {
  const output = {};
  const connectionHeaders = new Set(String(headers.connection || "").toLowerCase()
    .split(",").map(value => value.trim()).filter(Boolean));
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionHeaders.has(lower) || lower === "cookie" || lower === "set-cookie" || lower === "origin") continue;
    if (!fallback) {
      output[lower] = value;
    } else if (!FALLBACK_STRIP.has(lower) && (lower === "accept" || lower === "content-type" || lower === "user-agent")) {
      output[lower] = value;
    }
  }
  if (fallback) output.authorization = `Bearer ${fallbackKey}`;
  return output;
}

function responseHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if ((HOP_BY_HOP.has(lower) && lower !== "content-length") || lower === "set-cookie" || lower === "cookie"
      || lower === "authorization" || lower === "x-api-key" || lower === "proxy-authenticate" || lower === "location"
      || /(?:token|secret|credential|account|api[-_]?key)/.test(lower)) continue;
    output[lower] = value;
  }
  return output;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(Object.assign(new Error("request body timed out"), { code: "BODY_TIMEOUT" })), BODY_TIMEOUT_MS);
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      if (error) reject(error); else resolve(body);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        request.resume();
        finish(Object.assign(new Error("request body exceeds limit"), { code: "BODY_TOO_LARGE" }));
      } else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onAborted = () => finish(Object.assign(new Error("client aborted"), { code: "CLIENT_ABORTED" }));
    const onError = error => finish(error);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function requestUpstream({ origin, method, path, body, headers, headerTimeoutMs, clientRequest, clientResponse, onFailure, log }) {
  return new Promise(resolve => {
    const upstreamHeaders = { ...headers };
    if (body) upstreamHeaders["content-length"] = String(body.length);
    const upstream = http.request({
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method,
      path,
      headers: upstreamHeaders,
    });
    let settled = false;
    let failureNotified = false;
    // A client that hangs up makes the upstream teardown look like an upstream
    // failure (ECONNRESET/aborted). That is the reader leaving, not the primary
    // dying, and charging it would push every in-flight request onto the
    // fallback model for the whole stability window.
    let clientCancelled = false;
    const notifyFailure = () => {
      if (failureNotified || clientCancelled) return;
      failureNotified = true;
      try { onFailure(); } catch { /* recovery notification cannot affect the request */ }
    };
    let headerTimer = setTimeout(() => upstream.destroy(Object.assign(new Error("upstream headers timed out"), { code: "UPSTREAM_TIMEOUT" })), headerTimeoutMs);
    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(headerTimer);
      resolve(result);
    };
    upstream.once("response", upstreamResponse => {
      clearTimeout(headerTimer);
      if (upstreamResponse.statusCode >= 500) notifyFailure();
      clientResponse.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(clientResponse);
      upstreamResponse.once("end", () => settle({ ok: true }));
      upstreamResponse.once("error", error => {
        notifyFailure();
        safeLog(log, "upstream_stream_error", { code: error.code || "stream_error" });
        clientResponse.destroy(error);
        settle({ ok: false });
      });
      upstreamResponse.once("aborted", notifyFailure);
    });
    upstream.once("error", error => {
      notifyFailure();
      safeLog(log, "upstream_request_error", { code: error.code || "request_error" });
      if (!clientResponse.headersSent) writeJson(clientResponse, 502, { error: { code: "upstream_unavailable" } });
      settle({ ok: false });
    });
    clientRequest.once("aborted", () => { clientCancelled = true; upstream.destroy(); });
    clientResponse.once("close", () => {
      if (!clientResponse.writableEnded) { clientCancelled = true; upstream.destroy(); }
    });
    if (body && body.length) upstream.end(body); else upstream.end();
  });
}

async function createGateway(options) {
  const {
    port,
    primaryOrigin: primaryOriginInput,
    fallbackOrigin: fallbackOriginInput,
    models = {},
    readFallbackKey,
    isPrimaryReady,
    isStopped,
    onPrimaryFailure,
    log = () => {},
    headerTimeoutMs = 90_000,
    maxConcurrentRequests = MIN_CONCURRENT_REQUESTS,
  } = options || {};
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be a TCP port");
  if (typeof readFallbackKey !== "function" || typeof isPrimaryReady !== "function"
    || typeof isStopped !== "function" || typeof onPrimaryFailure !== "function") throw new Error("gateway callbacks are required");
  const primaryOrigin = parseOrigin(primaryOriginInput, "primaryOrigin");
  const fallbackOrigin = parseOrigin(fallbackOriginInput, "fallbackOrigin");
  if (primaryOrigin.origin === fallbackOrigin.origin) throw new Error("primary and fallback origins must differ");
  if (port !== 0 && (primaryOrigin.port === String(port) || fallbackOrigin.port === String(port))) {
    throw new Error("gateway cannot proxy to itself");
  }
  const modelMap = Object.freeze({ ...models });
  const boundedHeaderTimeoutMs = Number.isFinite(headerTimeoutMs)
    ? Math.min(MAX_HEADER_TIMEOUT_MS, Math.max(1_000, Math.floor(headerTimeoutMs)))
    : 90_000;
  const boundedMaxConcurrentRequests = Number.isFinite(maxConcurrentRequests)
    ? Math.min(MAX_CONCURRENT_REQUESTS, Math.max(MIN_CONCURRENT_REQUESTS, Math.floor(maxConcurrentRequests)))
    : MIN_CONCURRENT_REQUESTS;
  let activeRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (activeRequests >= boundedMaxConcurrentRequests) {
      writeJson(response, 503, { error: { code: "gateway_busy" } });
      return;
    }
    activeRequests += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
    };
    response.once("finish", release);
    response.once("close", release);
    try {
    if (!allowedHosts.has(String(request.headers.host || "").toLowerCase())) {
      writeJson(response, 421, { error: { code: "invalid_host" } });
      return;
    }
    if (request.headers.origin !== undefined || request.headers.cookie !== undefined || request.method === "OPTIONS") {
      writeJson(response, 403, { error: { code: "browser_requests_denied" } });
      return;
    }
    if (!request.url || !request.url.startsWith("/") || request.url.startsWith("//")) {
      writeJson(response, 400, { error: { code: "invalid_request_target" } });
      return;
    }
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.search || (!GET_PATHS.has(requestUrl.pathname) && !POST_PATHS.has(requestUrl.pathname))) {
      writeJson(response, 404, { error: { code: "route_not_allowed" } });
      return;
    }
    if (requestUrl.pathname === "/healthz" && request.method === "GET") {
      const stopped = Boolean(isStopped());
      const primaryReady = stopped ? false : Boolean(isPrimaryReady());
      writeJson(response, 200, { service: "ocx-recovery-gateway", primaryReady });
      return;
    }
    if (requestUrl.pathname === "/readyz" && request.method === "GET") {
      const stopped = Boolean(isStopped());
      const primaryReady = stopped ? false : Boolean(isPrimaryReady());
      writeJson(response, !stopped && primaryReady ? 200 : 503, { service: "ocx-recovery-gateway", primaryReady });
      return;
    }
    if (isStopped()) {
      writeJson(response, 503, { error: { code: "gateway_stopped" } });
      return;
    }
    if (GET_PATHS.has(requestUrl.pathname) && request.method !== "GET") {
      writeJson(response, 405, { error: { code: "method_not_allowed" } });
      return;
    }
    if (POST_PATHS.has(requestUrl.pathname) && request.method !== "POST") {
      writeJson(response, 405, { error: { code: "method_not_allowed" } });
      return;
    }
    const primaryReady = Boolean(isPrimaryReady());
    let body = null;
    if (request.method === "POST") {
      try { body = await readBody(request); } catch (error) {
        writeJson(response, error.code === "BODY_TOO_LARGE" ? 413 : error.code === "CLIENT_ABORTED" ? 499 : 408,
          { error: { code: error.code === "BODY_TOO_LARGE" ? "body_too_large" : "body_timeout" } });
        return;
      }
    }
    if (primaryReady) {
      await requestUpstream({
        origin: primaryOrigin, method: request.method, path: requestUrl.pathname, body,
        headers: filteredHeaders(request.headers, false), headerTimeoutMs: boundedHeaderTimeoutMs, clientRequest: request,
        clientResponse: response, onFailure: onPrimaryFailure, log,
      });
      return;
    }
    let fallbackBody = body;
    if (request.method === "POST") {
      // One parse per request: this body can be 8 MiB and every decision below
      // reads the same document.
      let parsed = null;
      try { parsed = JSON.parse(body.toString("utf8")); } catch { /* not JSON, so neither a continuation nor a mappable model */ }
      if (typeof parsed?.previous_response_id === "string" && parsed.previous_response_id.length > 0) {
        writeJson(response, 503, { error: { code: "fallback_requires_fresh_full_context" } });
        return;
      }
      const mapped = typeof parsed?.model === "string" && Object.prototype.hasOwnProperty.call(modelMap, parsed.model)
        ? modelMap[parsed.model] : null;
      if (typeof mapped !== "string" || !mapped) {
        writeJson(response, 503, { error: { code: "fallback_model_unavailable" } });
        return;
      }
      fallbackBody = Buffer.from(JSON.stringify({ ...parsed, model: mapped }));
    }
    let fallbackKey;
    try { fallbackKey = await readFallbackKey(); } catch {
      writeJson(response, 503, { error: { code: "fallback_unavailable" } });
      return;
    }
    if (typeof fallbackKey !== "string" || !fallbackKey) {
      writeJson(response, 503, { error: { code: "fallback_unavailable" } });
      return;
    }
    await requestUpstream({
      origin: fallbackOrigin, method: request.method, path: requestUrl.pathname, body: fallbackBody,
      headers: filteredHeaders(request.headers, true, fallbackKey), headerTimeoutMs: boundedHeaderTimeoutMs, clientRequest: request,
      clientResponse: response, onFailure: () => safeLog(log, "fallback_failure", { route: requestUrl.pathname }), log,
    });
    } catch {
      safeLog(log, "gateway_request_error", { code: "gateway_error" });
      try { onPrimaryFailure(); } catch { /* recovery notification cannot affect the request */ }
      if (!response.headersSent) writeJson(response, 502, { error: { code: "gateway_unavailable" } });
      else response.destroy();
    } finally {
      if (response.writableEnded) release();
    }
  });
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.headersTimeout = boundedHeaderTimeoutMs;
  server.requestTimeout = boundedHeaderTimeoutMs;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const localPort = server.address().port;
  // Fixed once the socket is bound. Rebuilding this per request cost a `server.address()`
  // object, two template strings and a Set on every proxied call.
  const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
  if (primaryOrigin.port === String(localPort) || fallbackOrigin.port === String(localPort)) {
    await new Promise(resolve => server.close(resolve));
    throw new Error("gateway cannot proxy to itself");
  }
  return {
    server,
    port: localPort,
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

module.exports = { createGateway };
