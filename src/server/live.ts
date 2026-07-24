/**
 * /v1/live and /v1/realtime/calls relay (issue #371).
 *
 * Codex App / ChatGPT voice (GPT‑Live / Frameless Bidi) POSTs call-create against the injected
 * `base_url`, then opens a sideband WebSocket at `/v1/live/{callId}` (Frameless) or
 * `/v1/realtime?call_id=` (Realtime v1). Under Design B that host is this proxy.
 *
 * Inbound HTTP:
 * - `POST /v1/live` — Frameless / ChatGPT App shape against an injected `/v1` base
 * - `POST /v1/realtime/calls` — openai/codex RealtimeCallClient and the public OpenAI Realtime API
 *
 * Upstream HTTP (matches openai/codex `RealtimeCallClient`):
 * - ChatGPT `backend-api` → JSON `{ sdp, session? }` at
 *   `{base}/realtime/calls?intent=quicksilver&architecture=avas`
 * - OpenAI API-key provider → multipart at
 *   `{base}/v1/realtime/calls?intent=quicksilver&architecture=avas`
 *
 * Inbound sideband WebSocket (transparent bidirectional relay):
 * - `GET /v1/live/{callId}` — Frameless
 * - `GET /v1/realtime/calls/{callId}` — path-form join
 * - `GET /v1/realtime?call_id=` — Realtime v1/v2 join
 */
import { appendFileSync } from "node:fs";
import { formatErrorResponse } from "../bridge";
import {
  CodexAccountCooldownError,
  CodexAuthContextError,
  CodexPoolAuthenticationError,
  CodexThreadAffinityExpiredError,
} from "../codex/auth-context";
import { formatCodexProviderForLog } from "../codex/routing";
import { signalWithTimeout } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import { resolveFirstUsableOpenAiSidecar, selectOpenAiImagesProvider } from "../providers/openai-sidecar";
import { ForwardAdmissionCredentialError, validateForwardAdmissionCredential } from "./auth-cors";
import type { RequestLogContext } from "./request-log";
import { codexLogAccountId } from "./responses";

/** Voice call create can wait on SDP negotiation; bound a hung upstream. */
const LIVE_UPSTREAM_TIMEOUT_MS = 120_000;
export const LIVE_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
export const LIVE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const LIVE_RELAY_HEADERS = ["content-type", "location"] as const;

/** AVAS WebRTC call-create query (openai/codex `configure_realtime_call_request`). */
export const LIVE_AVAS_QUERY = "intent=quicksilver&architecture=avas";

/**
 * Sideband WebSocket API root. openai/codex joins the sideband via the API provider default
 * (`to_api_provider(AuthMode::ApiKey)` → https://api.openai.com/v1) even for ChatGPT-auth calls
 * created through backend-api; chatgpt.com/backend-api rejects sideband upgrades pre-101
 * (verified live 2026-07-24). The call-create bearer works on the API host unchanged.
 */
export const LIVE_SIDEBAND_API_ROOT = "https://api.openai.com/v1";

/**
 * Client protocol headers relayed verbatim to the upstream on call-create and sideband upgrade.
 * `openai-alpha: quicksilver=v2` carries the Frameless protocol negotiation — without it the
 * ChatGPT backend validates the type-less Frameless session as v1 quicksilver and 400s
 * (openai/codex `realtime_request_headers`, core/src/realtime_conversation.rs). Auth headers
 * (`authorization`, `chatgpt-account-id`) stay proxy-owned and are never taken from this list.
 */
export const LIVE_CLIENT_PROTOCOL_HEADERS = [
  "openai-alpha",
  "x-session-id",
  "session-id",
  "thread-id",
  "originator",
  "x-oai-attestation",
] as const;

