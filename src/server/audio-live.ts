import { createHash } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import { MAIN_CODEX_ACCOUNT_ID } from "../codex/account-id";
import { cancelBodyOnAbort, clearableDeadline } from "../lib/abort";
import type { AdmissionLease } from "../lib/admission";
import { captureExplicitOpenAiCallerAuth } from "../providers/openai-sidecar";
import type { OcxConfig } from "../types";
import type { AudioClient } from "./audio-client";
import { finishAudioUpstream, type AudioSocketTarget } from "./audio-dictation";
import { LIVE_AUDIO_MODEL, resolveAudioUpstream, type AudioUpstream } from "./audio-upstream";
import { registerTurn, unregisterTurn } from "./lifecycle";
import {
  backendJsonBodyFromApiMultipart, buildLiveSidebandUpstreamWsUrl, forwardLiveUrl, keyedLiveUrl,
  LIVE_CLIENT_PROTOCOL_HEADERS, LIVE_REQUEST_MAX_BYTES, LIVE_RESPONSE_MAX_BYTES, readBodyCapped,
  type LiveSidebandTarget,
} from "./live";
import { LIVE_CALL_TTL_MS, LiveCallBindings, upstreamLiveCallId } from "./live-call-bindings";
import type { RequestLogContext } from "./request-log";

function protocolHeaders(client: AudioClient, relay: AudioUpstream, frameless: boolean): Headers {
  const headers = new Headers();
  for (const name of LIVE_CLIENT_PROTOCOL_HEADERS) {
    const value = client.headers.get(name);
    if (value) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(relay.headers)) headers.set(name, value);
  if (frameless && !headers.has("openai-alpha")) headers.set("openai-alpha", "quicksilver=v2");
  return headers;
}

async function parseExternalOffer(req: Request, signal: AbortSignal): Promise<{ sdp: string; session?: Record<string, unknown> } | Response> {
  const upload = clearableDeadline(30_000, signal);
  try {
    const body = await readBodyCapped(req.body, LIVE_REQUEST_MAX_BYTES, () => "Live offer too large", upload.signal);
    if (body instanceof Response) return formatErrorResponse(413, "invalid_request_error", "Live offer exceeds 16 MiB");
    const type = req.headers.get("content-type") ?? "";
    let payload: unknown;
    if (type.toLowerCase().includes("multipart/form-data")) {
      const converted = await backendJsonBodyFromApiMultipart(body, type);
      if (converted instanceof Response) return converted;
      payload = JSON.parse(new TextDecoder().decode(converted.body));
    } else if (type.toLowerCase().includes("application/json")) {
      payload = JSON.parse(new TextDecoder().decode(body));
    } else if (type.toLowerCase().includes("application/sdp")) {
      payload = { sdp: new TextDecoder().decode(body) };
    }
    if (!payload || typeof payload !== "object" || !("sdp" in payload) || typeof payload.sdp !== "string" || !payload.sdp.trim()) {
      return formatErrorResponse(400, "invalid_request_error", "Live call requires a nonempty SDP offer");
    }
    const session = "session" in payload ? payload.session : undefined;
    if (session !== undefined && (!session || typeof session !== "object" || Array.isArray(session))) {
      return formatErrorResponse(400, "invalid_request_error", "Live session must be an object");
    }
    return { sdp: payload.sdp, ...(session ? { session: session as Record<string, unknown> } : {}) };
  } catch {
    if (signal.aborted) throw signal.reason;
    return formatErrorResponse(upload.didExpire() ? 408 : 400, "invalid_request_error", upload.didExpire() ? "Live offer upload timed out" : "Malformed live offer");
  } finally { upload.clear(); }
}

