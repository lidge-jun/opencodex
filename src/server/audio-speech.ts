/**
 * `POST /v1/audio/speech` — text to audio, for read-aloud.
 *
 * Unlike transcription and dictation there is no built-in path behind this: opencodex has never
 * had a speech backend, so an unconfigured `speech` block means the route is genuinely
 * unavailable rather than quietly falling back to OpenAI. A 501 saying which setting is missing
 * is more useful than a 404 that looks like a routing bug.
 *
 * The body is OpenAI's own speech shape, forwarded unchanged. The provider's audio bytes come
 * back with their own content type — nothing here re-encodes audio.
 */
import { formatErrorResponse } from "../bridge";
import { resolveVoiceHeaders, selectVoiceBackend, voiceProviderEndpointError } from "../config/voice-target";
import { cancelBodyOnAbort, clearableDeadline, signalWithTimeout } from "../lib/abort";
import type { AdmissionLease } from "../lib/admission";
import { sidecarEnter } from "../lib/sidecar-tracker";
import type { OcxConfig } from "../types";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveDictationActiveModelId } from "./audio-dictation";
import { registerTurn, unregisterTurn } from "./lifecycle";
import { readBodyCapped } from "./live";
import type { RequestLogContext } from "./request-log";

/** A spoken reply is text; a request anywhere near this size is a client fault. */
export const SPEECH_REQUEST_MAX_BYTES = 1024 * 1024;
/** Generated audio. Ten minutes of 24 kHz mono PCM16 WAV is about 29 MiB. */
export const SPEECH_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 120_000;
/** Longest single utterance accepted, in characters. */
const SPEECH_INPUT_MAX_CHARS = 8192;

const FIELDS = new Set(["model", "input", "voice", "response_format", "speed", "instructions"]);

interface SpeechInput {
  body: Record<string, unknown>;
}

function invalid(message: string, status = 400): Response {
  return formatErrorResponse(status, "invalid_request_error", message);
}

async function parseSpeech(req: Request, signal: AbortSignal): Promise<SpeechInput | Response> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) {
    return invalid("Expected application/json with model and input");
  }
  const deadline = clearableDeadline(30_000, signal);
  let raw: ArrayBuffer | Response;
  try {
    raw = await readBodyCapped(req.body, SPEECH_REQUEST_MAX_BYTES, () => "Speech request too large", deadline.signal);
  } catch {
    return deadline.didExpire()
      ? formatErrorResponse(408, "request_timeout", "Speech upload timed out")
      : invalid("Malformed speech request body");
  } finally {
    deadline.clear();
  }
  if (raw instanceof Response) return invalid("Speech request exceeds 1 MiB", 413);

  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch {
    return invalid("Speech request body is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return invalid("Speech request body must be a JSON object");
  }
  const body = payload as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => !FIELDS.has(key));
  if (unknown) return invalid(`Unsupported speech field: ${unknown.slice(0, 64)}`);
  if (typeof body.input !== "string" || body.input.trim() === "") {
    return invalid("A nonempty `input` string is required");
  }
  if (body.input.length > SPEECH_INPUT_MAX_CHARS) {
    return invalid(`\`input\` exceeds ${SPEECH_INPUT_MAX_CHARS} characters`, 413);
  }
  if (body.model !== undefined && typeof body.model !== "string") return invalid("`model` must be a string");
  if (body.voice !== undefined && typeof body.voice !== "string") return invalid("`voice` must be a string");
  if (body.response_format !== undefined && typeof body.response_format !== "string") {
    return invalid("`response_format` must be a string");
  }
  return { body };
}

async function speakAdmitted(
  req: Request,
  config: OcxConfig,
  operation: { signal: AbortSignal; didExpire: () => boolean },
): Promise<Response> {
  const backend = selectVoiceBackend(
    config.providers,
    config.speech,
    resolveDictationActiveModelId(req.headers),
    "speech",
  );
  if (backend.kind === "invalid") return formatErrorResponse(502, "configuration_error", backend.error);
  if (backend.kind === "openai") {
    return formatErrorResponse(501, "unsupported_route",
      "No speech backend is configured. Set speech.provider (or speech.byModel) to a custom provider with a speechUrl.");
  }
  const endpointError = voiceProviderEndpointError(backend.providerName, backend.provider, "speech");
  if (endpointError) return formatErrorResponse(502, "configuration_error", endpointError);

  const input = await parseSpeech(req, operation.signal);
  if (input instanceof Response) return input;
  if (operation.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Speech request canceled");

  const signal = signalWithTimeout(SPEECH_TIMEOUT_MS, operation.signal);
  const exit = sidecarEnter("audio-speech");
  try {
    const headers = new Headers({ "content-type": "application/json" });
    for (const [name, value] of Object.entries(resolveVoiceHeaders(backend.provider.speechHeaders))) {
      headers.set(name, value);
    }
    const upstream = await fetch(backend.provider.speechUrl!, {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      signal: signal.signal,
      redirect: "manual",
    });
    const detach = cancelBodyOnAbort(upstream.body, signal.signal);
    let audio: ArrayBuffer | Response;
    try {
      audio = await readBodyCapped(upstream.body, SPEECH_RESPONSE_MAX_BYTES, () => "Speech response too large", signal.signal);
    } finally {
      detach();
    }
    if (audio instanceof Response) return audio;
    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
      return formatErrorResponse(status, "upstream_error",
        `Speech provider "${backend.providerName}" returned HTTP ${upstream.status}`);
    }
    if (audio.byteLength === 0) {
      return formatErrorResponse(502, "upstream_error", `Speech provider "${backend.providerName}" returned no audio`);
    }
    // Carry the provider's own content type: the caller asked for a format and
    // relabelling the bytes would be a lie the player finds out about later.
    return new Response(audio, {
      headers: { "content-type": upstream.headers.get("content-type") ?? "audio/mpeg" },
    });
  } catch {
    if (operation.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Speech request canceled");
    const timedOut = signal.signal.aborted;
    return formatErrorResponse(timedOut ? 504 : 502, "upstream_error",
      timedOut ? `Speech provider "${backend.providerName}" timed out`
               : `Speech provider "${backend.providerName}" connection failed`);
  } finally {
    signal.cleanup();
    exit();
  }
}

export async function handleAudioSpeech(
  req: Request,
  config: OcxConfig,
  _log: RequestLogContext,
  _admission: DataPlaneAdmission,
  lease?: AdmissionLease,
): Promise<Response> {
  const operation = new AbortController();
  if (lease) registerTurn(operation, lease);
  const deadline = clearableDeadline(SPEECH_TIMEOUT_MS, AbortSignal.any([req.signal, operation.signal]));
  try {
    const response = await speakAdmitted(req, config, { signal: deadline.signal, didExpire: deadline.didExpire });
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Speech request canceled");
    if (operation.signal.aborted) return formatErrorResponse(503, "server_draining", "Speech request stopped during shutdown");
    if (deadline.didExpire()) return formatErrorResponse(504, "upstream_error", "Speech request timed out");
    return response;
  } finally {
    deadline.clear();
    if (lease) unregisterTurn(operation);
  }
}