/**
 * Env-gated sideband frame forensics (diagnostic for multibyte transcript corruption).
 *
 * When `OCX_LIVE_FRAME_LOG` is set to a file path, every relayed sideband frame appends one
 * JSONL record: direction, frame kind, byte length, and whether the payload contains U+FFFD.
 * Privacy: full frame payloads are never written — only when U+FFFD is present, a short
 * excerpt around the first replacement character is included so the corruption point can be
 * attributed (upstream vs relay vs client). Disabled entirely when the env var is unset.
 */
export const LIVE_FRAME_LOG_ENV = "OCX_LIVE_FRAME_LOG";
const LIVE_FRAME_LOG_CONTEXT_CHARS = 24;

function fffdContext(text: string): string | undefined {
  const idx = text.indexOf("\uFFFD");
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - LIVE_FRAME_LOG_CONTEXT_CHARS);
  const end = Math.min(text.length, idx + LIVE_FRAME_LOG_CONTEXT_CHARS);
  return text.slice(start, end);
}

export function logLiveSidebandFrame(dir: "c2u" | "u2c", data: unknown): void {
  const logPath = process.env[LIVE_FRAME_LOG_ENV];
  if (!logPath) return;
  try {
    let kind: "text" | "binary" = "binary";
    let bytes = 0;
    let context: string | undefined;
    if (typeof data === "string") {
      kind = "text";
      bytes = Buffer.byteLength(data);
      context = fffdContext(data);
    } else if (data instanceof ArrayBuffer) {
      bytes = data.byteLength;
      context = fffdContext(new TextDecoder().decode(new Uint8Array(data)));
    } else if (ArrayBuffer.isView(data)) {
      const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      bytes = data.byteLength;
      context = fffdContext(new TextDecoder().decode(view));
    } else {
      return;
    }
    const record = {
      ts: new Date().toISOString(),
      dir,
      kind,
      bytes,
      fffd: context !== undefined,
      ...(context !== undefined ? { context } : {}),
    };
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // Frame forensics must never break the relay.
  }
}

function clientProtocolHeaders(reqHeaders: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of LIVE_CLIENT_PROTOCOL_HEADERS) {
    const value = reqHeaders.get(name);
    if (value != null && value !== "") out[name] = value;
  }
  return out;
}

const LIVE_CALL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type LiveSidebandTarget =
  | { style: "frameless-path"; callId: string }
  | { style: "realtime-calls-path"; callId: string }
  | { style: "realtime-query"; callId: string };

export type LiveRelayTarget = {
  headers: Record<string, string>;
  providerBaseUrl: string;
  usesBackendShape: boolean;
  keyed: boolean;
  recordOutcome?: (status: number | "timeout" | "connect_error") => void;
};

function isChatGptBackendBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes("/backend-api");
}

function withAvasQuery(url: string): string {
  if (/[?&]intent=/.test(url) && /[?&]architecture=/.test(url)) return url;
  return url.includes("?") ? `${url}&${LIVE_AVAS_QUERY}` : `${url}?${LIVE_AVAS_QUERY}`;
}

export function keyedLiveUrl(baseUrl: string): string {
  return withAvasQuery(`${baseUrl.replace(/\/v1\/?$/, "")}/v1/realtime/calls`);
}

export function forwardLiveUrl(baseUrl: string, usesBackendShape: boolean): string {
  const root = baseUrl.replace(/\/$/, "");
  if (usesBackendShape) return withAvasQuery(`${root}/realtime/calls`);
  // Frameless API shape posts to /live without the AVAS query (codex RealtimeCallClient).
  return `${root}/live`;
}

function httpsToWss(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  return httpUrl;
}