export async function handleExternalLive(
  req: Request, config: OcxConfig, log: RequestLogContext,
  options: { client: AudioClient; lease: AdmissionLease; bindings: LiveCallBindings },
): Promise<Response> {
  const controller = new AbortController();
  registerTurn(controller, options.lease);
  const deadline = clearableDeadline(120_000, AbortSignal.any([req.signal, controller.signal]));
  let relay: AudioUpstream | undefined;
  let outcome: number | "timeout" | "connect_error" | undefined;
  try {
    const offer = await parseExternalOffer(req, deadline.signal);
    if (offer instanceof Response) return offer;
    if (!options.bindings.hasCapacity()) return formatErrorResponse(503, "server_busy", "Live call capacity reached");
    const frameless = new URL(req.url).pathname === "/v1/live";
    const session = offer.session ? { ...offer.session } : frameless ? {
      model: LIVE_AUDIO_MODEL, instructions: "", audio: { output: { voice: "cove" } }, delegation: { type: "client" },
    } : undefined;
    if (session?.model === "gpt-live-1") session.model = LIVE_AUDIO_MODEL;
    const model = typeof session?.model === "string" ? session.model : LIVE_AUDIO_MODEL;
    const resolved = await resolveAudioUpstream(options.client.headers, config, log, {
      admission: options.client.admission, model, lease: options.lease, signal: deadline.signal,
    });
    if (!(resolved instanceof Response)) relay = resolved;
    deadline.signal.throwIfAborted();
    if (resolved instanceof Response) return resolved;
    relay = resolved;
    const headers = protocolHeaders(options.client, relay, frameless);
    let body: BodyInit;
    if (relay.keyed) {
      const form = new FormData();
      form.set("sdp", offer.sdp);
      if (session) form.set("session", JSON.stringify(session));
      headers.delete("content-type");
      body = form;
    } else {
      headers.set("content-type", "application/json");
      body = JSON.stringify({ sdp: offer.sdp, ...(session ? { session } : {}) });
    }
    const url = relay.keyed
      ? frameless ? forwardLiveUrl(relay.providerBaseUrl, false) : keyedLiveUrl(relay.providerBaseUrl)
      : forwardLiveUrl(relay.providerBaseUrl, true);
    const upstream = await fetch(url, { method: "POST", headers, body, signal: deadline.signal, redirect: "manual" });
    outcome = upstream.ok ? 502 : upstream.status;
    const detach = cancelBodyOnAbort(upstream.body, deadline.signal);
    let responseBody: ArrayBuffer | Response;
    try { responseBody = await readBodyCapped(upstream.body, LIVE_RESPONSE_MAX_BYTES, () => "Live answer too large", deadline.signal); }
    finally { detach(); }
    if (responseBody instanceof Response) return responseBody;
    if (!upstream.ok) return formatErrorResponse(upstream.status >= 400 ? upstream.status : 502, "upstream_error", `Live upstream returned HTTP ${upstream.status}`);
    const callId = upstreamLiveCallId(upstream.headers.get("location"));
    if (!callId || responseBody.byteLength === 0) return formatErrorResponse(502, "upstream_error", "Live upstream returned an invalid call answer");
    const context = relay.authContext;
    const callerOwned = context?.kind === "main" && captureExplicitOpenAiCallerAuth(options.client.headers, config) !== null;
    const alias = options.bindings.create({
      owner: options.client.owner, upstreamCallId: callId,
      joinStyle: frameless ? "frameless-path" : "realtime-query",
      providerName: relay.providerName,
      accountId: context ? context.kind === "main" ? callerOwned ? undefined : MAIN_CODEX_ACCOUNT_ID : context.accountId : undefined,
      chatgptAccountId: new Headers(relay.headers).get("chatgpt-account-id") ?? undefined,
      keyedCredentialDigest: relay.keyed ? createHash("sha256").update(new Headers(relay.headers).get("authorization") ?? "").digest("hex") : undefined,
      callerOwned,
      sidebandBaseUrl: config.experimentalRealtimeWsBaseUrl,
    });
    if (!alias) return formatErrorResponse(503, "server_busy", "Live call could not be registered");
    outcome = upstream.status;
    return new Response(responseBody, { status: upstream.status, headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/sdp",
      location: `/v1/${frameless ? "live" : "realtime/calls"}/${alias}`,
    } });
  } catch {
    if (req.signal.aborted || controller.signal.aborted) {
      outcome = undefined;
      return formatErrorResponse(req.signal.aborted ? 499 : 503, "client_closed_request", "Live call canceled");
    }
    outcome = deadline.didExpire() ? "timeout" : "connect_error";
    return formatErrorResponse(deadline.didExpire() ? 504 : 502, "upstream_error", deadline.didExpire() ? "Live call timed out" : "Live upstream connection failed");
  } finally {
    try { if (outcome !== undefined) relay?.recordOutcome?.(outcome); }
    finally { relay?.release(); deadline.clear(); unregisterTurn(controller); }
  }
}

export async function resolveExternalLiveSocket(
  client: AudioClient, config: OcxConfig, log: RequestLogContext, target: LiveSidebandTarget,
  options: { lease: AdmissionLease; bindings: LiveCallBindings; signal?: AbortSignal },
): Promise<AudioSocketTarget | Response> {
  const binding = "callId" in target ? options.bindings.get(target.callId, client.owner) : undefined;
  if ("callId" in target && !binding) return formatErrorResponse(404, "not_found", "Live call is unavailable for this key");
  if (binding?.callerOwned && !captureExplicitOpenAiCallerAuth(client.headers, config)) {
    return formatErrorResponse(401, "authentication_error", "Live call requires its original caller account");
  }
  let upstreamTarget = binding ? { style: binding.joinStyle, callId: binding.upstreamCallId } as LiveSidebandTarget : target;
  const frameless = upstreamTarget.style === "frameless-path" || upstreamTarget.style === "frameless-standalone";
  let model = LIVE_AUDIO_MODEL;
  if (upstreamTarget.style === "frameless-standalone") {
    const query = new URLSearchParams(upstreamTarget.query);
    if (!query.has("model") || query.get("model") === "gpt-live-1") query.set("model", LIVE_AUDIO_MODEL);
    model = query.get("model") ?? LIVE_AUDIO_MODEL;
    upstreamTarget = { ...upstreamTarget, query: query.toString() };
  }
  const relay = await resolveAudioUpstream(client.headers, config, log, {
    admission: client.admission, model, lease: options.lease,
    signal: options.signal,
    ...(binding ? { exactAccountId: binding.accountId, providerName: binding.providerName } : {}),
  });
  if (relay instanceof Response) return relay;
  try {
    if (binding && (relay.providerName !== binding.providerName
      || (new Headers(relay.headers).get("chatgpt-account-id") ?? undefined) !== binding.chatgptAccountId
      || (binding.keyedCredentialDigest !== undefined
        && createHash("sha256").update(new Headers(relay.headers).get("authorization") ?? "").digest("hex") !== binding.keyedCredentialDigest))) {
      relay.release();
      return formatErrorResponse(409, "authentication_error", "Live call account is no longer available");
    }
    return {
      headers: Object.fromEntries(protocolHeaders(client, relay, frameless)),
      upstreamWsUrl: buildLiveSidebandUpstreamWsUrl(upstreamTarget, binding ? binding.sidebandBaseUrl : config.experimentalRealtimeWsBaseUrl),
      maxSessionMs: LIVE_CALL_TTL_MS,
      finish: finishAudioUpstream(relay),
    };
  } catch {
    relay.release();
    return formatErrorResponse(400, "invalid_request_error", "Invalid live endpoint configuration");
  }
}
