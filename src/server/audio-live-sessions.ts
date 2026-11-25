/**
 * Public GPT-Live session creation (`POST /v1/live/sessions`) for external audio keys.
 *
 * OpenAI's GPT-Live API creates a WebRTC session with JSON `{ session, transport }` and answers
 * `201 { session: { id }, transport: { type, sdp } }` (developers.openai.com/api/reference/resources/live).
 * Only an OpenAI API-key provider serves it: no documented ChatGPT subscription endpoint exists, so a
 * ChatGPT account is never substituted. SIP transport places phone calls with trunk credentials and is
 * refused. The returned session id is replaced by an alias bound to the creating key, so only that key
 * can attach (`WS /v1/live/sessions/{id}/attach`).
 */
import { createHash } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import { cancelBodyOnAbort, clearableDeadline } from "../lib/abort";
import type { AdmissionLease } from "../lib/admission";
import { selectOpenAiImagesProvider } from "../providers/openai-sidecar";
import type { OcxConfig } from "../types";
import type { AudioClient } from "./audio-client";
import { resolveAudioUpstream, type AudioUpstream } from "./audio-upstream";
import { registerTurn, unregisterTurn } from "./lifecycle";
import { LIVE_CLIENT_PROTOCOL_HEADERS, LIVE_RESPONSE_MAX_BYTES, readBodyCapped } from "./live";
import type { LiveCallBindings } from "./live-call-bindings";
import type { RequestLogContext } from "./request-log";

export const LIVE_SESSION_REQUEST_MAX_BYTES = 1024 * 1024;
const LIVE_SESSION_TIMEOUT_MS = 120_000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Client headers the public GPT-Live API documents, relayed only when the client sent them. */
export const LIVE_SESSION_CLIENT_HEADERS = [...LIVE_CLIENT_PROTOCOL_HEADERS, "openai-safety-identifier"] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string, status = 400): Response {
  return formatErrorResponse(status, "invalid_request_error", message);
}

/** The API-key provider a GPT-Live session must use, or the refusal when none is configured. */
export function liveSessionProviderName(config: OcxConfig): string | Response {
  return selectOpenAiImagesProvider(config).keyed?.providerName
    ?? invalid("GPT-Live sessions require an OpenAI API-key provider");
}

/** Headers for a GPT-Live upstream: the documented client headers, then the provider credential. */
export function liveSessionHeaders(client: AudioClient, relay: AudioUpstream): Headers {
  const headers = new Headers();
  for (const name of LIVE_SESSION_CLIENT_HEADERS) {
    const value = client.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(relay.headers)) headers.set(name, value);
  return headers;
}

async function parseSessionRequest(req: Request, signal: AbortSignal): Promise<JsonObject | Response> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return invalid("GPT-Live session creation expects application/json");
  }
  const body = await readBodyCapped(req.body, LIVE_SESSION_REQUEST_MAX_BYTES, () => "too large", signal);
  if (body instanceof Response) return invalid("GPT-Live session request exceeds 1 MiB", 413);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(body)); } catch { return invalid("Malformed GPT-Live session request"); }
  if (!isObject(payload) || !isObject(payload.session) || !isObject(payload.transport)) {
    return invalid("GPT-Live session creation requires session and transport objects");
  }
  const model = payload.session.model;
  if (typeof model !== "string" || !model.trim()) return invalid("GPT-Live session.model is required");
  if (payload.transport.type === "sip") return invalid("SIP transport is not supported by OpenCodex");
  if (payload.transport.type !== "webrtc" || typeof payload.transport.sdp !== "string" || !payload.transport.sdp.trim()) {
    return invalid("GPT-Live session creation requires a WebRTC transport with an SDP offer");
  }
  return payload;
}

export async function handleLiveSessionCreate(
  req: Request, config: OcxConfig, log: RequestLogContext,
  options: { client: AudioClient; lease: AdmissionLease; bindings: LiveCallBindings },
): Promise<Response> {
  const controller = new AbortController();
  registerTurn(controller, options.lease);
  const deadline = clearableDeadline(LIVE_SESSION_TIMEOUT_MS, AbortSignal.any([req.signal, controller.signal]));
  let relay: AudioUpstream | undefined;
  let outcome: number | "timeout" | "connect_error" | undefined;
  try {
    const payload = await parseSessionRequest(req, deadline.signal);
    if (payload instanceof Response) return payload;
    const providerName = liveSessionProviderName(config);
    if (providerName instanceof Response) return providerName;
    if (!options.bindings.hasCapacity()) return formatErrorResponse(503, "server_busy", "Live call capacity reached");
    const model = (payload.session as JsonObject).model as string;
    const resolved = await resolveAudioUpstream(options.client.headers, config, log, {
      admission: options.client.admission, model, lease: options.lease, providerName, signal: deadline.signal,
    });
    if (resolved instanceof Response) return resolved;
    relay = resolved;
    if (!relay.keyed) return invalid("GPT-Live sessions require an OpenAI API-key provider");
    const headers = liveSessionHeaders(options.client, relay);
    headers.set("content-type", "application/json");
    const upstream = await fetch(`${relay.providerBaseUrl.replace(/\/+$/, "")}/live/sessions`, {
      method: "POST", headers, body: JSON.stringify(payload), signal: deadline.signal, redirect: "manual",
    });
    outcome = upstream.status;
    const detach = cancelBodyOnAbort(upstream.body, deadline.signal);
    let raw: ArrayBuffer | Response;
    try { raw = await readBodyCapped(upstream.body, LIVE_RESPONSE_MAX_BYTES, () => "GPT-Live answer too large", deadline.signal); }
    finally { detach(); }
    if (raw instanceof Response) return raw;
    if (!upstream.ok) {
      return formatErrorResponse(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, "upstream_error", `GPT-Live upstream returned HTTP ${upstream.status}`);
    }
    let answer: unknown;
    try { answer = JSON.parse(new TextDecoder().decode(raw)); } catch { answer = undefined; }
    const sessionId = isObject(answer) && isObject(answer.session) ? answer.session.id : undefined;
    const transport = isObject(answer) ? answer.transport : undefined;
    if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId) || !isObject(transport)
      || transport.type !== "webrtc" || typeof transport.sdp !== "string" || !transport.sdp.trim()) {
      return formatErrorResponse(502, "upstream_error", "GPT-Live upstream returned an invalid session answer");
    }
    const alias = options.bindings.create({
      owner: options.client.owner, upstreamCallId: sessionId, joinStyle: "live-session",
      providerName: relay.providerName, model,
      keyedCredentialDigest: createHash("sha256").update(new Headers(relay.headers).get("authorization") ?? "").digest("hex"),
      callerOwned: false,
    });
    if (!alias) return formatErrorResponse(503, "server_busy", "Live call could not be registered");
    return Response.json({ ...(answer as JsonObject), session: { ...((answer as JsonObject).session as JsonObject), id: alias } }, { status: upstream.status });
  } catch {
    if (req.signal.aborted || controller.signal.aborted) {
      outcome = undefined;
      return formatErrorResponse(req.signal.aborted ? 499 : 503, "client_closed_request", "GPT-Live session creation canceled");
    }
    outcome = deadline.didExpire() ? "timeout" : "connect_error";
    return formatErrorResponse(deadline.didExpire() ? 504 : 502, "upstream_error", deadline.didExpire() ? "GPT-Live session creation timed out" : "GPT-Live upstream connection failed");
  } finally {
    try { if (outcome !== undefined) relay?.recordOutcome?.(outcome); }
    finally { relay?.release(); deadline.clear(); unregisterTurn(controller); }
  }
}