export function parseLiveSidebandTarget(pathname: string, searchParams: URLSearchParams): LiveSidebandTarget | null {
  const liveMatch = pathname.match(/^\/v1\/live\/([^/]+)\/?$/);
  if (liveMatch) {
    const callId = decodeURIComponent(liveMatch[1]!);
    if (!LIVE_CALL_ID_RE.test(callId)) return null;
    return { style: "frameless-path", callId };
  }
  const callsMatch = pathname.match(/^\/v1\/realtime\/calls\/([^/]+)\/?$/);
  if (callsMatch) {
    const callId = decodeURIComponent(callsMatch[1]!);
    if (!LIVE_CALL_ID_RE.test(callId)) return null;
    return { style: "realtime-calls-path", callId };
  }
  if (pathname === "/v1/realtime" || pathname === "/v1/realtime/") {
    const callId = searchParams.get("call_id")?.trim() ?? "";
    if (!LIVE_CALL_ID_RE.test(callId)) return null;
    return { style: "realtime-query", callId };
  }
  return null;
}

/**
 * Build the upstream sideband WebSocket URL for a resolved OpenAI/ChatGPT provider.
 * Mirrors openai/codex `websocket_url_from_api_url_for_call` + `normalize_realtime_path`.
 */
export function buildLiveSidebandUpstreamWsUrl(
  providerBaseUrl: string,
  usesBackendShape: boolean,
  target: LiveSidebandTarget,
): string {
  const root = providerBaseUrl.replace(/\/$/, "");
  if (usesBackendShape) {
    // ChatGPT backend-api call-create, but the sideband join lives on the public API host
    // (matches openai/codex, which builds the sideband from the ApiKey provider default).
    if (target.style === "frameless-path") {
      return httpsToWss(`${LIVE_SIDEBAND_API_ROOT}/live/${target.callId}`);
    }
    if (target.style === "realtime-calls-path") {
      return httpsToWss(`${LIVE_SIDEBAND_API_ROOT}/realtime/calls/${target.callId}`);
    }
    return httpsToWss(
      `${LIVE_SIDEBAND_API_ROOT}/realtime?intent=quicksilver&call_id=${encodeURIComponent(target.callId)}`,
    );
  }
  if (target.style === "frameless-path") {
    // Frameless: normalize to .../live then append /{callId}.
    const apiRoot = root.replace(/\/v1\/?$/, "");
    return httpsToWss(`${apiRoot}/v1/live/${target.callId}`);
  }
  if (target.style === "realtime-calls-path") {
    const apiRoot = root.replace(/\/v1\/?$/, "");
    return httpsToWss(`${apiRoot}/v1/realtime/calls/${target.callId}`);
  }
  // Realtime v1/v2: /v1/realtime?intent=quicksilver&call_id=
  const apiRoot = root.replace(/\/v1\/?$/, "");
  return httpsToWss(
    `${apiRoot}/v1/realtime?intent=quicksilver&call_id=${encodeURIComponent(target.callId)}`,
  );
}

async function backendJsonBodyFromApiMultipart(
  body: ArrayBuffer,
  contentType: string,
): Promise<{ body: Uint8Array; contentType: string } | Response> {
  let form: FormData;
  try {
    form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  } catch {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay could not parse multipart call-create body",
    );
  }
  const sdp = form.get("sdp");
  if (typeof sdp !== "string") {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT voice relay expects multipart field sdp on call-create",
    );
  }
  // `session` is optional on the public Realtime calls API; omit when the client sends SDP only.
  const sessionRaw = form.get("session");
  let session: unknown | undefined;
  if (sessionRaw != null) {
    if (typeof sessionRaw !== "string") {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT voice relay expected a string multipart session field",
      );
    }
    try {
      session = JSON.parse(sessionRaw);
    } catch {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        "ChatGPT voice relay expected JSON in the multipart session field",
      );
    }
  }
  const payload = session === undefined ? { sdp } : { sdp, session };
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  return { body: encoded, contentType: "application/json" };
}

/** Read a body stream with a hard byte cap so oversized payloads abort before full buffering. */
export async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeMessage: (total: number) => string,
): Promise<ArrayBuffer | Response> {
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return formatErrorResponse(502, "upstream_error", tooLargeMessage(total));
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released / cancelled
    }
  }
  if (chunks.length === 0) return new ArrayBuffer(0);
  if (chunks.length === 1) {
    const only = chunks[0]!;
    return only.buffer.slice(only.byteOffset, only.byteOffset + only.byteLength) as ArrayBuffer;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

async function readRequestBodyCapped(req: Request, maxBytes: number): Promise<ArrayBuffer | Response> {
  try {
    const result = await readBodyCapped(
      req.body,
      maxBytes,
      total => `live request body too large (${total} bytes)`,
    );
    if (result instanceof Response) {
      // Oversize inbound is a client error, not an upstream failure.
      return formatErrorResponse(413, "invalid_request_error", `live request body too large`);
    }
    return result;
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "live request canceled by client");
    }
    return formatErrorResponse(
      400,
      "invalid_request_error",
      `live request body unreadable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve OpenAI/ChatGPT auth + headers for live HTTP or sideband WebSocket relays.
 * Shared by call-create and sideband so pool token override stays consistent.
 */
export async function resolveLiveRelay(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<LiveRelayTarget | Response> {
  try {
    validateForwardAdmissionCredential(req.headers, config);
  } catch (err) {
    if (err instanceof ForwardAdmissionCredentialError) {
      return formatErrorResponse(401, "authentication_error", err.message);
    }
    throw err;
  }

  const candidates = selectOpenAiImagesProvider(config);
  if (candidates.forwardCandidates.length === 0 && !candidates.keyed) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in ChatGPT voice needs an OpenAI upstream (ChatGPT login or an OpenAI API-key provider), "
        + "but none is configured in opencodex. Routed providers cannot serve voice call-create.",
    );
  }

  let forward: Awaited<ReturnType<typeof resolveFirstUsableOpenAiSidecar>> | undefined;
  let forwardAuthError: Response | undefined;
  if (candidates.forwardCandidates.length > 0) {
    try {
      forward = await resolveFirstUsableOpenAiSidecar(candidates.forwardCandidates, req.headers, config);
      if (forward) {
        logCtx.provider = formatCodexProviderForLog(
          forward.providerName,
          codexLogAccountId(forward.authContext),
          config,
        );
      }
    } catch (err) {
      if (err instanceof CodexAccountCooldownError) {
        forwardAuthError = formatErrorResponse(429, "rate_limit_error", "Selected Codex account is cooling down");
      } else if (err instanceof CodexThreadAffinityExpiredError) {
        forwardAuthError = formatErrorResponse(
          409,
          "invalid_request_error",
          "Codex thread account affinity expired; start a new session",
        );
      } else if (err instanceof CodexAuthContextError) {
        const safeAccountLabel = formatCodexProviderForLog("openai", err.accountId, config);
        console.error(`[live] Pool account ${safeAccountLabel} token failed; reauthentication required`);
        forwardAuthError = formatErrorResponse(
          401,
          "authentication_error",
          "Selected Codex account needs reauthentication",
        );
      } else if (err instanceof CodexPoolAuthenticationError) {
        forwardAuthError = formatErrorResponse(401, "authentication_error", err.message);
      } else {
        throw err;
      }
    }
  }

  // Client protocol headers first so provider/auth headers below always win on conflict.
  const headers: Record<string, string> = clientProtocolHeaders(req.headers);
  if (forward) {
    const { provider } = forward;
    if (provider.headers) Object.assign(headers, provider.headers);
    for (const [name, value] of forward.headers) headers[name] = value;
    logCtx.model = "gpt-live";
    return {
      headers,
      providerBaseUrl: provider.baseUrl,
      usesBackendShape: isChatGptBackendBaseUrl(provider.baseUrl),
      keyed: false,
      recordOutcome: status => forward.recordOutcome?.(status),
    };
  }
  if (forwardAuthError) return forwardAuthError;
  if (candidates.keyed) {
    const { provider, apiKey, providerName } = candidates.keyed;
    if (provider.headers) Object.assign(headers, provider.headers);
    headers.authorization = `Bearer ${apiKey}`;
    logCtx.provider = providerName;
    logCtx.model = "gpt-live";
    return {
      headers,
      providerBaseUrl: provider.baseUrl,
      usesBackendShape: false,
      keyed: true,
    };
  }
  return formatErrorResponse(
    401,
    "authentication_error",
    "voice relay needs ChatGPT auth (Authorization header) or an OpenAI API-key provider",
  );
}

export async function handleLive(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
): Promise<Response> {
  const inboundContentType = req.headers.get("content-type") ?? "application/octet-stream";
  const inboundBodyOrError = await readRequestBodyCapped(req, LIVE_REQUEST_MAX_BYTES);
  if (inboundBodyOrError instanceof Response) return inboundBodyOrError;
  const inboundBody = inboundBodyOrError;

  const relay = await resolveLiveRelay(req, config, logCtx);
  if (relay instanceof Response) return relay;

  const headers: Record<string, string> = { ...relay.headers };
  let url: string;
  let outboundBody: ArrayBuffer = inboundBody;
  let outboundContentType = inboundContentType;

  if (!relay.keyed) {
    url = forwardLiveUrl(relay.providerBaseUrl, relay.usesBackendShape);
    if (relay.usesBackendShape && inboundContentType.toLowerCase().includes("multipart/form-data")) {
      const rewritten = await backendJsonBodyFromApiMultipart(inboundBody, inboundContentType);
      if (rewritten instanceof Response) return rewritten;
      outboundBody = rewritten.body.buffer.slice(
        rewritten.body.byteOffset,
        rewritten.body.byteOffset + rewritten.body.byteLength,
      ) as ArrayBuffer;
      outboundContentType = rewritten.contentType;
    }
  } else {
    url = keyedLiveUrl(relay.providerBaseUrl);
  }

  headers["content-type"] = outboundContentType;

  const linkedSignal = signalWithTimeout(LIVE_UPSTREAM_TIMEOUT_MS, req.signal);
  const sidecarExit = sidecarEnter("live");
  try {
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers,
      body: outboundBody,
      signal: linkedSignal.signal,
    });
    // Record every completed upstream response before body size handling so account health /
    // cooldown still updates when we reject an oversized payload.
    relay.recordOutcome?.(upstreamResponse.status);
    const payload = await readBodyCapped(
      upstreamResponse.body,
      LIVE_RESPONSE_MAX_BYTES,
      total => `live response too large (${total} bytes)`,
    );
    if (payload instanceof Response) return payload;
    const relayHeaders: Record<string, string> = {};
    for (const name of LIVE_RELAY_HEADERS) {
      const value = upstreamResponse.headers.get(name);
      if (value) relayHeaders[name] = value;
    }
    return new Response(payload, { status: upstreamResponse.status, headers: relayHeaders });
  } catch (err) {
    if (req.signal.aborted) {
      return formatErrorResponse(499, "client_closed_request", "live request canceled by client");
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      relay.recordOutcome?.("timeout");
      return formatErrorResponse(504, "upstream_error", "live upstream timed out");
    }
    relay.recordOutcome?.("connect_error");
    return formatErrorResponse(
      502,
      "upstream_error",
      `live relay failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}

/** Resolve sideband upstream WebSocket URL + headers for an accepted upgrade. */
export async function resolveLiveSidebandUpgrade(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  target: LiveSidebandTarget,
): Promise<{ headers: Record<string, string>; upstreamWsUrl: string; recordOutcome?: LiveRelayTarget["recordOutcome"] } | Response> {
  const relay = await resolveLiveRelay(req, config, logCtx);
  if (relay instanceof Response) return relay;
  return {
    headers: relay.headers,
    upstreamWsUrl: buildLiveSidebandUpstreamWsUrl(relay.providerBaseUrl, relay.usesBackendShape, target),
    recordOutcome: relay.recordOutcome,
  };
}
